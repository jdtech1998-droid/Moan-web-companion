// Funscript playback, ported from Howl's Funscript.kt and the helpers it uses in Utils.kt.
// Positions are smoothed with monotone cubic (Fritsch-Carlson) interpolation. Amplitude comes from how fast
// the script moves, the stroke position pans between channels A and B, and frequency blends position,
// energy and direction, with extra effects from the other axes of a multi-axis script.

export class BadFileError extends Error {}

export const FUNSCRIPT_DEFAULTS = {
  volume: 0.8, // "Scaling coefficient": higher boosts slow movements but reduces dynamic range
  positionalEffectStrength: 1.0,
  smoothingSigma: 0.2, // "Amplitude calculation window", seconds
  freqEnergyProportion: 0.2,
  directionalFreqShift: 0.15,
  flipDirectionalFreqShift: false,
  normaliseAxes: true,
};

const MAX_SPEED = 5.0; // approximate maximum speed of a stroker device
const MAX_MAGNITUDE = 80.0; // maximum acceleration magnitude used for normalisation
const SUPPORTED_AXES = new Set(['L0', 'L1', 'L2', 'R0', 'R1', 'R2']);
const BALANCED_AXES = new Set(['L1', 'L2', 'R0', 'R1', 'R2']);
const LINEAR_AXES = ['L0', 'L1', 'L2'];
const ROTATION_AXES = ['R0', 'R1', 'R2'];
const WINDOW_WIDTH_SIGMAS = 3.0;
const SAMPLES_PER_SIGMA = 4;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const AXIS_NAMES = { L0: 'Stroke', L1: 'Surge', L2: 'Sway', R0: 'Twist', R1: 'Roll', R2: 'Pitch' };
export const isRotationAxis = id => id.startsWith('R');

const clamp01 = v => Math.min(Math.max(v, 0), 1);

/** Cubic Hermite position, velocity and acceleration between (t0, p0, m0) and (t1, p1, m1). */
export function hermite(t, t0, p0, m0, t1, p1, m1) {
  const dt = t1 - t0;
  if (dt <= 0) return [p0, 0, 0];
  const h = (t - t0) / dt;
  const h2 = h * h;
  const h3 = h2 * h;
  const position = p0 * (2 * h3 - 3 * h2 + 1) + m0 * (h3 - 2 * h2 + h) * dt + p1 * (-2 * h3 + 3 * h2) + m1 * (h3 - h2) * dt;
  const dpdh = (6 * h2 - 6 * h) * p0 + (3 * h2 - 4 * h + 1) * m0 * dt + (-6 * h2 + 6 * h) * p1 + (3 * h2 - 2 * h) * m1 * dt;
  const d2pdh2 = (12 * h - 6) * p0 + (6 * h - 4) * m0 * dt + (-12 * h + 6) * p1 + (6 * h - 2) * m1 * dt;
  return [position, dpdh / dt, d2pdh2 / (dt * dt)];
}

/** Splits one amplitude between channels by position, as Howl's calculatePositionalEffect. */
export function positionalEffect(amplitude, position, strength, curve) {
  const effective = 0.5 * (1 - strength) + position * strength;
  const c = Math.max(curve, 0.01);
  return [amplitude * clamp01(1 - effective) ** c, amplitude * clamp01(effective) ** c];
}

export class FunscriptAxis {
  /**
   * @param {string} id
   * @param {{at:number, pos:number}[]} actions `at` in ms, `pos` 0-100
   * @param {'full'|'balanced'|'off'} normalisation
   */
  constructor(id, actions, normalisation = 'off') {
    this.id = id;
    const seen = new Set();
    const unique = actions
      .filter(a => Number.isFinite(a?.at) && Number.isFinite(a?.pos))
      .filter(a => (seen.has(a.at) ? false : (seen.add(a.at), true)))
      .sort((a, b) => a.at - b.at)
      .map(a => ({ at: a.at, pos: Math.min(Math.max(a.pos, 0), 100) }));
    if (unique.length < 2) throw new BadFileError(`Funscript axis ${id} must have at least 2 actions`);

    // A loop, not Math.min(...): long scripts can have more actions than a call can take arguments
    let rawMin = Infinity;
    let rawMax = -Infinity;
    for (const a of unique) {
      rawMin = Math.min(rawMin, a.pos);
      rawMax = Math.max(rawMax, a.pos);
    }
    let minPos = 0;
    let maxPos = 100;
    if (normalisation === 'full') {
      minPos = rawMin;
      maxPos = rawMax;
    } else if (normalisation === 'balanced') {
      const maxDist = Math.max(50 - rawMin, rawMax - 50);
      minPos = 50 - maxDist;
      maxPos = 50 + maxDist;
    }
    const range = maxPos - minPos;
    if (normalisation !== 'off' && (rawMin === rawMax || range <= 0)) {
      throw new BadFileError(`Funscript axis ${id} must contain at least 2 different positions`);
    }

    const n = unique.length;
    this.times = unique.map(a => a.at / 1000);
    this.positions = unique.map(a => (normalisation !== 'off' ? (a.pos - minPos) / range : a.pos / 100));

    // Secant slopes, then Fritsch-Carlson tangents so the curve never overshoots
    const secants = [];
    for (let i = 0; i < n - 1; i++) {
      const dt = this.times[i + 1] - this.times[i];
      secants.push(dt === 0 ? 0 : (this.positions[i + 1] - this.positions[i]) / dt);
    }
    this.velocities = this.times.map((time, i) => {
      if (i === 0) return secants[0];
      if (i === n - 1) return secants[n - 2];
      const mLeft = secants[i - 1];
      const mRight = secants[i];
      if (mLeft * mRight <= 0) return 0; // peak or valley
      const dtLeft = time - this.times[i - 1];
      const dtRight = this.times[i + 1] - time;
      const common = dtLeft + dtRight;
      return (3 * common) / ((common + dtRight) / mLeft + (common + dtLeft) / mRight);
    });
  }

  get duration() {
    return this.times[this.times.length - 1];
  }

  /** Index of the last point at or before `time`, or -1. */
  floorIndex(time) {
    let lo = 0;
    let hi = this.times.length - 1;
    if (time < this.times[0]) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** [position, velocity, acceleration] at `time` (seconds). */
  at(time) {
    const i = this.floorIndex(time);
    if (i < 0) return [this.positions[0], 0, 0];
    if (i >= this.times.length - 1) return [this.positions[i], 0, 0];
    const p0 = this.positions[i];
    const p1 = this.positions[i + 1];
    if (p0 === p1) return [p0, 0, 0];
    const [pos, vel, acc] = hermite(time, this.times[i], p0, this.velocities[i], this.times[i + 1], p1, this.velocities[i + 1]);
    return [clamp01(pos), vel, acc];
  }

  positionAt(time) {
    return this.at(time)[0];
  }
}

export class FunscriptSource {
  /**
   * @param {string} text the .funscript file's JSON
   * @param {string} name
   * @param {typeof FUNSCRIPT_DEFAULTS} options
   * @param {() => number} positionalCurve the calibrated positional effect curve (0.5 = constant power)
   */
  constructor(text, name, options = FUNSCRIPT_DEFAULTS, positionalCurve = () => 0.5) {
    this.options = options;
    this.positionalCurve = positionalCurve;
    this.name = name;
    this.loop = false;
    let script;
    try {
      script = JSON.parse(text);
    } catch {
      throw new BadFileError('Funscript decoding failed');
    }
    if (!Array.isArray(script?.actions)) throw new BadFileError('Funscript decoding failed');

    const normalise = options.normaliseAxes;
    this.axes = new Map([['L0', new FunscriptAxis('L0', script.actions, normalise ? 'full' : 'off')]]);
    for (const axis of Array.isArray(script.axes) ? script.axes : []) {
      if (axis?.id === 'L0' || !SUPPORTED_AXES.has(axis?.id) || !Array.isArray(axis.actions)) continue;
      try {
        this.axes.set(axis.id, new FunscriptAxis(axis.id, axis.actions, normalise && BALANCED_AXES.has(axis.id) ? 'balanced' : 'off'));
      } catch (e) {
        if (!(e instanceof BadFileError)) throw e;
      }
    }
    this.axisIds = [...this.axes.keys()].sort();
    this.info = `${this.axes.size} axis funscript`;
    this.duration = Math.max(...[...this.axes.values()].map(a => a.duration));
  }

  axisPosition(id, time) {
    return this.axes.get(id)?.positionAt(time) ?? null;
  }

  instantaneousEnergy(time) {
    let energy = 0;
    for (const id of [...LINEAR_AXES, ...ROTATION_AXES]) {
      const axis = this.axes.get(id);
      if (!axis) continue;
      const v = clamp01(Math.abs(axis.at(time)[1]) / MAX_SPEED);
      energy += v * v;
    }
    return energy;
  }

  /** RMS speed over a backward-looking Gaussian window. */
  totalAmplitude(time) {
    const sigma = Math.max(this.options.smoothingSigma, 0.01);
    const step = sigma / SAMPLES_PER_SIGMA;
    const steps = WINDOW_WIDTH_SIGMAS * SAMPLES_PER_SIGMA;
    let weighted = 0;
    let weights = 0;
    for (let i = -steps; i <= 0; i++) {
      const offset = i * step;
      const w = Math.exp(-(offset * offset) / (2 * sigma * sigma));
      weighted += w * this.instantaneousEnergy(time + offset);
      weights += w;
    }
    const raw = clamp01(Math.sqrt(weights > 0 ? weighted / weights : 0));
    return raw < 0.005 ? 0 : raw;
  }

  baseFrequencies(time, position, amplitude) {
    const o = this.options;
    const l0Vel = this.axes.get('L0')?.at(time)[1] ?? 0;
    const normVel = Math.min(Math.max(l0Vel / MAX_SPEED, -1), 1);
    const core = position * (1 - o.freqEnergyProportion) + amplitude * o.freqEnergyProportion;
    let shift = normVel * o.directionalFreqShift;
    if (o.flipDirectionalFreqShift) shift = -shift;
    // Channel A (base) and B (tip)
    return [clamp01(core - shift), clamp01(core + shift)];
  }

  spatialFrequencies(time, position, amplitude) {
    if (amplitude <= 0) return [0, 0];
    let [freqA, freqB] = this.baseFrequencies(time, position, amplitude);

    const r0 = this.axes.get('R0'); // twist: friction buzz on both
    if (r0) {
      const buzz = clamp01(Math.abs(r0.at(time)[1]) / MAX_SPEED) * 0.5;
      freqA += buzz;
      freqB += buzz;
    }
    const r1 = this.axes.get('R1'); // roll: symmetrical lateral spread, mostly B
    if (r1) {
      const spread = Math.abs(r1.positionAt(time) - 0.5) * 0.4;
      freqA += spread * 0.2;
      freqB -= spread * 0.8;
    }
    const r2 = this.axes.get('R2'); // pitch: towards vs away
    if (r2) {
      const offset = (r2.positionAt(time) - 0.5) * 0.4;
      freqA += offset;
      freqB -= offset;
    }
    let impactSq = 0; // surge and sway: acceleration "impacts" lower both
    for (const id of ['L1', 'L2']) {
      const axis = this.axes.get(id);
      if (axis) impactSq += (axis.at(time)[2] / MAX_MAGNITUDE) ** 2;
    }
    if (impactSq > 0) {
      const drop = clamp01(Math.sqrt(impactSq)) * 0.4;
      freqA -= drop;
      freqB -= drop;
    }
    return [clamp01(freqA), clamp01(freqB)];
  }

  pulseAt(time) {
    const o = this.options;
    const raw = this.totalAmplitude(time);
    const amplitude = clamp01(raw ** Math.max(1 - o.volume, 0.001));
    const position = this.axes.get('L0').positionAt(time);
    const [ampA, ampB] = positionalEffect(amplitude, position, o.positionalEffectStrength, this.positionalCurve());
    const [freqA, freqB] = this.spatialFrequencies(time, position, raw);
    return { ampA, ampB, freqA, freqB };
  }
}

export { MAX_FILE_BYTES };
