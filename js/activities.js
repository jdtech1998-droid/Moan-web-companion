// The activities on the Activity tab, ported one to one from Howl's Activity.kt.
// Controls are described as data (see the renderer in app.js) instead of Compose UI:
//   { type: 'switch', label, get, set, heading? }
//   { type: 'slider', label, min, max, step, get, set, disabled?, persist? }
//   { type: 'select', label, options: [[value, label]], get, set, disabled? }
//   { type: 'smoother', label, smoother, targetRange, rateRange, disabled? }
// `disabled` is a function (checked on every refresh); `persist` saves the page's settings after a change.

import {
  Activity, Timer, NiceSmoother, WaveManager, wave, SMALL_AMOUNT,
  randomInRange, randomItem, randomBool, scaleVelocity, feelAdjustment, clamp,
} from './activitycore.js';

/** Persisted activity options and their defaults (Howl's Prefs.activity*). */
export const ACTIVITY_OPTION_DEFAULTS = {
  vibePulseDutyCycle: 1.0,
  vibePulseTime: 0.3,
  vibeHoldProbability: 0.25,
  chaosCycleTime: 1.0,
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

// ---- The list the Activity tab picks from, in Howl's order ----------------------------------------

export const ACTIVITY_TYPES = [
  { id: 'LICKS', name: 'Infinite licks', icon: 'grin_tongue', create: ctx => new LickActivity(ctx) },
  { id: 'PENETRATION', name: 'Penetration', icon: 'rocket', create: ctx => new PenetrationActivity(ctx) },
  { id: 'VIBRATOR', name: 'Sliding vibrator', icon: 'vibration', create: ctx => new VibroActivity(ctx) },
  { id: 'MILKMASTER', name: 'Milkmaster 3000', icon: 'cow', create: ctx => new MilkerActivity(ctx) },
  { id: 'CHAOS', name: 'Chaos', icon: 'chaos', create: ctx => new ChaosActivity(ctx) },
];

/** Excluded from random select by default, as in Howl (the calibration activities, once ported). */
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
    this.type = ACTIVITY_TYPES.find(t => t.id === id) ?? ACTIVITY_TYPES[0];
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
