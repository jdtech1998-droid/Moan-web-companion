import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALIBRATION_DEFAULTS, applyCalibration, frequencyScale } from '../js/calibration.js';

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);
const pulse = { ampA: 0.8, ampB: 0.6, freqA: 0.25, freqB: 0.75 };

test('default calibration leaves pulses unchanged', () => {
  assert.deepEqual(applyCalibration(pulse, CALIBRATION_DEFAULTS), pulse);
});

test('power balance lowers only the channel it leans away from', () => {
  const towardsB = applyCalibration(pulse, { ...CALIBRATION_DEFAULTS, amplitudeBalance: 0.75 });
  near(towardsB.ampA, 0.4); near(towardsB.ampB, 0.6);
  const towardsA = applyCalibration(pulse, { ...CALIBRATION_DEFAULTS, amplitudeBalance: 0 });
  near(towardsA.ampA, 0.8); near(towardsA.ampB, 0);
});

test('frequency balance lowers high frequencies below 0.5 and low ones above', () => {
  near(frequencyScale(0.5, 0.3), 1);
  near(frequencyScale(0, 1), 0); near(frequencyScale(0, 0), 1);
  near(frequencyScale(1, 0), 0); near(frequencyScale(1, 1), 1);
  near(frequencyScale(0.25, 0.5), 0.75);
});

test('amplitude scaling scales both channels, frequencies pass through', () => {
  const p = applyCalibration(pulse, { ...CALIBRATION_DEFAULTS, amplitudeScaling: 0.5 });
  near(p.ampA, 0.4); near(p.ampB, 0.3);
  assert.equal(p.freqA, pulse.freqA); assert.equal(p.freqB, pulse.freqB);
});

test('no calibration setting can raise power', () => {
  const values = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  for (const amplitudeBalance of values) for (const frequencyBalanceA of values) for (const amplitudeScaling of values) {
    for (const freq of values) {
      const cal = { ...CALIBRATION_DEFAULTS, amplitudeBalance, frequencyBalanceA, frequencyBalanceB: frequencyBalanceA, amplitudeScaling };
      const p = applyCalibration({ ampA: 1, ampB: 1, freqA: freq, freqB: freq }, cal);
      assert.ok(p.ampA >= 0 && p.ampA <= 1 && p.ampB >= 0 && p.ampB <= 1, JSON.stringify(cal));
    }
  }
});
