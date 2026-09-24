// A small wave generator for the Driver, modeled on Howl's Generator tab: each channel has a power shape
// and a frequency shape that share one speed. Output pulses use 0-1 amplitude and 0-1 frequency.

/** Wave shapes: `cycles` is the total cycle count so far; each returns 0-1. */
export const SHAPES = {
  'Sine': c => 0.5 - 0.5 * Math.cos(2 * Math.PI * frac(c)),
  'Triangle': c => 1 - Math.abs(2 * frac(c) - 1),
  'Sawtooth': c => frac(c),
  'Reverse saw': c => 1 - frac(c),
  'Square': c => (frac(c) < 0.5 ? 1 : 0),
  'Fast attack': c => attack(frac(c), 0.1),
  'Gentle attack': c => attack(frac(c), 0.7),
  'Double time': c => 1 - Math.abs(2 * frac(2 * c) - 1),
  'Random': c => smoothNoise(c * 2),
  'Constant': () => 1,
};
export const SHAPE_NAMES = Object.keys(SHAPES);

export const SPEED_RANGE = [0.05, 3]; // cycles per second

export function defaultChannel() {
  return { shape: 'Sine', speed: 0.3, ampMin: 0.3, ampMax: 0.8, freqShape: 'Constant', freqMin: 0.4, freqMax: 0.6 };
}

export class Generator {
  constructor() {
    this.channels = [defaultChannel(), { ...defaultChannel(), shape: 'Triangle', speed: 0.23 }];
    this.cycles = [0, 0];
  }

  /** Advances by `dt` seconds and returns the pulse for that moment. */
  next(dt) {
    const out = [];
    for (let ch = 0; ch < 2; ch++) {
      const p = this.channels[ch];
      this.cycles[ch] += p.speed * dt;
      const c = this.cycles[ch];
      out.push({
        amp: lerp(p.ampMin, p.ampMax, SHAPES[p.shape](c)),
        // Different noise offset so a Random frequency doesn't mirror a Random power
        freq: lerp(p.freqMin, p.freqMax, SHAPES[p.freqShape](c + 17.3)),
      });
    }
    return { ampA: out[0].amp, freqA: out[0].freq, ampB: out[1].amp, freqB: out[1].freq };
  }

  randomize() {
    this.channels = [randomChannel(), randomChannel()];
  }
}

function randomChannel() {
  const ampMin = rand(0.1, 0.6);
  const freqA = Math.random();
  const freqB = Math.random();
  return {
    shape: pick(SHAPE_NAMES.filter(s => s !== 'Constant')),
    speed: round2(Math.exp(rand(Math.log(0.08), Math.log(2)))),
    ampMin: round3(ampMin),
    ampMax: round3(rand(Math.max(ampMin + 0.15, 0.6), 1)),
    freqShape: pick(SHAPE_NAMES),
    freqMin: round3(Math.min(freqA, freqB)),
    freqMax: round3(Math.max(freqA, freqB)),
  };
}

function attack(p, peak) {
  return p < peak ? p / peak : 1 - (p - peak) / (1 - peak);
}

function frac(x) {
  return x - Math.floor(x);
}

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(x) {
  const i = Math.floor(x);
  const t = 0.5 - 0.5 * Math.cos(Math.PI * (x - i));
  return lerp(hash(i), hash(i + 1), t);
}

const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = list => list[Math.floor(Math.random() * list.length)];
const round2 = x => Math.round(x * 100) / 100;
const round3 = x => Math.round(x * 1000) / 1000;
