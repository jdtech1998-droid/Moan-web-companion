// 3D OpenSimplex noise (after Kurt Spencer), ported from Howl's SimplexNoise.kt. The body of random3D is a
// mechanical translation of the Kotlin; keep it that way so the two stay easy to compare.

const GRADIENTS_3D = [
  -11, 4, 4, -4, 11, 4, -4, 4, 11,
  11, 4, 4, 4, 11, 4, 4, 4, 11,
  -11, -4, 4, -4, -11, 4, -4, -4, 11,
  11, -4, 4, 4, -11, 4, 4, -4, 11,
  -11, 4, -4, -4, 11, -4, -4, 4, -11,
  11, 4, -4, 4, 11, -4, 4, 4, -11,
  -11, -4, -4, -4, -11, -4, -4, -4, -11,
  11, -4, -4, 4, -11, -4, 4, -4, -11,
];
const STRETCH = -1.0 / 6;
const SQUISH = 1.0 / 3;
const NORM = 103.0;

export class SimplexNoise {
  constructor(seed = Date.now()) {
    this.perm = new Int32Array(256);
    this.permGradIndex3D = new Int32Array(256);
    // 64-bit LCG as in the Kotlin (Long arithmetic wraps), so BigInt
    const step = s => BigInt.asIntN(64, s * 6364136223846793005n + 1442695040888963407n);
    let s = BigInt.asIntN(64, BigInt(Math.floor(seed)));
    const source = Array.from({ length: 256 }, (_, i) => i);
    s = step(step(step(s)));
    for (let i = 255; i >= 0; i--) {
      s = step(s);
      let r = Number((s + 31n) % BigInt(i + 1));
      if (r < 0) r += i + 1;
      this.perm[i] = source[r];
      this.permGradIndex3D[i] = (this.perm[i] % (GRADIENTS_3D.length / 3)) * 3;
      source[r] = source[i];
    }
  }

  /** Noise in roughly -1..1. */
  random3D(x, y, z) {
    let stretchOffset = (x + y + z) * STRETCH
    let xs = x + stretchOffset
    let ys = y + stretchOffset
    let zs = z + stretchOffset

    let xsb = Math.floor(xs)
    let ysb = Math.floor(ys)
    let zsb = Math.floor(zs)

    let squishOffset = (xsb + ysb + zsb) * SQUISH
    let xb = xsb + squishOffset
    let yb = ysb + squishOffset
    let zb = zsb + squishOffset

    let xIns = xs - xsb
    let yIns = ys - ysb
    let zIns = zs - zsb

    let inSum = xIns + yIns + zIns

    let dx0 = x - xb
    let dy0 = y - yb
    let dz0 = z - zb

    let dxExt0; let dyExt0; let dzExt0
    let dxExt1; let dyExt1; let dzExt1
    let xsvExt0; let ysvExt0; let zsvExt0
    let xsvExt1; let ysvExt1; let zsvExt1

    let value = 0.0
    if (inSum <= 1.0) {
        let aPoint = 0x01; let aScore = xIns
        let bPoint = 0x02; let bScore = yIns
        if (aScore >= bScore && zIns > bScore) { bScore = zIns; bPoint = 0x04 }
        else if (aScore < bScore && zIns > aScore) { aScore = zIns; aPoint = 0x04 }

        let wins = 1 - inSum
        if (wins > aScore || wins > bScore) {
            let c = (bScore > aScore) ? bPoint : aPoint
            if ((c & 0x01) == 0) { xsvExt0 = xsb - 1; xsvExt1 = xsb; dxExt0 = dx0 + 1; dxExt1 = dx0 }
            else { xsvExt1 = xsb + 1; xsvExt0 = xsvExt1; dxExt1 = dx0 - 1; dxExt0 = dxExt1 }

            if ((c & 0x02) == 0) {
                ysvExt1 = ysb; ysvExt0 = ysvExt1; dyExt1 = dy0; dyExt0 = dyExt1
                if ((c & 0x01) == 0) { ysvExt1 -= 1; dyExt1 += 1.0 } else { ysvExt0 -= 1; dyExt0 += 1.0 }
            } else { ysvExt1 = ysb + 1; ysvExt0 = ysvExt1; dyExt1 = dy0 - 1; dyExt0 = dyExt1 }

            if ((c & 0x04) == 0) { zsvExt0 = zsb; zsvExt1 = zsb - 1; dzExt0 = dz0; dzExt1 = dz0 + 1 }
            else { zsvExt1 = zsb + 1; zsvExt0 = zsvExt1; dzExt1 = dz0 - 1; dzExt0 = dzExt1 }
        } else {
            let c = aPoint | bPoint
            if ((c & 0x01) == 0) { xsvExt0 = xsb; xsvExt1 = xsb - 1; dxExt0 = dx0 - 2 * SQUISH; dxExt1 = dx0 + 1 - SQUISH }
            else { xsvExt1 = xsb + 1; xsvExt0 = xsvExt1; dxExt0 = dx0 - 1 - 2 * SQUISH; dxExt1 = dx0 - 1 - SQUISH }

            if ((c & 0x02) == 0) { ysvExt0 = ysb; ysvExt1 = ysb - 1; dyExt0 = dy0 - 2 * SQUISH; dyExt1 = dy0 + 1 - SQUISH }
            else { ysvExt1 = ysb + 1; ysvExt0 = ysvExt1; dyExt0 = dy0 - 1 - 2 * SQUISH; dyExt1 = dy0 - 1 - SQUISH }

            if ((c & 0x04) == 0) { zsvExt0 = zsb; zsvExt1 = zsb - 1; dzExt0 = dz0 - 2 * SQUISH; dzExt1 = dz0 + 1 - SQUISH }
            else { zsvExt1 = zsb + 1; zsvExt0 = zsvExt1; dzExt0 = dz0 - 1 - 2 * SQUISH; dzExt1 = dz0 - 1 - SQUISH }
        }

        let attn0 = 2.0 - dx0 * dx0 - dy0 * dy0 - dz0 * dz0
        if (attn0 > 0) { attn0 *= attn0; value += attn0 * attn0 * this.extrapolate(xsb, ysb, zsb, dx0, dy0, dz0) }

        let dx1 = dx0 - 1 - SQUISH
        let dy1 = dy0 - 0 - SQUISH
        let dz1 = dz0 - 0 - SQUISH
        let attn1 = 2.0 - dx1 * dx1 - dy1 * dy1 - dz1 * dz1
        if (attn1 > 0) { attn1 *= attn1; value += attn1 * attn1 * this.extrapolate(xsb + 1, ysb, zsb, dx1, dy1, dz1) }

        let dx2 = dx0 - 0 - SQUISH
        let dy2 = dy0 - 1 - SQUISH
        let attn2 = 2.0 - dx2 * dx2 - dy2 * dy2 - dz1 * dz1
        if (attn2 > 0) { attn2 *= attn2; value += attn2 * attn2 * this.extrapolate(xsb, ysb + 1, zsb, dx2, dy2, dz1) }

        let dz3 = dz0 - 1 - SQUISH
        let attn3 = 2.0 - dx2 * dx2 - dy1 * dy1 - dz3 * dz3
        if (attn3 > 0) { attn3 *= attn3; value += attn3 * attn3 * this.extrapolate(xsb, ysb, zsb + 1, dx2, dy1, dz3) }

    } else if (inSum >= 2.0) {
        let aPoint = 0x06; let aScore = xIns
        let bPoint = 0x05; let bScore = yIns
        if (aScore <= bScore && zIns < bScore) { bScore = zIns; bPoint = 0x03 }
        else if (aScore > bScore && zIns < aScore) { aScore = zIns; aPoint = 0x03 }

        let wins = 3 - inSum
        if (wins < aScore || wins < bScore) {
            let c = (bScore < aScore) ? bPoint : aPoint
            if ((c & 0x01) != 0) { xsvExt0 = xsb + 2; xsvExt1 = xsb + 1; dxExt0 = dx0 - 2 - 3 * SQUISH; dxExt1 = dx0 - 1 - 3 * SQUISH }
            else { xsvExt1 = xsb; xsvExt0 = xsvExt1; dxExt1 = dx0 - 3 * SQUISH; dxExt0 = dxExt1 }

            if ((c & 0x02) != 0) {
                ysvExt1 = ysb + 1; ysvExt0 = ysvExt1; dyExt1 = dy0 - 1 - 3 * SQUISH; dyExt0 = dyExt1
                if ((c & 0x01) != 0) { ysvExt1 += 1; dyExt1 -= 1.0 } else { ysvExt0 += 1; dyExt0 -= 1.0 }
            } else { ysvExt1 = ysb; ysvExt0 = ysvExt1; dyExt1 = dy0 - 3 * SQUISH; dyExt0 = dyExt1 }

            if ((c & 0x04) != 0) { zsvExt0 = zsb + 1; zsvExt1 = zsb + 2; dzExt0 = dz0 - 1 - 3 * SQUISH; dzExt1 = dz0 - 2 - 3 * SQUISH }
            else { zsvExt1 = zsb; zsvExt0 = zsvExt1; dzExt1 = dz0 - 3 * SQUISH; dzExt0 = dzExt1 }
        } else {
            let c = aPoint & bPoint
            if ((c & 0x01) != 0) { xsvExt0 = xsb + 1; xsvExt1 = xsb + 2; dxExt0 = dx0 - 1 - SQUISH; dxExt1 = dx0 - 2 - 2 * SQUISH }
            else { xsvExt1 = xsb; xsvExt0 = xsvExt1; dxExt0 = dx0 - SQUISH; dxExt1 = dx0 - 2 * SQUISH }

            if ((c & 0x02) != 0) { ysvExt0 = ysb + 1; ysvExt1 = ysb + 2; dyExt0 = dy0 - 1 - SQUISH; dyExt1 = dy0 - 2 - 2 * SQUISH }
            else { ysvExt1 = ysb; ysvExt0 = ysvExt1; dyExt0 = dy0 - SQUISH; dyExt1 = dy0 - 2 * SQUISH }

            if ((c & 0x04) != 0) { zsvExt0 = zsb + 1; zsvExt1 = zsb + 2; dzExt0 = dz0 - 1 - SQUISH; dzExt1 = dz0 - 2 - 2 * SQUISH }
            else { zsvExt1 = zsb; zsvExt0 = zsvExt1; dzExt0 = dz0 - SQUISH; dzExt1 = dz0 - 2 * SQUISH }
        }

        let dx3 = dx0 - 1 - 2 * SQUISH
        let dy3 = dy0 - 1 - 2 * SQUISH
        let dz3 = dz0 - 0 - 2 * SQUISH
        let attn3 = 2.0 - dx3 * dx3 - dy3 * dy3 - dz3 * dz3
        if (attn3 > 0) { attn3 *= attn3; value += attn3 * attn3 * this.extrapolate(xsb + 1, ysb + 1, zsb, dx3, dy3, dz3) }

        let dy2 = dy0 - 0 - 2 * SQUISH
        let dz2 = dz0 - 1 - 2 * SQUISH
        let attn2 = 2.0 - dx3 * dx3 - dy2 * dy2 - dz2 * dz2
        if (attn2 > 0) { attn2 *= attn2; value += attn2 * attn2 * this.extrapolate(xsb + 1, ysb, zsb + 1, dx3, dy2, dz2) }

        let dx1 = dx0 - 0 - 2 * SQUISH
        let attn1 = 2.0 - dx1 * dx1 - dy3 * dy3 - dz2 * dz2
        if (attn1 > 0) { attn1 *= attn1; value += attn1 * attn1 * this.extrapolate(xsb, ysb + 1, zsb + 1, dx1, dy3, dz2) }

        dx0 = dx0 - 1 - 3 * SQUISH
        dy0 = dy0 - 1 - 3 * SQUISH
        dz0 = dz0 - 1 - 3 * SQUISH
        let attn0 = 2.0 - dx0 * dx0 - dy0 * dy0 - dz0 * dz0
        if (attn0 > 0) { attn0 *= attn0; value += attn0 * attn0 * this.extrapolate(xsb + 1, ysb + 1, zsb + 1, dx0, dy0, dz0) }

    } else {
        let aScore; let aPoint; let aIsFurtherSide
        let bScore; let bPoint; let bIsFurtherSide

        let p1 = xIns + yIns
        if (p1 > 1) { aScore = p1 - 1; aPoint = 0x03; aIsFurtherSide = true }
        else { aScore = 1 - p1; aPoint = 0x04; aIsFurtherSide = false }

        let p2 = xIns + zIns
        if (p2 > 1) { bScore = p2 - 1; bPoint = 0x05; bIsFurtherSide = true }
        else { bScore = 1 - p2; bPoint = 0x02; bIsFurtherSide = false }

        let p3 = yIns + zIns
        if (p3 > 1) {
            let score = p3 - 1
            if (aScore <= bScore && aScore < score) {
                aPoint = 0x06; aIsFurtherSide = true }
            else if (aScore > bScore && bScore < score) {
                bPoint = 0x06; bIsFurtherSide = true }
        } else {
            let score = 1 - p3
            if (aScore <= bScore && aScore < score) {
                aPoint = 0x01; aIsFurtherSide = false }
            else if (aScore > bScore && bScore < score) {
                bPoint = 0x01; bIsFurtherSide = false }
        }

        if (aIsFurtherSide == bIsFurtherSide) {
            if (aIsFurtherSide) {
                dxExt0 = dx0 - 1 - 3 * SQUISH; dyExt0 = dy0 - 1 - 3 * SQUISH; dzExt0 = dz0 - 1 - 3 * SQUISH
                xsvExt0 = xsb + 1; ysvExt0 = ysb + 1; zsvExt0 = zsb + 1

                let c = aPoint & bPoint
                if ((c & 0x01) != 0) { dxExt1 = dx0 - 2 - 2 * SQUISH; dyExt1 = dy0 - 2 * SQUISH; dzExt1 = dz0 - 2 * SQUISH; xsvExt1 = xsb + 2; ysvExt1 = ysb; zsvExt1 = zsb }
                else if ((c & 0x02) != 0) { dxExt1 = dx0 - 2 * SQUISH; dyExt1 = dy0 - 2 - 2 * SQUISH; dzExt1 = dz0 - 2 * SQUISH; xsvExt1 = xsb; ysvExt1 = ysb + 2; zsvExt1 = zsb }
                else { dxExt1 = dx0 - 2 * SQUISH; dyExt1 = dy0 - 2 * SQUISH; dzExt1 = dz0 - 2 - 2 * SQUISH; xsvExt1 = xsb; ysvExt1 = ysb; zsvExt1 = zsb + 2 }
            } else {
                dxExt0 = dx0; dyExt0 = dy0; dzExt0 = dz0
                xsvExt0 = xsb; ysvExt0 = ysb; zsvExt0 = zsb

                let c = aPoint | bPoint
                if ((c & 0x01) == 0) { dxExt1 = dx0 + 1 - SQUISH; dyExt1 = dy0 - 1 - SQUISH; dzExt1 = dz0 - 1 - SQUISH; xsvExt1 = xsb - 1; ysvExt1 = ysb + 1; zsvExt1 = zsb + 1 }
                else if ((c & 0x02) == 0) { dxExt1 = dx0 - 1 - SQUISH; dyExt1 = dy0 + 1 - SQUISH; dzExt1 = dz0 - 1 - SQUISH; xsvExt1 = xsb + 1; ysvExt1 = ysb - 1; zsvExt1 = zsb + 1 }
                else { dxExt1 = dx0 - 1 - SQUISH; dyExt1 = dy0 - 1 - SQUISH; dzExt1 = dz0 + 1 - SQUISH; xsvExt1 = xsb + 1; ysvExt1 = ysb + 1; zsvExt1 = zsb - 1 }
            }
        } else {
            let c1 = (aIsFurtherSide) ? aPoint : bPoint
            let c2 = (aIsFurtherSide) ? bPoint : aPoint

            if ((c1 & 0x01) == 0) { dxExt0 = dx0 + 1 - SQUISH; dyExt0 = dy0 - 1 - SQUISH; dzExt0 = dz0 - 1 - SQUISH; xsvExt0 = xsb - 1; ysvExt0 = ysb + 1; zsvExt0 = zsb + 1 }
            else if ((c1 & 0x02) == 0) { dxExt0 = dx0 - 1 - SQUISH; dyExt0 = dy0 + 1 - SQUISH; dzExt0 = dz0 - 1 - SQUISH; xsvExt0 = xsb + 1; ysvExt0 = ysb - 1; zsvExt0 = zsb + 1 }
            else { dxExt0 = dx0 - 1 - SQUISH; dyExt0 = dy0 - 1 - SQUISH; dzExt0 = dz0 + 1 - SQUISH; xsvExt0 = xsb + 1; ysvExt0 = ysb + 1; zsvExt0 = zsb - 1 }

            dxExt1 = dx0 - 2 * SQUISH; dyExt1 = dy0 - 2 * SQUISH; dzExt1 = dz0 - 2 * SQUISH
            xsvExt1 = xsb; ysvExt1 = ysb; zsvExt1 = zsb
            if ((c2 & 0x01) != 0) { dxExt1 -= 2.0; xsvExt1 += 2 }
            else if ((c2 & 0x02) != 0) { dyExt1 -= 2.0; ysvExt1 += 2 }
            else { dzExt1 -= 2.0; zsvExt1 += 2 }
        }

        let dx1 = dx0 - 1 - SQUISH
        let dy1 = dy0 - 0 - SQUISH
        let dz1 = dz0 - 0 - SQUISH
        let attn1 = 2.0 - dx1 * dx1 - dy1 * dy1 - dz1 * dz1
        if (attn1 > 0) { attn1 *= attn1; value += attn1 * attn1 * this.extrapolate(xsb + 1, ysb, zsb, dx1, dy1, dz1) }

        let dx2 = dx0 - 0 - SQUISH
        let dy2 = dy0 - 1 - SQUISH
        let attn2 = 2.0 - dx2 * dx2 - dy2 * dy2 - dz1 * dz1
        if (attn2 > 0) { attn2 *= attn2; value += attn2 * attn2 * this.extrapolate(xsb, ysb + 1, zsb, dx2, dy2, dz1) }

        let dz3 = dz0 - 1 - SQUISH
        let attn3 = 2.0 - dx2 * dx2 - dy1 * dy1 - dz3 * dz3
        if (attn3 > 0) { attn3 *= attn3; value += attn3 * attn3 * this.extrapolate(xsb, ysb, zsb + 1, dx2, dy1, dz3) }

        let dx4 = dx0 - 1 - 2 * SQUISH
        let dy4 = dy0 - 1 - 2 * SQUISH
        let dz4 = dz0 - 0 - 2 * SQUISH
        let attn4 = 2.0 - dx4 * dx4 - dy4 * dy4 - dz4 * dz4
        if (attn4 > 0) { attn4 *= attn4; value += attn4 * attn4 * this.extrapolate(xsb + 1, ysb + 1, zsb, dx4, dy4, dz4) }

        let dy5 = dy0 - 0 - 2 * SQUISH
        let dz5 = dz0 - 1 - 2 * SQUISH
        let attn5 = 2.0 - dx4 * dx4 - dy5 * dy5 - dz5 * dz5
        if (attn5 > 0) { attn5 *= attn5; value += attn5 * attn5 * this.extrapolate(xsb + 1, ysb, zsb + 1, dx4, dy5, dz5) }

        let dx6 = dx0 - 0 - 2 * SQUISH
        let attn6 = 2.0 - dx6 * dx6 - dy4 * dy4 - dz5 * dz5
        if (attn6 > 0) { attn6 *= attn6; value += attn6 * attn6 * this.extrapolate(xsb, ysb + 1, zsb + 1, dx6, dy4, dz5) }
    }

    let attnExt0 = 2.0 - dxExt0 * dxExt0 - dyExt0 * dyExt0 - dzExt0 * dzExt0
    if (attnExt0 > 0) { attnExt0 *= attnExt0; value += attnExt0 * attnExt0 * this.extrapolate(xsvExt0, ysvExt0, zsvExt0, dxExt0, dyExt0, dzExt0) }

    let attnExt1 = 2.0 - dxExt1 * dxExt1 - dyExt1 * dyExt1 - dzExt1 * dzExt1
    if (attnExt1 > 0) { attnExt1 *= attnExt1; value += attnExt1 * attnExt1 * this.extrapolate(xsvExt1, ysvExt1, zsvExt1, dxExt1, dyExt1, dzExt1) }

    return value / NORM

  }

  extrapolate(xsb, ysb, zsb, dx, dy, dz) {
    const p = this.perm;
    const index = this.permGradIndex3D[(p[(p[xsb & 0xFF] + ysb) & 0xFF] + zsb) & 0xFF];
    return GRADIENTS_3D[index] * dx + GRADIENTS_3D[index + 1] * dy + GRADIENTS_3D[index + 2] * dz;
  }
}

/** Two related noise values from a point circling a time axis, as Howl's NoiseGenerator. */
export class NoiseGenerator {
  constructor(seed = Date.now()) {
    this.noise = new SimplexNoise(seed);
  }

  getNoise(time, rotation, radius, axis, shiftResult) {
    const cx = radius * Math.cos(rotation);
    const cy = radius * Math.sin(rotation);
    const p0 = axis === 0 ? [time, cx, cy] : axis === 1 ? [cx, time, cy] : [cx, cy, time];
    const p1 = axis === 0 ? [time, -cx, -cy] : axis === 1 ? [-cx, time, -cy] : [-cx, -cy, time];
    const a = this.noise.random3D(...p0);
    const b = this.noise.random3D(...p1);
    return shiftResult ? [(a + 1) / 2, (b + 1) / 2] : [a, b];
  }
}
