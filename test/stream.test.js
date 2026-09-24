import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteStream, STARVED_HOLD_MS, STARVED_FADE_MS } from '../js/stream.js';

const samples = (amp, hz = 55, n = 4) => Array(n).fill({ amp, hz });

/** Feeds `batches` Driver batches (A then B, 4 pulses each). */
function feed(stream, batches, ampA = 1, ampB = 0.5) {
  for (let i = 0; i < batches; i++) {
    stream.addChannel(0, samples(ampA));
    stream.addChannel(1, samples(ampB));
  }
}

test('stays silent until the prebuffer fills', () => {
  const s = new RemoteStream();
  feed(s, 2); // 8 pulses in, 6 held back by the smoother's 7-pulse window -> 2 buffered
  assert.equal(s.next(0).ampA, 0);
  feed(s, 2); // 10 buffered
  const p = s.next(25);
  assert.equal(p.ampA, 1);
  assert.equal(p.ampB, 0.5);
  assert.equal(p.freqA, 0.5); // 55Hz is the middle of the 10-100Hz wire span
});

test('pairs A with B, and plays an unpartnered A on its own', () => {
  const s = new RemoteStream({ prebuffer: 1 });
  for (let i = 0; i < 3; i++) s.addChannel(0, samples(0.8)); // A, A (first emitted alone), A
  s.addChannel(1, samples(0.2));
  // 12 pulses emitted (two lone A batches + one pair), minus 6 held by the smoother
  assert.equal(s.buffer.length, 6);
  assert.ok(s.buffer.every(p => p.ampA === 0.8));
});

test('fades out after the hold time when starved', () => {
  const s = new RemoteStream({ prebuffer: 1 });
  feed(s, 3);
  let t = 0;
  while (s.buffer.length) s.next((t += 25));
  const last = t;
  assert.equal(s.next(last + STARVED_HOLD_MS).ampA, 1);
  const mid = s.next(last + STARVED_HOLD_MS + STARVED_FADE_MS / 2).ampA;
  assert.ok(mid > 0.4 && mid < 0.6, `mid fade ${mid}`);
  assert.equal(s.next(last + STARVED_HOLD_MS + STARVED_FADE_MS + 1).ampA, 0);
});

test('silence() drops buffered pulses at once', () => {
  const s = new RemoteStream({ prebuffer: 1 });
  feed(s, 3);
  s.next(0);
  s.silence();
  assert.equal(s.next(25).ampA, 0);
  assert.equal(s.buffer.length, 0);
});

test('buffer never grows past its size', () => {
  const s = new RemoteStream();
  feed(s, 20);
  assert.equal(s.buffer.length, 16);
});
