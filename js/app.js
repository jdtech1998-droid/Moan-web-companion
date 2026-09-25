import {
  DEFAULT_RELAY_URL, POWER_MAX, ChannelEncoder, cmd, normalizedToWireHz, clamp,
} from './protocol.js';
import { Coyote3, bluetoothSupported } from './coyote3.js';
import { RemoteStream } from './stream.js';
import { Generator, SHAPE_NAMES, SPEED_RANGE } from './generator.js';
import { RiderSession, DriverSession } from './remote.js';
import { FEEDBACK_PRESETS, RIDER_ESTOP_PRESET, isSafety, isStop } from './feedback.js';
import { PulseHistory, PulseChart, CHART_MODES, CHART_STYLES } from './pulsechart.js';
import { Manual, MANUAL_DEFAULTS, SMOOTHING_RANGE, CENTER_RATE_RANGE } from './manual.js';
import { Touchpad } from './touchpad.js';
import { FUNSCRIPT_DEFAULTS, AXIS_NAMES, isRotationAxis } from './funscript.js';
import { ActivityHost, ACTIVITY_TYPES, ACTIVITY_OPTION_DEFAULTS, DEFAULT_EXCLUDED } from './activities.js';
import { buildControls } from './controls.js';
import { icon } from './icons.js';
import { Player, Recorder, openFile, writeHWL, PLAYER_DEFAULTS, SPEED_RANGE as PLAYBACK_SPEED_RANGE, FINE_TUNE_RANGE } from './player.js';

const $ = id => document.getElementById(id);

// ---- Settings (per browser) ---------------------------------------------------------------------

const STORAGE_KEY = 'moan-web-companion';
const DEFAULT_SETTINGS = {
  role: 'rider',
  limits: [70, 70], // local power limits, like Howl's default; a Rider session uses its own MAX instead
  step: 1,
  autoDelay: [120, 120], // seconds between auto-increase steps, per channel (Howl's default)
  chartStyle: 'Point',
  manual: { ...MANUAL_DEFAULTS },
  player: { ...PLAYER_DEFAULTS },
  funscript: { ...FUNSCRIPT_DEFAULTS },
  showFunscriptMeters: true,
  activity: { changeProbability: 0, excluded: [...DEFAULT_EXCLUDED], options: { ...ACTIVITY_OPTION_DEFAULTS } },
  balance: { frequencyBalanceA: 200, frequencyBalanceB: 200, intensityBalanceA: 0, intensityBalanceB: 0 },
  relayUrl: DEFAULT_RELAY_URL,
  freqRange: [10, 100], // output frequency range, Hz
  generator: null,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...structuredClone(DEFAULT_SETTINGS), ...saved, balance: { ...DEFAULT_SETTINGS.balance, ...saved.balance }, manual: { ...DEFAULT_SETTINGS.manual, ...saved.manual },
      player: { ...DEFAULT_SETTINGS.player, ...saved.player }, funscript: { ...DEFAULT_SETTINGS.funscript, ...saved.funscript },
      activity: { ...DEFAULT_SETTINGS.activity, ...saved.activity, options: { ...DEFAULT_SETTINGS.activity.options, ...saved.activity?.options } } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  settings.generator = generator.channels;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* private mode or blocked storage: settings just won't persist */ }
}

const settings = loadSettings();

// ---- State --------------------------------------------------------------------------------------

const SILENT = { ampA: 0, ampB: 0, freqA: 0, freqB: 0 };
const PULSES_PER_TICK = 4; // 4 x 25ms per 100ms tick: Howl's 40Hz pulse rate, batched like the Coyote wants
const TICK_SECONDS = 0.1;
const FEED_MERGE_MS = 10000;
const FEED_MAX = 50;
const POPUP_MS = 4000; // how long a non-safety pop-up stays up on another tab
const AUTO_CHANGE_TICKS = 300; // 30s

const coyote = new Coyote3();
const generator = new Generator();
if (Array.isArray(settings.generator) && settings.generator.length === 2) generator.channels = settings.generator;
const stream = new RemoteStream();
const encoders = [new ChannelEncoder(), new ChannelEncoder()];
const manual = new Manual();
manual.smoothing = settings.manual.smoothing;
const player = new Player();
player.speed = settings.player.speed;
const recorder = new Recorder();
const activityHost = new ActivityHost(
  { settings: settings.activity.options, positionalCurve: () => settings.funscript.positionalEffectCurve },
  () => settings.activity,
);
const sources = { generator, manual, player, activity: activityHost };
const pulseHistory = new PulseHistory();
const touchpads = ['padA', 'padB'].map((id, ch) =>
  new Touchpad(document.getElementById(id), pos => manual.setPosition(ch, pos), () => settings.manual.centerRate));
const pulseChart = new PulseChart(document.getElementById('pulseChart'));

const state = {
  session: null, // RiderSession | DriverSession
  status: 'idle', // idle | waiting | connected | error
  statusText: 'Ready to start session',
  alert: false,
  code: '',
  power: [0, 0],
  sessionMax: [0, 0], // Rider: this session's MAX, starts at 0
  riderMax: [null, null], // Driver: the Rider's reported MAX
  muted: false,
  playing: false,
  source: 'generator', // what plays while `playing`: 'generator' | 'manual' | 'player' | 'activity', like Howl's active pulse source
  seeking: false, // the Player's seek bar is being dragged
  // Header toggles. Not saved: like the Android app, a reload starts with them off
  autoIncrease: false,
  autoElapsedMs: [0, 0],
  swap: false,
  chartMode: 'Off',
  feed: [],
  feedSeq: 0,
  unread: 0, // Driver: feedback that arrived while the Remote tab wasn't showing
  tab: 'remote',
  mainTab: 'generator', // the tab shown in the left column on a wide screen
  lastPulse: SILENT,
  ticks: 0,
};

// Wide screens show Remote in its own column, with the other tabs on the left (see the matching @media in app.css)
const wideQuery = matchMedia('(min-width: 1200px)');
const remoteShowing = () => state.tab === 'remote' || wideQuery.matches;

const riderActive = () => state.session instanceof RiderSession;
const driverActive = () => state.session instanceof DriverSession;
const driverBound = () => driverActive() && state.session.bound;
const riderBound = () => riderActive() && state.session.bound;

function powerLimit(ch) {
  if (riderActive()) return state.sessionMax[ch];
  if (driverActive()) return state.riderMax[ch] ?? POWER_MAX;
  return settings.limits[ch];
}

/** Limits written to the Coyote itself: the hardware ceiling. */
const coyoteLimits = () => (riderActive() ? state.sessionMax : settings.limits);

// ---- Power --------------------------------------------------------------------------------------

function setPower(ch, value, { send = true } = {}) {
  const v = clamp(Math.round(value), 0, powerLimit(ch));
  if (v === state.power[ch]) return renderPower();
  state.power[ch] = v;
  if (send && driverBound()) state.session.send(cmd.strength(ch, 2, v));
  renderPower();
}

/** A power change made on this page (buttons, auto-increase). A Rider reports it so the Driver's dial stays in step. */
function adjustPower(ch, value) {
  setPower(ch, value);
  if (riderBound()) state.session.send(cmd.power(ch, state.power[ch]));
}

/** Auto-increase power, as in Howl's MainOptions: +1 on each channel that is above 0, every autoDelay seconds. */
function autoIncreasePower(elapsedMs) {
  if (!state.autoIncrease || state.muted) return;
  for (const ch of [0, 1]) {
    if (state.power[ch] === 0) continue;
    state.autoElapsedMs[ch] += elapsedMs;
    if (state.autoElapsedMs[ch] >= settings.autoDelay[ch] * 1000) {
      state.autoElapsedMs[ch] = 0;
      adjustPower(ch, state.power[ch] + 1);
    }
  }
}

let limitSync = null;
let limitDirty = false;
/** Coalesces BF writes: a slider drag sends the latest value, not every step. */
function syncCoyoteLimits() {
  limitDirty = true;
  if (limitSync || !coyote.ready) return;
  limitSync = (async () => {
    while (limitDirty && coyote.ready) {
      limitDirty = false;
      const [a, b] = coyoteLimits();
      await coyote.syncLimits(a, b, settings.balance).catch(e => console.warn('Limit sync failed', e));
    }
    limitSync = null;
  })();
}

// ---- Output loop --------------------------------------------------------------------------------

function tick() {
  const now = performance.now();
  const fromStream = riderActive();
  const fromSource = !fromStream && state.playing;
  const source = sources[state.source];

  const pulses = [];
  for (let i = 0; i < PULSES_PER_TICK; i++) {
    let p = fromStream ? stream.next(now + i * 25) : fromSource ? source.next(TICK_SECONDS / PULSES_PER_TICK) : SILENT;
    // The recorder keeps the source's own pulses, before swap and mute, as Howl's does
    if (fromSource) recorder.add(p);
    if (state.swap) p = { ampA: p.ampB, ampB: p.ampA, freqA: p.freqB, freqB: p.freqA };
    if (state.muted) p = { ...p, ampA: 0, ampB: 0 };
    pulses.push(p);
    pulseHistory.add(p);
  }
  // As on Android, auto-increase only counts while something plays
  if (fromSource || fromStream) autoIncreasePower(TICK_SECONDS * 1000);

  // Driver: the generator's waves go to the Rider, 4 pulses per channel per message, as DriverRelayOutput sends them
  if (driverBound() && state.playing) {
    for (const [ch, key] of [[0, 'A'], [1, 'B']]) {
      const hex = encoders[ch].encode(pulses.map(p => ({
        hz: normalizedToWireHz(ch === 0 ? p.freqA : p.freqB),
        amp: ch === 0 ? p.ampA : p.ampB,
      })));
      state.session.send(cmd.pulse(key, hex));
    }
  }

  // Local Coyote plays the Rider stream or the local generator. A Driver's waves are only felt by the Rider.
  if (coyote.ready) {
    const local = driverActive() ? pulses.map(() => SILENT) : pulses;
    const [fMin, fMax] = settings.freqRange;
    coyote.sendPulses(state.power[0], state.power[1], local.map(p => ({
      freqAHz: fMin + (fMax - fMin) * p.freqA,
      ampA: p.ampA,
      freqBHz: fMin + (fMax - fMin) * p.freqB,
      ampB: p.ampB,
    })));
  }

  state.lastPulse = pulses[pulses.length - 1];
  renderMeters();
  if (state.source === 'player') {
    if (player.ended) {
      setPlaying(false);
      player.seek(0);
    }
    renderPlayerPosition();
  }
  renderRecorder();
  if (!$('tab-activity').hidden) refreshActivityControls();

  if (fromSource && state.source === 'generator' && $('genAuto').checked && ++state.ticks % AUTO_CHANGE_TICKS === 0) {
    generator.randomize();
    saveSettings();
    renderGenerator();
  }
}

function startClock() {
  // Timers in a worker keep running at full rate when the tab is in the background; main-thread timers don't
  try {
    const src = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 100)'], { type: 'text/javascript' }));
    new Worker(src).onmessage = tick;
  } catch {
    setInterval(tick, 100);
  }
}

/** Plays or stops. Playing another source switches to it, as Howl's Player.switchPulseSource. */
function setPlaying(playing, source = state.source) {
  if (playing && riderActive()) return;
  if (playing && source === 'player' && !player.file) {
    toast('Open a .funscript or .hwl file first.');
    return;
  }
  if (playing === state.playing && (!playing || source === state.source)) return;
  if (playing) {
    state.source = source;
    // Manual starts from the centre every time, as in ManualViewModel.start()
    if (source === 'manual') {
      manual.reset();
      touchpads.forEach(pad => pad.reset());
    }
  }
  state.playing = playing;
  if (!playing) {
    // Pause and stop end the stream: the Rider must go quiet at once, not freeze on the last pulse
    if (driverBound()) state.session.send(cmd.streamEnd());
    encoders.forEach(e => e.reset());
  }
  renderPlay();
  renderManual();
  renderPlayer();
  renderGeneratorHint();
}

const isPlaying = source => state.playing && state.source === source;

// ---- Rider --------------------------------------------------------------------------------------

function startRider() {
  setPlaying(false);
  state.power = [0, 0];
  state.sessionMax = [0, 0];
  stream.reset();
  state.session = new RiderSession(settings.relayUrl, {
    onCode: code => {
      state.code = code;
      setStatus('waiting', 'Share this code with your Driver');
      renderRemote();
    },
    onDriverAttached: () => {
      setStatus('connected', 'Driver connected');
      state.session.send(cmd.max(0, state.sessionMax[0]));
      state.session.send(cmd.max(1, state.sessionMax[1]));
      renderAll();
    },
    onDriverLeft: () => {
      riderZero();
      setStatus('waiting', 'Driver left - waiting for a Driver');
      renderAll();
    },
    onCommand: handleRiderCommand,
    onError: text => setStatus('error', text),
    onEnded: reason => endSession(reason),
  });
  syncCoyoteLimits();
  setStatus('waiting', 'Connecting to relay…');
  keepAwake(true);
  if (!coyote.ready) toast('Connect your Coyote to feel the Driver.');
  renderAll();
}

function handleRiderCommand(c) {
  switch (c.type) {
    case 'strength':
      if (c.mode === 2) setPower(c.channel, c.value, { send: false });
      else setPower(c.channel, state.power[c.channel] + (c.mode === 1 ? c.value : -c.value), { send: false });
      break;
    case 'pulse':
      stream.addChannel(c.channel, c.samples);
      break;
    case 'streamEnd':
      stream.silence();
      break;
    case 'driverEstop':
      riderZero();
      setStatus('connected', 'Driver hit E-STOP - output stopped', true);
      break;
  }
}

/** Power to 0 and the signal silenced: zero power alone would leave the last pulse ready to play again. */
function riderZero() {
  setPower(0, 0, { send: false });
  setPower(1, 0, { send: false });
  stream.silence();
}

function riderEmergencyStop() {
  riderZero();
  if (riderBound()) {
    state.session.send(cmd.riderEstop());
    // Also as power reports, for a Driver on an older build that ignores howl-estop
    state.session.send(cmd.power(0, 0));
    state.session.send(cmd.power(1, 0));
  }
  setStatus(state.status, 'E-STOP - output stopped', true);
}

function setRiderMax(ch, value) {
  state.sessionMax[ch] = value;
  syncCoyoteLimits();
  if (state.power[ch] > value) {
    setPower(ch, value, { send: false });
    if (riderBound()) state.session.send(cmd.power(ch, value));
  }
  if (riderBound()) state.session.send(cmd.max(ch, value));
  renderPower();
  $(ch === 0 ? 'riderMaxAOut' : 'riderMaxBOut').textContent = value;
}

function sendFeedback(index, button) {
  if (!riderBound()) {
    toast('No Driver connected yet.');
    return;
  }
  state.session.send(cmd.feedback(index));
  button.classList.remove('flash');
  void button.offsetWidth;
  button.classList.add('flash');
  setTimeout(() => button.classList.remove('flash'), 400);
}

// ---- Driver -------------------------------------------------------------------------------------

function startDriver() {
  const code = $('driverCode').value.replace(/\s+/g, '');
  if (!code) {
    toast('Enter the code your Rider shared.');
    return;
  }
  state.riderMax = [null, null];
  state.feed = [];
  state.unread = 0;
  encoders.forEach(e => e.reset());
  state.session = new DriverSession(settings.relayUrl, code, {
    onBound: () => {
      setStatus('connected', 'Connected to Rider');
      state.session.send(cmd.strength(0, 2, state.power[0]));
      state.session.send(cmd.strength(1, 2, state.power[1]));
      renderAll();
    },
    onCommand: handleDriverCommand,
    onError: text => setStatus('error', text),
    onEnded: reason => endSession(reason),
  });
  setStatus('waiting', 'Joining Rider session…');
  keepAwake(true);
  renderAll();
}

function handleDriverCommand(c) {
  switch (c.type) {
    case 'feedback': {
      const preset = FEEDBACK_PRESETS[c.index];
      if (preset) addFeedback(preset);
      break;
    }
    case 'max':
      state.riderMax[c.channel] = c.value;
      // The Rider clamps its own power; this keeps the Driver's dial from climbing past it
      if (state.power[c.channel] > c.value) setPower(c.channel, c.value, { send: false });
      renderPower();
      renderDriverMax();
      break;
    case 'power':
      setPower(c.channel, c.value, { send: false });
      break;
    case 'riderEstop':
      setPower(0, 0, { send: false });
      setPower(1, 0, { send: false });
      setPlaying(false);
      addFeedback(RIDER_ESTOP_PRESET);
      break;
  }
}

function driverEmergencyStop() {
  setPower(0, 0, { send: false });
  setPower(1, 0, { send: false });
  setPlaying(false);
  if (driverBound()) {
    state.session.send(cmd.driverEstop());
    // Sent explicitly: the Rider may still hold a level the Driver thinks is already 0
    state.session.send(cmd.strength(0, 2, 0));
    state.session.send(cmd.strength(1, 2, 0));
  }
}

function addFeedback(preset) {
  const now = Date.now();
  const seq = ++state.feedSeq;
  const latest = state.feed[0];
  if (latest && !isSafety(preset) && latest.preset === preset && now - latest.at <= FEED_MERGE_MS) {
    latest.count++;
    latest.at = now;
    latest.seq = seq;
    latest.popUntil = now + POPUP_MS;
  } else {
    state.feed.unshift({ preset, at: now, count: 1, id: seq, seq, acked: !isSafety(preset), popUntil: now + POPUP_MS });
    state.feed.length = Math.min(state.feed.length, FEED_MAX);
  }
  if (!remoteShowing()) state.unread++;
  setTimeout(renderPopups, POPUP_MS + 50);
  if (isSafety(preset)) navigator.vibrate?.([200, 100, 200]);
  renderFeed(seq);
}

// ---- Session end --------------------------------------------------------------------------------

function endSession(reason) {
  if (!state.session) return;
  const wasRider = riderActive();
  state.session = null;
  state.code = '';
  if (wasRider) {
    riderZero();
    state.sessionMax = [0, 0];
    syncCoyoteLimits(); // back to this browser's own limits
  } else {
    state.riderMax = [null, null];
    // Don't let the generator carry on into the local Coyote once the session is over
    setPlaying(false);
  }
  // Re-clamp to the limits that apply now
  setPower(0, state.power[0], { send: false });
  setPower(1, state.power[1], { send: false });
  setStatus(reason ? 'error' : 'idle', reason ?? 'Session ended');
  keepAwake(false);
  renderAll();
}

function stopSession() {
  state.session?.close();
}

// ---- Wake lock ----------------------------------------------------------------------------------

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or not allowed right now */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) keepAwake(true);
});

// ---- Rendering ----------------------------------------------------------------------------------

let alertTimer = null;
function setStatus(status, text, alert = false) {
  state.status = status;
  state.statusText = text;
  state.alert = alert;
  clearTimeout(alertTimer);
  if (alert) alertTimer = setTimeout(() => { state.alert = false; renderStatus(); }, 8000);
  renderStatus();
}

function renderStatus() {
  const banner = $('statusBanner');
  banner.className = `status-banner ${state.alert ? 'alert' : state.status}`;
  $('statusText').textContent = state.statusText;
}

function renderPower() {
  $('powerA').textContent = state.power[0];
  $('powerB').textContent = state.power[1];
  $('maxA').textContent = `/ ${powerLimit(0)} MAX`;
  $('maxB').textContent = `/ ${powerLimit(1)} MAX`;
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

/** The power bar behind each channel, as in Howl's PowerLevelPanel: height is amplitude, red to yellow is frequency. */
function renderMeters() {
  const yellowGreen = darkQuery.matches ? 255 : 223;
  for (const [id, amp, freq] of [['meterA', state.lastPulse.ampA, state.lastPulse.freqA], ['meterB', state.lastPulse.ampB, state.lastPulse.freqB]]) {
    const meter = $(id);
    meter.style.height = `${Math.round(clamp(amp, 0, 1) * 100)}%`;
    meter.style.setProperty('--meter-rgb', `255, ${Math.round(clamp(freq, 0, 1) * yellowGreen)}, 0`);
  }
}

function renderPlay() {
  const path = source => (isPlaying(source) ? 'M7 5h4v14H7zm6 0h4v14h-4z' : 'M8 5v14l11-7z');
  $('genPlayPath').setAttribute('d', path('generator'));
  $('manualPlayPath').setAttribute('d', path('manual'));
  $('playerPlayPath').setAttribute('d', path('player'));
  $('activityPlayPath').setAttribute('d', path('activity'));
  $('activityPlay').disabled = riderActive();
  $('playerPlay').disabled = riderActive();
  $('genPlay').disabled = riderActive();
  $('manualPlay').disabled = riderActive();
}

function renderMute() {
  $('muteBtn').setAttribute('aria-pressed', String(state.muted));
  $('muteLabel').textContent = state.muted ? 'Muted' : 'Mute';
}

function renderToolbar() {
  $('autoBtn').setAttribute('aria-pressed', String(state.autoIncrease));
  $('swapBtn').setAttribute('aria-pressed', String(state.swap));
  const chart = $('chartBtn');
  chart.setAttribute('aria-pressed', String(state.chartMode !== 'Off'));
  chart.title = `Pulse chart: ${state.chartMode}`;
  chart.setAttribute('aria-label', chart.title);
}

let chartFrame = null;
function setChartMode(mode) {
  state.chartMode = mode;
  pulseChart.setMode(mode);
  renderToolbar();
  cancelAnimationFrame(chartFrame);
  const draw = () => {
    pulseChart.draw(pulseHistory, settings.chartStyle);
    chartFrame = requestAnimationFrame(draw);
  };
  if (mode !== 'Off') draw();
}

function renderFreqRange() {
  const [lo, hi] = settings.freqRange;
  $('freqMin').value = lo;
  $('freqMax').value = hi;
  $('freqMinLabel').textContent = `${lo}Hz`;
  $('freqMaxLabel').textContent = `${hi}Hz`;
  const span = 199;
  $('freqFill').style.left = `${((lo - 1) / span) * 100}%`;
  $('freqFill').style.right = `${100 - ((hi - 1) / span) * 100}%`;
}

function renderDevice() {
  const label = $('connectLabel');
  const button = $('connectBtn');
  if (!bluetoothSupported()) {
    $('deviceStatus').textContent = 'No Bluetooth in this browser';
    button.disabled = true;
    return;
  }
  const status = coyote.ready ? `Coyote 3${coyote.battery != null ? ` · ${coyote.battery}%` : ''}` : (coyote.statusText ?? 'Disconnected');
  $('deviceStatus').textContent = status;
  label.textContent = coyote.ready ? 'Disconnect' : 'Connect';
  button.disabled = coyote.busy === true;
}

function renderRemote() {
  const active = !!state.session;
  const role = active ? (riderActive() ? 'rider' : 'driver') : settings.role;
  document.querySelectorAll('.role').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.role === role));
    b.disabled = active && b.dataset.role !== role;
  });
  $('riderPanel').hidden = role !== 'rider';
  $('driverPanel').hidden = role !== 'driver';
  $('riderIdle').hidden = riderActive();
  $('riderActive').hidden = !riderActive();
  $('driverIdle').hidden = driverActive();
  $('driverActive').hidden = !driverActive();
  $('estopBtn').hidden = !active;
  $('sessionCode').textContent = state.code || '········';
  $('copyCode').disabled = !state.code;
  $('riderMaxA').value = state.sessionMax[0];
  $('riderMaxB').value = state.sessionMax[1];
  $('riderMaxAOut').textContent = state.sessionMax[0];
  $('riderMaxBOut').textContent = state.sessionMax[1];
  renderDriverMax();
  renderFeed();
}

function renderDriverMax() {
  $('riderMaxShowA').textContent = state.riderMax[0] ?? '–';
  $('riderMaxShowB').textContent = state.riderMax[1] ?? '–';
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function renderFeed(newSeq) {
  renderPopups();
  const now = Date.now();
  const pinned = $('pinnedFeed');
  pinned.replaceChildren(...state.feed.filter(e => !e.acked).map(e => {
    const row = el('div', `pinned-item${isStop(e.preset) ? ' stop' : ''}`, presetStyle(e.preset));
    row.append(el('span', null, null, e.preset.icon), el('span', null, null, e.preset.message), el('span', 'when', null, ago(now - e.at)));
    const ok = el('button', null, null, 'Got it');
    ok.onclick = () => { e.acked = true; renderFeed(); };
    row.append(ok);
    return row;
  }));

  const list = $('feedbackFeed');
  if (!state.feed.length) {
    list.replaceChildren(el('li', 'muted small empty', null, 'Nothing yet.'));
    return;
  }
  list.replaceChildren(...state.feed.map(e => {
    const row = el('li', `feed-item${e.seq === newSeq ? ' new' : ''}`, presetStyle(e.preset));
    row.append(el('span', null, null, e.preset.icon), el('span', null, null, e.preset.message));
    if (e.count > 1) row.append(el('span', 'count', null, `×${e.count}`));
    row.append(el('span', 'when', null, ago(now - e.at)));
    return row;
  }));
}

// Feedback shown over the other tabs, so the Driver sees it while busy on the Generator or Settings.
// Safety words stay until tapped; the rest fade after POPUP_MS. Tapping a pop-up opens the Remote tab.
function renderPopups() {
  const badge = $('remoteBadge');
  badge.hidden = state.unread === 0;
  badge.textContent = state.unread > 9 ? '9+' : String(state.unread);

  const box = $('feedPopups');
  // The Remote tab already shows the pinned list and the feed while a Driver session is up
  if (remoteShowing() && driverActive()) {
    box.replaceChildren();
    return;
  }
  const now = Date.now();
  box.replaceChildren(...state.feed.filter(e => !e.acked || (!remoteShowing() && e.popUntil > now)).map(e => {
    const pop = el('div', `feed-popup${!e.acked ? ' pinned' : ''}${isStop(e.preset) ? ' stop' : ''}`, presetStyle(e.preset));
    pop.setAttribute('role', e.acked ? 'status' : 'alert');
    pop.append(el('span', null, null, e.preset.icon), el('span', null, null, e.preset.message));
    if (e.count > 1) pop.append(el('span', 'count', null, `×${e.count}`));
    pop.onclick = () => { if (driverActive()) selectTab('remote'); };
    if (!e.acked) {
      const ok = el('button', null, null, 'Got it');
      ok.onclick = ev => { ev.stopPropagation(); e.acked = true; renderFeed(); };
      pop.append(ok);
    }
    return pop;
  }));
}

const presetStyle = p => `--fb-bg:${p.background};--fb-badge:${p.badge}`;

function el(tag, className, style, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (style) node.style.cssText = style;
  if (text != null) node.textContent = text;
  return node;
}

function buildFeedbackGrid() {
  const grid = $('feedbackGrid');
  FEEDBACK_PRESETS.forEach((p, index) => {
    const b = el('button', `fb-btn${p.label === 'STOP' ? ' stop' : ''}`, presetStyle(p));
    const badge = el('span', 'fb-badge', null, p.icon);
    const text = el('span', 'fb-text');
    text.append(el('b', null, null, p.label), el('small', null, null, p.message));
    b.append(badge, text);
    b.onclick = () => sendFeedback(index, b);
    grid.append(b);
  });
}

// Generator cards, laid out like the Android Generator tab
function renderGenerator() {
  const grid = $('genGrid');
  const [fMin, fMax] = settings.freqRange;
  const toHz = n => Math.round(fMin + (fMax - fMin) * n);
  const fromHz = hz => clamp((hz - fMin) / Math.max(1, fMax - fMin), 0, 1);

  grid.replaceChildren(...generator.channels.map((p, ch) => {
    const card = el('div', 'card gen-card');
    card.append(el('div', 'card-title', null, `Channel ${ch === 0 ? 'A' : 'B'}`));

    const select = (value, onChange) => {
      const s = document.createElement('select');
      SHAPE_NAMES.forEach(name => s.append(new Option(name, name, false, name === value)));
      s.onchange = () => onChange(s.value);
      return s;
    };
    const num = (value, min, max, step, onChange) => {
      const i = document.createElement('input');
      Object.assign(i, { type: 'number', min, max, step, value });
      i.onchange = () => {
        const v = clamp(parseFloat(i.value) || 0, min, max);
        i.value = v;
        onChange(v);
      };
      return i;
    };
    const row = (label, ...controls) => {
      const r = el('div', 'gen-row');
      r.append(el('span', null, null, label));
      if (controls.length === 1) r.append(controls[0]);
      else {
        const pair = el('span', 'pair');
        pair.append(...controls);
        r.append(pair);
      }
      return r;
    };
    const update = changes => {
      generator.channels[ch] = { ...generator.channels[ch], ...changes };
      saveSettings();
    };

    card.append(
      row('Shape', select(p.shape, v => update({ shape: v }))),
      row('Speed', num(p.speed, SPEED_RANGE[0], SPEED_RANGE[1], 0.01, v => update({ speed: v }))),
      row('Power',
        num(Math.round(p.ampMin * 100), 0, 100, 1, v => update({ ampMin: Math.min(v / 100, generator.channels[ch].ampMax) })),
        el('span', null, null, '% –'),
        num(Math.round(p.ampMax * 100), 0, 100, 1, v => update({ ampMax: Math.max(v / 100, generator.channels[ch].ampMin) })),
        el('span', null, null, '%')),
      row('Freq shape', select(p.freqShape, v => update({ freqShape: v }))),
      row('Freq',
        num(toHz(p.freqMin), fMin, fMax, 1, v => update({ freqMin: fromHz(v) })),
        el('span', null, null, '–'),
        num(toHz(p.freqMax), fMin, fMax, 1, v => update({ freqMax: fromHz(v) })),
        el('span', null, null, 'Hz')),
    );
    return card;
  }));
  renderGeneratorHint();
}

function renderManual() {
  const playing = isPlaying('manual');
  $('touchpads').hidden = !playing;
  $('manualHint').hidden = playing;
  $('manualHint').textContent = riderActive()
    ? "Manual control is off while you're the Rider: your Driver is in control."
    : 'Press play to begin manual control.';
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function renderPlayer() {
  const file = player.file;
  $('playerName').textContent = file?.name ?? 'Player';
  $('playerInfo').textContent = file?.info ?? '';
  $('playerInfo').hidden = !file?.info;
  $('playerSeek').disabled = !file;
  $('playerSeek').max = file ? file.duration : 0;
  $('playerHint').hidden = !!file;
  $('fineTuneRow').hidden = !settings.player.showSyncFineTune;
  $('playerFineTune').value = player.syncFineTune;
  $('playerFineTuneOut').textContent = player.syncFineTune.toFixed(2);
  buildFunscriptMeters();
  renderPlayerPosition();
}

function renderPlayerPosition() {
  if (!state.seeking) {
    $('playerSeek').value = player.position;
    $('playerTime').textContent = formatTime(player.position);
  }
  const meters = $('funscriptMeters');
  if (meters.hidden) return;
  for (const m of meters.querySelectorAll('[data-axis]')) {
    const pos = player.file.axisPosition(m.dataset.axis, player.position) ?? 0;
    if (m.classList.contains('fs-dial')) {
      // 270 degree sweep: 0 at the upper right, 0.5 at the bottom, as Howl's RotationDialMeter
      m.style.setProperty('--angle', `${-45 + 270 * (1 - pos)}deg`);
    } else {
      m.style.setProperty('--pos', pos.toFixed(3));
    }
  }
}

function buildFunscriptMeters() {
  const meters = $('funscriptMeters');
  const file = player.file;
  meters.hidden = !(settings.showFunscriptMeters && file?.axisIds);
  if (meters.hidden) return meters.replaceChildren();
  if (meters.dataset.for === file.name + file.axisIds) return;
  meters.dataset.for = file.name + file.axisIds;
  const group = ids => {
    const g = el('div', 'fs-group');
    for (const id of ids) {
      const meter = el('div', 'fs-meter');
      const gauge = el('div', isRotationAxis(id) ? 'fs-dial' : 'fs-bar');
      gauge.dataset.axis = id;
      gauge.append(el('i'));
      meter.append(el('span', null, null, AXIS_NAMES[id] ?? id), gauge);
      g.append(meter);
    }
    return g;
  };
  const linear = file.axisIds.filter(id => !isRotationAxis(id));
  const rotation = file.axisIds.filter(isRotationAxis);
  meters.replaceChildren(...[linear, rotation].filter(ids => ids.length).map(group));
}

function renderPlayerSettings() {
  $('setSpeed').value = settings.player.speed;
  $('setSpeedOut').textContent = settings.player.speed.toFixed(2);
  $('setShowFineTune').checked = settings.player.showSyncFineTune;
  $('setShowMeters').checked = settings.showFunscriptMeters;
  const f = settings.funscript;
  for (const [id, key] of FUNSCRIPT_SLIDERS) {
    $(id).value = f[key];
    $(`${id}Out`).textContent = f[key].toFixed(2);
  }
  $('fsFlip').checked = f.flipDirectionalFreqShift;
  $('fsNormalise').checked = f.normaliseAxes;
}

const FUNSCRIPT_SLIDERS = [
  ['fsVolume', 'volume'], ['fsPositional', 'positionalEffectStrength'], ['fsSigma', 'smoothingSigma'],
  ['fsEnergy', 'freqEnergyProportion'], ['fsShift', 'directionalFreqShift'],
];

let lastRecordRender = '';
function renderRecorder() {
  const key = `${recorder.recordMode}${recorder.recording}${recorder.pulses.length}`;
  if (key === lastRecordRender) return;
  lastRecordRender = key;
  $('recorderCard').classList.toggle('active', recorder.recordMode);
  $('recordMode').checked = recorder.recordMode;
  $('recordBtn').hidden = !recorder.recordMode;
  $('recordClear').hidden = !recorder.recordMode;
  $('recordBtn').setAttribute('aria-pressed', String(recorder.recording));
  $('recordSave').disabled = recorder.duration === 0;
  $('recordTime').textContent = formatTime(recorder.duration);
}

/** Loads a file into the Player. Like Howl, loading stops whatever plays and makes the file the active source. */
async function loadPlayerFile(file) {
  try {
    const source = await openFile(file, settings.funscript);
    setPlaying(false);
    player.load(source);
    state.source = 'player';
    renderPlay();
    renderManual();
    renderPlayer();
  } catch (e) {
    toast(e.message || 'Could not open that file.');
  }
}

function saveRecording() {
  setPlaying(false);
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const name = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}--${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.hwl`;
  const url = URL.createObjectURL(new Blob([writeHWL(recorder.pulses)], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- Activity tab ----

let refreshActivityControls = () => {};

function buildActivityPicker() {
  const select = $('activitySelect');
  select.replaceChildren(...ACTIVITY_TYPES.map(t => Object.assign(document.createElement('option'), { value: t.id, textContent: t.name })));
  $('activityRestart').replaceChildren(icon('replay'));
}

/** Rebuilds the Activity tab for the current activity: called when it changes, by the user or at random. */
function renderActivity() {
  const type = activityHost.type;
  const inst = activityHost.instance;
  const excluded = settings.activity.excluded;
  $('activitySelect').value = type.id;
  for (const opt of $('activitySelect').options) opt.classList.toggle('excluded', excluded.includes(opt.value));
  $('activityIcon').replaceChildren(icon(type.icon));
  const calibration = type.id.startsWith('CALIBRATE');
  $('activityTitle').textContent = `${type.name} settings`;
  $('activityTitle').hidden = calibration;
  $('activityRandomRow').hidden = calibration;
  $('activityRandom').checked = !excluded.includes(type.id);

  const persist = () => saveSettings();
  const permanent = $('activityPermanent');
  permanent.replaceChildren();
  const refreshPermanent = buildControls(permanent, inst.permanentControls(), persist);
  permanent.hidden = !permanent.childElementCount;
  $('activitySettings').hidden = calibration && !permanent.childElementCount;

  const temporary = $('activityTemporary');
  temporary.replaceChildren();
  const refreshTemporary = buildControls(temporary, inst.temporaryControls(), persist);
  temporary.hidden = !temporary.childElementCount;

  refreshActivityControls = () => { refreshPermanent(); refreshTemporary(); };
  renderActivityHint();
}

function renderActivityHint() {
  $('activityChange').value = settings.activity.changeProbability;
  $('activityChangeOut').textContent = settings.activity.changeProbability.toFixed(2);
  const hint = $('activityHint');
  hint.textContent = riderActive() ? "Activities are off while you're the Rider: your Driver is in control." : '';
  hint.hidden = !hint.textContent;
}

function renderManualSettings() {
  const { centerRate, smoothing } = settings.manual;
  $('setCenterRate').value = centerRate;
  $('setSmoothing').value = smoothing;
  $('centerRateOut').textContent = centerRate.toFixed(2);
  $('smoothingOut').textContent = smoothing.toFixed(2);
}

function renderGeneratorHint() {
  let hint;
  if (riderActive()) hint = "The generator is off while you're the Rider: your Driver is in control.";
  else if (driverBound()) hint = isPlaying('generator') ? 'Streaming these waves to your Rider.' : 'Press play to send these waves to your Rider.';
  else if (driverActive()) hint = 'Waiting for the Rider…';
  else if (coyote.ready) hint = 'Plays on your Coyote. Start a Driver session on the Remote tab to send it to a Rider instead.';
  else hint = 'Connect a Coyote to feel it yourself, or join a Rider as the Driver on the Remote tab.';
  $('genHint').textContent = hint;
}

function renderSettings() {
  $('setLimitA').value = settings.limits[0];
  $('setLimitB').value = settings.limits[1];
  $('setStep').value = settings.step;
  $('setAutoDelayA').value = settings.autoDelay[0];
  $('setAutoDelayB').value = settings.autoDelay[1];
  $('setChartStyle').value = settings.chartStyle;
  $('setFbA').value = settings.balance.frequencyBalanceA;
  $('setFbB').value = settings.balance.frequencyBalanceB;
  $('setIbA').value = settings.balance.intensityBalanceA;
  $('setIbB').value = settings.balance.intensityBalanceB;
  $('setRelay').value = settings.relayUrl;
}

function renderAll() {
  renderStatus();
  renderPower();
  renderMeters();
  renderPlay();
  renderMute();
  renderToolbar();
  renderFreqRange();
  renderDevice();
  renderRemote();
  renderManual();
  renderPlayer();
  renderRecorder();
  renderActivityHint();
  renderGeneratorHint();
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---- Wiring -------------------------------------------------------------------------------------

function selectTab(name) {
  const wide = wideQuery.matches;
  // Remote always has its own column on a wide screen, so the tab row only switches the left one
  if (wide && name === 'remote') name = state.mainTab;
  state.tab = name;
  if (name !== 'remote') state.mainTab = name;
  if (name !== 'manual') touchpads.forEach(pad => pad.reset());
  if (remoteShowing()) state.unread = 0;
  renderPopups();
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}` && !(wide && p.id === 'tab-remote'); });
}

function wire() {
  document.querySelectorAll('.tab').forEach(t => { t.onclick = () => selectTab(t.dataset.tab); });
  wideQuery.addEventListener('change', () => selectTab(state.tab));
  selectTab(state.tab);
  document.querySelectorAll('[data-goto]').forEach(a => {
    a.onclick = e => { e.preventDefault(); selectTab(a.dataset.goto); };
  });

  document.querySelectorAll('[data-power]').forEach(b => {
    const ch = Number(b.dataset.power);
    const delta = Number(b.dataset.delta);
    let held = false;
    b.onclick = () => {
      if (held) { held = false; return; }
      adjustPower(ch, state.power[ch] + delta * settings.step);
    };
    // Holding minus drops the channel straight to 0, as on the Android app
    if (delta < 0) {
      let timer = null;
      const cancel = () => clearTimeout(timer);
      b.onpointerdown = () => {
        held = false;
        timer = setTimeout(() => { held = true; adjustPower(ch, 0); }, 500);
      };
      b.onpointerup = b.onpointerleave = b.onpointercancel = cancel;
      b.oncontextmenu = e => e.preventDefault();
    }
  });

  $('muteBtn').onclick = () => { state.muted = !state.muted; renderMute(); };
  $('autoBtn').onclick = () => {
    state.autoIncrease = !state.autoIncrease;
    state.autoElapsedMs = [0, 0];
    renderToolbar();
  };
  $('swapBtn').onclick = () => { state.swap = !state.swap; renderToolbar(); };
  $('chartBtn').onclick = () => setChartMode(CHART_MODES[(CHART_MODES.indexOf(state.chartMode) + 1) % CHART_MODES.length]);
  $('genPlay').onclick = () => setPlaying(!isPlaying('generator'), 'generator');
  $('manualPlay').onclick = () => setPlaying(!isPlaying('manual'), 'manual');
  $('playerPlay').onclick = () => setPlaying(!isPlaying('player'), 'player');
  $('activityPlay').onclick = () => setPlaying(!isPlaying('activity'), 'activity');
  buildActivityPicker();
  activityHost.onChange = renderActivity;
  renderActivity();
  $('activitySelect').onchange = e => activityHost.setCurrent(e.target.value);
  $('activityRestart').onclick = () => activityHost.setCurrent(activityHost.type.id);
  $('activityChange').oninput = e => {
    settings.activity.changeProbability = clamp(Number(e.target.value) || 0, 0, 1);
    renderActivityHint();
  };
  $('activityChange').onchange = () => saveSettings();
  $('activityRandom').onchange = e => {
    const id = activityHost.type.id;
    const rest = settings.activity.excluded.filter(x => x !== id);
    settings.activity.excluded = e.target.checked ? rest : [...rest, id];
    saveSettings();
    renderActivity();
  };
  $('playerOpen').onclick = () => {
    if (isPlaying('player')) setPlaying(false);
    $('playerFile').click();
  };
  $('playerFile').onchange = e => {
    const file = e.target.files[0];
    e.target.value = ''; // so picking the same file again still loads it
    if (file) loadPlayerFile(file);
  };
  const card = $('playerCard');
  card.ondragover = e => { e.preventDefault(); card.classList.add('drop'); };
  card.ondragleave = () => card.classList.remove('drop');
  card.ondrop = e => {
    e.preventDefault();
    card.classList.remove('drop');
    const file = e.dataTransfer.files[0];
    if (file) loadPlayerFile(file);
  };
  // The position only changes when the drag ends, so dragging doesn't send garbled output
  $('playerSeek').oninput = e => {
    state.seeking = true;
    $('playerTime').textContent = formatTime(Number(e.target.value));
  };
  $('playerSeek').onchange = e => {
    state.seeking = false;
    player.seek(Number(e.target.value));
    renderPlayerPosition();
  };
  $('playerFineTune').oninput = e => {
    player.syncFineTune = clamp(Number(e.target.value) || 0, ...FINE_TUNE_RANGE);
    $('playerFineTuneOut').textContent = player.syncFineTune.toFixed(2);
  };
  $('playerSettingsBtn').onclick = () => {
    const panel = $('playerSettings');
    panel.hidden = !panel.hidden;
    $('playerSettingsBtn').setAttribute('aria-expanded', String(!panel.hidden));
  };
  $('setSpeed').oninput = e => {
    settings.player.speed = clamp(Number(e.target.value) || 1, ...PLAYBACK_SPEED_RANGE);
    player.speed = settings.player.speed;
    renderPlayerSettings();
  };
  $('setSpeed').onchange = () => saveSettings();
  $('setShowFineTune').onchange = e => { settings.player.showSyncFineTune = e.target.checked; saveSettings(); renderPlayer(); };
  $('setShowMeters').onchange = e => { settings.showFunscriptMeters = e.target.checked; saveSettings(); renderPlayer(); };
  for (const [id, key] of FUNSCRIPT_SLIDERS) {
    $(id).oninput = e => { settings.funscript[key] = Number(e.target.value); renderPlayerSettings(); };
    $(id).onchange = () => saveSettings();
  }
  $('fsFlip').onchange = e => { settings.funscript.flipDirectionalFreqShift = e.target.checked; saveSettings(); };
  $('fsNormalise').onchange = e => { settings.funscript.normaliseAxes = e.target.checked; saveSettings(); };
  $('fsReset').onclick = () => {
    // Reset in place: a loaded funscript keeps a reference to this object
    Object.assign(settings.funscript, FUNSCRIPT_DEFAULTS);
    saveSettings();
    renderPlayerSettings();
  };

  $('recordMode').onchange = e => { recorder.setRecordMode(e.target.checked); renderRecorder(); };
  $('recordBtn').onclick = () => { recorder.recording = !recorder.recording; renderRecorder(); };
  $('recordClear').onclick = () => { recorder.clear(); renderRecorder(); };
  $('recordSave').onclick = saveRecording;
  $('manualSettingsBtn').onclick = () => {
    const panel = $('manualSettings');
    panel.hidden = !panel.hidden;
    $('manualSettingsBtn').setAttribute('aria-expanded', String(!panel.hidden));
  };
  const manualSetting = (id, key, [min, max]) => {
    $(id).oninput = e => {
      settings.manual[key] = clamp(Number(e.target.value) || 0, min, max);
      manual.smoothing = settings.manual.smoothing;
      renderManualSettings();
    };
    $(id).onchange = () => saveSettings();
  };
  manualSetting('setCenterRate', 'centerRate', CENTER_RATE_RANGE);
  manualSetting('setSmoothing', 'smoothing', SMOOTHING_RANGE);

  const onFreq = which => () => {
    let lo = Number($('freqMin').value);
    let hi = Number($('freqMax').value);
    if (lo > hi) (which === 'min' ? (lo = hi) : (hi = lo));
    settings.freqRange = [lo, hi];
    saveSettings();
    renderFreqRange();
  };
  $('freqMin').oninput = onFreq('min');
  $('freqMax').oninput = onFreq('max');
  $('freqMin').onchange = $('freqMax').onchange = () => renderGenerator();

  document.querySelectorAll('.role').forEach(b => {
    b.onclick = () => {
      if (state.session) return;
      settings.role = b.dataset.role;
      saveSettings();
      setStatus('idle', 'Ready to start session');
      renderRemote();
    };
  });
  $('riderStart').onclick = startRider;
  $('riderStop').onclick = stopSession;
  $('driverStart').onclick = startDriver;
  $('driverCode').onkeydown = e => { if (e.key === 'Enter') startDriver(); };
  $('driverStop').onclick = stopSession;
  $('copyCode').onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.code);
      toast('Code copied');
    } catch {
      toast('Copy failed - select the code instead');
    }
  };
  $('riderMaxA').oninput = e => setRiderMax(0, Number(e.target.value));
  $('riderMaxB').oninput = e => setRiderMax(1, Number(e.target.value));
  $('estopBtn').onclick = () => (riderActive() ? riderEmergencyStop() : driverEmergencyStop());
  buildFeedbackGrid();

  $('genRandom').onclick = () => { generator.randomize(); saveSettings(); renderGenerator(); };

  const numSetting = (id, min, max, apply) => {
    $(id).onchange = e => {
      const v = clamp(Math.round(Number(e.target.value) || 0), min, max);
      e.target.value = v;
      apply(v);
      saveSettings();
    };
  };
  const limitChanged = () => {
    if (!state.session) {
      setPower(0, state.power[0]);
      setPower(1, state.power[1]);
      syncCoyoteLimits();
    }
    renderPower();
  };
  numSetting('setLimitA', 0, POWER_MAX, v => { settings.limits[0] = v; limitChanged(); });
  numSetting('setLimitB', 0, POWER_MAX, v => { settings.limits[1] = v; limitChanged(); });
  numSetting('setStep', 1, 20, v => { settings.step = v; });
  numSetting('setAutoDelayA', 1, 600, v => { settings.autoDelay[0] = v; });
  numSetting('setAutoDelayB', 1, 600, v => { settings.autoDelay[1] = v; });
  $('setChartStyle').onchange = e => {
    settings.chartStyle = CHART_STYLES.includes(e.target.value) ? e.target.value : 'Point';
    saveSettings();
  };
  for (const [id, key] of [['setFbA', 'frequencyBalanceA'], ['setFbB', 'frequencyBalanceB'], ['setIbA', 'intensityBalanceA'], ['setIbB', 'intensityBalanceB']]) {
    numSetting(id, 0, 255, v => { settings.balance[key] = v; syncCoyoteLimits(); });
  }
  $('setRelay').onchange = e => { settings.relayUrl = e.target.value.trim() || DEFAULT_RELAY_URL; saveSettings(); renderSettings(); };
  $('resetRelay').onclick = () => { settings.relayUrl = DEFAULT_RELAY_URL; saveSettings(); renderSettings(); };

  $('connectBtn').onclick = async () => {
    if (coyote.ready) {
      await coyote.disconnect();
      return;
    }
    coyote.busy = true;
    renderDevice();
    try {
      await coyote.connect();
      syncCoyoteLimits();
    } catch (e) {
      coyote.statusText = 'Disconnected';
      // Closing the device picker isn't an error worth showing
      if (e.name !== 'NotFoundError') toast(e.message);
      coyote.device?.gatt?.disconnect();
    } finally {
      coyote.busy = false;
      renderDevice();
      renderGeneratorHint();
    }
  };
  coyote.onStatus = s => { coyote.statusText = s; renderDevice(); renderGeneratorHint(); };
  coyote.onBattery = () => renderDevice();
  coyote.onDevicePower = (a, b) => {
    setPower(0, a, { send: !riderActive() });
    setPower(1, b, { send: !riderActive() });
    if (riderBound()) {
      state.session.send(cmd.power(0, state.power[0]));
      state.session.send(cmd.power(1, state.power[1]));
    }
  };

  // Feed timestamps tick along
  setInterval(() => { if (driverActive() && state.feed.length) renderFeed(); }, 5000);

  // Leaving the page: silence the box and end the session
  window.addEventListener('pagehide', () => {
    state.session?.close();
    if (coyote.ready) coyote.disconnect();
  });
}

wire();
renderSettings();
renderManualSettings();
renderPlayerSettings();
renderGenerator();
renderAll();
startClock();
