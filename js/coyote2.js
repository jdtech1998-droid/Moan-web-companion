// DG-LAB Coyote 2 over Web Bluetooth. A port of OutputCoyote2.kt.
// The Coyote 2 takes 10 waveform updates a second per channel. As in Howl, the page sends it 20 pulses a second
// and alternates channels, so each channel updates every 100ms but the two are 50ms apart, which feels less sluggish.
// It has no hardware power limit like the Coyote 3's BF command: the page's own power clamp is the only limit.

const uuid = short => `955a${short}-0fe2-f5aa-a094-84b8d4f3e8ad`;
const BATTERY_SERVICE = uuid('180a');
const MAIN_SERVICE = uuid('180b');
const BATTERY_CHAR = uuid('1500');
const POWER_CHAR = uuid('1504');
const PATTERN_A_CHAR = uuid('1506');
const PATTERN_B_CHAR = uuid('1505');

export const COYOTE2_NAME = 'D-LAB ESTIM01';
export const COYOTE2_SERVICES = [MAIN_SERVICE, BATTERY_SERVICE];
export const COYOTE2_FREQ_LIMITS = [1, 200]; // Hz

const BATTERY_POLL_MS = 60020;
const MAX_Z = 20; // pulse width steps; the docs say above 20 is more likely to sting, and testers agreed
const POWER_SCALE = 7; // device power 0-2047 = page power x 7, matching the DG app and the box's own buttons
const INTERLEAVE_MS = 50;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const threeBytes = packed => Uint8Array.of(packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff);

/** Power levels as the 3-byte little-endian power command: A in bits 21-11, B in bits 10-0. */
export function encodePower(powerA, powerB) {
  const a = clamp(powerA * POWER_SCALE, 0, 2047);
  const b = clamp(powerB * POWER_SCALE, 0, 2047);
  return threeBytes((a << 11) | b);
}

/** A power notification back to page power levels, or null if malformed. */
export function decodePower(data) {
  if (data.length !== 3) return null;
  const packed = data[0] | (data[1] << 8) | (data[2] << 16);
  return [Math.floor(((packed >> 11) & 0x7ff) / POWER_SCALE), Math.floor((packed & 0x7ff) / POWER_SCALE)];
}

/**
 * Howl's frequencyHzToXY: X ms of pulses then a Y ms gap, so the pulse rate is 1000 / (X + Y) Hz.
 * Longer X at low frequencies, loosely following DG-LAB's formula.
 */
export function frequencyToXY(hz) {
  const x = clamp(Math.round(Math.sqrt(1 / hz) * 15), 1, 31);
  const y = clamp(Math.round(1000 / hz) - x, 0, 1023);
  return [x, y];
}

/** Amplitude 0-1 to the pulse width parameter Z (width = Z x 5 microseconds), capped at 20. */
export const amplitudeToZ = amp => clamp(Math.round(MAX_Z * amp), 0, MAX_Z);

/** One channel's waveform as 3 little-endian bytes: Z in bits 19-15, Y in bits 14-5, X in bits 4-0. */
export function encodeWaveform(x, y, z) {
  return threeBytes((clamp(z, 0, 31) << 15) | (clamp(y, 0, 1023) << 5) | clamp(x, 0, 31));
}

const waveform = (hz, amp) => encodeWaveform(...frequencyToXY(clamp(hz, ...COYOTE2_FREQ_LIMITS)), amplitudeToZ(amp));

export class Coyote2 {
  constructor() {
    this.model = 'Coyote 2';
    this.device = null;
    this.chars = null;
    this.ready = false;
    this.battery = null;
    this.previousPowerA = -1;
    this.previousPowerB = -1;
    this.writing = false;
    /** @type {(status:string)=>void} */ this.onStatus = () => {};
    /** @type {(a:number, b:number)=>void} called when the power is changed on the box */ this.onDevicePower = () => {};
    /** @type {(pct:number)=>void} */ this.onBattery = () => {};
  }

  /** @param {BluetoothDevice} device chosen in the browser's device picker */
  async connect(device) {
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
    this.onStatus('Connecting');
    const server = await device.gatt.connect();
    const main = await server.getPrimaryService(MAIN_SERVICE);
    this.chars = {
      power: await main.getCharacteristic(POWER_CHAR),
      patternA: await main.getCharacteristic(PATTERN_A_CHAR),
      patternB: await main.getCharacteristic(PATTERN_B_CHAR),
    };
    await this.chars.power.startNotifications();
    this.chars.power.addEventListener('characteristicvaluechanged', e => this.handlePower(new Uint8Array(e.target.value.buffer)));

    try {
      const batteryService = await server.getPrimaryService(BATTERY_SERVICE);
      this.batteryChar = await batteryService.getCharacteristic(BATTERY_CHAR);
      this.pollBattery();
      this.batteryTimer = setInterval(() => this.pollBattery(), BATTERY_POLL_MS);
    } catch (e) {
      console.warn('Coyote 2 battery service unavailable', e);
    }

    this.previousPowerA = -1;
    this.previousPowerB = -1;
    this.ready = true;
    this.onStatus('Connected');
  }

  async disconnect() {
    if (this.ready) {
      clearTimeout(this.interleaveTimer);
      // Leave the box at zero power rather than on its last level
      await this.queueWrite(this.chars.power, encodePower(0, 0), true).catch(() => {});
    }
    this.device?.gatt?.disconnect();
    this.handleDisconnect();
  }

  handleDisconnect() {
    if (!this.device) return;
    clearInterval(this.batteryTimer);
    clearTimeout(this.interleaveTimer);
    this.ready = false;
    this.chars = null;
    this.batteryChar = null;
    this.device = null;
    this.battery = null;
    this.onStatus('Disconnected');
  }

  /** The Coyote 2 has no hardware limit; the page clamps power to its limits before it gets here. */
  async syncLimits() {}

  /**
   * Called every 100ms with 4 pulses of {freqAHz, ampA, freqBHz, ampB} and the power levels. Like Howl's pulse
   * divider of 2, it uses every second pulse: channel A from the second now, channel B from the fourth 50ms later.
   */
  async sendPulses(powerA, powerB, pulses) {
    if (!this.ready) return;
    if (powerA !== this.previousPowerA || powerB !== this.previousPowerB) {
      try {
        await this.queueWrite(this.chars.power, encodePower(powerA, powerB), true);
        this.previousPowerA = powerA;
        this.previousPowerB = powerB;
      } catch (e) {
        console.warn('Coyote 2 power write failed', e.message);
      }
    }
    const [, a, , b] = pulses;
    this.writePattern(this.chars?.patternA, waveform(a.freqAHz, a.ampA));
    clearTimeout(this.interleaveTimer);
    this.interleaveTimer = setTimeout(() => this.writePattern(this.chars?.patternB, waveform(b.freqBHz, b.ampB)), INTERLEAVE_MS);
  }

  async writePattern(char, bytes) {
    // Fire and forget, like Howl's no-response pulse writes: a late pattern is worse than a dropped one
    if (!char || this.writing) return;
    await this.queueWrite(char, bytes, false).catch(e => console.warn('Coyote 2 pattern write failed', e.message));
  }

  async queueWrite(char, bytes, withResponse) {
    // Web Bluetooth rejects a second GATT operation while one is running, so wait for the current one
    while (this.writing) await new Promise(r => setTimeout(r, 5));
    if (!this.ready && !withResponse) return;
    this.writing = true;
    try {
      if (withResponse) await char.writeValueWithResponse(bytes);
      else await char.writeValueWithoutResponse(bytes);
    } finally {
      this.writing = false;
    }
  }

  handlePower(data) {
    const levels = decodePower(data);
    if (!levels) return;
    const [a, b] = levels;
    const changed = a !== this.previousPowerA || b !== this.previousPowerB;
    // Remember what the box has, so a level above the page's limit is written back down on the next send
    this.previousPowerA = a;
    this.previousPowerB = b;
    if (changed) this.onDevicePower(a, b);
  }

  async pollBattery() {
    if (!this.batteryChar || this.writing) return;
    try {
      this.writing = true;
      const value = await this.batteryChar.readValue();
      this.battery = value.getUint8(0);
      this.onBattery(this.battery);
    } catch (e) {
      console.warn('Coyote 2 battery poll failed', e.message);
    } finally {
      this.writing = false;
    }
  }
}
