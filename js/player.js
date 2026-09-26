// File playback for the Player tab, as Howl's Player.kt with HWL.kt and OutputRecorder.kt.
// The page's clock asks for one pulse every 1/40 s; the player advances by that much times the playback speed.

import { BadFileError, FunscriptSource, MAX_FILE_BYTES } from './funscript.js';

// HWL: "YEAHBOI!" then 16 bytes per pulse (ampA, ampB, freqA, freqB as little-endian float32), 40 pulses/s
const HWL_HEADER = 'YEAHBOI!';
const HWL_PULSE_SIZE = 16;
export const HWL_PULSES_PER_SEC = 40;
const HWL_PULSE_TIME = 1 / HWL_PULSES_PER_SEC;

export const PLAYER_DEFAULTS = { speed: 1, showSyncFineTune: false };
export const SPEED_RANGE = [0.25, 4];
export const FINE_TUNE_RANGE = [-0.5, 0.5]; // seconds

const RECORD_PASSIVE_SECS = 120; // always keeps the last 2 minutes, so a good moment can still be saved
const RECORD_ACTIVE_SECS = 7200;

/** @param {ArrayBuffer} buffer */
export function readHWL(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < HWL_HEADER.length || String.fromCharCode(...bytes.subarray(0, HWL_HEADER.length)) !== HWL_HEADER) {
    throw new BadFileError('Invalid HWL file: header mismatch.');
  }
  const body = bytes.length - HWL_HEADER.length;
  if (body % HWL_PULSE_SIZE !== 0) throw new BadFileError('Invalid HWL file: incomplete pulse data.');
  const view = new DataView(buffer, HWL_HEADER.length);
  const pulses = [];
  for (let off = 0; off < body; off += HWL_PULSE_SIZE) {
    pulses.push({
      ampA: view.getFloat32(off, true),
      ampB: view.getFloat32(off + 4, true),
      freqA: view.getFloat32(off + 8, true),
      freqB: view.getFloat32(off + 12, true),
    });
  }
  return pulses;
}

/** @returns {ArrayBuffer} */
export function writeHWL(pulses) {
  const buffer = new ArrayBuffer(HWL_HEADER.length + pulses.length * HWL_PULSE_SIZE);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < HWL_HEADER.length; i++) bytes[i] = HWL_HEADER.charCodeAt(i);
  const view = new DataView(buffer, HWL_HEADER.length);
  pulses.forEach((p, i) => {
    const off = i * HWL_PULSE_SIZE;
    view.setFloat32(off, p.ampA, true);
    view.setFloat32(off + 4, p.ampB, true);
    view.setFloat32(off + 8, p.freqA, true);
    view.setFloat32(off + 12, p.freqB, true);
  });
  return buffer;
}

export class HwlSource {
  constructor(pulses, name) {
    if (!pulses.length) throw new BadFileError('Invalid HWL file: no pulses.');
    this.pulses = pulses;
    this.name = name;
    this.info = '';
    this.loop = true;
    this.duration = pulses.length * HWL_PULSE_TIME;
  }

  /** Linear interpolation between the recorded pulses. */
  pulseAt(time) {
    const data = this.pulses;
    if (time <= 0) return data[0];
    const idx = time / HWL_PULSE_TIME;
    const i = Math.floor(idx);
    if (i >= data.length - 1) return data[data.length - 1];
    const h = idx - i;
    const a = data[i];
    const b = data[i + 1];
    const mix = key => a[key] + (b[key] - a[key]) * h;
    return { ampA: mix('ampA'), ampB: mix('ampB'), freqA: mix('freqA'), freqB: mix('freqB') };
  }
}

/**
 * Opens a .funscript or .hwl file.
 * @param {File} file
 * @param {object} funscriptOptions
 * @param {() => number} positionalCurve
 */
export async function openFile(file, funscriptOptions, positionalCurve) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (file.size > MAX_FILE_BYTES) throw new BadFileError(`File is too large (${Math.round(file.size / 1048576)}MB)`);
  if (ext === 'funscript') return new FunscriptSource(await file.text(), file.name, funscriptOptions, positionalCurve);
  if (ext === 'hwl') return new HwlSource(readHWL(await file.arrayBuffer()), file.name);
  throw new BadFileError(`Unsupported file type: "${file.name}" (expected .hwl or .funscript)`);
}

export class Player {
  constructor() {
    this.file = null; // FunscriptSource | HwlSource
    this.position = 0; // seconds
    this.speed = PLAYER_DEFAULTS.speed;
    this.syncFineTune = 0;
    this.ended = false; // set when a non-looping file reaches its end
  }

  load(file) {
    this.file = file;
    this.position = 0;
    this.syncFineTune = 0;
    this.ended = false;
  }

  seek(position) {
    if (!this.file) return;
    this.position = Math.min(Math.max(position, 0), this.file.duration);
    this.ended = false;
  }

  /** Advances by `dt` seconds of wall time and returns the pulse for that moment. */
  next(dt) {
    const file = this.file;
    if (!file) return { ampA: 0, ampB: 0, freqA: 0, freqB: 0 };
    if (this.position > file.duration) {
      if (!file.loop) {
        this.ended = true;
        return { ampA: 0, ampB: 0, freqA: 0, freqB: 0 };
      }
      this.position = 0;
    }
    const time = Math.max(this.position + this.syncFineTune * this.speed, 0);
    const pulse = file.pulseAt(time);
    this.position += dt * this.speed;
    return pulse;
  }
}

/** Keeps what played, as Howl's recorder: always the last 2 minutes, or up to 2 hours while recording. */
export class Recorder {
  constructor() {
    this.recordMode = false;
    this.recording = false;
    this.pulses = [];
    this.limit = RECORD_PASSIVE_SECS * HWL_PULSES_PER_SEC;
  }

  get duration() {
    return this.pulses.length / HWL_PULSES_PER_SEC;
  }

  add(pulse) {
    if (this.recordMode && !this.recording) return;
    this.pulses.push(pulse);
    if (this.pulses.length > this.limit) this.pulses.splice(0, this.pulses.length - this.limit);
  }

  setRecordMode(on) {
    this.recordMode = on;
    this.recording = false;
    this.limit = (on ? RECORD_ACTIVE_SECS : RECORD_PASSIVE_SECS) * HWL_PULSES_PER_SEC;
    this.pulses = [];
  }

  clear() {
    this.pulses = [];
  }
}
