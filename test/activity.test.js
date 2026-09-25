import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timer, NiceSmoother, WaveManager, wave, SMALL_AMOUNT } from '../js/activitycore.js';
import { ActivityHost, ACTIVITY_TYPES, ACTIVITY_OPTION_DEFAULTS } from '../js/activities.js';
import { SimplexNoise } from '../js/simplex.js';

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);
const ctx = () => ({ settings: { ...ACTIVITY_OPTION_DEFAULTS }, positionalCurve: () => 0.5 });

test('a repeating timer fires once per period, a one-shot timer once', () => {
  let fired = 0;
  const t = new Timer(1, true, () => fired++);
  t.start();
  for (let i = 0; i < 400; i++) t.update(0.025); // 10 s
  assert.equal(fired, 10);
  let once = 0;
  const o = new Timer(0.5, false, () => once++);
  o.start();
  for (let i = 0; i < 100; i++) o.update(0.025);
  assert.equal(once, 1);
  assert.equal(o.state, 'finished');
});

test('a smoother eases to its target without overshooting and calls back once', () => {
  const s = new NiceSmoother(0, [0, 1]);
  let reached = 0;
  s.setTarget(0.8, 0.5, () => reached++);
  let prev = 0;
  for (let i = 0; i < 200; i++) {
    s.update(0.025);
    assert.ok(s.value >= prev - 1e-9 && s.value <= 0.8 + 1e-9, `step ${i}: ${s.value}`);
    prev = s.value;
  }
  near(s.value, 0.8);
  assert.equal(reached, 1);
});

test('waves pass through their points and wrap around the cycle', () => {
  const w = wave('tri', [[0, 0], [0.5, 1]], 'linear');
  near(w.position(0.25), 0.5);
  near(w.position(0.5), 1);
  near(w.position(0.75), 0.5);
  near(w.position(1.25), 0.5);
  const h = wave('ramp', [[0, 0, 0], [1 - SMALL_AMOUNT, 1, 0]]);
  for (let t = 0; t < 1; t += 0.01) assert.ok(h.position(t) >= 0 && h.position(t) <= 1);
});

test('a wave manager stops after the set number of cycles', () => {
  const m = new WaveManager();
  m.addWave(wave('tri', [[0, 0], [0.5, 1]], 'linear'));
  m.setSpeed(2);
  let done = false;
  m.stopAfterIterations(3, () => { done = true; });
  for (let i = 0; i < 80 && !done; i++) m.update(0.025); // 3 cycles at 2/s = 1.5 s
  assert.equal(done, true);
  near(m.currentTime, 3);
});

test('every activity runs for two minutes with valid output', () => {
  for (const type of ACTIVITY_TYPES) {
    const host = new ActivityHost(ctx(), () => ({ changeProbability: 0, excluded: [] }));
    host.setCurrent(type.id);
    let total = 0;
    for (let i = 0; i < 40 * 120; i++) {
      const p = host.next(0.025);
      for (const [k, v] of Object.entries(p)) assert.ok(v >= 0 && v <= 1, `${type.name} ${k}=${v} at ${i}`);
      total += p.ampA + p.ampB;
    }
    assert.ok(total > 0, `${type.name} was silent`);
    assert.equal(host.type.id, type.id, `${type.name} changed with probability 0`);
  }
});

test('random changes avoid excluded activities and the current one', () => {
  const excluded = ACTIVITY_TYPES.slice(1).map(t => t.id).slice(0, -1); // all but the first and last
  const host = new ActivityHost(ctx(), () => ({ changeProbability: 1, excluded }));
  host.setCurrent(ACTIVITY_TYPES[0].id);
  const seen = new Set();
  for (let i = 0; i < 40 * 600; i++) {
    host.next(0.025);
    seen.add(host.type.id);
  }
  for (const id of excluded) assert.ok(!seen.has(id), `picked excluded ${id}`);
  assert.ok(seen.has(ACTIVITY_TYPES.at(-1).id));
});

test('manual control freezes the automatic changes', () => {
  const host = new ActivityHost(ctx(), () => ({ changeProbability: 0, excluded: [] }));
  host.setCurrent('PENETRATION');
  host.instance.setManual(true);
  const speed = host.instance.waveManager.baseSpeed;
  const target = speed.target;
  for (let i = 0; i < 40 * 60; i++) host.next(0.025);
  near(speed.target, target);
});

test('simplex noise is smooth, bounded and seeded', () => {
  const n = new SimplexNoise(42);
  let prev = n.random3D(0, 0, 0);
  for (let i = 1; i < 5000; i++) {
    const v = n.random3D(i * 0.01, 0.5, 0.25);
    assert.ok(Math.abs(v) <= 1, `value ${v}`);
    assert.ok(Math.abs(v - prev) < 0.1, `jump at ${i}`);
    prev = v;
  }
  assert.equal(new SimplexNoise(5).random3D(1.1, 2.2, 3.3), new SimplexNoise(5).random3D(1.1, 2.2, 3.3));
});
