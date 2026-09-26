// DG-LAB Coyote 3 over Web Bluetooth. A port of OutputCoyote3.kt.

import { buildB0, buildBF, parseB1 } from './protocol.js';

const uuid = short => `0000${short}-0000-1000-8000-00805f9b34fb`;
const MAIN_SERVICE = uuid('180c');
const WRITE_CHAR = uuid('150a');
const NOTIFY_CHAR = uuid('150b');
const BATTERY_SERVICE = uuid('180a');
const BATTERY_CHAR = uuid('1500');

// Battery reads can collide with pulse writes; the odd interval keeps that from repeating every time
const BATTERY_POLL_MS = 60020;

export const bluetoothSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export const COYOTE3_NAME_PREFIX = '47L121';
export const COYOTE3_SERVICES = [MAIN_SERVICE, BATTERY_SERVICE];

export class Coyote3 {
  constructor() {
    this.model = 'Coyote 3';
    this.device = null;
    this.writeChar = null;
    this.ready = false;
    this.battery = null;
    this.previousPowerA = -1;
    this.previousPowerB = -1;
    this.writing = false;
    /** @type {(status:string)=>void} */ this.onStatus = () => {};
    /** @type {(a:number, b:number)=>void} called when the power wheel on the box is turned */ this.onDevicePower = () => {};
    /** @type {(pct:number)=>void} */ this.onBattery = () => {};
  }

  /** @param {BluetoothDevice} device chosen in the browser's device picker */
  async connect(device) {
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());

    this.onStatus('Connecting');
    const server = await device.gatt.connect();
    const main = await server.getPrimaryService(MAIN_SERVICE);
    this.writeChar = await main.getCharacteristic(WRITE_CHAR);
    const notify = await main.getCharacteristic(NOTIFY_CHAR);
    await notify.startNotifications();
    notify.addEventListener('characteristicvaluechanged', e => this.handleNotify(new Uint8Array(e.target.value.buffer)));

    try {
      const batteryService = await server.getPrimaryService(BATTERY_SERVICE);
      this.batteryChar = await batteryService.getCharacteristic(BATTERY_CHAR);
      this.pollBattery();
      this.batteryTimer = setInterval(() => this.pollBattery(), BATTERY_POLL_MS);
    } catch (e) {
      console.warn('Coyote battery service unavailable', e);
    }

    this.previousPowerA = -1;
    this.previousPowerB = -1;
    this.ready = true;
    this.onStatus('Connected');
  }

  async disconnect() {
    if (this.ready) {
      // Leave the box silent and at zero power rather than on its last packet
      await this.sendPulses(0, 0, SILENT_BATCH, true).catch(() => {});
    }
    this.device?.gatt?.disconnect();
    this.handleDisconnect();
  }

  handleDisconnect() {
    if (!this.device) return;
    clearInterval(this.batteryTimer);
    this.ready = false;
    this.writeChar = null;
    this.batteryChar = null;
    this.device = null;
    this.battery = null;
    this.onStatus('Disconnected');
  }

  /** Sends the power limits (the Rider's MAX). The box will not output above them whatever B0 asks for. */
  async syncLimits(limitA, limitB, settings) {
    if (!this.ready) return;
    await this.queueWrite(buildBF(limitA, limitB, settings), true);
  }

  /**
   * Sends one 100ms batch: 4 pulses of {freqAHz, ampA, freqBHz, ampB}, with the current power levels.
   * Dropped if the previous write is still in flight, like the fire-and-forget write on Android.
   */
  async sendPulses(powerA, powerB, pulses, force = false) {
    if (!this.ready) return;
    if (this.writing && !force) return;
    const changed = powerA !== this.previousPowerA || powerB !== this.previousPowerB;
    const packet = buildB0(powerA, powerB, changed, pulses);
    try {
      await this.queueWrite(packet, false);
      if (changed) {
        this.previousPowerA = powerA;
        this.previousPowerB = powerB;
      }
    } catch (e) {
      console.warn('Pulse send failed', e.message);
    }
  }

  async queueWrite(bytes, withResponse) {
    // Web Bluetooth rejects a second GATT operation while one is running, so wait for the current one
    while (this.writing) await new Promise(r => setTimeout(r, 5));
    if (!this.writeChar) return;
    this.writing = true;
    try {
      if (withResponse) await this.writeChar.writeValueWithResponse(bytes);
      else await this.writeChar.writeValueWithoutResponse(bytes);
    } finally {
      this.writing = false;
    }
  }

  handleNotify(bytes) {
    const b1 = parseB1(bytes);
    if (!b1) return;
    this.previousPowerA = b1.powerA;
    this.previousPowerB = b1.powerB;
    if (b1.fromDevice) this.onDevicePower(b1.powerA, b1.powerB);
  }

  async pollBattery() {
    if (!this.batteryChar || this.writing) return;
    try {
      this.writing = true;
      const value = await this.batteryChar.readValue();
      this.battery = value.getUint8(0);
      this.onBattery(this.battery);
    } catch (e) {
      console.warn('Battery poll failed', e.message);
    } finally {
      this.writing = false;
    }
  }
}

const SILENT_BATCH = Array(4).fill({ freqAHz: 10, ampA: 0, freqBHz: 10, ampB: 0 });
