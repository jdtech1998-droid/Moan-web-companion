import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Manual, angleToFrequency } from '../js/manual.js';

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

test('frequency is 1 at the top of the pad, 0 at the bottom and 0.5 at the sides', () => {
  near(angleToFrequency(Math.atan2(-1, 0)), 1);
  near(angleToFrequency(Math.atan2(1, 0)), 0);
  near(angleToFrequency(Math.atan2(0, 1)), 0.5);
  near(angleToFrequency(Math.atan2(0, -1)), 0.5);
});

test('without smoothing a pad maps straight to amplitude and frequency', () => {
  const m = new Manual();
  m.smoothing = 0;
  m.setPosition(0, { x: 0, y: -0.8 }); // A: 80% up
  m.setPosition(1, { x: 0.5, y: 0 }); // B: halfway right
  const p = m.next(0.025);
  near(p.ampA, 0.8);
  near(p.freqA, 1);
  near(p.ampB, 0.5);
  near(p.freqB, 0.5);
});

test('smoothing eases towards the pad position without overshooting', () => {
  const m = new Manual();
  m.smoothing = 0.1;
  m.setPosition(0, { x: 0, y: -1 });
  const first = m.next(0.025).ampA;
  assert.ok(first > 0 && first < 1, `first step ${first}`);
  let amp = first;
  for (let i = 0; i < 200; i++) {
    const next = m.next(0.025).ampA;
    assert.ok(next >= amp - 1e-9 && next <= 1, `step ${i}: ${next}`);
    amp = next;
  }
  near(amp, 1, 1e-3);
});

test('reset silences both channels', () => {
  const m = new Manual();
  m.smoothing = 0;
  m.setPosition(0, { x: 1, y: 0 });
  m.setPosition(1, { x: 0, y: 1 });
  m.next(0.025);
  m.reset();
  const p = m.next(0.025);
  assert.equal(p.ampA, 0);
  assert.equal(p.ampB, 0);
});
