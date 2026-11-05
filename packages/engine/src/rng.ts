/**
 * Randomness abstraction. The engine never reaches for a global RNG: callers
 * inject one. Production uses a cryptographically secure source (see the
 * server's secureRng); tests use the deterministic seeded generator below.
 */
export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

/**
 * Deterministic generator for tests (sfc32 seeded via splitmix32).
 * Not suitable for production dealing.
 */
export function createSeededRng(seed: number): Rng {
  let s = seed >>> 0;
  const splitmix = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix();
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  return {
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error('maxExclusive must be a positive integer');
      // Rejection sampling to stay uniform.
      const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
      for (;;) {
        const v = next();
        if (v < limit) return v % maxExclusive;
      }
    },
  };
}

/** Uniform in-place Fisher–Yates shuffle; returns the same array. */
export function shuffleInPlace<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}
