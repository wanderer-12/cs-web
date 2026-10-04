// =============================================================================
// core/rng.ts — deterministic PRNG. Bullet spread must be reproducible so that
// replays, tests and lag compensation all agree on where a shot went.
// =============================================================================

/** mulberry32: small, fast, good enough distribution for gameplay noise. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit integer hash (xxHash-ish finaliser) used to derive per-shot seeds. */
export function hash32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Combine several integers into one seed. */
export function combineSeed(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

/** Random angle/direction generator with a stable seed. */
export class Rng {
  private next: () => number;

  constructor(seed = 1) {
    this.next = mulberry32(seed);
  }

  reseed(seed: number): void {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  /** Uniform point inside the unit disc (used for bullet spread cones). */
  disc(): { x: number; y: number } {
    const r = Math.sqrt(this.next());
    const a = this.next() * Math.PI * 2;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  }

  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /** Fisher-Yates in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = items[i];
      items[i] = items[j];
      items[j] = t;
    }
    return items;
  }
}

/** Global gameplay RNG (bot decisions, cosmetic jitter). */
export const gameRng = new Rng(0x1a2b3c4d);
