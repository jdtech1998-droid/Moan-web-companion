import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioCore, ContinuousGen, WaveletGen, MultiPulseGen, AUDIO_DEFAULTS, waveSample, estimateBurst, waveletDutyAt100Hz,
  STARVED_BLOCKS, BLOCK_SECONDS,
} from '../js/audiodsp.js';

const SR = 48000;
const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);
const pulse = (o = {}) => ({ ampA: 1, ampB: 1, freqAHz: 500, freqBHz: 500, powerA: 200, powerB: 200, ...o });
const left = buf => buf.filter((_, i) => i % 2 === 0);
const right = buf => buf.filter((_, i) => i % 2 === 1);
const peak = arr => arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const crossings = arr => arr.reduce((n, v, i) => n + (i && arr[i - 1] < 0 && v >= 0 ? 1 : 0), 0);
/** Seeded random so burst tests are repeatable */
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** Renders `seconds` of audio from a core fed a steady pulse, returning [left, right]. */
function renderCore(core, p, seconds) {
  const frames = Math.round(seconds * SR);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) {
    if (i % Math.round(0.1 * SR) < 128) core.push([p, p, p, p]); // a batch every 100ms, as the page sends
    core.render(L.subarray(i, i + 128), R.subarray(i, i + 128));
  }
  return [L, R];
}

test('wave shapes stay within -1..1 and hit their corners', () => {
  for (const shape of ['SINE', 'SQUARE', 'TRIANGLE', 'TRAPEZOID']) {
    for (let p = -10; p < 10; p += 0.01) assert.ok(Math.abs(waveSample(shape, p)) <= 1 + 1e-12, shape);
  }
  near(waveSample('SQUARE', 0.1), 1);
  near(waveSample('TRIANGLE', Math.PI), 1);
  near(waveSample('TRAPEZOID', Math.PI * 0.9), 1);
});

test('continuous plays each channel at its own frequency, scaled by amplitude and power', () => {
  const gen = new ContinuousGen(SR);
  const s = AUDIO_DEFAULTS.continuous;
  const p = pulse({ freqAHz: 500, freqBHz: 800, ampA: 1, ampB: 0.5, powerA: 100, powerB: 200 });
  gen.fill(new Float32Array(2400), 1200, p, s); // settle the interpolation from silence
  const buf = new Float32Array(SR * 2);
  const block = new Float32Array(2400);
  for (let f = 0; f < SR; f += 1200) {
    gen.fill(block, 1200, p, s);
    buf.set(block, f * 2);
  }
  assert.ok(Math.abs(crossings(left(buf)) - 500) <= 1);
  assert.ok(Math.abs(crossings(right(buf)) - 800) <= 1);
  near(peak(left(buf)), 0.5, 1e-3); // amplitude 1 x power 100/200
  near(peak(right(buf)), 0.5, 1e-3); // amplitude 0.5 x power 200/200
});

test('power 0 is silent unless "Always full volume" is on', () => {
  const s = AUDIO_DEFAULTS.continuous;
  const p = pulse({ powerA: 0, powerB: 0 });
  const quiet = new Float32Array(4800);
  const g1 = new ContinuousGen(SR);
  g1.fill(quiet, 2400, p, s);
  g1.fill(quiet, 2400, p, s);
  assert.equal(peak(quiet), 0);
  const loud = new Float32Array(4800);
  const g2 = new ContinuousGen(SR);
  g2.fill(loud, 2400, p, { ...s, fullVolume: true });
  g2.fill(loud, 2400, p, { ...s, fullVolume: true });
  assert.ok(peak(loud) > 0.99);
});

test('wavelets fire at the pulse frequency with the configured width', () => {
  const gen = new WaveletGen(SR, seeded());
  const s = AUDIO_DEFAULTS.wavelet; // 1000Hz carrier, 5 cycles = 240 samples
  const buf = new Float32Array(SR * 2);
  const block = new Float32Array(2400);
  for (let f = 0; f < SR; f += 1200) {
    gen.fill(block, 1200, pulse({ freqAHz: 50, freqBHz: 20 }), s);
    buf.set(block, f * 2);
  }
  const bursts = ch => ch.reduce((n, v, i) => n + (v !== 0 && (i === 0 || ch[i - 1] === 0) && ch.slice(Math.max(0, i - 50), i).every(x => x === 0) ? 1 : 0), 0);
  assert.ok(Math.abs(bursts(left(buf)) - 50) <= 1, `A bursts ${bursts(left(buf))}`);
  assert.ok(Math.abs(bursts(right(buf)) - 20) <= 1, `B bursts ${bursts(right(buf))}`);
  assert.ok(peak(left(buf)) <= 1);
  assert.equal(waveletDutyAt100Hz(s), 50);
});

test('multi-pulse bursts are charge balanced and have the configured pulse count', () => {
  const gen = new MultiPulseGen(SR, seeded(7));
  const s = { ...AUDIO_DEFAULTS.multipulse, lowFreqPulses: 4, highFreqPulses: 4 };
  const frames = 18 * 1200; // 0.45s: whole bursts at 0.1, 0.2, 0.3 and 0.4s
  const buf = new Float32Array(frames * 2);
  const block = new Float32Array(2400);
  for (let f = 0; f < frames; f += 1200) {
    gen.fill(block, 1200, pulse({ freqAHz: 10, freqBHz: 10, ampA: 0.8 }), s);
    buf.set(block, f * 2);
  }
  const a = left(buf);
  near(a.reduce((sum, v) => sum + v, 0), 0, 1e-6); // every positive half has an equal negative half
  near(peak(a), 0.8, 1e-6); // stored as Float32
  // 4 bursts at 10Hz, 4 pulses each, 2 halves per pulse = 32 half-pulses
  const halves = a.reduce((n, v, i) => n + (v !== 0 && (i === 0 || a[i - 1] !== v) ? 1 : 0), 0);
  assert.equal(halves, 32);
});

test('multi-pulse burst estimates match Howl', () => {
  const s = AUDIO_DEFAULTS.multipulse;
  assert.deepEqual(estimateBurst(10, s), { dutyCyclePercent: 11, burstFits: true });
  const e100 = estimateBurst(100, s);
  assert.equal(e100.dutyCyclePercent, 36);
  assert.equal(e100.burstFits, true);
  assert.equal(estimateBurst(100, { ...s, highFreqPulses: 15, pulseWidth: 1000 }).burstFits, false);
});

test('the engine fades in over half a second and out when playback stops', () => {
  const core = new AudioCore(SR);
  core.configure('CONTINUOUS', AUDIO_DEFAULTS);
  core.playing = true;
  const [L] = renderCore(core, pulse(), 1);
  assert.ok(peak(L.subarray(0, SR * 0.05)) < 0.15, 'quiet at the start');
  assert.ok(peak(L.subarray(SR * 0.6, SR)) > 0.99, 'full after the fade');
  core.playing = false;
  const [L2] = renderCore(core, pulse(), 0.7);
  assert.equal(peak(L2.subarray(SR * 0.55)), 0, 'silent after fading out');
});

test('the engine goes silent when pulses stop arriving, and at once on stopNow', () => {
  const core = new AudioCore(SR);
  core.configure('CONTINUOUS', AUDIO_DEFAULTS);
  core.playing = true;
  renderCore(core, pulse(), 1);
  // No more pulses: holds briefly, then silence after STARVED_BLOCKS
  const frames = Math.round((STARVED_BLOCKS + 4) * BLOCK_SECONDS * SR);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) core.render(L.subarray(i, i + 128), R.subarray(i, i + 128));
  assert.ok(peak(L.subarray(0, 480)) > 0.9, 'holds the last pulse briefly');
  assert.equal(peak(L.subarray(frames - Math.round(2 * BLOCK_SECONDS * SR))), 0, 'silent once starved');

  renderCore(core, pulse(), 0.3);
  core.stopNow();
  const [L3] = renderCore(core, pulse(), 0.1);
  assert.equal(peak(L3), 0, 'silent straight after stopNow');
});

test('every output type stays within -1..1 at full volume', () => {
  for (const type of ['CONTINUOUS', 'WAVELET', 'MULTIPULSE']) {
    const core = new AudioCore(SR, seeded(3));
    const settings = structuredClone(AUDIO_DEFAULTS);
    for (const k of Object.keys(settings)) settings[k].fullVolume = true;
    core.configure(type, settings);
    core.playing = true;
    const [L, R] = renderCore(core, pulse({ ampA: 1, ampB: 1, freqAHz: 80, freqBHz: 95 }), 1);
    assert.ok(peak(L) <= 1 && peak(R) <= 1, type);
    assert.ok(peak(L) > 0.5, `${type} should play`);
  }
});
