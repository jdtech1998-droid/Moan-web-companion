import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePower, decodePower, frequencyToXY, amplitudeToZ, encodeWaveform, Coyote2 } from '../js/coyote2.js';

const unpack = b => b[0] | (b[1] << 8) | (b[2] << 16);

test('power is packed as A in bits 21-11 and B in bits 10-0, times 7', () => {
  const packed = unpack(encodePower(20, 3));
  assert.equal(packed >> 11, 140);
  assert.equal(packed & 0x7ff, 21);
  assert.deepEqual(decodePower(encodePower(20, 3)), [20, 3]);
  // 200 x 7 = 1400 fits; anything above 2047 would be clamped
  assert.deepEqual(decodePower(encodePower(200, 200)), [200, 200]);
  assert.equal(unpack(encodePower(400, 0)) >> 11, 2047);
  assert.equal(decodePower(Uint8Array.of(1, 2)), null);
});

test('frequency maps to X ms on and Y ms off, as Howl computes it', () => {
  assert.deepEqual(frequencyToXY(100), [2, 8]); // x = round(sqrt(0.01) * 15) = 2
  assert.deepEqual(frequencyToXY(10), [5, 95]);
  assert.deepEqual(frequencyToXY(1), [15, 985]);
  for (const hz of [1, 5, 10, 33, 100, 200]) {
    const [x, y] = frequencyToXY(hz);
    assert.ok(x >= 1 && x <= 31 && y >= 0 && y <= 1023);
    assert.ok(Math.abs(1000 / (x + y) - hz) / hz < 0.1, `${hz}Hz -> ${1000 / (x + y)}Hz`);
  }
});

test('amplitude maps to a pulse width of at most 20', () => {
  assert.equal(amplitudeToZ(0), 0);
  assert.equal(amplitudeToZ(0.5), 10);
  assert.equal(amplitudeToZ(1), 20);
  assert.equal(amplitudeToZ(1.5), 20);
});

test('waveforms pack Z in bits 19-15, Y in 14-5, X in 4-0, clamped', () => {
  const packed = unpack(encodeWaveform(2, 8, 20));
  assert.equal(packed & 0x1f, 2);
  assert.equal((packed >> 5) & 0x3ff, 8);
  assert.equal((packed >> 15) & 0x1f, 20);
  assert.equal(unpack(encodeWaveform(99, 5000, 99)), (31 << 15) | (1023 << 5) | 31);
});

test('a power change on the box is reported once, and a level over the limit is written back down', async () => {
  const writes = [];
  const char = name => ({ writeValueWithResponse: async b => writes.push([name, [...b]]), writeValueWithoutResponse: async b => writes.push([name, [...b]]) });
  const c = new Coyote2();
  c.ready = true;
  c.chars = { power: char('power'), patternA: char('A'), patternB: char('B') };
  const reported = [];
  c.onDevicePower = (a, b) => reported.push([a, b]);
  const pulse = { freqAHz: 50, ampA: 0.5, freqBHz: 50, ampB: 0.5 };

  await c.sendPulses(10, 10, [pulse, pulse, pulse, pulse]);
  assert.deepEqual(writes.map(w => w[0]), ['power', 'A']);
  c.handlePower(encodePower(10, 10)); // the box echoing our own write
  assert.deepEqual(reported, []);
  c.handlePower(encodePower(90, 10)); // the box's button pushed A to 90
  assert.deepEqual(reported, [[90, 10]]);
  writes.length = 0;
  await c.sendPulses(70, 10, [pulse, pulse, pulse, pulse]); // the page clamped it to its limit of 70
  assert.deepEqual(decodePower(Uint8Array.from(writes[0][1])), [70, 10]);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(writes.at(-1)[0], 'B'); // channel B follows 50ms after A
  clearTimeout(c.interleaveTimer);
});
