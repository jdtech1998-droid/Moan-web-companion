// The page side of the audio outputs: owns the AudioContext and worklet, and turns the page's pulses into the
// audio pulses AudioCore plays. Howl's per-output frequency limits apply here: Continuous maps pulse frequency onto
// its own tone range, Wavelet and Multi-pulse use the page's frequency range, clamped to their limits.

import { AUDIO_TYPES } from './audiodsp.js';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class AudioOut {
  constructor() {
    this.type = 'OFF';
    this.ctx = null;
    this.node = null;
  }

  get active() {
    return this.type !== 'OFF' && !!this.node;
  }

  /**
   * Switches output type. Starting one needs a user gesture (browsers keep audio off until the page is used).
   * @param {'OFF'|'CONTINUOUS'|'WAVELET'|'MULTIPULSE'} type
   * @param {object} settings the saved audio settings (settings.audio)
   */
  async setType(type, settings) {
    if (type === 'OFF') {
      this.type = 'OFF';
      this.stopNow();
      await this.ctx?.close();
      this.ctx = null;
      this.node = null;
      return;
    }
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(ctx, 'moan-audio', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(ctx.destination);
      this.ctx = ctx;
    }
    await this.ctx.resume();
    this.type = type;
    this.configure(settings);
  }

  /** Sends the current settings; call after any change. */
  configure(settings) {
    this.node?.port.postMessage({ type: 'config', output: this.type, settings });
  }

  /**
   * One 100ms batch of pulses (0-1 values, after tweaks and calibration), the power levels, and whether
   * anything is playing (the output fades in and out on that, as Howl's does).
   */
  send(pulses, power, playing, freqRange, settings) {
    if (!this.active) return;
    const toHz = this.hzMapper(freqRange, settings);
    this.node.port.postMessage({ type: 'playing', value: playing });
    this.node.port.postMessage({
      type: 'pulses',
      pulses: pulses.map(p => ({
        ampA: p.ampA, ampB: p.ampB, freqAHz: toHz(p.freqA), freqBHz: toHz(p.freqB), powerA: power[0], powerB: power[1],
      })),
    });
  }

  hzMapper(freqRange, settings) {
    if (this.type === 'CONTINUOUS') {
      const { minFrequency, maxFrequency } = settings.continuous;
      return f => minFrequency + (maxFrequency - minFrequency) * f;
    }
    const [lo, hi] = AUDIO_TYPES[this.type].freqLimits;
    const [fMin, fMax] = freqRange;
    return f => clamp(fMin + (fMax - fMin) * f, lo, hi);
  }

  /** E-STOP: silence now, without the usual half-second fade. */
  stopNow() {
    this.node?.port.postMessage({ type: 'stopNow' });
  }
}
