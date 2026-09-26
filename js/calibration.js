// Output tweaks and calibration, ported from Howl's Tweaks and Calibration (OutputBase.kt receivePulse) and its
// calibration_ preference. Applied only to pulses going to the local Coyote, as Howl applies them in the device
// output: tweaks first, then calibration. Every calibration factor is at most 1, so calibration can only lower
// power. Tweaks can raise quiet pulses (amplitude feel above 1), but never above full strength.

export const TWEAK_DEFAULTS = {
  amplitudeFeelA: 1.0,
  amplitudeFeelB: 1.0,
  frequencyFeelA: 1.0,
  frequencyFeelB: 1.0,
  frequencyInvertA: false,
  frequencyInvertB: false,
  frequencyAdjustA: 0.0,
  frequencyAdjustB: 0.0,
};

export const CALIBRATION_DEFAULTS = {
  amplitudeScaling: 1.0,
  amplitudeBalance: 0.5, // "Power balance": above 0.5 lowers A, below lowers B
  frequencyBalanceA: 0.5, // below 0.5 lowers high frequencies, above lowers low ones
  frequencyBalanceB: 0.5,
  positionalEffectCurve: 0.5, // shared by funscripts and activities: 1.0 = linear panning, 0.5 = constant power
};

const clamp01 = v => Math.min(Math.max(v, 0), 1);

/** Howl's calculateFeelAdjustment: value^(1/feel), so a feel above 1 lifts values and below 1 lowers them. */
const feel = (value, f) => clamp01(value ** (1 / f));

/**
 * Applies tweaks to one pulse, in Howl's order: invert frequencies, then feel curves, then flat frequency adjust.
 * @param {{ampA:number, ampB:number, freqA:number, freqB:number}} p
 * @param {typeof TWEAK_DEFAULTS} tw
 */
export function applyTweaks(p, tw) {
  const freqA = feel(tw.frequencyInvertA ? 1 - p.freqA : p.freqA, tw.frequencyFeelA);
  const freqB = feel(tw.frequencyInvertB ? 1 - p.freqB : p.freqB, tw.frequencyFeelB);
  return {
    ...p,
    ampA: feel(p.ampA, tw.amplitudeFeelA),
    ampB: feel(p.ampB, tw.amplitudeFeelB),
    freqA: clamp01(freqA + tw.frequencyAdjustA),
    freqB: clamp01(freqB + tw.frequencyAdjustB),
  };
}

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
