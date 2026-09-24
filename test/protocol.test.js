import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelEncoder, decodeChannelHex, frequencyHzToCoyote, coyoteToFrequencyHz, parseCommand, cmd,
  messageFrame, urlWithTid, describeClose, buildB0, buildBF, parseB1, wireHzToNormalized, normalizedToWireHz,
} from '../js/protocol.js';

test('frequency bytes follow the Coyote period encoding', () => {
  assert.equal(frequencyHzToCoyote(100), 10); // 10ms
  assert.equal(frequencyHzToCoyote(10), 100); // 100ms
  assert.equal(frequencyHzToCoyote(5), 120); // 200ms -> (200-100)/5+100
  assert.equal(frequencyHzToCoyote(1), 240); // 1000ms -> (1000-600)/10+200
  assert.equal(frequencyHzToCoyote(1000), 10); // out of range falls back to 10, as on Android
  assert.equal(coyoteToFrequencyHz(10), 100);
  assert.equal(coyoteToFrequencyHz(100), 10);
  assert.equal(coyoteToFrequencyHz(120), 5);
  assert.equal(coyoteToFrequencyHz(240), 1);
});

test('channel packets round-trip through hex', () => {
  const enc = new ChannelEncoder();
  const hex = enc.encode([{ hz: 100, amp: 0 }, { hz: 50, amp: 0.5 }, { hz: 20, amp: 1 }, { hz: 10, amp: 0.25 }]);
  assert.equal(hex, '0A14326400326419');
  const samples = decodeChannelHex(hex);
  assert.deepEqual(samples.map(s => Math.round(s.hz)), [100, 50, 20, 10]);
  assert.deepEqual(samples.map(s => s.amp), [0, 0.5, 1, 0.25]);
});

test('frequency error carry averages to the true frequency', () => {
  const enc = new ChannelEncoder();
  const bytes = [];
  for (let n = 0; n < 25; n++) {
    const hex = enc.encode(Array(4).fill({ hz: 1000 / 12.5, amp: 1 }));
    for (let i = 0; i < 4; i++) bytes.push(parseInt(hex.substr(i * 2, 2), 16));
  }
  const mean = bytes.reduce((a, b) => a + b) / bytes.length;
  assert.ok(Math.abs(mean - 12.5) < 0.05, `mean byte ${mean}`);
  assert.ok(bytes.every(b => b === 12 || b === 13));
});

test('decoder skips malformed packets', () => {
  assert.equal(decodeChannelHex('XYZ, 0A0A0A0A64646464 ,123').length, 4);
  assert.equal(decodeChannelHex('').length, 0);
});

test('commands match the Android wire strings', () => {
  assert.equal(cmd.strength(0, 2, 50), 'strength-1+2+50');
  assert.equal(cmd.strength(1, 1, 5), 'strength-2+1+5');
  assert.equal(cmd.pulse('A', '0A0A0A0A64646464'), 'pulse-A:[0A0A0A0A64646464]');
  assert.equal(cmd.max(1, 80), 'howl-max-B+80');
  assert.equal(cmd.power(0, 0), 'howl-power-A+0');
  assert.equal(cmd.feedback(3), 'feedback-3');
});

test('commands parse back', () => {
  assert.deepEqual(parseCommand('strength-1+2+50'), { type: 'strength', channel: 0, mode: 2, value: 50 });
  assert.deepEqual(parseCommand('strength-2-0-7'), { type: 'strength', channel: 1, mode: 0, value: 7 });
  assert.equal(parseCommand('strength-3+2+50'), null);
  assert.deepEqual(parseCommand('howl-max-A+120'), { type: 'max', channel: 0, value: 120 });
  assert.deepEqual(parseCommand('howl-power-B+0'), { type: 'power', channel: 1, value: 0 });
  assert.deepEqual(parseCommand('feedback-9'), { type: 'feedback', index: 9 });
  assert.equal(parseCommand('howl-estop').type, 'riderEstop');
  assert.equal(parseCommand('howl-driver-estop').type, 'driverEstop');
  assert.equal(parseCommand('howl-stream-end').type, 'streamEnd');
  const pulse = parseCommand('pulse-B:[0A0A0A0A64646464]');
  assert.equal(pulse.channel, 1);
  assert.equal(pulse.samples.length, 4);
  assert.equal(parseCommand('nonsense'), null);
});

test('relay frames and URLs', () => {
  assert.equal(messageFrame(null, 'howl-estop'), '{"type":"message","data":{"cmd":"howl-estop"}}');
  assert.equal(messageFrame('ab12cd34', 'feedback-1'), '{"type":"message","clientId":"ab12cd34","data":{"cmd":"feedback-1"}}');
  assert.equal(urlWithTid('wss://x/v4', 'ab12cd34'), 'wss://x/v4?tid=ab12cd34');
  assert.equal(urlWithTid('wss://x/v4?a=1', 'ab'), 'wss://x/v4?a=1&tid=ab');
  assert.equal(describeClose(4001), 'Rider not found - check the code');
  assert.equal(describeClose(1000), null);
});

test('wire span mapping', () => {
  assert.equal(normalizedToWireHz(0), 10);
  assert.equal(normalizedToWireHz(1), 100);
  assert.equal(wireHzToNormalized(55), 0.5);
  assert.equal(wireHzToNormalized(500), 1);
});

test('Coyote 3 packets', () => {
  const pulses = Array(4).fill({ freqAHz: 100, ampA: 0.5, freqBHz: 10, ampB: 1 });
  const b0 = buildB0(30, 250, true, pulses);
  assert.equal(b0.length, 20);
  assert.deepEqual([...b0.slice(0, 4)], [0xb0, 0x1f, 30, 200]);
  assert.deepEqual([...b0.slice(4, 8)], [10, 10, 10, 10]);
  assert.deepEqual([...b0.slice(8, 12)], [50, 50, 50, 50]);
  assert.deepEqual([...b0.slice(12, 16)], [100, 100, 100, 100]);
  assert.deepEqual([...b0.slice(16, 20)], [100, 100, 100, 100]);
  assert.equal(buildB0(0, 0, false, pulses)[1], 0);
  assert.deepEqual([...buildBF(70, 0)], [0xbf, 70, 0, 200, 200, 0, 0]);
  assert.deepEqual(parseB1(Uint8Array.from([0xb1, 0, 12, 34])), { fromDevice: true, powerA: 12, powerB: 34 });
  assert.equal(parseB1(Uint8Array.from([0xb0, 0, 0, 0])), null);
});
