// The audio thread side of the audio outputs: runs AudioCore (audiodsp.js) on the browser's audio thread.
import { AudioCore } from './audiodsp.js';

class MoanAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new AudioCore(sampleRate);
    this.port.onmessage = e => this.core.handle(e.data);
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    this.core.render(left, right ?? left);
    return true;
  }
}

registerProcessor('moan-audio', MoanAudioProcessor);
