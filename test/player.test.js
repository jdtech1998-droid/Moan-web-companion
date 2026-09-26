import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FunscriptAxis, FunscriptSource, BadFileError, positionalEffect } from '../js/funscript.js';
import { readHWL, writeHWL, HwlSource, Player, Recorder } from '../js/player.js';
import { CALIBRATION_DEFAULTS } from '../js/calibration.js';

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

// A stroke every half second between 10 and 90
const strokes = n => Array.from({ length: n }, (_, i) => ({ at: i * 500, pos: i % 2 ? 90 : 10 }));

test('an axis passes through its points and never overshoots between them', () => {
  const axis = new FunscriptAxis('L0', strokes(9), 'off');
  near(axis.positionAt(0), 0.1);
  near(axis.positionAt(0.5), 0.9);
  for (let t = 0; t <= 4; t += 0.01) {
    const p = axis.positionAt(t);
    assert.ok(p >= 0.1 - 1e-9 && p <= 0.9 + 1e-9, `t=${t}: ${p}`);
  }
  // Before the first and after the last point it holds still
  near(axis.positionAt(-1), 0.1);
  near(axis.positionAt(99), axis.positions.at(-1));
});

test('full normalisation stretches a limited script to 0-1', () => {
  const axis = new FunscriptAxis('L0', strokes(5), 'full');
  near(axis.positionAt(0), 0);
  near(axis.positionAt(0.5), 1);
});

test('duplicate and unsorted actions are cleaned up; too few actions are rejected', () => {
  const axis = new FunscriptAxis('L0', [{ at: 1000, pos: 100 }, { at: 0, pos: 0 }, { at: 1000, pos: 50 }], 'off');
  assert.deepEqual(axis.times, [0, 1]);
  assert.throws(() => new FunscriptAxis('L0', [{ at: 0, pos: 0 }], 'off'), BadFileError);
});

test('a moving script gives output, a still one gives silence', () => {
  const moving = new FunscriptSource(JSON.stringify({ actions: strokes(21) }), 'moving.funscript');
  const p = moving.pulseAt(5);
  assert.ok(p.ampA + p.ampB > 0.1, `amp ${p.ampA} + ${p.ampB}`);
  for (const v of Object.values(p)) assert.ok(v >= 0 && v <= 1);

  const still = new FunscriptSource(JSON.stringify({ actions: [{ at: 0, pos: 20 }, { at: 1000, pos: 80 }, { at: 10000, pos: 80 }] }), 'still.funscript');
  const q = still.pulseAt(8);
  assert.equal(q.ampA, 0);
  assert.equal(q.ampB, 0);
});

test('extra axes load, unsupported ones are skipped, and duration covers every axis', () => {
  const src = new FunscriptSource(JSON.stringify({
    actions: strokes(5),
    axes: [{ id: 'R0', actions: strokes(9) }, { id: 'X9', actions: strokes(5) }],
  }), 'multi.funscript');
  assert.deepEqual(src.axisIds, ['L0', 'R0']);
  assert.equal(src.info, '2 axis funscript');
  near(src.duration, 4);
});

test('invalid funscripts are rejected', () => {
  assert.throws(() => new FunscriptSource('not json', 'x'), BadFileError);
  assert.throws(() => new FunscriptSource('{"foo":1}', 'x'), BadFileError);
});

test('the positional effect pans power from A at the bottom to B at the top', () => {
  const [a0, b0] = positionalEffect(1, 0, 1, CALIBRATION_DEFAULTS.positionalEffectCurve);
  near(a0, 1); near(b0, 0);
  const [a1, b1] = positionalEffect(1, 1, 1, 0.5);
  near(a1, 0); near(b1, 1);
  const [am, bm] = positionalEffect(1, 0.5, 1, 0.5);
  near(am, Math.SQRT1_2); near(bm, Math.SQRT1_2);
  // Strength 0 keeps both channels equal wherever the stroke is
  const [as, bs] = positionalEffect(1, 0, 0, 0.5);
  near(as, bs);
});

test('HWL round-trips and interpolates between pulses', () => {
  const pulses = [{ ampA: 0, ampB: 1, freqA: 0.25, freqB: 0.5 }, { ampA: 1, ampB: 0, freqA: 0.75, freqB: 0.5 }];
  const back = readHWL(writeHWL(pulses));
  assert.deepEqual(back, pulses);
  const src = new HwlSource(back, 'x.hwl');
  near(src.duration, 0.05);
  const mid = src.pulseAt(0.0125);
  near(mid.ampA, 0.5); near(mid.freqA, 0.5);
  assert.throws(() => readHWL(new TextEncoder().encode('NOPE').buffer), BadFileError);
  assert.throws(() => readHWL(new TextEncoder().encode('YEAHBOI!abc').buffer), BadFileError);
});

test('the player stops at the end of a funscript and loops an HWL file', () => {
  const player = new Player();
  player.load(new FunscriptSource(JSON.stringify({ actions: strokes(3) }), 's.funscript')); // 1s long
  for (let i = 0; i < 60 && !player.ended; i++) player.next(0.025);
  assert.equal(player.ended, true);

  const hwl = new Player();
  hwl.load(new HwlSource(Array.from({ length: 20 }, () => ({ ampA: 1, ampB: 1, freqA: 0, freqB: 0 })), 'h.hwl')); // 0.5s
  for (let i = 0; i < 100; i++) hwl.next(0.025);
  assert.equal(hwl.ended, false);
  assert.ok(hwl.position <= 0.55, `position ${hwl.position}`);
});

test('playback speed and seeking', () => {
  const player = new Player();
  player.load(new FunscriptSource(JSON.stringify({ actions: strokes(21) }), 's.funscript'));
  player.speed = 2;
  for (let i = 0; i < 40; i++) player.next(0.025);
  near(player.position, 2);
  player.seek(99);
  near(player.position, 10);
  player.seek(-5);
  near(player.position, 0);
});

test('the recorder keeps the last 2 minutes, or only what is recorded in record mode', () => {
  const r = new Recorder();
  const p = { ampA: 0, ampB: 0, freqA: 0, freqB: 0 };
  for (let i = 0; i < 130 * 40; i++) r.add(p);
  near(r.duration, 120);
  r.setRecordMode(true);
  r.add(p);
  assert.equal(r.duration, 0);
  r.recording = true;
  for (let i = 0; i < 40; i++) r.add(p);
  near(r.duration, 1);
});
