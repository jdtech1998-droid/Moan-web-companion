import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALIBRATION_DEFAULTS, TWEAK_DEFAULTS, applyCalibration, applyTweaks, frequencyScale } from '../js/calibration.js';

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

test('default tweaks leave pulses unchanged', () => {
  assert.deepEqual(applyTweaks(pulse, TWEAK_DEFAULTS), pulse);
});

test('tweaks invert, then apply feel, then shift frequency, as Howl does', () => {
  // Invert 0.25 -> 0.75, feel 2 -> sqrt(0.75), then +0.1
  const p = applyTweaks(pulse, { ...TWEAK_DEFAULTS, frequencyInvertA: true, frequencyFeelA: 2, frequencyAdjustA: 0.1 });
  near(p.freqA, Math.sqrt(0.75) + 0.1);
  // Shifts clamp at the ends
  near(applyTweaks(pulse, { ...TWEAK_DEFAULTS, frequencyAdjustB: 1 }).freqB, 1);
  near(applyTweaks(pulse, { ...TWEAK_DEFAULTS, frequencyAdjustB: -1 }).freqB, 0);
});

test('amplitude feel lifts or lowers quiet pulses but keeps silence silent and full at full', () => {
  near(applyTweaks({ ...pulse, ampA: 0.25 }, { ...TWEAK_DEFAULTS, amplitudeFeelA: 2 }).ampA, 0.5);
  near(applyTweaks({ ...pulse, ampA: 0.25 }, { ...TWEAK_DEFAULTS, amplitudeFeelA: 0.5 }).ampA, 0.0625);
  for (const f of [0.5, 1, 2]) {
    assert.equal(applyTweaks({ ...pulse, ampA: 0 }, { ...TWEAK_DEFAULTS, amplitudeFeelA: f }).ampA, 0);
    near(applyTweaks({ ...pulse, ampA: 1 }, { ...TWEAK_DEFAULTS, amplitudeFeelA: f }).ampA, 1);
  }
});

test('tweaks and calibration together stay within 0-1', () => {
  for (const amplitudeFeelA of [0.5, 1, 2]) for (const frequencyAdjustA of [-1, -0.3, 0, 0.3, 1]) for (const inv of [false, true]) {
    for (const v of [0, 0.1, 0.5, 0.9, 1]) {
      const tw = { ...TWEAK_DEFAULTS, amplitudeFeelA, frequencyFeelA: amplitudeFeelA, frequencyAdjustA, frequencyInvertA: inv };
      const p = applyCalibration(applyTweaks({ ampA: v, ampB: v, freqA: v, freqB: v }, tw), { ...CALIBRATION_DEFAULTS, frequencyBalanceA: 0.2 });
      for (const k of ['ampA', 'ampB', 'freqA', 'freqB']) assert.ok(p[k] >= 0 && p[k] <= 1, `${k}=${p[k]}`);
    }
  }
});
