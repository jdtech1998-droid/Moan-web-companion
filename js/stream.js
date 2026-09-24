// The Rider's incoming pulse stream: pairs the Driver's A/B messages, smooths frequency, and buffers pulses
// for steady playback. Ports RiderRelayClient.parsePulse / FrequencySmoother and StreamSource
// (prebuffer 8, buffer 16, silence when starved). Frequencies are 0-1 over the wire span.

import { wireHzToNormalized } from './protocol.js';

const SILENT = Object.freeze({ ampA: 0, ampB: 0, freqA: 0, freqB: 0 });

/** Triangle-weighted average over 7 pulses (175ms), centred, so it doesn't lag fast changes. Amplitude is untouched. */
const WEIGHTS = [1, 2, 3, 4, 3, 2, 1];
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b);
const DELAY = Math.floor(WEIGHTS.length / 2);

export const STARVED_HOLD_MS = 400;
export const STARVED_FADE_MS = 300;

export class RemoteStream {
  constructor({ prebuffer = 8, bufferSize = 16 } = {}) {
    this.prebuffer = prebuffer;
    this.bufferSize = bufferSize;
    this.reset();
  }

  reset() {
    this.buffer = [];
    this.window = [];
    this.pendingA = null;
    this.lastA = { amp: 0, freq: 0 };
    this.lastB = { amp: 0, freq: 0 };
    this.current = SILENT;
    this.buffering = true;
    this.lastFreshAt = NaN;
  }

  /** Drops everything buffered and plays silence until fresh pulses arrive (stream end, E-STOP, disconnect). */
  silence() {
    this.reset();
  }

  /**
   * Adds one decoded pulse message. A arrives first and waits for its B so both channels play together,
   * keeping the stream at one pulse per Driver tick.
   * @param {0|1} channel
   * @param {{amp:number, hz:number}[]} samples
   */
  addChannel(channel, samples) {
    if (!samples.length) return;
    const normalized = samples.map(s => ({ amp: s.amp, freq: wireHzToNormalized(s.hz) }));
    if (channel === 0) {
      // An A still waiting means its B never came; play it alone rather than lose it
      if (this.pendingA) this.emit(this.pendingA, null);
      this.pendingA = normalized;
    } else {
      const a = this.pendingA;
      this.pendingA = null;
      this.emit(a, normalized);
    }
  }

  emit(a, b) {
    const count = Math.max(a?.length ?? 0, b?.length ?? 0);
    for (let i = 0; i < count; i++) {
      if (a) this.lastA = a[Math.min(i, a.length - 1)];
      if (b) this.lastB = b[Math.min(i, b.length - 1)];
      const smoothed = this.smooth({ ampA: this.lastA.amp, ampB: this.lastB.amp, freqA: this.lastA.freq, freqB: this.lastB.freq });
      if (smoothed) this.push(smoothed);
    }
  }

  smooth(pulse) {
    this.window.push(pulse);
    if (this.window.length < WEIGHTS.length) return null;
    let freqA = 0;
    let freqB = 0;
    for (let i = 0; i < WEIGHTS.length; i++) {
      freqA += WEIGHTS[i] * this.window[i].freqA;
      freqB += WEIGHTS[i] * this.window[i].freqB;
    }
    const centre = this.window[DELAY];
    this.window.shift();
    return { ...centre, freqA: freqA / WEIGHT_SUM, freqB: freqB / WEIGHT_SUM };
  }

  push(pulse) {
    this.buffer.push(pulse);
    // Full buffer: the oldest pulse goes, so latency can't build up
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
  }

  /** Takes the next pulse for playback (called at 40Hz). */
  next(nowMs) {
    if (Number.isNaN(this.lastFreshAt)) this.lastFreshAt = nowMs;

    if (this.buffering && this.buffer.length >= this.prebuffer) this.buffering = false;
    if (!this.buffering) {
      const pulse = this.buffer.shift();
      if (pulse) {
        this.current = pulse;
        this.lastFreshAt = nowMs;
      } else {
        // Ran dry: hold the last pulse and refill the cushion rather than stutter on each late arrival
        this.buffering = true;
      }
    }

    // Starved: hold briefly to ride out network hiccups, then fade out rather than freeze on the last pulse
    const idle = nowMs - this.lastFreshAt - STARVED_HOLD_MS;
    if (idle <= 0) return this.current;
    const gain = Math.max(0, 1 - idle / STARVED_FADE_MS);
    return { ...this.current, ampA: this.current.ampA * gain, ampB: this.current.ampB * gain };
  }
}
