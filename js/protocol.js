// Wire formats shared with the Android app. Everything here must stay byte-for-byte compatible with
// Howl-2.0.1's remoteplay/RelayProtocol.kt, DriverRelayClient.kt, RiderRelayClient.kt and OutputCoyote3.kt.
// Pure functions only, so it runs under `node --test` as well as in the browser.

/**
 * DG-LAB "V4" relay (github.com/dungeonlab-open/dglab-websocket-server, v4-server.ts).
 * - A connection with no `tid` is the relay's "controller" and gets `{"type":"hello","clientId":"<8 hex>"}`.
 *   That ID is the pairing code. The Rider uses this role.
 * - A connection to `?tid=<code>` is a "client". The Driver uses this role.
 * - Everything else is `{"type":"message","clientId":"<target>","data":{"cmd":"..."}}`.
 */
export const DEFAULT_RELAY_URL = 'wss://trex.dungeon-lab.cn/v4';
export const PING_INTERVAL_MS = 5000;
export const STALE_AFTER_MS = 10000;

/** Pulse frequencies travel over the wire in this span; both ends map their 0-1 frequency onto it. */
export const WIRE_MIN_HZ = 10;
export const WIRE_MAX_HZ = 100;

export const POWER_MAX = 200;

const CLOSE_TEXT = {
  4000: 'Rider ended the session',
  4001: 'Rider not found - check the code',
  4002: 'Session timed out - no Driver joined in time',
};

/** User-facing text for the relay's WebSocket close codes, or null for an ordinary close. */
export function describeClose(code) {
  return CLOSE_TEXT[code] ?? null;
}

export function isRiderNotFound(code) {
  return code === 4001;
}

export function messageFrame(targetClientId, cmd) {
  const frame = { type: 'message' };
  if (targetClientId != null) frame.clientId = targetClientId;
  frame.data = { cmd };
  return JSON.stringify(frame);
}

export function pingFrame() {
  return JSON.stringify({ type: 'ping' });
}

export function urlWithTid(relayUrl, tid) {
  const separator = relayUrl.includes('?') ? '&' : '?';
  return `${relayUrl}${separator}tid=${encodeURIComponent(tid)}`;
}

// ---- Coyote frequency bytes ----------------------------------------------------------------------

/** Unrounded Coyote frequency byte (5-240) for a frequency in Hz. */
export function frequencyHzToCoyoteExact(hz) {
  const period = 1000 / hz;
  if (period >= 5 && period <= 100) return period;
  if (period >= 100 && period <= 600) return (period - 100) / 5 + 100;
  if (period >= 600 && period <= 1000) return (period - 600) / 10 + 200;
  return 10;
}

export function frequencyHzToCoyote(hz) {
  return clamp(Math.round(frequencyHzToCoyoteExact(hz)), 5, 240);
}

export function coyoteToFrequencyHz(byte) {
  let period;
  if (byte >= 5 && byte <= 100) period = byte;
  else if (byte >= 101 && byte <= 200) period = (byte - 100) * 5 + 100;
  else if (byte >= 201 && byte <= 240) period = (byte - 200) * 10 + 600;
  else period = 100;
  return 1000 / period;
}

// ---- Pulse packets (Driver -> Rider) ------------------------------------------------------------

/**
 * Encodes one channel's 4 pulses as a 16-hex-digit Coyote packet: 4 frequency bytes, then 4 amplitude bytes.
 * Keeps each channel's rounding error and carries it into the next pulse, like DriverRelayOutput.encodeFrequency,
 * so the average frequency is exact even though each byte is a whole number of milliseconds.
 */
export class ChannelEncoder {
  constructor() {
    this.error = 0;
  }

  reset() {
    this.error = 0;
  }

  /** @param {{hz:number, amp:number}[]} pulses exactly 4 */
  encode(pulses) {
    const bytes = new Array(8);
    for (let i = 0; i < 4; i++) {
      const exact = frequencyHzToCoyoteExact(pulses[i].hz) + this.error;
      const byte = clamp(Math.round(exact), 5, 240);
      this.error = clamp(exact - byte, -1, 1);
      bytes[i] = byte;
      bytes[i + 4] = clamp(Math.round(pulses[i].amp * 100), 0, 100);
    }
    return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
}

/** Decodes a comma-separated list of 16-hex packets into samples of {amp 0-1, hz}. Bad packets are skipped. */
export function decodeChannelHex(hexList) {
  const samples = [];
  if (!hexList) return samples;
  for (const raw of hexList.split(',')) {
    const hex = raw.trim();
    if (hex.length !== 16 || !/^[0-9a-fA-F]+$/.test(hex)) continue;
    const bytes = [];
    for (let i = 0; i < 8; i++) bytes.push(parseInt(hex.substr(i * 2, 2), 16));
    for (let i = 0; i < 4; i++) {
      samples.push({ amp: clamp(bytes[i + 4] / 100, 0, 1), hz: coyoteToFrequencyHz(bytes[i]) });
    }
  }
  return samples;
}

/** Wire Hz -> 0-1, over the fixed wire span (not the Rider's own output range). */
export function wireHzToNormalized(hz) {
  return clamp((hz - WIRE_MIN_HZ) / (WIRE_MAX_HZ - WIRE_MIN_HZ), 0, 1);
}

export function normalizedToWireHz(norm) {
  return WIRE_MIN_HZ + clamp(norm, 0, 1) * (WIRE_MAX_HZ - WIRE_MIN_HZ);
}

// ---- Text commands ------------------------------------------------------------------------------

export const cmd = {
  /** channel 0=A 1=B; mode 0=decrease 1=increase 2=set */
  strength: (channel, mode, value) => `strength-${channel + 1}+${mode}+${value}`,
  pulse: (channelChar, hex) => `pulse-${channelChar}:[${hex}]`,
  clear: channel => `clear-${channel === 0 ? 'A' : 'B'}`,
  streamEnd: () => 'howl-stream-end',
  driverEstop: () => 'howl-driver-estop',
  feedback: index => `feedback-${index}`,
  max: (channel, value) => `howl-max-${channel === 0 ? 'A' : 'B'}+${value}`,
  power: (channel, value) => `howl-power-${channel === 0 ? 'A' : 'B'}+${value}`,
  riderEstop: () => 'howl-estop',
};

/** Parses a Howl text command into a plain object, or null if it isn't one we understand. */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;

  if (text.startsWith('strength-')) {
    const body = text.slice('strength-'.length);
    const parts = body.includes('+') ? body.split('+') : body.split('-');
    if (parts.length !== 3) return null;
    const [channel, mode, value] = parts.map(p => parseInt(p, 10));
    if ([channel, mode, value].some(Number.isNaN) || (channel !== 1 && channel !== 2) || mode < 0 || mode > 2) return null;
    return { type: 'strength', channel: channel - 1, mode, value };
  }
  if (text.startsWith('pulse-')) {
    const body = text.slice('pulse-'.length);
    const channelChar = body[0];
    if (channelChar !== 'A' && channelChar !== 'B') return null;
    const list = body.slice(body.indexOf(':') + 1).replace(/^\[|\]$/g, '');
    return { type: 'pulse', channel: channelChar === 'A' ? 0 : 1, samples: decodeChannelHex(list) };
  }
  if (text.startsWith('clear-')) return { type: 'clear', channel: text.endsWith('A') ? 0 : 1 };
  if (text === 'howl-stream-end') return { type: 'streamEnd' };
  if (text === 'howl-driver-estop') return { type: 'driverEstop' };
  if (text === 'howl-estop') return { type: 'riderEstop' };
  if (text.startsWith('feedback-')) {
    const index = parseInt(text.slice('feedback-'.length), 10);
    return Number.isNaN(index) ? null : { type: 'feedback', index };
  }
  for (const [prefix, type] of [['howl-max-', 'max'], ['howl-power-', 'power']]) {
    if (text.startsWith(prefix)) {
      const body = text.slice(prefix.length);
      const value = parseInt(body.split('+')[1], 10);
      if ((body[0] !== 'A' && body[0] !== 'B') || Number.isNaN(value)) return null;
      return { type, channel: body[0] === 'A' ? 0 : 1, value };
    }
  }
  return null;
}

// ---- Coyote 3 Bluetooth packets -----------------------------------------------------------------

/**
 * B0: header, strength byte, power A, power B, then 4 freq A, 4 amp A, 4 freq B, 4 amp B (20 bytes).
 * The strength byte is 0x1F (sequence 1, both channels set absolutely) when power changed, else 0x00.
 * @param {{freqAHz:number, ampA:number, freqBHz:number, ampB:number}[]} pulses exactly 4
 */
export function buildB0(powerA, powerB, powerChanged, pulses) {
  const out = new Uint8Array(20);
  out[0] = 0xb0;
  out[1] = powerChanged ? 0x1f : 0x00;
  out[2] = clamp(powerA, 0, POWER_MAX);
  out[3] = clamp(powerB, 0, POWER_MAX);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = frequencyHzToCoyote(pulses[i].freqAHz);
    out[8 + i] = clamp(Math.round(pulses[i].ampA * 100), 0, 100);
    out[12 + i] = frequencyHzToCoyote(pulses[i].freqBHz);
    out[16 + i] = clamp(Math.round(pulses[i].ampB * 100), 0, 100);
  }
  return out;
}

/** BF: power limits and balance parameters. Defaults match Coyote3Settings. */
export function buildBF(limitA, limitB, { frequencyBalanceA = 200, frequencyBalanceB = 200, intensityBalanceA = 0, intensityBalanceB = 0 } = {}) {
  return Uint8Array.from([
    0xbf,
    clamp(limitA, 0, POWER_MAX),
    clamp(limitB, 0, POWER_MAX),
    clamp(frequencyBalanceA, 0, 255),
    clamp(frequencyBalanceB, 0, 255),
    clamp(intensityBalanceA, 0, 255),
    clamp(intensityBalanceB, 0, 255),
  ]);
}

/** B1 notification -> {fromDevice, powerA, powerB}, or null. fromDevice means the wheel was turned on the box. */
export function parseB1(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xb1) return null;
  return { fromDevice: bytes[1] === 0x00, powerA: bytes[2], powerB: bytes[3] };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
