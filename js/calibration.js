// Output calibration, ported from Howl's Calibration (OutputBase.kt) and its calibration_ preference.
// Applied only to pulses going to the local Coyote, as Howl applies it in the device output. Every factor
// is at most 1, so calibration can only lower power, never raise it.

export const CALIBRATION_DEFAULTS = {
  amplitudeScaling: 1.0,
  amplitudeBalance: 0.5, // "Power balance": above 0.5 lowers A, below lowers B
  frequencyBalanceA: 0.5, // below 0.5 lowers high frequencies, above lowers low ones
  frequencyBalanceB: 0.5,
  positionalEffectCurve: 0.5, // shared by funscripts and activities: 1.0 = linear panning, 0.5 = constant power
};

const clamp01 = v => Math.min(Math.max(v, 0), 1);

/** Howl's calculateFrequencyScale: how much a frequency balance keeps of a pulse at frequency `freq` (0-1). */
export function frequencyScale(balance, freq) {
  const reduction = 2 * Math.abs(balance - 0.5);
  const target = balance < 0.5 ? freq : 1 - freq;
  return 1 - reduction * target;
}

/**
 * Applies calibration to one pulse (amplitudes and frequencies 0-1). Frequencies pass through unchanged.
 * @param {{ampA:number, ampB:number, freqA:number, freqB:number}} p
 * @param {typeof CALIBRATION_DEFAULTS} cal
 */
export function applyCalibration(p, cal) {
  const ampAScale = 1 - Math.max(0, cal.amplitudeBalance - 0.5) * 2;
  const ampBScale = 1 - Math.max(0, 0.5 - cal.amplitudeBalance) * 2;
  return {
    ...p,
    ampA: clamp01(p.ampA * ampAScale * frequencyScale(cal.frequencyBalanceA, p.freqA) * cal.amplitudeScaling),
    ampB: clamp01(p.ampB * ampBScale * frequencyScale(cal.frequencyBalanceB, p.freqB) * cal.amplitudeScaling),
  };
}
