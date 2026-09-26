// Pulse chart, as in Howl's PulseChart.kt: the most recent pulses scroll right to left,
// height is amplitude (or frequency on Quad's bottom row) and colour is frequency.

export const CHART_MODES = ['Off', 'Combined', 'Per Channel', 'Quad'];
export const CHART_STYLES = ['Point', 'Line'];

const HISTORY_SIZE = 301; // 7.5 seconds at 40 pulses/sec (+1 so the line chart's last point can join up)
const PER_CHANNEL_WINDOW = 150;
const COMBINED_WINDOW = 300;
const GRID_FRACTIONS = [0.25, 0.5, 0.75];

// [low frequency colour, high frequency colour]
const COLOURS_A = [[0xFF, 0x22, 0x00], [0xFF, 0xDD, 0x00]];
const COLOURS_B = [[0x00, 0x55, 0xFF], [0x00, 0xFF, 0xAA]];

const ampA = { value: p => p.ampA, freq: p => p.freqA, colours: COLOURS_A };
const ampB = { value: p => p.ampB, freq: p => p.freqB, colours: COLOURS_B };
const freqA = { value: p => p.freqA, freq: p => p.freqA, colours: COLOURS_A };
const freqB = { value: p => p.freqB, freq: p => p.freqB, colours: COLOURS_B };

const LAYOUTS = {
  Combined: [{ label: 'A+B', window: COMBINED_WINDOW, series: [ampA, ampB], wide: true }],
  'Per Channel': [
    { label: 'A', window: PER_CHANNEL_WINDOW, series: [ampA] },
    { label: 'B', window: PER_CHANNEL_WINDOW, series: [ampB] },
  ],
  Quad: [
    { label: 'A (Amp)', window: PER_CHANNEL_WINDOW, series: [ampA] },
    { label: 'B (Amp)', window: PER_CHANNEL_WINDOW, series: [ampB] },
    { label: 'A (Freq)', window: PER_CHANNEL_WINDOW, series: [freqA] },
    { label: 'B (Freq)', window: PER_CHANNEL_WINDOW, series: [freqB] },
  ],
};

export class PulseHistory {
  constructor() {
    this.pulses = [];
  }

  add(pulse) {
    this.pulses.push(pulse);
    if (this.pulses.length > HISTORY_SIZE) this.pulses.shift();
  }

  /** Up to `count` most recent pulses, oldest first. */
  recent(count) {
    return this.pulses.slice(-count);
  }
}

function colour([low, high], t) {
  const f = Math.min(Math.max(t, 0), 1);
  const [r, g, b] = low.map((c, i) => Math.round(c + (high[i] - c) * f));
  return `rgb(${r},${g},${b})`;
}

export class PulseChart {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.mode = 'Off';
    this.charts = [];
  }

  setMode(mode) {
    this.mode = mode;
    this.container.hidden = mode === 'Off';
    this.container.dataset.mode = mode;
    this.charts = (LAYOUTS[mode] ?? []).map(layout => {
      const canvas = document.createElement('canvas');
      canvas.className = `chart${layout.wide ? ' wide' : ''}`;
      return { ...layout, canvas };
    });
    this.container.replaceChildren(...this.charts.map(c => c.canvas));
  }

  /** @param {PulseHistory} history @param {'Point'|'Line'} style */
  draw(history, style) {
    if (!this.charts.length) return;
    const css = getComputedStyle(this.container);
    const grid = css.getPropertyValue('--outline-variant').trim();
    const label = css.getPropertyValue('--on-surface-variant').trim();
    for (const chart of this.charts) {
      const { canvas } = chart;
      // Device pixels per page pixel, including any page zoom, so the chart stays sharp
      const dpr = (window.devicePixelRatio || 1) * (canvas.getBoundingClientRect().width / canvas.clientWidth || 1);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w <= 1 || h <= 1) continue;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (const frac of GRID_FRACTIONS) {
        ctx.beginPath();
        ctx.moveTo(0, frac * h);
        ctx.lineTo(w, frac * h);
        ctx.stroke();
      }

      // One extra pulse so the oldest visible point connects to the left edge
      const pulses = history.recent(chart.window + 1);
      const last = pulses.length - 1;
      const step = w / chart.window;
      const lineWidth = 2.2 * dpr;
      const x = i => w - (last - i) * step;
      const y = v => (1 - Math.min(Math.max(v, 0), 1)) * h;

      for (const s of chart.series) {
        if (style === 'Line') {
          ctx.lineWidth = lineWidth;
          ctx.lineCap = 'round';
          for (let i = 0; i < last; i++) {
            ctx.strokeStyle = colour(s.colours, (s.freq(pulses[i]) + s.freq(pulses[i + 1])) / 2);
            ctx.beginPath();
            ctx.moveTo(x(i), y(s.value(pulses[i])));
            ctx.lineTo(x(i + 1), y(s.value(pulses[i + 1])));
            ctx.stroke();
          }
        } else {
          const r = lineWidth * 0.6;
          for (let i = 0; i <= last; i++) {
            ctx.fillStyle = colour(s.colours, s.freq(pulses[i]));
            ctx.beginPath();
            ctx.arc(x(i), y(s.value(pulses[i])), r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      ctx.globalAlpha = 0.6;
      ctx.fillStyle = label;
      ctx.font = `${12 * dpr}px Roboto, "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(chart.label, 6 * dpr, h - 6 * dpr);
      ctx.globalAlpha = 1;
    }
  }
}
