// DG-LAB Paw Prints wireless button over Web Bluetooth. A port of PawPrintsProtocol.kt and InputDevicePawPrints.kt.
// The Paw runs in "physical data passthrough" mode: it reports its raw sensor state every 100ms and the page decides
// what the buttons do. It uses the same service and characteristics as the Coyote 3, under its own device name.

const uuid = short => `0000${short}-0000-1000-8000-00805f9b34fb`;
const SERVICE = uuid('180c');
const WRITE_CHAR = uuid('150a');
const NOTIFY_CHAR = uuid('150b');

export const PAW_DEVICE_NAME = '47L120300';
const INDICATOR_COLOR = 0x06; // green shoulder LED while connected

const CMD_CONFIGURE = 0x50;
const MODE_PASSTHROUGH = 0xd0;
const MSG_STATUS = 0x51;
const MSG_PHYSICAL = 0xd0;
const CONFIG_SIZE = 17;
const STATUS_SIZE = 4;
const PHYSICAL_SIZE = 9;

// The Paw reports every 100ms, so this much silence means the link is dead even if the browser hasn't noticed
const STALE_TIMEOUT_MS = 2000;
const WATCHDOG_INTERVAL_MS = 500;

/** "50 <colour> D0" plus 14 bytes of padding: report the raw sensor state every 100ms. */
export function passthroughConfig(indicatorColor = INDICATOR_COLOR) {
  const command = new Uint8Array(CONFIG_SIZE);
  command.set([CMD_CONFIGURE, indicatorColor, MODE_PASSTHROUGH]);
  return command;
}

/**
 * Decodes a notification from the Paw, or returns null for anything unused or too short.
 * @param {Uint8Array} data
 */
export function parsePawFrame(data) {
  if (!data.length) return null;
  const signed = i => (data[i] << 24) >> 24;
  if (data[0] === MSG_STATUS) {
    if (data.length < STATUS_SIZE) return null;
    return { type: 'status', indicatorColor: data[1], battery: Math.min(Math.max(data[3], 0), 100) };
  }
  if (data[0] === MSG_PHYSICAL) {
    if (data.length < PHYSICAL_SIZE) return null;
    return {
      type: 'physical', indicatorColor: data[1], sequence: data[2], buttons: data[3], acceleration: data[4],
      angleX: signed(5), angleY: signed(6), angleZ: signed(7), externalVoltage: data[8],
    };
  }
  return null;
}

/** The three button corners. A physical frame reports them as a sum of these masks. */
export const PAW_BUTTONS = [
  { id: 'right', mask: 0x01, label: 'Right button' },
  { id: 'left', mask: 0x02, label: 'Left button' },
  { id: 'top', mask: 0x04, label: 'Top button' },
];

export const PAW_ACTIONS = [
  ['NONE', 'Nothing'],
  ['E_STOP', 'Emergency stop'],
  ['MUTE_TOGGLE', 'Mute / unmute'],
  ['POWER_UP', 'Power up'],
  ['POWER_DOWN', 'Power down'],
];

/** Which action each corner does, saved with the page's settings. */
export const PAW_DEFAULTS = { top: 'E_STOP', left: 'POWER_DOWN', right: 'POWER_UP' };

/** What to do when `pressed` (button ids) go down together. An emergency stop always wins over anything pressed with it. */
export function actionsFor(settings, pressed) {
  const actions = pressed.map(id => settings[id]).filter(a => a && a !== 'NONE');
  return actions.includes('E_STOP') ? ['E_STOP'] : actions;
}

/**
 * Turns the raw button bitmask into press events. Nothing counts until the buttons have been seen all released
 * once: pairing needs a button held while connecting, and that must not be taken as a press.
 */
export class PawButtonTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.armed = false;
    this.previous = 0;
  }

  /** Returns the ids of the buttons that went from released to pressed with this frame. */
  update(state) {
    if (!this.armed) {
      if (state === 0) this.armed = true;
      return [];
    }
    const pressed = PAW_BUTTONS.filter(b => (state & b.mask) && !(this.previous & b.mask)).map(b => b.id);
    this.previous = state;
    return pressed;
  }
}

export class PawPrints {
  constructor() {
    this.device = null;
    this.writeChar = null;
    this.ready = false;
    this.battery = null;
    this.tracker = new PawButtonTracker();
    this.lastFrame = 0;
    this.expectDisconnect = false;
    /** @type {(status:string)=>void} */ this.onStatus = () => {};
    /** @type {(pct:number)=>void} */ this.onBattery = () => {};
    /** @type {(ids:string[])=>void} */ this.onPressed = () => {};
    /** @type {(reason:string)=>void} called when the Paw drops without the user asking */ this.onLost = () => {};
  }

  async connect() {
    this.onStatus('Scanning');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ name: PAW_DEVICE_NAME }],
      optionalServices: [SERVICE],
    });
    this.device = device;
    this.expectDisconnect = false;
    device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());

    this.onStatus('Connecting');
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    this.writeChar = await service.getCharacteristic(WRITE_CHAR);
    this.tracker.reset();
    // The Paw drops the connection if it isn't configured straight away, so this goes before anything else
    await this.writeChar.writeValueWithResponse(passthroughConfig());
    const notify = await service.getCharacteristic(NOTIFY_CHAR);
    await notify.startNotifications();
    notify.addEventListener('characteristicvaluechanged', e => this.handleFrame(parsePawFrame(new Uint8Array(e.target.value.buffer))));
    this.lastFrame = Date.now();
    this.watchdog = setInterval(() => this.checkStale(), WATCHDOG_INTERVAL_MS);
    // The Paw answers a configuration with its status (battery), but sent that before notifications were on.
    // Configuring again is harmless and gets the reply through.
    await this.writeChar.writeValueWithResponse(passthroughConfig()).catch(e => console.warn('Paw Prints did not report its status', e));

    this.ready = true;
    this.onStatus('Connected');
  }

  disconnect() {
    this.expectDisconnect = true;
    this.device?.gatt?.disconnect();
    this.handleDisconnect();
  }

  /**
   * A Paw that quietly stops reporting would leave the user believing its emergency stop still works.
   * Dropping the connection makes that visible.
   */
  checkStale() {
    if (Date.now() - this.lastFrame <= STALE_TIMEOUT_MS) return;
    console.warn(`No data from Paw Prints for ${STALE_TIMEOUT_MS}ms, disconnecting`);
    const device = this.device;
    this.handleDisconnect('stopped responding');
    device?.gatt?.disconnect();
  }

  handleDisconnect(reason = 'disconnected') {
    if (!this.device) return;
    clearInterval(this.watchdog);
    const wasReady = this.ready;
    this.ready = false;
    this.writeChar = null;
    this.device = null;
    this.battery = null;
    this.tracker.reset();
    this.onStatus('Disconnected');
    if (wasReady && !this.expectDisconnect) this.onLost(reason);
  }

  handleFrame(frame) {
    if (!frame) return;
    this.lastFrame = Date.now();
    if (frame.type === 'status') {
      this.battery = frame.battery;
      this.onBattery(frame.battery);
    } else {
      const pressed = this.tracker.update(frame.buttons);
      if (pressed.length) this.onPressed(pressed);
    }
  }
}
