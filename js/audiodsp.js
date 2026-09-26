// Audio outputs for stereostim and audio-driven boxes, ported from Howl's OutputContinuous.kt, OutputWavelet.kt,
// OutputMultiPulse.kt and AudioEngine.kt. Pure sample generation with no browser APIs, so it runs both in the
// AudioWorklet (audio-worklet.js) and in the unit tests. Channel A is the left channel, B the right.
//
// A pulse here is { ampA, ampB (0-1), freqAHz, freqBHz, powerA, powerB (0-200) }. The page's power scales the
// signal (power / 200), unless an output's "Always full volume" is on, as in Howl.

export const BLOCK_SECONDS = 0.025; // one pulse per block: Howl's 40Hz main loop
const FADE_SECONDS = 0.5; // Howl's AudioEngine fade in/out on play and stop
const QUEUE_CAPACITY = 8; // two 100ms batches of 4 pulses; the oldest are dropped past this
// Web-only guard: the page's timers can stall (e.g. a throttled background tab). Rather than hold the last pulse
// forever, as Howl can on Android, play silence once no pulse has arrived for this many blocks (250ms).
export const STARVED_BLOCKS = 10;

export const WAVE_SHAPES = [['SINE', 'Sine'], ['SQUARE', 'Square'], ['TRIANGLE', 'Triangle'], ['TRAPEZOID', 'Trapezoid']];

export const AUDIO_TYPES = {
  CONTINUOUS: {
    name: 'Audio (continuous)',
    description: 'Produces continuous tones for devices with their own audio processing (e.g. units that respond to music).',
    warning: 'WARNING: Do not use with directly driven devices such as DIY stereostim or the Tingler (many available frequency range choices are unsafe for these units).',
  },
  WAVELET: {
    name: 'Audio (wavelet)',
    description: 'Produces wavelets for stereostim devices. The wavelet technique uses discrete bursts of pulses from a fast carrier wave. It aims to provide similar sensation to traditional audio techniques, while reducing the energy transmitted.',
    warning: null,
    freqLimits: [1, 200],
  },
  MULTIPULSE: {
    name: 'Audio (multipulse)',
    description: "An experimental audio output technique for stereostim devices. It's inspired by how pulse based units work, but uses bursts of multiple pulses rather than individual ones.",
    warning: 'WARNING: Multipulse output is at an early testing stage, so it is only for experienced stereostim users.',
    freqLimits: [1, 100],
  },
};

export const AUDIO_DEFAULTS = {
  continuous: { fullVolume: false, minFrequency: 500, maxFrequency: 1000, waveShape: 'SINE' },
  wavelet: { fullVolume: false, carrierShape: 'SINE', carrierFrequency: 1000, waveletWidth: 5, waveletFade: 0.5 },
  multipulse: { fullVolume: false, lowFreqPulses: 10, highFreqPulses: 3, pulseWidth: 600, intraPulseDelay: 50, interPulseDelay: 200, preventInterference: false },
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const lerp = (a, b, t) => a + (b - a) * t;
const TWO_PI = 2 * Math.PI;

const wrap01 = phase => {
  const n = phase / TWO_PI;
  return n - Math.floor(n);
};
const triangle = phase => 1 - 4 * Math.abs(wrap01(phase) - 0.5);

/** Howl's AudioWaveShape.sample: a value in [-1, 1] for a phase in radians. */
export function waveSample(shape, phase) {
  switch (shape) {
    case 'SQUARE': return wrap01(phase) < 0.5 ? 1 : -1;
    case 'TRIANGLE': return triangle(phase);
    case 'TRAPEZOID': {
      const tri = triangle(phase);
      const duty = 0.25;
      return tri > duty ? 1 : tri < -duty ? -1 : tri / duty;
    }
    default: return Math.sin(phase);
  }
}

/** power / 200, or 1 with "Always full volume". */
const powerScale = (power, fullVolume) => (fullVolume ? 1 : clamp(power / 200, 0, 1));

export const SILENT_PULSE = Object.freeze({ ampA: 0, ampB: 0, freqAHz: 0, freqBHz: 0, powerA: 0, powerB: 0 });

// ---- Continuous -----------------------------------------------------------------------------------

/** An unbroken tone per channel, frequency and amplitude interpolated between successive pulses. */
export class ContinuousGen {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.phaseA = 0;
    this.phaseB = 0;
    this.lastPulse = SILENT_PULSE;
  }

  fill(buffer, frameCount, pulse, s) {
    const start = this.lastPulse;
    const end = pulse;
    this.lastPulse = end;
    const k = TWO_PI / this.sr;
    const inv = frameCount > 1 ? 1 / (frameCount - 1) : 0;
    const powerA = powerScale(end.powerA, s.fullVolume);
    const powerB = powerScale(end.powerB, s.fullVolume);
    let idx = 0;
    for (let f = 0; f < frameCount; f++) {
      const t = f * inv;
      buffer[idx++] = waveSample(s.waveShape, this.phaseA) * lerp(start.ampA, end.ampA, t) * powerA;
      buffer[idx++] = waveSample(s.waveShape, this.phaseB) * lerp(start.ampB, end.ampB, t) * powerB;
      this.phaseA += k * lerp(start.freqAHz, end.freqAHz, t);
      this.phaseB += k * lerp(start.freqBHz, end.freqBHz, t);
    }
    this.phaseA %= TWO_PI;
    this.phaseB %= TWO_PI;
  }
}

// ---- Wavelet --------------------------------------------------------------------------------------

const MINIMUM_REST_SAMPLES = 100;

/** Rough share of time a wavelet is on at a 100Hz pulse rate, as Howl's settings screen shows it. */
export const waveletDutyAt100Hz = s => clamp(Math.round((((1 / s.carrierFrequency) * s.waveletWidth) / 0.01) * 100), 0, 100);

/** Each pulse fires a short burst of a carrier wave; the gap between bursts sets the pulse frequency. */
export class WaveletGen {
  constructor(sampleRate, random = Math.random) {
    this.sr = sampleRate;
    this.random = random;
    this.a = WaveletGen.channel();
    this.b = WaveletGen.channel();
  }

  static channel() {
    return { stage: 'REST', counter: 0, length: 0, amplitude: 0, fade: 0, phase: 0 };
  }

  fill(buffer, frameCount, pulse, s) {
    const phaseInc = (TWO_PI * s.carrierFrequency) / this.sr;
    const ampA = clamp(pulse.ampA * powerScale(pulse.powerA, s.fullVolume), 0, 1);
    const ampB = clamp(pulse.ampB * powerScale(pulse.powerB, s.fullVolume), 0, 1);
    const length = s.carrierFrequency > 0 ? Math.max(1, Math.trunc(s.waveletWidth * (this.sr / s.carrierFrequency))) : 1;
    const restA = Math.max(MINIMUM_REST_SAMPLES, Math.round(this.sr / pulse.freqAHz - length));
    const restB = Math.max(MINIMUM_REST_SAMPLES, Math.round(this.sr / pulse.freqBHz - length));
    let idx = 0;
    for (let f = 0; f < frameCount; f++) {
      buffer[idx++] = this.sample(this.a, s.carrierShape, phaseInc, ampA, length, restA, s.waveletFade);
      buffer[idx++] = this.sample(this.b, s.carrierShape, phaseInc, ampB, length, restB, s.waveletFade);
    }
  }

  sample(ch, shape, phaseInc, amplitude, length, rest, fade) {
    ch.counter++;
    if (ch.stage === 'WAVELET') {
      const carrier = waveSample(shape, ch.phase);
      ch.phase += phaseInc;
      // Raised cosine fade in and out
      const n = ch.counter;
      const fadeLength = Math.trunc(ch.length * 0.5 * ch.fade);
      const sustainEnd = ch.length - fadeLength;
      const envelope = fadeLength === 0 ? 1
        : n <= fadeLength ? 0.5 * (1 - Math.cos((Math.PI * n) / fadeLength))
          : n >= sustainEnd ? 0.5 * (1 - Math.cos((Math.PI * (ch.length - n)) / fadeLength))
            : 1;
      if (n >= ch.length) {
        ch.stage = 'REST';
        ch.counter = 0;
      }
      return carrier * ch.amplitude * envelope;
    }
    // The rest length always follows the latest pulse; a wavelet's own settings are fixed once it starts
    if (ch.counter >= rest) {
      ch.stage = 'WAVELET';
      ch.counter = 0;
      ch.length = length;
      ch.amplitude = amplitude;
      ch.fade = fade;
      // A random starting phase for each burst reduces charge imbalance over time
      ch.phase = this.random() * TWO_PI;
    }
    return 0;
  }
}

// ---- Multi-pulse ----------------------------------------------------------------------------------

export const MIN_BURST_GAP_US = 2000;
const INTERFERENCE_GUARD_GAP_US = 500;

/** Howl's estimateBurst: duty cycle at a burst frequency, and whether the burst fits in its period. */
export function estimateBurst(burstHz, s) {
  const t = clamp((burstHz - 1) / 99, 0, 1);
  const count = clamp(Math.round(s.lowFreqPulses + (s.highFreqPulses - s.lowFreqPulses) * t),
    Math.min(s.lowFreqPulses, s.highFreqPulses), Math.max(s.lowFreqPulses, s.highFreqPulses));
  const periodUs = 1e6 / burstHz;
  const burstUs = count * (2 * s.pulseWidth + s.intraPulseDelay) + (count - 1) * s.interPulseDelay;
  const duty = clamp((count * 2 * s.pulseWidth) / periodUs, 0, 1);
  return { dutyCyclePercent: Math.round(duty * 100), burstFits: burstUs + MIN_BURST_GAP_US <= periodUs };
}

/** Bursts of charge-balanced square pulses (a positive half then an equal negative half, or the reverse). */
export class MultiPulseGen {
  constructor(sampleRate, random = Math.random) {
    this.sr = sampleRate;
    this.random = random;
    this.a = MultiPulseGen.channel();
    this.b = MultiPulseGen.channel();
    this.anyBurstActive = false;
    this.samplesSinceAnyBurstEnd = 0;
    this.lastFired = -1;
  }

  static channel() {
    return {
      phase: 'IDLE', counter: 0, remaining: 0, sinceStart: 0, sinceEnd: 0,
      polarity: 1, amplitude: 0, widthSamples: 0, intraSamples: 0, interSamples: 0,
    };
  }

  us(microseconds) {
    return Math.trunc((microseconds * this.sr) / 1e6);
  }

  fill(buffer, frameCount, pulse, s) {
    const ampA = clamp(pulse.ampA * powerScale(pulse.powerA, s.fullVolume), 0, 1);
    const ampB = clamp(pulse.ampB * powerScale(pulse.powerB, s.fullVolume), 0, 1);
    const periodA = pulse.freqAHz > 0 ? Math.round(this.sr / pulse.freqAHz) : Infinity;
    const periodB = pulse.freqBHz > 0 ? Math.round(this.sr / pulse.freqBHz) : Infinity;
    const minGap = this.us(MIN_BURST_GAP_US);
    const guardGap = this.us(INTERFERENCE_GUARD_GAP_US);
    const prevent = s.preventInterference;
    let idx = 0;
    for (let f = 0; f < frameCount; f++) {
      if (!this.anyBurstActive) this.samplesSinceAnyBurstEnd++;
      let sa;
      let sb;
      // With interference prevention, the channel that didn't fire last gets the first chance to start
      if (prevent && this.lastFired === 0) {
        sb = this.advance(this.b, periodB, minGap, ampB, pulse.freqBHz, guardGap, prevent, 1, s);
        sa = this.advance(this.a, periodA, minGap, ampA, pulse.freqAHz, guardGap, prevent, 0, s);
      } else {
        sa = this.advance(this.a, periodA, minGap, ampA, pulse.freqAHz, guardGap, prevent, 0, s);
        sb = this.advance(this.b, periodB, minGap, ampB, pulse.freqBHz, guardGap, prevent, 1, s);
      }
      buffer[idx++] = sa;
      buffer[idx++] = sb;
    }
  }

  advance(ch, period, minGap, amplitude, burstHz, guardGap, prevent, id, s) {
    ch.sinceStart++;
    switch (ch.phase) {
      case 'IDLE': {
        ch.sinceEnd++;
        const crossOk = !prevent || (!this.anyBurstActive && this.samplesSinceAnyBurstEnd >= guardGap);
        if (ch.sinceStart >= period && ch.sinceEnd >= minGap && crossOk) {
          this.startBurst(ch, amplitude, burstHz, id, s);
          this.anyBurstActive = true;
          ch.phase = 'FIRST_HALF';
          ch.counter = 1;
          return ch.polarity * ch.amplitude;
        }
        return 0;
      }
      case 'FIRST_HALF':
        ch.counter++;
        if (ch.counter > ch.widthSamples) {
          ch.phase = 'INTRA_DELAY';
          ch.counter = 1;
          return 0;
        }
        return ch.polarity * ch.amplitude;
      case 'INTRA_DELAY':
        ch.counter++;
        if (ch.counter > ch.intraSamples) {
          ch.phase = 'SECOND_HALF';
          ch.counter = 1;
          return -ch.polarity * ch.amplitude;
        }
        return 0;
      case 'SECOND_HALF':
        ch.counter++;
        if (ch.counter > ch.widthSamples) {
          ch.remaining--;
          if (ch.remaining > 0) {
            ch.phase = 'INTER_DELAY';
            ch.counter = 1;
          } else {
            ch.phase = 'IDLE';
            ch.counter = 0;
            ch.sinceEnd = 0;
            this.anyBurstActive = false;
            this.samplesSinceAnyBurstEnd = 0;
          }
          return 0;
        }
        return -ch.polarity * ch.amplitude;
      default: // INTER_DELAY
        ch.counter++;
        if (ch.counter > ch.interSamples) {
          ch.phase = 'FIRST_HALF';
          ch.counter = 1;
          return ch.polarity * ch.amplitude;
        }
        return 0;
    }
  }

  /** Fixes a burst's settings when it starts, so it runs unchanged whatever arrives mid-burst. */
  startBurst(ch, amplitude, burstHz, id, s) {
    const t = clamp((burstHz - 1) / 99, 0, 1);
    const raw = s.lowFreqPulses + (s.highFreqPulses - s.lowFreqPulses) * t;
    const floor = Math.trunc(raw);
    // Fractional counts dither between the two nearest whole numbers
    const count = clamp(this.random() < raw - floor ? floor + 1 : floor,
      Math.min(s.lowFreqPulses, s.highFreqPulses), Math.max(s.lowFreqPulses, s.highFreqPulses));
    ch.remaining = count;
    ch.polarity = this.random() < 0.5 ? 1 : -1;
    ch.amplitude = amplitude;
    ch.widthSamples = Math.max(1, this.us(s.pulseWidth));
    ch.intraSamples = this.us(s.intraPulseDelay);
    ch.interSamples = this.us(s.interPulseDelay);
    ch.sinceStart = 0;
    this.lastFired = id;
  }
}

// ---- Engine ---------------------------------------------------------------------------------------

const GENERATORS = { CONTINUOUS: ContinuousGen, WAVELET: WaveletGen, MULTIPULSE: MultiPulseGen };
const SETTINGS_KEY = { CONTINUOUS: 'continuous', WAVELET: 'wavelet', MULTIPULSE: 'multipulse' };

/**
 * Howl's AudioEngine without Android: turns queued pulses into stereo samples one 25ms block at a time, fading
 * in over 0.5s when playback starts and out when it stops. Runs inside the AudioWorklet.
 */
export class AudioCore {
  constructor(sampleRate, random = Math.random) {
    this.sr = sampleRate;
    this.random = random;
    this.blockFrames = Math.round(BLOCK_SECONDS * sampleRate);
    this.block = new Float32Array(this.blockFrames * 2);
    this.blockPos = this.blockFrames; // empty: the first render fills a block
    this.fadeStep = this.blockFrames / (FADE_SECONDS * sampleRate);
    this.volume = 0;
    this.playing = false;
    this.queue = [];
    this.lastPulse = SILENT_PULSE;
    this.starved = STARVED_BLOCKS;
    this.type = null;
    this.gen = null;
    this.settings = null;
  }

  /** Messages from the page: pulses, playing, config and stopNow. */
  handle(msg) {
    if (msg.type === 'pulses') this.push(msg.pulses);
    else if (msg.type === 'playing') this.playing = msg.value;
    else if (msg.type === 'config') this.configure(msg.output, msg.settings);
    else if (msg.type === 'stopNow') this.stopNow();
  }

  configure(type, allSettings) {
    if (type !== this.type) {
      this.type = GENERATORS[type] ? type : null;
      this.gen = this.type ? new GENERATORS[this.type](this.sr, this.random) : null;
    }
    this.settings = this.type ? allSettings[SETTINGS_KEY[this.type]] : null;
  }

  push(pulses) {
    for (const p of pulses) this.queue.push(p);
    while (this.queue.length > QUEUE_CAPACITY) this.queue.shift();
    this.starved = 0;
  }

  /** E-STOP: silent at once, no fade, and nothing queued left to play. */
  stopNow() {
    this.playing = false;
    this.volume = 0;
    this.queue.length = 0;
    this.lastPulse = SILENT_PULSE;
    this.block.fill(0);
    this.blockPos = this.blockFrames;
  }

  nextBlock() {
    let pulse = this.queue.shift();
    if (pulse) {
      this.lastPulse = pulse;
    } else if (++this.starved >= STARVED_BLOCKS) {
      pulse = this.lastPulse = SILENT_PULSE;
    } else {
      pulse = this.lastPulse; // brief gaps: hold the last pulse, as Howl does
    }
    const start = this.volume;
    const target = this.playing ? 1 : 0;
    this.volume += clamp(target - this.volume, -this.fadeStep, this.fadeStep);
    const end = this.volume;
    if (!this.gen || (start === 0 && end === 0)) {
      this.block.fill(0);
    } else {
      this.gen.fill(this.block, this.blockFrames, pulse, this.settings);
      if (start < 1 || end < 1) {
        const step = (end - start) / this.blockFrames;
        let v = start;
        for (let f = 0; f < this.blockFrames; f++) {
          this.block[f * 2] *= v;
          this.block[f * 2 + 1] *= v;
          v += step;
        }
      }
    }
    this.blockPos = 0;
  }

  /** Fills the worklet's output arrays (left = A, right = B). */
  render(left, right) {
    for (let i = 0; i < left.length; i++) {
      if (this.blockPos >= this.blockFrames) this.nextBlock();
      left[i] = clamp(this.block[this.blockPos * 2], -1, 1);
      right[i] = clamp(this.block[this.blockPos * 2 + 1], -1, 1);
      this.blockPos++;
    }
  }
}
