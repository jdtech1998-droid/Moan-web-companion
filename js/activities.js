// The activities on the Activity tab, ported one to one from Howl's Activity.kt.
// Controls are described as data (see the renderer in app.js) instead of Compose UI:
//   { type: 'switch', label, get, set, heading? }
//   { type: 'slider', label, min, max, step, get, set, disabled?, persist?, digits? }
//   { type: 'select', label, options: [[value, label]], get, set, disabled? }
//   { type: 'smoother', label, smoother, targetRange, rateRange?, step?, disabled? }  (no rateRange: no rate slider)
//   { type: 'buttons', buttons: [[label, onClick]], disabled? }
//   { type: 'text', text (string or function), heading?, warning? }
// `disabled` is a function (checked on every refresh); `persist` saves the page's settings after a change.

import {
  Activity, Timer, NiceSmoother, WaveManager, CyclicalWave, WaveShape, wave, SMALL_AMOUNT,
  randomInRange, randomInt, randomItem, randomBool, scaleVelocity, feelAdjustment, clamp,
  scaleBetween, engulfEffect, smoothstep, lerp,
} from './activitycore.js';
import { NoiseGenerator } from './simplex.js';

/** Persisted activity options and their defaults (Howl's Prefs.activity*). */
export const ACTIVITY_OPTION_DEFAULTS = {
  vibePulseDutyCycle: 1.0,
  vibePulseTime: 0.3,
  vibeHoldProbability: 0.25,
  chaosCycleTime: 1.0,
  luxuryHJBonusProbability: 0.7,
  luxuryHJAmplitudeJitter: 0.15,
  luxuryHJTimingJitter: 0.15,
  simplexPreset: 'PRO',
};

const manualSwitch = (activity) => ({
  type: 'switch', label: 'Manual control', heading: true,
  get: () => activity.manual, set: v => activity.setManual(v),
});

// ---- Infinite licks -------------------------------------------------------------------------------

const LICK_TYPES = [['unidirectional', 'Unidirectional'], ['bidirectional', 'Bidirectional']];
const AMP_TYPES = [['consistent', 'Consistent'], ['lick', 'Lick'], ['dip', 'Dip'], ['ramp', 'Ramp'], ['flicks', 'Flicks']];

export class LickActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.manual = false;
    const w = this.waveManager;
    w.addWave(wave('bidirectional', [[0, 0], [0.5, 1]]));
    w.addWave(wave('unidirectional', [[0, 0], [1 - SMALL_AMOUNT, 1]]));
    w.addWave(wave('consistent', [[0, 0.85], [0.5, 0.95]]));
    w.addWave(wave('lick', [[0, 0], [0.05, 0.6], [0.5, 1], [0.95, 0.6], [1 - SMALL_AMOUNT, 0]]));
    w.addWave(wave('dip', [[0, 0.9], [0.35, 0.8], [0.5, 0.6], [0.65, 0.8]]));
    w.addWave(wave('ramp', [[0, 0.4], [0.5, 0.7], [1 - SMALL_AMOUNT, 1]]));
    w.addWave(wave('flicks', [[0, 0], [0.0833, 1], [0.25, 1], [0.3333, 0], [0.4166, 1], [0.5833, 1], [0.6666, 0], [0.75, 1], [0.9166, 1]]));
    w.setSpeedJitter(0.5);
    w.setAmplitudeJitter(0.1);
    this.manager.register(w);
    this.newLick();
  }

  newLick() {
    this.lickType = randomItem(LICK_TYPES)[0];
    this.ampType = randomItem(AMP_TYPES)[0];
    this.lickStart = randomInRange([0, 1]);
    this.lickEnd = randomInRange([0, 1]);
    const distance = Math.abs(this.lickEnd - this.lickStart);
    const maxSpeed = -3 * distance + 4.5;
    const speed = randomInRange([0.3, maxSpeed]);
    const desiredTime = randomInRange([1, 5]);
    const reps = Math.max(Math.trunc(desiredTime * speed), 1);
    this.waveManager.restart();
    this.waveManager.setSpeed(speed);
    this.waveManager.stopAfterIterations(reps, () => this.newLick());
  }

  setManual(manual) {
    this.manual = manual;
    if (manual) this.waveManager.restart();
    else this.newLick();
  }

  getPulse() {
    const w = this.waveManager;
    const position = w.position(this.lickType);
    const power = w.position(this.ampType);
    const lickPosition = (this.lickEnd - this.lickStart) * position + this.lickStart;
    const amp = power * w.currentAmplitude;
    const [ampA, ampB] = this.positional(amp, lickPosition);
    return { ampA, ampB, freqA: lickPosition * 0.5 + 0.5, freqB: lickPosition * 0.52 + 0.48 };
  }

  temporaryControls() {
    const off = () => !this.manual;
    return [
      manualSwitch(this),
      { type: 'slider', label: 'Lick start point', min: 0, max: 1, step: 0.01, get: () => this.lickStart, set: v => { this.lickStart = v; }, disabled: off },
      { type: 'slider', label: 'Lick end point', min: 0, max: 1, step: 0.01, get: () => this.lickEnd, set: v => { this.lickEnd = v; }, disabled: off },
      { type: 'select', label: 'Lick type', options: LICK_TYPES, get: () => this.lickType, set: v => { this.lickType = v; }, disabled: off },
      { type: 'select', label: 'Amp type', options: AMP_TYPES, get: () => this.ampType, set: v => { this.ampType = v; }, disabled: off },
      { type: 'smoother', label: 'Average speed', smoother: this.waveManager.baseSpeed, targetRange: [0.1, 5], rateRange: [0.1, 1], disabled: off },
    ];
  }
}

// ---- Penetration ----------------------------------------------------------------------------------

const PEN_SPEED = [0.3, 3.0];
const PEN_SPEED_RATE = [0.05, 0.3];
const PEN_FEEL = [0.5, 1.0];
const PEN_FEEL_RATE = [0.05, 0.1];

export class PenetrationActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.manual = false;
    this.speedTimer = new Timer(() => randomInRange([1, 20]), true, () => this.speedChange());
    this.feelTimer = new Timer(() => randomInRange([2, 10]), true, () => this.feelChange());
    this.feel = new NiceSmoother(randomInRange(PEN_FEEL));
    const w = this.waveManager;
    w.addWave(wave('penetration', [[0, 0, 0], [0.4, 0.95, 0.2], [0.5, 0.97, 0], [0.6, 0.95, -0.2]]));
    w.setSpeedJitter(0.2);
    w.setAmplitudeJitter(0.1);
    w.setSpeed(0.5);
    this.speedChange();
    this.feelChange();
    for (const c of [this.speedTimer, this.feelTimer, this.feel, w]) this.manager.register(c);
    this.speedTimer.start();
    this.feelTimer.start();
  }

  speedChange() {
    this.waveManager.setTargetSpeed(randomInRange(PEN_SPEED), randomInRange(PEN_SPEED_RATE));
  }

  feelChange() {
    this.feel.setTarget(randomInRange(PEN_FEEL), randomInRange(PEN_FEEL_RATE));
  }

  setManual(manual) {
    this.manual = manual;
    for (const t of [this.speedTimer, this.feelTimer]) (manual ? t.pause() : t.resume());
  }

  getPulse() {
    const w = this.waveManager;
    const [position, velocity] = w.positionAndVelocity('penetration');
    const v = scaleVelocity(velocity, 0.1);
    const ampFactor = 0.8 + ((w.currentSpeed - PEN_SPEED[0]) / (PEN_SPEED[1] - PEN_SPEED[0])) * 0.2;
    return {
      freqA: feelAdjustment(position * 0.7, this.feel.value),
      freqB: feelAdjustment(v * 0.5 + position * 0.4, this.feel.value),
      ampA: position * ampFactor,
      ampB: (v * 0.6 + position * 0.4) * ampFactor,
    };
  }

  temporaryControls() {
    const off = () => !this.manual;
    return [
      manualSwitch(this),
      { type: 'smoother', label: 'Target speed', smoother: this.waveManager.baseSpeed, targetRange: PEN_SPEED, rateRange: PEN_SPEED_RATE, disabled: off },
      { type: 'smoother', label: 'Target feel exponent', smoother: this.feel, targetRange: PEN_FEEL, rateRange: PEN_FEEL_RATE, disabled: off },
    ];
  }
}

// ---- Sliding vibrator -----------------------------------------------------------------------------

const VIBE_MOVE_SPEED = [0.08, 0.2];
const VIBE_POWER = 0.9;

export class VibroActivity extends Activity {
  initialise() {
    this.manual = false;
    this.frequency = randomInRange([0, 1]);
    this.position = new NiceSmoother(randomInRange([0, 1]));
    this.pulseTracker = 0;
    this.vibeActive = false;
    this.frequencyTimer = new Timer(() => randomInRange([5, 30]), true, () => { this.frequency = randomInRange([0, 1]); });
    this.holdTimer = new Timer(() => randomInRange([1, 3]), false, () => this.newTarget());
    this.position.rate = randomInRange(VIBE_MOVE_SPEED);
    for (const c of [this.frequencyTimer, this.holdTimer, this.position]) this.manager.register(c);
    this.newTarget();
    this.frequencyTimer.start();
  }

  newTarget() {
    this.position.rate = randomInRange(VIBE_MOVE_SPEED);
    this.position.setTarget(randomInRange([0, 1]), null, () => this.targetReached());
  }

  targetReached() {
    if (Math.random() < this.ctx.settings.vibeHoldProbability) this.holdTimer.reset();
    else this.newTarget();
  }

  setManual(manual) {
    this.manual = manual;
    this.holdTimer.cancel();
    if (manual) {
      this.position.setTarget(this.position.value);
      this.frequencyTimer.cancel();
    } else {
      this.targetReached();
      this.frequencyTimer.reset();
    }
  }

  runSimulation(dt) {
    super.runSimulation(dt);
    const { vibePulseTime: pulseTime, vibePulseDutyCycle: duty } = this.ctx.settings;
    this.pulseTracker += dt;
    this.vibeActive = this.pulseTracker % pulseTime >= pulseTime * (1 - duty);
  }

  getPulse() {
    const [ampA, ampB] = this.vibeActive ? this.positional(VIBE_POWER, this.position.value) : [0, 0];
    return { ampA, ampB, freqA: this.frequency, freqB: this.frequency };
  }

  permanentControls() {
    const s = this.ctx.settings;
    const opt = (label, key, min, step) => ({ type: 'slider', label, min, max: 1, step, get: () => s[key], set: v => { s[key] = v; }, persist: true });
    return [
      opt('Hold probability', 'vibeHoldProbability', 0, 0.05),
      opt('Pulse duty cycle', 'vibePulseDutyCycle', 0.1, 0.05),
      opt('Pulse time', 'vibePulseTime', 0.1, 0.05),
    ];
  }

  temporaryControls() {
    const off = () => !this.manual;
    return [
      manualSwitch(this),
      { type: 'smoother', label: 'Target position', smoother: this.position, targetRange: [0, 1], rateRange: [0.05, 0.5], disabled: off },
      { type: 'slider', label: 'Frequency', min: 0, max: 1, step: 0.01, get: () => this.frequency, set: v => { this.frequency = v; }, disabled: off },
    ];
  }
}

// ---- Milkmaster 3000 ------------------------------------------------------------------------------

export class MilkerActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.stage = 'womp';
    this.reverseWomp = false;
    this.buzzTimer = new Timer(() => randomInRange([6, 12]), false, () => this.wompStart());
    this.waveManager.addWave(wave('womp', [[0, 1, 0], [1 - SMALL_AMOUNT, 0, 0]]));
    this.waveManager.addWave(wave('buzz', [[0, 0, 0], [0.5, 1, 0]]));
    this.manager.register(this.waveManager);
    this.manager.register(this.buzzTimer);
    this.wompStart();
  }

  wompStart() {
    const w = this.waveManager;
    this.stage = 'womp';
    w.restart();
    this.reverseWomp = randomBool();
    w.setSpeed(0.3);
    w.setTargetSpeed(2.5, randomInRange([0.1, 0.15]), () => w.stopAtEndOfCycle(() => this.buzzStart()));
  }

  buzzStart() {
    this.stage = 'buzz';
    this.buzzFreqA = [randomInRange([0, 0.3]), randomInRange([0, 0.3])];
    this.buzzFreqB = [randomInRange([0.7, 1]), randomInRange([0.7, 1])];
    this.waveManager.restart();
    this.waveManager.setSpeed(randomInRange([0.4, 0.8]));
    this.buzzTimer.start();
  }

  getPulse() {
    if (this.stage === 'womp') {
      const p = this.waveManager.position('womp');
      const pos = this.reverseWomp ? 1 - p : p;
      const [ampA, ampB] = this.positional(0.9, pos);
      const freq = pos * 0.7; // womp frequency runs 0 to 0.7
      return { ampA, ampB, freqA: freq, freqB: freq };
    }
    const p = this.waveManager.position('buzz');
    const t = this.buzzTimer.progress;
    const amp = 0.8 + 0.1 * p;
    return {
      ampA: amp,
      ampB: amp,
      freqA: this.buzzFreqA[0] + t * (this.buzzFreqA[1] - this.buzzFreqA[0]),
      freqB: this.buzzFreqB[0] + t * (this.buzzFreqB[1] - this.buzzFreqB[0]),
    };
  }
}

// ---- Chaos ----------------------------------------------------------------------------------------

export class ChaosActivity extends Activity {
  initialise() {
    this.counter = 0;
    this.randomise();
  }

  randomise() {
    this.pulse = { ampA: Math.random(), ampB: Math.random(), freqA: Math.random(), freqB: Math.random() };
  }

  runSimulation(dt) {
    super.runSimulation(dt);
    const cycle = this.ctx.settings.chaosCycleTime;
    this.counter += dt;
    if (this.counter > cycle) {
      this.randomise();
      this.counter -= cycle;
    }
  }

  getPulse() {
    return this.pulse;
  }

  permanentControls() {
    const s = this.ctx.settings;
    return [{ type: 'slider', label: 'Cycle time', min: 0.1, max: 5, step: 0.1, get: () => s.chaosCycleTime, set: v => { s.chaosCycleTime = v; }, persist: true }];
  }
}

// ---- Luxury HJ ------------------------------------------------------------------------------------

const HJ_SPEED = [0.3, 3.0];
const HJ_SPEED_RATE = [0.05, 0.3];
const HJ_BONUS_SPEED = [1.5, 5.0];
const HJ_FREQ = [0.15, 0.65];
const HJ_BONUS_FREQ = [0.8, 1.0];

export class LuxuryHJActivity extends Activity {
  initialise() {
    this.hjWaveManager = new WaveManager();
    this.bonusWaveManager = new WaveManager();
    this.bonusChannel = 0;
    this.manual = false;
    this.speedChangeTimer = new Timer(() => randomInRange([1, 20]), true, () => this.speedChange());
    this.bonusTimer = new Timer(() => randomInRange([10, 25]), false);
    const hj = this.hjWaveManager;
    const bonus = this.bonusWaveManager;
    hj.addWave(wave('hj', [[0, 0, 0], [0.5, 1, 0]]));
    bonus.addWave(wave('bonus', [[0, 0.6, 0], [0.5, 1, 0]]));
    this.updateJitter();
    hj.setAmplitudeJitterEaseIn(1.0);
    bonus.setSpeedJitter(0.5);
    bonus.setAmplitudeJitter(0.075);
    bonus.setSpeed(randomInRange(HJ_BONUS_SPEED));
    hj.setSpeed(randomInRange(HJ_SPEED));
    hj.baseSpeed.rate = randomInRange(HJ_SPEED_RATE);
    for (const c of [this.speedChangeTimer, this.bonusTimer, hj, bonus]) this.manager.register(c);
    this.speedChangeTimer.start();
  }

  updateJitter() {
    const s = this.ctx.settings;
    this.hjWaveManager.setSpeedJitter(s.luxuryHJTimingJitter);
    this.hjWaveManager.setAmplitudeJitter(s.luxuryHJAmplitudeJitter);
  }

  speedChange() {
    this.hjWaveManager.setTargetSpeed(randomInRange(HJ_SPEED), randomInRange(HJ_SPEED_RATE));
  }

  startBonus(channel = Math.floor(Math.random() * 2)) {
    this.bonusWaveManager.setSpeed(randomInRange(HJ_BONUS_SPEED));
    this.bonusChannel = channel;
    this.bonusTimer.start();
  }

  setManual(manual) {
    this.manual = manual;
    if (manual) {
      this.speedChangeTimer.pause();
      this.bonusTimer.cancel();
    } else {
      this.speedChangeTimer.resume();
    }
  }

  runSimulation(dt) {
    super.runSimulation(dt);
    const p = this.ctx.settings.luxuryHJBonusProbability;
    if (!this.bonusTimer.isRunning && !this.manual && Math.random() < (p * dt) / 60) this.startBonus();
  }

  getPulse() {
    const position = this.hjWaveManager.position('hj');
    let [ampA, ampB] = this.positional(this.hjWaveManager.currentAmplitude, position);
    let freqA = scaleBetween(position, HJ_FREQ) * 0.98;
    let freqB = scaleBetween(position, HJ_FREQ);
    if (this.bonusTimer.isRunning) {
      const weight = 0.7;
      const ampBonus = this.bonusWaveManager.position('bonus');
      const freqBonus = scaleBetween(ampBonus, HJ_BONUS_FREQ);
      if (this.bonusChannel === 0) {
        ampA = ampBonus * weight + ampA * (1 - weight);
        freqA = freqBonus * weight + freqA * (1 - weight);
      } else {
        ampB = ampBonus * weight + ampB * (1 - weight);
        freqB = freqBonus * weight + freqB * (1 - weight);
      }
    }
    return { ampA, ampB, freqA, freqB };
  }

  permanentControls() {
    const s = this.ctx.settings;
    const jitter = (label, key) => ({
      type: 'slider', label, min: 0, max: 0.5, step: 0.05, persist: true,
      get: () => s[key], set: v => { s[key] = v; this.updateJitter(); },
    });
    return [
      { type: 'slider', label: 'Bonus pattern probability', min: 0, max: 3, step: 0.1, persist: true,
        get: () => s.luxuryHJBonusProbability, set: v => { s.luxuryHJBonusProbability = v; } },
      jitter('Amplitude jitter', 'luxuryHJAmplitudeJitter'),
      jitter('Timing jitter', 'luxuryHJTimingJitter'),
    ];
  }

  temporaryControls() {
    const off = () => !this.manual;
    return [
      manualSwitch(this),
      { type: 'smoother', label: 'Target stroke speed', smoother: this.hjWaveManager.baseSpeed, targetRange: HJ_SPEED, rateRange: HJ_SPEED_RATE, disabled: off },
      { type: 'buttons', buttons: [['Bonus A', () => this.startBonus(0)], ['Bonus B', () => this.startBonus(1)]], disabled: off },
    ];
  }
}

// ---- Opposites ------------------------------------------------------------------------------------

const OPP_SPEED = [0.5, 3.0];
const OPP_SPEED_RATE = [0.2, 0.5];
const OPP_BASE_RATE = [0.15, 0.4];

export class OppositesActivity extends Activity {
  initialise() {
    this.ampA = new NiceSmoother(randomInRange([0, 1]));
    this.freqA = new NiceSmoother(randomInRange([0, 1]));
    this.overallSpeed = new NiceSmoother(randomInRange(OPP_SPEED), OPP_SPEED);
    this.speedChangeTimer = new Timer(() => randomInRange([10, 20]), true, () => this.speedChange());
    this.newRandomTarget(this.ampA);
    this.newRandomTarget(this.freqA);
    this.speedChange();
    for (const c of [this.ampA, this.freqA, this.overallSpeed, this.speedChangeTimer]) this.manager.register(c);
    this.speedChangeTimer.start();
  }

  speedChange() {
    this.overallSpeed.setTarget(randomInRange(OPP_SPEED), randomInRange(OPP_SPEED_RATE));
  }

  // Howl has separate amplitude and frequency versions; both use 0-1 ranges, so one does for both
  newRandomTarget(smoother) {
    const rate = randomInRange(OPP_BASE_RATE) * this.overallSpeed.value;
    smoother.setTarget(randomInRange([0, 1]), rate, () => this.newRandomTarget(smoother));
  }

  getPulse() {
    return { ampA: this.ampA.value, ampB: 1 - this.ampA.value, freqA: this.freqA.value, freqB: 1 - this.freqA.value };
  }
}

// ---- Calibration ----------------------------------------------------------------------------------
// Howl's texts point at the output's calibration sliders in another screen. Here the sliders sit under the text
// instead (the page shows one tab at a time on a phone); they edit the same values as Settings > Calibration.

/** A slider for one calibration value, saved with the page's settings. */
const calibrationSlider = (ctx, label, key, min = 0) => ({
  type: 'slider', label, min, max: 1, step: 0.01, persist: true,
  get: () => ctx.calibration[key], set: v => { ctx.calibration[key] = v; },
});

export class PowerCalibrationActivity extends Activity {
  initialise() {
    this.channelA = true;
    const swap = new Timer(0.5, true, () => { this.channelA = !this.channelA; });
    this.manager.register(swap);
    swap.start();
  }

  getPulse() {
    const power = 0.9;
    return { ampA: this.channelA ? power : 0, ampB: this.channelA ? 0 : power, freqA: 0.5, freqB: 0.5 };
  }

  permanentControls() {
    return [
      { type: 'text', heading: true, text: 'Power calibration' },
      { type: 'text', text: 'Use the main power controls to set both channels to the same numbered power level (e.g. both 20). Then adjust the power balance slider below until the sensation you feel on both channels is equal.' },
      calibrationSlider(this.ctx, 'Power balance', 'amplitudeBalance'),
    ];
  }
}

const FREQ_TEST_PATTERNS = [['SWAP_A', 'Swap A'], ['SWAP_B', 'Swap B'], ['SWEEP_A', 'Sweep A'], ['SWEEP_B', 'Sweep B']];

export class FrequencyCalibrationActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.pattern = 'SWAP_A';
    this.swapState = false;
    const swap = new Timer(0.8, true, () => { this.swapState = !this.swapState; });
    this.waveManager.addWave(wave('calibration', [[0, 0, 0], [0.5, 1, 0]]));
    this.waveManager.setSpeed(0.2);
    this.manager.register(swap);
    this.manager.register(this.waveManager);
    swap.start();
  }

  getPulse() {
    const power = 0.9;
    const sweep = this.pattern.startsWith('SWEEP');
    const freq = sweep ? this.waveManager.position('calibration') : this.swapState ? 1 : 0;
    const onA = this.pattern.endsWith('A');
    return { ampA: onA ? power : 0, ampB: onA ? 0 : power, freqA: freq, freqB: freq };
  }

  permanentControls() {
    return [
      { type: 'text', heading: true, text: 'Frequency calibration' },
      { type: 'text', text: "Adjust the frequency balance sliders below to change the relative power of high and low frequencies on each channel. For example, you might wish to make high and low frequencies feel equally powerful. But this is personal preference." },
      { type: 'text', text: 'This adjustment is frequency range dependent. Using a different frequency range to what you calibrated with will cause the balance to shift.' },
      calibrationSlider(this.ctx, 'Frequency balance A', 'frequencyBalanceA'),
      calibrationSlider(this.ctx, 'Frequency balance B', 'frequencyBalanceB'),
    ];
  }

  temporaryControls() {
    return [{ type: 'select', label: 'Test pattern', options: FREQ_TEST_PATTERNS, get: () => this.pattern, set: v => { this.pattern = v; } }];
  }
}

export class PositionalCalibrationActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.waveManager.addWave(wave('calibration', [[0, 0, 0], [0.5, 1, 0]]));
    this.waveManager.setSpeed(0.2);
    this.manager.register(this.waveManager);
  }

  getPulse() {
    const [ampA, ampB] = this.positional(0.9, this.waveManager.position('calibration'));
    return { ampA, ampB, freqA: 0.5, freqB: 0.5 };
  }

  permanentControls() {
    return [
      { type: 'text', heading: true, text: 'Positional calibration' },
      { type: 'text', text: 'Important: Both channels must have equal feeling power levels (do the power calibration first).' },
      { type: 'text', text: 'Positional effects are used whenever you play funscript files, and in several activities. Adjust the slider until you feel the slow strokes evenly throughout. If the top and bottom feel stronger than the middle, reduce the slider. If the middle feels stronger, increase the slider.' },
      calibrationSlider(this.ctx, 'Positional effect curve', 'positionalEffectCurve', 0.1),
    ];
  }
}

// ---- BJ Megamix -----------------------------------------------------------------------------------

const BJ_STAGES = [['FullLick', 'Full licks'], ['TipLick', 'Tip licks'], ['Suck', 'Suck'], ['Deepthroat', 'Deepthroat']];
const BJ_LICK_FREQ = [0.8, 1.0];
const BJ_SPEED = [0.2, 1.2];
const BJ_SPEED_RATE = [0.03, 0.2];
const BJ_FULL_LICK_SPEED = [0.3, 1.0];
const BJ_TIP_LICK_SPEED = [0.5, 3.0];

export class BJActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.manual = false;
    this.stage = randomItem(BJ_STAGES)[0];
    this.deepthroatFrequencyConverter = wave('deepthroatFrequencyConverter', [[0, 1], [0.7, 0], [1 - SMALL_AMOUNT, 0.3]]);
    const stageEnd = () => this.waveManager.stopAtEndOfCycle(() => this.nextStage());
    this.primaryStageTimer = new Timer(() => randomInRange([20, 60]), false, stageEnd);
    this.secondaryStageTimer = new Timer(() => randomInRange([6, 20]), false, stageEnd);
    this.speedChangeTimer = new Timer(() => randomInRange([1, 20]), true, () => this.speedChange());
    const w = this.waveManager;
    w.addWave(wave('position', [[0, 0, 0], [0.35, 1, 0]]));
    w.addWave(wave('bidirectional', [[0, 0, 0], [0.5, 1, 0]]));
    w.addWave(wave('unidirectional', [[0, 0, 0], [1 - SMALL_AMOUNT, 1, 0]]));
    for (const c of [w, this.speedChangeTimer, this.primaryStageTimer, this.secondaryStageTimer]) this.manager.register(c);
    this.speedChangeTimer.start();
    this.setStage(this.stage);
  }

  get isLick() {
    return this.stage === 'FullLick' || this.stage === 'TipLick';
  }

  speedChange() {
    if (this.isLick) return;
    this.waveManager.setTargetSpeed(randomInRange(BJ_SPEED), randomInRange(BJ_SPEED_RATE));
  }

  setStage(stage, manual = false) {
    const w = this.waveManager;
    this.stage = stage;
    w.restart();
    w.setSpeedJitter(this.isLick ? 0.4 : 0.2);
    w.setAmplitudeJitter(this.isLick ? 0.15 : 0.1);
    if (!manual) {
      const speedRange = stage === 'FullLick' ? BJ_FULL_LICK_SPEED : stage === 'TipLick' ? BJ_TIP_LICK_SPEED : BJ_SPEED;
      w.setSpeed(randomInRange(speedRange));
      w.baseSpeed.rate = randomInRange(BJ_SPEED_RATE);
      (this.isLick ? this.secondaryStageTimer : this.primaryStageTimer).reset();
    }
  }

  nextStage() {
    this.setStage(randomItem(BJ_STAGES.filter(([id]) => id !== this.stage))[0]);
  }

  setManual(manual) {
    this.manual = manual;
    if (manual) {
      this.speedChangeTimer.pause();
      this.primaryStageTimer.cancel();
      this.secondaryStageTimer.cancel();
    } else {
      this.speedChangeTimer.resume();
      this.nextStage();
    }
  }

  getPulse() {
    const w = this.waveManager;
    switch (this.stage) {
      case 'FullLick':
      case 'TipLick': {
        const full = this.stage === 'FullLick';
        const [position, velocity] = w.positionAndVelocity(full ? 'unidirectional' : 'bidirectional');
        const lickPosition = full ? position : scaleBetween(position, [0.6, 1.0]);
        const [ampA, ampB] = this.positional(scaleVelocity(velocity, 0.1), lickPosition);
        return { ampA, ampB, freqA: scaleBetween(position, BJ_LICK_FREQ) - 0.1, freqB: scaleBetween(position, BJ_LICK_FREQ) };
      }
      case 'Suck': {
        const position = w.position('position');
        const [ampA, ampB] = engulfEffect(w.currentAmplitude, position, 0.7, 0.4);
        return { ampA, ampB, freqA: lerp(0.7, 0.3, smoothstep(position)), freqB: lerp(0.9, 0.3, smoothstep(position)) };
      }
      default: { // Deepthroat
        const position = w.position('position');
        const [ampA, ampB] = engulfEffect(w.currentAmplitude, position, 0.8, 0.3);
        return { ampA, ampB, freqA: position, freqB: this.deepthroatFrequencyConverter.position(position) };
      }
    }
  }

  temporaryControls() {
    const off = () => !this.manual;
    return [
      manualSwitch(this),
      { type: 'select', label: 'Stage', options: BJ_STAGES, get: () => this.stage, set: v => this.setStage(v, true), disabled: off },
      { type: 'smoother', label: 'Target speed', smoother: this.waveManager.baseSpeed, targetRange: [0.1, 3.0], rateRange: [0.03, 0.3], disabled: off },
    ];
  }
}

// ---- Fast/slow ------------------------------------------------------------------------------------

const FS_MIN_SPEED = 0.15;
const FS_MAX_SPEED = 5.0;
const FS_SPEED_RATE = [0.1, 0.3];
const FS_SWITCH_PROBABILITY = 0.1;
const FS_SHAPE_CHANGE_PROBABILITY = 0.2;

export class FastSlowActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.waveManager2 = new WaveManager();
    this.accelerating = false;
    this.switch = randomBool();
    this.freqSwitch = randomBool();
    this.possibleWaves = [
      wave('sawtooth', [[0, 0, 0], [1 - SMALL_AMOUNT, 0.9, 0]], 'linear'),
      wave('reverseSawtooth', [[0, 0.9, 0], [1 - SMALL_AMOUNT, 0, 0]], 'linear'),
      wave('hermiteSawtooth', [[0, 0, 0], [1 - SMALL_AMOUNT, 0.9, 0]]),
      wave('hermiteReverseSawtooth', [[0, 0.9, 0], [1 - SMALL_AMOUNT, 0, 0]]),
    ];
    this.waveA = this.possibleWaves[0].name;
    this.waveB = this.possibleWaves[0].name;
    for (const w of this.possibleWaves) {
      this.waveManager.addWave(w);
      this.waveManager2.addWave(w);
    }
    this.manager.register(this.waveManager);
    this.manager.register(this.waveManager2);
    this.nextIteration();
  }

  nextIteration() {
    this.accelerating = !this.accelerating;
    const start = this.accelerating ? FS_MIN_SPEED : FS_MAX_SPEED;
    const target = this.accelerating ? FS_MAX_SPEED : FS_MIN_SPEED;
    const rate = randomInRange(FS_SPEED_RATE);
    this.waveManager.setSpeed(start);
    this.waveManager.setTargetSpeed(target, rate, () => this.nextIteration());
    this.waveManager2.setSpeed(target);
    this.waveManager2.setTargetSpeed(start, rate);
    if (Math.random() < FS_SHAPE_CHANGE_PROBABILITY) this.waveA = randomItem(this.possibleWaves).name;
    if (Math.random() < FS_SHAPE_CHANGE_PROBABILITY) this.waveB = randomItem(this.possibleWaves).name;
    if (Math.random() < FS_SWITCH_PROBABILITY) this.switch = !this.switch;
    if (Math.random() < FS_SWITCH_PROBABILITY) this.freqSwitch = !this.freqSwitch;
  }

  getPulse() {
    const phase = (this.waveManager.currentSpeed - FS_MIN_SPEED) / (FS_MAX_SPEED - FS_MIN_SPEED);
    let ampA = this.waveManager2.position(this.waveA);
    let ampB = this.waveManager.position(this.waveB);
    let freqA = scaleBetween(1 - phase, [0, 1]);
    let freqB = scaleBetween(phase, [0, 1]);
    if (this.switch) [ampA, ampB] = [ampB, ampA];
    if (this.freqSwitch) [freqA, freqB] = [freqB, freqA];
    return { ampA, ampB, freqA, freqB };
  }
}

// ---- Simplex --------------------------------------------------------------------------------------

const SIMPLEX_PRESETS = {
  STANDARD: { ampTimeSpeed: [0.2, 4.0], ampRotationSpeed: [0, Math.PI * 0.2], changeRate: [0.1, 0.5], ampRadius: 0.3, freqRadius: 0.2 },
  PRO: { ampTimeSpeed: [0.2, 0.8], ampRotationSpeed: [Math.PI * 0.5, Math.PI * 4], changeRate: [0.2, 0.5], ampRadius: 0.4, freqRadius: 0.3 },
  TURBO: { ampTimeSpeed: [0.1, 0.5], ampRotationSpeed: [Math.PI * 3, Math.PI * 6], changeRate: [0.2, 0.5], ampRadius: 0.6, freqRadius: 0.3 },
};
const SIMPLEX_PRESET_NAMES = [['STANDARD', 'Standard'], ['PRO', 'Pro'], ['TURBO', 'Turbo']];
const SIMPLEX_FREQ_TIME_SPEED = 0.2;
const SIMPLEX_FREQ_ROTATION_SPEED = 0.1;

export class SimplexActivity extends Activity {
  initialise() {
    this.noiseGenerator = new NoiseGenerator();
    this.elapsedTime = 0;
    this.phaseTime = 0;
    this.phaseRotation = 0;
    this.ampTimeSpeed = new NiceSmoother(0, [0, Math.PI * 10]);
    this.ampRotationSpeed = new NiceSmoother(0, [0, Math.PI * 10]);
    this.ampTimeSpeedChangeTimer = new Timer(() => randomInRange([10, 50]), true, () => {
      this.ampTimeSpeed.setTarget(randomInRange(this.preset.ampTimeSpeed), randomInRange(this.preset.changeRate));
    });
    this.ampRotationSpeedChangeTimer = new Timer(() => randomInRange([10, 50]), true, () => {
      this.ampRotationSpeed.setTarget(randomInRange(this.preset.ampRotationSpeed), randomInRange(this.preset.changeRate));
    });
    this.presetChanged(this.ctx.settings.simplexPreset);
    for (const c of [this.ampTimeSpeed, this.ampRotationSpeed, this.ampTimeSpeedChangeTimer, this.ampRotationSpeedChangeTimer]) this.manager.register(c);
    this.ampTimeSpeedChangeTimer.start();
    this.ampRotationSpeedChangeTimer.start();
  }

  presetChanged(name) {
    this.preset = SIMPLEX_PRESETS[name] ?? SIMPLEX_PRESETS.PRO;
    this.ampTimeSpeed.setImmediately(randomInRange(this.preset.ampTimeSpeed));
    this.ampRotationSpeed.setImmediately(randomInRange(this.preset.ampRotationSpeed));
  }

  runSimulation(dt) {
    super.runSimulation(dt);
    this.elapsedTime += dt;
    this.phaseTime += this.ampTimeSpeed.value * dt;
    this.phaseRotation += this.ampRotationSpeed.value * dt;
  }

  getPulse() {
    const [ampA, ampB] = this.noiseGenerator.getNoise(this.phaseTime, this.phaseRotation, this.preset.ampRadius, 2, true);
    const [freqA, freqB] = this.noiseGenerator.getNoise(
      this.elapsedTime * SIMPLEX_FREQ_TIME_SPEED, this.elapsedTime * SIMPLEX_FREQ_ROTATION_SPEED, this.preset.freqRadius, 1, true,
    );
    return { ampA, ampB, freqA, freqB };
  }

  permanentControls() {
    const s = this.ctx.settings;
    return [{
      type: 'select', label: 'Preset', options: SIMPLEX_PRESET_NAMES, persist: true,
      get: () => s.simplexPreset, set: v => { s.simplexPreset = v; this.presetChanged(v); },
    }];
  }
}

// ---- Relentless -----------------------------------------------------------------------------------

const RELENTLESS_SPEED = [0.2, 0.4];
const RELENTLESS_SPEED_BIAS = 2.5;
const RELENTLESS_POWER = [0.8, 0.95];

export class RelentlessActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.iterationTimer = new Timer(() => randomInRange([1, 30]), true, () => this.waveManager.stopAtEndOfCycle(() => this.nextIteration()));
    this.manager.register(this.waveManager);
    this.manager.register(this.iterationTimer);
    this.iterationTimer.start();
    this.nextIteration();
  }

  /** An attack, an optional hold and a decay, each attack or decay sometimes split in two. */
  createRandomWaveShape() {
    const hasHold = Math.random() < 0.3;
    const splitAttack = Math.random() < 0.5;
    const splitDecay = Math.random() < 0.5;
    const peak = randomInRange(RELENTLESS_POWER);
    const attackWeight = randomInRange([0.5, 3]);
    const decayWeight = randomInRange([0.5, 3]);
    const holdWeight = hasHold ? randomInRange([0.25, 1.5]) : 0;
    const total = attackWeight + decayWeight + holdWeight;
    const attack = attackWeight / total;
    const decay = decayWeight / total;
    const hold = holdWeight / total;

    const points = [[0, 0]];
    let x = 0;
    if (splitAttack) points.push([x + attack * randomInRange([0.3, 0.7]), peak * randomInRange([0.2, 0.8])]);
    x += attack;
    points.push([x, peak]);
    if (hasHold) {
      x += hold;
      points.push([x, peak]);
    }
    if (splitDecay) points.push([x + decay * randomInRange([0.3, 0.7]), peak * randomInRange([0.2, 0.8])]);
    // The rest of the decay comes from the wave wrapping back to its start
    return new WaveShape('randomWave', points);
  }

  nextIteration() {
    this.frequencyA = randomInRange([0, 1]);
    this.frequencyB = randomInRange([0, 1]);
    this.swapChannels = randomBool();
    const longWave = new CyclicalWave(this.createRandomWaveShape());
    const shortWave = longWave.repeated(randomItem([1, 2, 3, 4]), 'shortWave');
    this.waveManager.addWave(longWave, 'longWave');
    this.waveManager.addWave(shortWave, 'shortWave');
    this.waveManager.setSpeed(randomInRange(RELENTLESS_SPEED, RELENTLESS_SPEED_BIAS));
    this.waveManager.restart();
  }

  getPulse() {
    const long = this.waveManager.position('longWave');
    const short = this.waveManager.position('shortWave');
    const [ampA, ampB] = this.swapChannels ? [long, short] : [short, long];
    return { ampA, ampB, freqA: this.frequencyA, freqB: this.frequencyB };
  }
}

// ---- Overflowing ----------------------------------------------------------------------------------

const OVERFLOW_SPEED = [0.05, 0.1];
const OVERFLOW_FREQ = [0.6, 1.0];
const OVERFLOW_FREQ_RATE = [0.02, 0.05];
const OVERFLOW_LONG_POWER = [0.85, 0.99];
const OVERFLOW_SHORT_POWER = [0.8, 0.99];

export class OverflowingActivity extends Activity {
  initialise() {
    this.waveManager = new WaveManager();
    this.freqA = new NiceSmoother(randomInRange(OVERFLOW_FREQ));
    this.freqB = new NiceSmoother(randomInRange(OVERFLOW_FREQ));
    this.updateFrequencyTarget(this.freqA);
    this.updateFrequencyTarget(this.freqB);
    for (const c of [this.waveManager, this.freqA, this.freqB]) this.manager.register(c);
    this.nextIteration();
  }

  /** A rise to a high plateau that ripples between full and 85% power many times, then falls back. */
  createLongWaveShape() {
    const power = randomInRange(OVERFLOW_LONG_POWER);
    const lowPower = power * 0.85;
    const highPowerPortion = randomInRange([0.8, 0.9]);
    const laps = randomInt(5, 20);
    const lapIncrement = highPowerPortion / (laps * 2);
    let t = (1 - highPowerPortion) / 2;
    const points = [[0, 0], [t, lowPower]];
    for (let i = 0; i < laps; i++) {
      t += lapIncrement;
      points.push([t, power]);
      t += lapIncrement;
      points.push([t, lowPower]);
    }
    return new WaveShape('longWave', points);
  }

  updateFrequencyTarget(freq) {
    freq.setTarget(randomInRange(OVERFLOW_FREQ), randomInRange(OVERFLOW_FREQ_RATE), () => this.updateFrequencyTarget(freq));
  }

  nextIteration() {
    const w = this.waveManager;
    const shortShape = wave('shortWaveShape', [[0, 0], [0.5, randomInRange(OVERFLOW_SHORT_POWER)]]);
    w.addWave(new CyclicalWave(this.createLongWaveShape()), 'longWave');
    w.addWave(shortShape.repeated(randomInt(4, 10), 'shortWave'), 'shortWave');
    w.setSpeed(randomInRange(OVERFLOW_SPEED));
    w.restart();
    w.stopAtEndOfCycle(() => this.nextIteration());
  }

  getPulse() {
    const longAmp = this.waveManager.position('longWave');
    const shortAmp = Math.min(this.waveManager.position('shortWave'), longAmp);
    return { ampA: shortAmp, ampB: longAmp, freqA: this.freqA.value, freqB: this.freqB.value };
  }
}

// ---- Succubus -------------------------------------------------------------------------------------

const SUCCUBUS_SPEED = [0.06, 2.0];
const SUCCUBUS_SPEED_BIAS = 3.5;
const SUCCUBUS_SPEED_RATE = [0.03, 0.2];
const SUCCUBUS_PROPORTION_RATE = 0.05;
const SUCCUBUS_SHAPE_CHANGE_PROBABILITY = 0.3;
const SUCCUBUS_PROPORTION_CHANGE_PROBABILITY = 0.3;
const SUCCUBUS_SPEED_CHANGE_PROBABILITY = 0.3;

export class SuccubusActivity extends Activity {
  initialise() {
    this.waveManagers = [new WaveManager(), new WaveManager()];
    this.ampProportionA = new NiceSmoother(randomInRange([0, 1]));
    this.ampProportionB = new NiceSmoother(randomInRange([0, 1]));
    this.freqProportionA = new NiceSmoother(randomInRange([0, 1]));
    this.freqProportionB = new NiceSmoother(randomInRange([0, 1]));
    this.proportions = [this.ampProportionA, this.ampProportionB, this.freqProportionA, this.freqProportionB];
    const shapeChange = new Timer(() => randomInRange([10, 40]), true, () => this.shapeChange());
    const speedChange = new Timer(() => randomInRange([10, 30]), true, () => this.speedChange());
    const proportionChange = new Timer(() => randomInRange([10, 30]), true, () => this.proportionChange());
    for (const w of this.waveManagers) {
      w.addWave(this.randomWave(randomInt(2, 6)), 'amp');
      w.addWave(this.randomWave(randomInt(2, 6)), 'freq');
      w.setSpeed(randomInRange(SUCCUBUS_SPEED, SUCCUBUS_SPEED_BIAS));
      this.manager.register(w);
    }
    for (const c of [shapeChange, speedChange, proportionChange, ...this.proportions]) this.manager.register(c);
    shapeChange.start();
    speedChange.start();
    proportionChange.start();
  }

  /** Points at random times at least 0.05 apart; at least one of them reaches 0.8 or more. */
  randomWave(numPoints) {
    const maxPower = 0.95;
    const powerLowerBound = 0.8;
    const points = [];
    for (let i = 0; i < numPoints; i++) {
      let t;
      do t = randomInRange([0, 1 - SMALL_AMOUNT]);
      while (points.some(([pt]) => Math.abs(pt - t) < 0.05));
      points.push([t, randomInRange([0, maxPower])]);
    }
    if (points.every(([, pos]) => pos < powerLowerBound)) {
      randomItem(points)[1] = randomInRange([powerLowerBound, maxPower]);
    }
    return wave('randomWave', points);
  }

  proportionChange() {
    for (const p of this.proportions) {
      if (Math.random() < SUCCUBUS_PROPORTION_CHANGE_PROBABILITY) p.setTarget(randomInRange([0, 1]), SUCCUBUS_PROPORTION_RATE);
    }
  }

  shapeChange() {
    for (const w of this.waveManagers) {
      if (Math.random() < SUCCUBUS_SHAPE_CHANGE_PROBABILITY) w.addWave(this.randomWave(randomInt(2, 6)), 'amp');
      if (Math.random() < SUCCUBUS_SHAPE_CHANGE_PROBABILITY) w.addWave(this.randomWave(randomInt(2, 6)), 'freq');
    }
  }

  speedChange() {
    for (const w of this.waveManagers) {
      if (Math.random() < SUCCUBUS_SPEED_CHANGE_PROBABILITY) {
        w.setTargetSpeed(randomInRange(SUCCUBUS_SPEED, SUCCUBUS_SPEED_BIAS), randomInRange(SUCCUBUS_SPEED_RATE));
      }
    }
  }

  getPulse() {
    const [w1, w2] = this.waveManagers;
    const amp1 = w1.position('amp');
    const amp2 = w2.position('amp');
    const freq1 = w1.position('freq');
    const freq2 = w2.position('freq');
    const mix = (a, b, p) => a * p.value + b * (1 - p.value);
    return {
      ampA: mix(amp1, amp2, this.ampProportionA),
      ampB: mix(amp1, amp2, this.ampProportionB),
      freqA: mix(freq1, freq2, this.freqProportionA),
      freqB: mix(freq1, freq2, this.freqProportionB),
    };
  }
}

// ---- Sine time ------------------------------------------------------------------------------------

const SINE_MAG = [0.1, 0.3];
const SINE_SPEED = [0.4, 0.88];
const SINE_FREQ = [0.5, 0.75];
const SINE_FREQ_SHIFT = [-0.25, 0.25];
const SINE_AMP = [0.8, 1.0];
const SINE_FADE_TIME = 0.5;

export class SineTimeActivity extends Activity {
  initialise() {
    this.manual = false;
    this.sineSpeed = 0.2;
    this.freqChange = 0;
    this.sineMag = new NiceSmoother(0.2, [0, 1]);
    this.offset = new NiceSmoother(0, [-Math.PI, Math.PI]);
    this.sinePhase = 0;
    this.patternTimer = new Timer(() => randomInRange([8, 15]), false, () => this.breakTimer.reset());
    // A short silence between patterns
    this.breakTimer = new Timer(() => randomInRange([0.8, 5], 2.5), false, () => this.nextIteration());
    for (const c of [this.patternTimer, this.breakTimer, this.offset, this.sineMag]) this.manager.register(c);
    this.nextIteration();
  }

  nextIteration() {
    if (!this.manual) {
      this.sineMag.setImmediately(randomInRange(SINE_MAG));
      this.sineSpeed = randomInRange(SINE_SPEED);
      this.freqChange = randomInRange(SINE_FREQ_SHIFT);
      this.offset.setImmediately(randomInRange([-Math.PI, Math.PI]));
    }
    this.freqA = randomInRange(SINE_FREQ);
    this.freqB = randomInRange(SINE_FREQ);
    this.amp = randomInRange(SINE_AMP); // set as in Howl, which doesn't use it either
    this.patternTimer.reset();
  }

  setManual(manual) {
    this.manual = manual;
  }

  runSimulation(dt) {
    super.runSimulation(dt);
    this.sinePhase = (this.sinePhase + 2 * Math.PI * this.sineSpeed * dt) % (2 * Math.PI);
  }

  getPulse() {
    if (this.breakTimer.isRunning) return { ampA: 0, ampB: 0, freqA: 0, freqB: 0 };
    const fadeIn = clamp(this.patternTimer.elapsedTime / SINE_FADE_TIME, 0, 1);
    const fadeOut = clamp(this.patternTimer.remainingTime / SINE_FADE_TIME, 0, 1);
    const fade = Math.min(fadeIn, fadeOut);
    const mag = this.sineMag.value;
    const baseAmp = 1 - mag;
    const amp = Math.sqrt(1 - Math.max(SINE_MAG[1] - mag, 0));
    const phaseA = Math.sin(this.sinePhase);
    const phaseB = Math.sin(this.sinePhase + this.offset.value);
    return {
      ampA: clamp((baseAmp + mag * phaseA) * fade * amp, 0, 1),
      ampB: clamp((baseAmp + mag * phaseB) * fade * amp, 0, 1),
      freqA: clamp(this.freqA + this.freqChange * phaseA, 0, 1),
      freqB: clamp(this.freqB + this.freqChange * phaseB, 0, 1),
    };
  }

  temporaryControls() {
    const off = () => !this.manual;
    return [
      manualSwitch(this),
      { type: 'smoother', label: 'Sine magnitude', smoother: this.sineMag, targetRange: [0, 0.4], step: 0.01, disabled: off },
      { type: 'slider', label: 'Sine speed', min: 0.2, max: 1, step: 0.01, get: () => this.sineSpeed, set: v => { this.sineSpeed = v; }, disabled: off },
      { type: 'smoother', label: 'Sine offset', smoother: this.offset, targetRange: [-Math.PI, Math.PI], step: (2 * Math.PI) / 40, disabled: off },
      { type: 'slider', label: 'Frequency change', min: SINE_FREQ_SHIFT[0], max: SINE_FREQ_SHIFT[1], step: 0.01, get: () => this.freqChange, set: v => { this.freqChange = v; }, disabled: off },
    ];
  }
}

// ---- The list the Activity tab picks from ---------------------------------------------------------

// Howl's order, except the calibration activities come first so they are easy to find
export const ACTIVITY_TYPES = [
  { id: 'CALIBRATE_POWER', name: 'Calibrate power', icon: 'plug', create: ctx => new PowerCalibrationActivity(ctx) },
  { id: 'CALIBRATE_FREQ', name: 'Calibrate frequency', icon: 'calibration', create: ctx => new FrequencyCalibrationActivity(ctx) },
  { id: 'CALIBRATE_POSITION', name: 'Calibrate position', icon: 'swapvert', create: ctx => new PositionalCalibrationActivity(ctx) },
  { id: 'LICKS', name: 'Infinite licks', icon: 'grin_tongue', create: ctx => new LickActivity(ctx) },
  { id: 'PENETRATION', name: 'Penetration', icon: 'rocket', create: ctx => new PenetrationActivity(ctx) },
  { id: 'VIBRATOR', name: 'Sliding vibrator', icon: 'vibration', create: ctx => new VibroActivity(ctx) },
  { id: 'MILKMASTER', name: 'Milkmaster 3000', icon: 'cow', create: ctx => new MilkerActivity(ctx) },
  { id: 'CHAOS', name: 'Chaos', icon: 'chaos', create: ctx => new ChaosActivity(ctx) },
  { id: 'HJ', name: 'Luxury HJ', icon: 'hand', create: ctx => new LuxuryHJActivity(ctx) },
  { id: 'OPPOSITES', name: 'Opposites', icon: 'yin_yang', create: ctx => new OppositesActivity(ctx) },
  { id: 'BJ', name: 'BJ Megamix', icon: 'lips', create: ctx => new BJActivity(ctx) },
  { id: 'FASTSLOW', name: 'Fast/slow', icon: 'speed', create: ctx => new FastSlowActivity(ctx) },
  { id: 'SIMPLEX', name: 'Simplex', icon: 'wave_triangle', create: ctx => new SimplexActivity(ctx) },
  { id: 'RELENTLESS', name: 'Relentless', icon: 'hammer', create: ctx => new RelentlessActivity(ctx) },
  { id: 'OVERFLOWING', name: 'Overflowing', icon: 'water_drop', create: ctx => new OverflowingActivity(ctx) },
  { id: 'SUCCUBUS', name: 'Succubus', icon: 'succubus', create: ctx => new SuccubusActivity(ctx) },
  { id: 'SINETIME', name: 'Sine time', icon: 'wave', create: ctx => new SineTimeActivity(ctx) },
];

/** Excluded from random select by default, as in Howl: the calibration activities. */
export const DEFAULT_EXCLUDED = ['CALIBRATE_POWER', 'CALIBRATE_FREQ', 'CALIBRATE_POSITION'];

/**
 * Runs the current activity and sometimes switches to a random one, as Howl's ActivityHost.
 * @param {{ settings: object, positionalCurve: () => number }} ctx
 * @param {() => {changeProbability: number, excluded: string[]}} hostSettings
 */
export class ActivityHost {
  constructor(ctx, hostSettings) {
    this.ctx = ctx;
    this.hostSettings = hostSettings;
    this.onChange = () => {};
    this.setCurrent(this.randomType().id);
  }

  setCurrent(id) {
    // An unknown id falls back to Infinite licks, not the first entry (a calibration activity)
    this.type = ACTIVITY_TYPES.find(t => t.id === id) ?? ACTIVITY_TYPES.find(t => t.id === 'LICKS');
    this.instance = this.type.create(this.ctx);
    this.instance.initialise();
    this.onChange();
  }

  randomType(avoid = null) {
    const { excluded } = this.hostSettings();
    const candidates = ACTIVITY_TYPES.filter(t => !excluded.includes(t.id) && t.id !== avoid);
    const fallback = ACTIVITY_TYPES.filter(t => t.id !== avoid);
    return randomItem(candidates.length ? candidates : fallback.length ? fallback : ACTIVITY_TYPES);
  }

  /** Advances by `dt` seconds and returns the pulse for that moment. */
  next(dt) {
    // Probability slider 1.0 = on average 3 changes a minute
    const p = (this.hostSettings().changeProbability * 3 * dt) / 60;
    if (Math.random() < p) this.setCurrent(this.randomType(this.type.id).id);
    this.instance.runSimulation(dt);
    // Some activities can overshoot 1 slightly (e.g. with speed jitter); the outputs clamp too, but keep meters honest
    const out = this.instance.getPulse();
    return { ampA: clamp(out.ampA, 0, 1), ampB: clamp(out.ampB, 0, 1), freqA: clamp(out.freqA, 0, 1), freqB: clamp(out.freqB, 0, 1) };
  }
}
