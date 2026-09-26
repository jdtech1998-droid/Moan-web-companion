// Ported from Howl's PawPrintsProtocolTest.kt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passthroughConfig, parsePawFrame, PAW_BUTTONS, PawButtonTracker, PAW_DEFAULTS, actionsFor } from '../js/pawprints.js';

const bytes = (...values) => new Uint8Array(values);
const mask = id => PAW_BUTTONS.find(b => b.id === id).mask;

test('the passthrough config is 17 bytes of header, colour, mode and padding', () => {
  const config = passthroughConfig(0x06);
  assert.equal(config.length, 17);
  assert.deepEqual([...config.slice(0, 3)], [0x50, 0x06, 0xd0]);
  assert.ok(config.slice(3).every(b => b === 0));
});

test('parses a physical frame', () => {
  // seq 44, nothing pressed, accel 1, angles X 3 / Y -2 / Z 64, external voltage 67
  assert.deepEqual(parsePawFrame(bytes(0xd0, 0x06, 0x2c, 0x00, 0x01, 0x03, 0xfe, 0x40, 0x43)), {
    type: 'physical', indicatorColor: 6, sequence: 44, buttons: 0, acceleration: 1,
    angleX: 3, angleY: -2, angleZ: 64, externalVoltage: 67,
  });
});

test('parses a status frame with battery, clamping implausible readings', () => {
  assert.deepEqual(parsePawFrame(bytes(0x51, 0x06, 0x03, 0x55)), { type: 'status', indicatorColor: 6, battery: 85 });
  assert.equal(parsePawFrame(bytes(0x51, 0x06, 0x03, 0xff)).battery, 100);
});

test('ignores short or unknown frames', () => {
  assert.equal(parsePawFrame(bytes()), null);
  assert.equal(parsePawFrame(bytes(0xd0, 0x06, 0x2c)), null);
  assert.equal(parsePawFrame(bytes(0x51, 0x06)), null);
  assert.equal(parsePawFrame(bytes(0x5a, 0x06, 0x01, 0x80)), null);
});

test('button corners are distinct bits', () => {
  assert.deepEqual(new Set(PAW_BUTTONS.map(b => b.mask)), new Set([0x01, 0x02, 0x04]));
});

test('a button held while connecting is not a press', () => {
  const tracker = new PawButtonTracker();
  assert.deepEqual(tracker.update(mask('right')), []);
  assert.deepEqual(tracker.update(mask('right')), []);
  assert.deepEqual(tracker.update(0), []);
  assert.deepEqual(tracker.update(mask('right')), ['right']);
});

test('a held button only presses once', () => {
  const tracker = new PawButtonTracker();
  tracker.update(0);
  assert.deepEqual(tracker.update(mask('top')), ['top']);
  assert.deepEqual(tracker.update(mask('top')), []);
  assert.deepEqual(tracker.update(mask('top')), []);
  assert.deepEqual(tracker.update(0), []);
  assert.deepEqual(tracker.update(mask('top')), ['top']);
});

test('reads each corner independently and combinations', () => {
  const tracker = new PawButtonTracker();
  tracker.update(0);
  assert.deepEqual(tracker.update(0x02), ['left']);
  // Right goes down while left is still held: only right is new
  assert.deepEqual(tracker.update(0x03), ['right']);
  tracker.update(0);
  assert.deepEqual(new Set(tracker.update(0x05)), new Set(['right', 'top']));
});

test('reset disarms until the buttons are released again', () => {
  const tracker = new PawButtonTracker();
  tracker.update(0);
  tracker.reset();
  assert.deepEqual(tracker.update(mask('left')), []);
  tracker.update(0);
  assert.deepEqual(tracker.update(mask('left')), ['left']);
});

test('default button actions', () => {
  assert.equal(PAW_DEFAULTS.top, 'E_STOP');
  assert.equal(PAW_DEFAULTS.right, 'POWER_UP');
  assert.equal(PAW_DEFAULTS.left, 'POWER_DOWN');
});

test('an emergency stop wins over other buttons pressed with it', () => {
  assert.deepEqual(actionsFor(PAW_DEFAULTS, ['right', 'top']), ['E_STOP']);
});

test('buttons set to nothing do nothing', () => {
  const settings = { ...PAW_DEFAULTS, left: 'NONE' };
  assert.deepEqual(actionsFor(settings, ['left']), []);
  assert.deepEqual(actionsFor(settings, ['left', 'right']), ['POWER_UP']);
});
