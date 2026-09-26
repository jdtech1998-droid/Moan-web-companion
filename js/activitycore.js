// Building blocks for the Activity tab, ported from Howl's ActivityComponents.kt, CyclicalWave.kt and the
// helpers in Utils.kt: timers, cyclical waves with jitter, and smoothers that ease a value towards a target.

import { hermite, positionalEffect } from './funscript.js';

export const SMALL_AMOUNT = 0.00001;

export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Random number in [min, max). bias > 1 favours low values, < 1 favours high ones, as Howl's randomInRange.
 * @param {[number, number]} range
 */
export function randomInRange([a, b], bias = 1) {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  if (min === max) return min;
  return min + Math.random() ** bias * (max - min);
}

export const randomInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1)); // inclusive
export const randomItem = list => list[Math.floor(Math.random() * list.length)];
export const randomBool = () => Math.random() < 0.5;

/** Maps any speed onto 0-1: v / (v + sensitivity). */
export const scaleVelocity = (velocity, sensitivity) => (velocity !== 0 ? Math.abs(velocity) / (Math.abs(velocity) + sensitivity) : 0);

export function smoothstep(t) {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/** Howl's calculateFeelAdjustment: raises frequency to 1/feel, so a higher feel uses more high frequencies. */
export const feelAdjustment = (value, feel) => clamp(value ** (1 / feel), 0, 1);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Howl's Double.scaleBetween: maps 0-1 onto a range and clamps to it. */
export const scaleBetween = (v, [a, b]) => clamp(a + (b - a) * v, Math.min(a, b), Math.max(a, b));

/**
 * Howl's calculateEngulfEffect: each channel builds up until the position reaches its engulf point,
 * then falls off slowly past it. Returns [ampA, ampB].
 */
export function engulfEffect(amplitude, position, engulfA, engulfB) {
  const channel = engulf => {
    if (position <= engulf) return engulf === 0 ? 1 : Math.sqrt(position / engulf);
    return Math.sqrt(1 - Math.abs(position - engulf) * 0.8);
  };
  return [channel(engulfA) * amplitude, channel(engulfB) * amplitude];
}

export { positionalEffect };

// ---- Components -----------------------------------------------------------------------------------

export class ActivityManager {
  constructor() {
    this.components = [];
  }

  register(component) {
    this.components.push(component);
  }

  unregister(component) {
    this.components = this.components.filter(c => c !== component);
  }

  update(dt) {
    for (const c of this.components) c.update(dt);
  }
}

export class Timer {
  /**
   * @param {number | (() => number)} duration seconds, or a function giving each run's duration
   * @param {boolean} repeating
   * @param {() => void} onTrigger
   */
  constructor(duration, repeating = false, onTrigger = () => {}) {
    this.durationProvider = typeof duration === 'function' ? duration : () => duration;
    this.repeating = repeating;
    this.onTrigger = onTrigger;
    this.duration = 0;
    this.remainingTime = 0;
    this.state = 'initial'; // initial | running | finished | paused | cancelled
  }

  get elapsedTime() {
    return clamp(this.duration - this.remainingTime, 0, this.duration);
  }

  get progress() {
    return this.duration <= 0 ? 0 : clamp(this.elapsedTime / this.duration, 0, 1);
  }

  get isRunning() {
    return this.state === 'running';
  }

  nextDuration() {
    const d = this.durationProvider();
    if (!(d > 0)) throw new Error('Timer duration must be > 0');
    return d;
  }

  update(dt) {
    if (this.state !== 'running') return;
    this.remainingTime -= dt;
    while (this.remainingTime <= 0) {
      this.onTrigger();
      if (!this.repeating) {
        this.remainingTime = 0;
        this.state = 'finished';
        return;
      }
      this.duration = this.nextDuration();
      this.remainingTime += this.duration;
    }
  }

  start() {
    this.reset();
  }

  reset() {
    this.duration = this.nextDuration();
    this.remainingTime = this.duration;
    this.state = 'running';
  }

  pause() {
    this.state = 'paused';
  }

  resume() {
    this.state = 'running';
  }

  cancel() {
    this.state = 'cancelled';
    this.remainingTime = 0;
  }
}

/**
 * A value that eases towards a target at `rate` units per second with an S-shaped profile,
 * handling target changes mid-way. Howl's NiceSmoother.
 */
export class NiceSmoother {
  constructor(initialValue = 0, range = [0, 1]) {
    this.range = range;
    this._value = clamp(initialValue, ...range);
    this._target = this._value;
    this._rate = 1;
    this.velocity = 0;
    this.startValue = initialValue;
    this.startVelocity = 0;
    this.duration = 0;
    this.elapsed = 0;
    this.isTransitioning = false;
    this.onReached = null;
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this._value = clamp(v, ...this.range);
  }

  get target() {
    return this._target;
  }

  get rate() {
    return this._rate;
  }

  set rate(r) {
    this._rate = Math.max(0.0001, r);
    if (this.isTransitioning) this.setTarget(this._target, null, this.onReached);
  }

  update(dt) {
    if (!this.isTransitioning) return;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) {
      this.finish();
      return;
    }
    const [pos, vel] = hermite(this.elapsed, 0, this.startValue, this.startVelocity, this.duration, this._target, 0);
    this.value = pos;
    this.velocity = vel;
  }

  setTarget(target, rate = null, onReached = null) {
    this.onReached = onReached;
    if (rate != null) this._rate = Math.max(rate, 0.0001);
    this.startValue = this._value;
    this.startVelocity = this.velocity;
    this._target = clamp(target, ...this.range);
    this.elapsed = 0;
    const distance = Math.abs(this._target - this.startValue);
    const direction = Math.sign(this._target - this.startValue);
    const wrongDirectionPenalty = this.startVelocity * direction < 0 ? Math.abs(this.startVelocity) / this._rate : 0;
    const smoothTime = 0.2 / this._rate; // so very short moves aren't too fast
    this.duration = distance / this._rate + wrongDirectionPenalty + smoothTime;
    this.isTransitioning = true;
  }

  setImmediately(value) {
    this.value = value;
    this.velocity = 0;
    this._target = this._value;
    this.isTransitioning = false;
    this.onReached = null;
  }

  finish() {
    this.value = this._target;
    this.velocity = 0;
    this.isTransitioning = false;
    const callback = this.onReached;
    this.onReached = null;
    callback?.();
  }
}

// ---- Waves ----------------------------------------------------------------------------------------

/**
 * One cycle of a wave, as points at times in [0, 1). Hermite shapes without slopes get monotone slopes
 * that wrap around the cycle, as Howl's WaveShape.
 * @param {string} name
 * @param {[number, number, number?][]} points [time, position, slope?]
 * @param {'hermite'|'linear'} interpolation
 */
export class WaveShape {
  constructor(name, points, interpolation = 'hermite') {
    this.name = name;
    this.interpolation = interpolation;
    if (!points.every(([t]) => t >= 0 && t < 1)) throw new Error('All times must be in [0.0, 1.0)');
    const seen = new Set();
    let sorted = points
      .map(([time, position, slope]) => ({ time, position, slope: slope ?? null }))
      .sort((a, b) => a.time - b.time)
      .filter(p => (seen.has(p.time) ? false : (seen.add(p.time), true)));
    if (sorted.length < 2) throw new Error('Shape must contain at least two unique points');
    if (interpolation === 'hermite' && sorted.some(p => p.slope === null)) {
      const slopes = monotoneSlopes(sorted);
      sorted = sorted.map((p, i) => ({ ...p, slope: p.slope ?? slopes[i] }));
    }
    this.points = sorted;
  }
}

function monotoneSlopes(points) {
  const n = points.length;
  const slopes = new Array(n).fill(0);
  const d = [];
  for (let i = 0; i < n; i++) {
    const next = i === n - 1 ? 0 : i + 1;
    const h = i === n - 1 ? 1 + points[next].time - points[i].time : points[next].time - points[i].time;
    d.push((points[next].position - points[i].position) / h);
  }
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? n - 1 : i - 1;
    slopes[i] = d[prev] * d[i] <= 0 ? 0 : (d[prev] + d[i]) / 2;
  }
  for (let i = 0; i < n; i++) {
    const next = i === n - 1 ? 0 : i + 1;
    if (d[i] === 0) {
      slopes[i] = 0;
      slopes[next] = 0;
    } else {
      const a = slopes[i] / d[i];
      const b = slopes[next] / d[i];
      const h = Math.hypot(a, b);
      if (h > 9) {
        const t = 3 / h;
        slopes[i] = t * a * d[i];
        slopes[next] = t * b * d[i];
      }
    }
  }
  return slopes;
}

export class CyclicalWave {
  /** @param {WaveShape} shape */
  constructor(shape) {
    this.shape = shape;
  }

  get name() {
    return this.shape.name;
  }

  surrounding(phase) {
    const pts = this.shape.points;
    let index = -1;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i].time <= phase) {
        index = i;
        break;
      }
    }
    if (index === -1) return [{ ...pts[pts.length - 1], time: pts[pts.length - 1].time - 1 }, pts[0]];
    if (index === pts.length - 1) return [pts[index], { ...pts[0], time: pts[0].time + 1 }];
    return [pts[index], pts[index + 1]];
  }

  /** [position, velocity] at a time counted in cycles. */
  positionAndVelocity(time) {
    const phase = time % 1;
    const [a, b] = this.surrounding(phase);
    let pos;
    let vel;
    if (this.shape.interpolation === 'hermite') {
      [pos, vel] = hermite(phase, a.time, a.position, a.slope, b.time, b.position, b.slope);
    } else if (a.time >= b.time) {
      [pos, vel] = [a.position, 0];
    } else {
      pos = a.position + ((phase - a.time) / (b.time - a.time)) * (b.position - a.position);
      vel = (b.position - a.position) / (b.time - a.time);
    }
    return [clamp(pos, 0, 1), vel];
  }

  position(time) {
    return this.positionAndVelocity(time)[0];
  }

  /** The same shape repeated `repeats` times per cycle, as Howl's createRepeatedWave. */
  repeated(repeats, newName) {
    const points = [];
    const scale = 1 / repeats;
    for (let i = 0; i < repeats; i++) {
      for (const p of this.shape.points) {
        const t = p.time * scale + i * scale;
        if (t < 1) points.push([t, p.position, p.slope == null ? undefined : p.slope * repeats]);
      }
    }
    if (points.length < 2) points.push([1 - SMALL_AMOUNT, points[0][1], points[0][2]]);
    return new CyclicalWave(new WaveShape(newName, points, this.shape.interpolation));
  }
}

/** Shorthand: a CyclicalWave from a name, points and interpolation. */
export const wave = (name, points, interpolation = 'hermite') => new CyclicalWave(new WaveShape(name, points, interpolation));

/** Random per-cycle variation of speed or amplitude, eased in over part of the cycle. */
export class JitterHandler {
  constructor() {
    this.jitter = 0;
    this.easeIn = 0;
    this.reset();
  }

  setJitter(j) {
    this.jitter = clamp(j, 0, 1);
  }

  setEaseIn(e) {
    this.easeIn = clamp(e, 0, 1);
  }

  factor() {
    return this.jitter === 0 ? 1 : 1 + randomInRange([-this.jitter, this.jitter]);
  }

  update(time) {
    const cycle = Math.floor(time);
    if (cycle === this.lastCycle) return;
    if (this.lastCycle === -1) {
      this.previous = this.current = this.factor();
    } else {
      this.previous = this.current;
      this.current = this.factor();
    }
    this.lastCycle = cycle;
  }

  reset() {
    this.lastCycle = -1;
    this.previous = 1;
    this.current = 1;
  }

  interpolated(time) {
    const phase = time % 1;
    const weight = this.easeIn === 0 ? 1 : clamp(phase / this.easeIn, 0, 1);
    return clamp(this.previous + (this.current - this.previous) * weight, 1 - this.jitter, 1 + this.jitter);
  }
}

/** Plays named waves at a shared, smoothly changing speed, with optional stop points. Howl's WaveManager. */
export class WaveManager {
  constructor() {
    this.waves = new Map();
    this.currentTime = 0;
    this.baseAmplitude = 1;
    this.baseSpeed = new NiceSmoother(1, [0.01, 10]);
    this.isStopped = false;
    this.stopTargetCycle = null;
    this.stopCallback = null;
    this.amplitudeJitter = new JitterHandler();
    this.speedJitter = new JitterHandler();
  }

  get currentAmplitude() {
    const j = this.amplitudeJitter.jitter;
    // Leave room for the jitter so it never has to clip
    const base = j === 0 ? this.baseAmplitude : this.baseAmplitude / (1 + j);
    return clamp(base * this.amplitudeJitter.interpolated(this.currentTime), 0, 1);
  }

  get currentSpeed() {
    return this.baseSpeed.value * this.speedJitter.interpolated(this.currentTime);
  }

  addWave(w, name = w.name) {
    this.waves.set(name, w);
  }

  getWave(name) {
    const w = this.waves.get(name);
    if (!w) throw new Error(`Wave '${name}' not found`);
    return w;
  }

  update(dt) {
    if (this.isStopped) return;
    this.baseSpeed.update(dt);
    const step = dt * this.currentSpeed;
    if (this.stopTargetCycle !== null && this.currentTime + step >= this.stopTargetCycle) {
      this.currentTime = this.stopTargetCycle;
      this.isStopped = true;
      this.stopCallback?.();
    } else {
      this.currentTime += step;
    }
    this.amplitudeJitter.update(this.currentTime);
    this.speedJitter.update(this.currentTime);
  }

  positionAndVelocity(name, { applyAmplitude = false, clampResult = true, offset = 0 } = {}) {
    const [p, v] = this.getWave(name).positionAndVelocity(this.currentTime + offset);
    const posScale = applyAmplitude ? this.currentAmplitude : 1;
    const velScale = applyAmplitude ? this.currentAmplitude * this.currentSpeed : this.currentSpeed;
    const pos = posScale * p;
    return [clampResult ? clamp(pos, 0, 1) : pos, velScale * v];
  }

  position(name, { applyAmplitude = false, clampResult = true, offset = 0 } = {}) {
    const scale = applyAmplitude ? this.currentAmplitude : 1;
    const r = scale * this.getWave(name).position(this.currentTime + offset);
    return clampResult ? clamp(r, 0, 1) : r;
  }

  stopAtEndOfCycle(callback) {
    this.stopTargetCycle = Math.floor(this.currentTime + 1);
    this.stopCallback = callback;
  }

  stopAfterIterations(iterations, callback) {
    this.stopTargetCycle = Math.floor(this.currentTime + iterations);
    this.stopCallback = callback;
  }

  restart() {
    this.stopTargetCycle = null;
    this.isStopped = false;
    this.currentTime = 0;
    this.amplitudeJitter.reset();
    this.speedJitter.reset();
  }

  setSpeed(s) {
    this.baseSpeed.setImmediately(s);
  }

  setAmplitude(a) {
    this.baseAmplitude = a;
  }

  setAmplitudeJitter(j) {
    this.amplitudeJitter.setJitter(j);
  }

  setSpeedJitter(j) {
    this.speedJitter.setJitter(j);
  }

  setAmplitudeJitterEaseIn(e) {
    this.amplitudeJitter.setEaseIn(e);
  }

  setSpeedJitterEaseIn(e) {
    this.speedJitter.setEaseIn(e);
  }

  setTargetSpeed(target, rate = null, onReached = null) {
    this.baseSpeed.setTarget(target, rate, onReached);
  }

  get targetSpeed() {
    return this.baseSpeed.target;
  }
}

/** Base class: an activity runs components each step and turns its state into a pulse. */
export class Activity {
  constructor(ctx) {
    this.ctx = ctx; // { settings: persisted activity options, positionalCurve: () => number }
    this.manager = new ActivityManager();
  }

  initialise() {}

  runSimulation(dt) {
    this.manager.update(dt);
  }

  /** @returns {{ampA:number, ampB:number, freqA:number, freqB:number}} */
  getPulse() {
    throw new Error('not implemented');
  }

  /** Splits amplitude by position using the shared positional curve. */
  positional(amplitude, position, strength = 1) {
    return positionalEffect(amplitude, position, strength, this.ctx.positionalCurve());
  }

  /** Controls saved between sessions, shown under "Available for random select". */
  permanentControls() {
    return [];
  }

  /** Controls for this run only (usually a Manual control switch and what it unlocks). */
  temporaryControls() {
    return [];
  }
}
