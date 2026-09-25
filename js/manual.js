// Manual control, ported from Howl's Manual.kt: two touchpads, left for channel A and right for B.
// A pad position is x, y in -1..1 (y grows downwards). Distance from the centre is the amplitude,
// the angle is the frequency: highest at the top, lowest at the bottom.

export const MANUAL_DEFAULTS = { smoothing: 0.1, centerRate: 0.6 }; // Howl's defaults
export const SMOOTHING_RANGE = [0, 2]; // seconds
export const CENTER_RATE_RANGE = [0, 4]; // pad units per second, 0 = stay where released

const ZERO = { x: 0, y: 0 };

/** 1 at the top of the pad, 0 at the bottom, whichever way round the angle is measured. */
export function angleToFrequency(angle) {
  const twoPi = 2 * Math.PI;
  const normalised = ((angle % twoPi) + twoPi) % twoPi;
  const top = (3 * Math.PI) / 2; // atan2 of straight up (y = -1)
  const dist = Math.abs(normalised - top);
  return 1 - Math.min(dist, twoPi - dist) / Math.PI;
}

/** Unity-style SmoothDamp on a 2D point, as in Manual.kt. Returns [position, velocity]. */
export function smoothDamp(current, target, velocity, smoothTime, dt) {
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  const changeX = current.x - target.x;
  const changeY = current.y - target.y;
  const tempX = (velocity.x + omega * changeX) * dt;
  const tempY = (velocity.y + omega * changeY) * dt;

  let vx = (velocity.x - omega * tempX) * exp;
  let vy = (velocity.y - omega * tempY) * exp;
  let outX = target.x + (changeX + tempX) * exp;
  let outY = target.y + (changeY + tempY) * exp;

  // Prevent overshooting
  if ((target.x - current.x) * (outX - target.x) + (target.y - current.y) * (outY - target.y) > 0) {
    outX = target.x;
    outY = target.y;
    vx = 0;
    vy = 0;
  }
  return [{ x: outX, y: outY }, { x: vx, y: vy }];
}

export class Manual {
  constructor() {
    this.smoothing = MANUAL_DEFAULTS.smoothing;
    this.reset();
  }

  reset() {
    this.targets = [ZERO, ZERO];
    this.smoothed = [ZERO, ZERO];
    this.velocity = [ZERO, ZERO];
  }

  /** @param {0|1} ch @param {{x:number, y:number}} position */
  setPosition(ch, position) {
    this.targets[ch] = position;
  }

  /** Advances by `dt` seconds and returns the pulse for that moment. */
  next(dt) {
    for (const ch of [0, 1]) {
      if (this.smoothing <= 0) {
        this.smoothed[ch] = this.targets[ch];
        // No stale momentum if smoothing is switched back on
        this.velocity[ch] = ZERO;
      } else {
        [this.smoothed[ch], this.velocity[ch]] = smoothDamp(this.smoothed[ch], this.targets[ch], this.velocity[ch], this.smoothing, dt);
      }
    }
    const [a, b] = this.smoothed;
    return {
      ampA: Math.min(Math.hypot(a.x, a.y), 1),
      ampB: Math.min(Math.hypot(b.x, b.y), 1),
      freqA: angleToFrequency(Math.atan2(a.y, a.x)),
      freqB: angleToFrequency(Math.atan2(b.y, b.x)),
    };
  }
}
