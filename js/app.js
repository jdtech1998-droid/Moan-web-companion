import {
  DEFAULT_RELAY_URL, POWER_MAX, ChannelEncoder, cmd, normalizedToWireHz, clamp,
} from './protocol.js';
import { Coyote3, bluetoothSupported } from './coyote3.js';
import { RemoteStream } from './stream.js';
import { Generator, SHAPE_NAMES, SPEED_RANGE } from './generator.js';
import { RiderSession, DriverSession } from './remote.js';
import { FEEDBACK_PRESETS, RIDER_ESTOP_PRESET, isSafety, isStop } from './feedback.js';

const $ = id => document.getElementById(id);

// ---- Settings (per browser) ---------------------------------------------------------------------

const STORAGE_KEY = 'howl-web-companion';
const DEFAULT_SETTINGS = {
  role: 'rider',
  limits: [70, 70], // local power limits, like Howl's default; a Rider session uses its own MAX instead
  step: 1,
  balance: { frequencyBalanceA: 200, frequencyBalanceB: 200, intensityBalanceA: 0, intensityBalanceB: 0 },
  relayUrl: DEFAULT_RELAY_URL,
  freqRange: [10, 100], // output frequency range, Hz
  generator: null,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...structuredClone(DEFAULT_SETTINGS), ...saved, balance: { ...DEFAULT_SETTINGS.balance, ...saved.balance } };
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
const AUTO_CHANGE_TICKS = 300; // 30s

const coyote = new Coyote3();
const generator = new Generator();
if (Array.isArray(settings.generator) && settings.generator.length === 2) generator.channels = settings.generator;
const stream = new RemoteStream();
const encoders = [new ChannelEncoder(), new ChannelEncoder()];

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
  feed: [],
  feedSeq: 0,
  lastPulse: SILENT,
  ticks: 0,
};

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
  const fromGenerator = !fromStream && state.playing;

  const pulses = [];
  for (let i = 0; i < PULSES_PER_TICK; i++) {
    let p = fromStream ? stream.next(now + i * 25) : fromGenerator ? generator.next(TICK_SECONDS / PULSES_PER_TICK) : SILENT;
    if (state.muted) p = { ...p, ampA: 0, ampB: 0 };
    pulses.push(p);
  }

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

  if (fromGenerator && $('genAuto').checked && ++state.ticks % AUTO_CHANGE_TICKS === 0) {
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

function setPlaying(playing) {
  if (playing && riderActive()) return;
  if (state.playing === playing) return;
  state.playing = playing;
  if (!playing) {
    // Pause and stop end the stream: the Rider must go quiet at once, not freeze on the last pulse
    if (driverBound()) state.session.send(cmd.streamEnd());
    encoders.forEach(e => e.reset());
  }
  renderPlay();
  renderGeneratorHint();
}

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
  } else {
    state.feed.unshift({ preset, at: now, count: 1, id: seq, seq, acked: !isSafety(preset) });
    state.feed.length = Math.min(state.feed.length, FEED_MAX);
  }
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

function renderMeters() {
  $('meterA').style.height = `${Math.round(state.lastPulse.ampA * 100)}%`;
  $('meterB').style.height = `${Math.round(state.lastPulse.ampB * 100)}%`;
}

function renderPlay() {
  const path = state.playing ? 'M7 5h4v14H7zm6 0h4v14h-4z' : 'M8 5v14l11-7z';
  $('playIconPath').setAttribute('d', path);
  $('genPlayPath').setAttribute('d', path);
  $('playBtn').disabled = riderActive();
  $('genPlay').disabled = riderActive();
}

function renderMute() {
  $('muteBtn').setAttribute('aria-pressed', String(state.muted));
  $('muteLabel').textContent = state.muted ? 'Muted' : 'Mute';
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

function renderGeneratorHint() {
  let hint;
  if (riderActive()) hint = "The generator is off while you're the Rider: your Driver is in control.";
  else if (driverBound()) hint = state.playing ? 'Streaming these waves to your Rider.' : 'Press play to send these waves to your Rider.';
  else if (driverActive()) hint = 'Waiting for the Rider…';
  else if (coyote.ready) hint = 'Plays on your Coyote. Start a Driver session on the Remote tab to send it to a Rider instead.';
  else hint = 'Connect a Coyote to feel it yourself, or join a Rider as the Driver on the Remote tab.';
  $('genHint').textContent = hint;
}

function renderSettings() {
  $('setLimitA').value = settings.limits[0];
  $('setLimitB').value = settings.limits[1];
  $('setStep').value = settings.step;
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
  renderFreqRange();
  renderDevice();
  renderRemote();
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
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
}

function wire() {
  document.querySelectorAll('.tab').forEach(t => { t.onclick = () => selectTab(t.dataset.tab); });
  document.querySelectorAll('[data-goto]').forEach(a => {
    a.onclick = e => { e.preventDefault(); selectTab(a.dataset.goto); };
  });

  document.querySelectorAll('[data-power]').forEach(b => {
    b.onclick = () => {
      const ch = Number(b.dataset.power);
      setPower(ch, state.power[ch] + Number(b.dataset.delta) * settings.step);
      // A Rider's own change is reported so the Driver's dial stays in step
      if (riderBound()) state.session.send(cmd.power(ch, state.power[ch]));
    };
  });

  $('muteBtn').onclick = () => { state.muted = !state.muted; renderMute(); };
  $('playBtn').onclick = $('genPlay').onclick = () => setPlaying(!state.playing);

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
renderGenerator();
renderAll();
startClock();
