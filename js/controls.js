// Builds form controls from the plain descriptions activities give (see activities.js) and keeps them in step
// with values the activity changes by itself, such as a smoother's target in automatic mode.

const fmt = v => Number(v).toFixed(2);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A range input that remembers when it is being dragged, so refreshes don't fight the user. */
function range(min, max, step, onInput) {
  const input = el('input');
  Object.assign(input, { type: 'range', min, max, step });
  input.addEventListener('pointerdown', () => { input.dataset.dragging = '1'; });
  const release = () => { delete input.dataset.dragging; };
  input.addEventListener('pointerup', release);
  input.addEventListener('pointercancel', release);
  input.addEventListener('change', release);
  input.addEventListener('input', () => onInput(Number(input.value)));
  return input;
}

const setIfIdle = (input, value) => {
  if (!input.dataset.dragging && document.activeElement !== input) input.value = value;
};

/**
 * @param {HTMLElement} container
 * @param {object[]} controls
 * @param {() => void} onPersist called after a change to a `persist` control
 * @returns {() => void} refresh
 */
export function buildControls(container, controls, onPersist) {
  const refreshers = [];
  const disabled = c => (c.disabled ? c.disabled() : false);

  for (const c of controls) {
    if (c.type === 'text') {
      container.append(el(c.heading ? 'h3' : 'p', c.heading ? 'controls-heading' : 'muted small', c.text));
    } else if (c.type === 'switch') {
      const row = el('label', `switch-row${c.heading ? ' heading' : ''}`);
      const box = el('input', 'switch');
      box.type = 'checkbox';
      // Refresh at once: a switch usually enables other controls, and output ticks may not be running
      box.onchange = () => { c.set(box.checked); if (c.persist) onPersist(); refresh(); };
      row.append(el('span', null, c.label), box);
      container.append(row);
      refreshers.push(() => { box.checked = c.get(); });
    } else if (c.type === 'slider') {
      const row = el('label', 'slider-setting');
      const out = el('output');
      const input = range(c.min, c.max, c.step, v => { c.set(v); out.textContent = fmt(v); });
      if (c.persist) input.addEventListener('change', onPersist);
      row.append(el('span', null, c.label), out, input);
      container.append(row);
      refreshers.push(() => {
        setIfIdle(input, c.get());
        if (!input.dataset.dragging) out.textContent = fmt(c.get());
        input.disabled = disabled(c);
        row.classList.toggle('disabled', input.disabled);
      });
    } else if (c.type === 'select') {
      const row = el('label', 'setting');
      const select = el('select');
      for (const [value, label] of c.options) select.append(Object.assign(el('option', null, label), { value }));
      select.onchange = () => { c.set(select.value); if (c.persist) onPersist(); };
      row.append(el('span', null, c.label), select);
      container.append(row);
      refreshers.push(() => {
        if (document.activeElement !== select) select.value = c.get();
        select.disabled = disabled(c);
        row.classList.toggle('disabled', select.disabled);
      });
    } else if (c.type === 'smoother') {
      // Target and rate side by side, as Howl's NiceSmootherControl. No rateRange: target only.
      const s = c.smoother;
      const row = el('div', c.rateRange ? 'smoother-control' : 'smoother-control target-only');
      const col = (label, out, input, cls) => {
        const box = el('label', cls);
        box.append(el('span', null, label), out, input);
        return box;
      };
      const targetOut = el('output');
      const target = range(c.targetRange[0], c.targetRange[1], c.step ?? 0.01, v => { s.setTarget(v); targetOut.textContent = fmt(v); });
      row.append(col(c.label, targetOut, target, 'slider-setting'));
      let rate = null;
      let rateOut = null;
      if (c.rateRange) {
        rateOut = el('output');
        rate = range(c.rateRange[0], c.rateRange[1], 0.01, v => { s.rate = v; rateOut.textContent = fmt(v); });
        row.append(col('Rate', rateOut, rate, 'slider-setting rate'));
      }
      container.append(row);
      refreshers.push(() => {
        setIfIdle(target, s.target);
        if (!target.dataset.dragging) targetOut.textContent = fmt(s.target);
        target.disabled = disabled(c);
        if (rate) {
          setIfIdle(rate, s.rate);
          if (!rate.dataset.dragging) rateOut.textContent = fmt(s.rate);
          rate.disabled = target.disabled;
        }
        row.classList.toggle('disabled', target.disabled);
      });
    } else if (c.type === 'buttons') {
      const row = el('div', 'button-row');
      const buttons = c.buttons.map(([label, onClick]) => {
        const b = el('button', 'btn-tonal small', label);
        b.type = 'button';
        b.onclick = onClick;
        return b;
      });
      row.append(...buttons);
      container.append(row);
      refreshers.push(() => { for (const b of buttons) b.disabled = disabled(c); });
    }
  }

  const refresh = () => refreshers.forEach(r => r());
  refresh();
  return refresh;
}
