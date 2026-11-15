// Seeded random numbers for sampling and hand-drawn wobble.
// The browser cannot reproduce numpy's or torch's generators, so the same
// seed gives the same picture here, but not the same picture as the Python app.

export class Rng {
  constructor(seed) {
    // splitmix32 to spread the seed, then xoshiro128**
    let s = (seed >>> 0) || 0x9e3779b9;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next(); this.b = next(); this.c = next(); this.d = next();
    this.spare = null;
  }

  u32() {
    const r = Math.imul(rotl(Math.imul(this.b, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.b << 9) >>> 0;
    this.c ^= this.a; this.d ^= this.b; this.b ^= this.c; this.a ^= this.d;
    this.c ^= t; this.d = rotl(this.d, 11);
    return r;
  }

  /** float in [0, 1) */
  random() { return this.u32() / 4294967296; }

  uniform(lo, hi) { return lo + (hi - lo) * this.random(); }

  normal(mean = 0, sd = 1) {
    if (this.spare !== null) { const v = this.spare; this.spare = null; return mean + sd * v; }
    let u = 0, v = 0;
    while (u <= 1e-12) u = this.random();
    v = this.random();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return mean + sd * r * Math.cos(2 * Math.PI * v);
  }
}

function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
