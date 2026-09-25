// A circular touchpad, as Howl's CircularTouchpad: drag inside the circle to move the dot. On release the dot
// glides back to the centre at `returnRate` pad units per second (0 leaves it where it was let go).

const BORDER = 4;
const DOT_RADIUS = 8;

export class Touchpad {
  /**
   * @param {HTMLElement} el the pad element (a square, drawn as a circle by CSS)
   * @param {(pos:{x:number, y:number}) => void} onChange positions in -1..1, y down
   * @param {() => number} returnRate
   */
  constructor(el, onChange, returnRate) {
    this.el = el;
    this.onChange = onChange;
    this.returnRate = returnRate;
    this.position = { x: 0, y: 0 };
    this.dot = el.appendChild(document.createElement('div'));
    this.dot.className = 'touchpad-dot';
    this.pointer = null;
    this.frame = null;

    el.addEventListener('pointerdown', e => {
      if (this.pointer !== null) return;
      const pos = this.toPad(e, false);
      if (!pos) return; // in the square's corner, outside the circle
      e.preventDefault();
      this.pointer = e.pointerId;
      el.setPointerCapture(e.pointerId);
      cancelAnimationFrame(this.frame); // stop any return to centre
      this.set(pos);
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerId === this.pointer) this.set(this.toPad(e, true));
    });
    const release = e => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      this.returnToCentre();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    new ResizeObserver(() => this.draw()).observe(el);
  }

  /** Pointer position as pad coordinates, clamped so the dot stays inside the border. */
  toPad(e, dragging) {
    const r = this.el.getBoundingClientRect();
    const outer = r.width / 2;
    const inner = Math.max(outer - BORDER - DOT_RADIUS, 1);
    const dx = e.clientX - (r.left + outer);
    const dy = e.clientY - (r.top + outer);
    const dist = Math.hypot(dx, dy);
    // A touch can start anywhere in the circle; a drag can wander outside it
    if (!dragging && dist > outer) return null;
    const scale = dist === 0 ? 0 : Math.min(dist, inner) / dist;
    const clamp = v => Math.min(Math.max(v, -1), 1);
    return { x: clamp((dx * scale) / inner), y: clamp((dy * scale) / inner) };
  }

  set(pos) {
    this.position = pos;
    this.onChange(pos);
    this.draw();
  }

  /** Straight back to the centre, taking distance / returnRate seconds. */
  returnToCentre() {
    const rate = this.returnRate();
    const start = this.position;
    const distance = Math.hypot(start.x, start.y);
    if (rate <= 0 || distance === 0) return;
    const duration = (distance / rate) * 1000;
    const t0 = performance.now();
    const step = now => {
      const progress = Math.min((now - t0) / duration, 1);
      this.set({ x: start.x * (1 - progress), y: start.y * (1 - progress) });
      if (progress < 1) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  /** Back to the centre at once, e.g. when the pad is hidden. */
  reset() {
    cancelAnimationFrame(this.frame);
    this.pointer = null;
    this.set({ x: 0, y: 0 });
  }

  draw() {
    const inner = Math.max(this.el.clientWidth / 2 - BORDER - DOT_RADIUS, 0);
    this.dot.style.transform = `translate(${this.position.x * inner}px, ${this.position.y * inner}px)`;
  }
}
