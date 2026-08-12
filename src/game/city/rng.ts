/**
 * Deterministic PRNG for procedural city generation.
 *
 * Never use `Math.random()` anywhere under `city/` — the same seed must produce a
 * byte-identical city every time, and `Math.random()` breaks that guarantee.
 */

export interface Rng {
  /** Next float in [0, 1). */
  readonly next: () => number;
  /** Next float in [min, max). */
  readonly range: (min: number, max: number) => number;
  /** Next integer in [min, max], inclusive on both ends. */
  readonly int: (min: number, max: number) => number;
  /** True with probability `p` (0..1). */
  readonly chance: (p: number) => boolean;
}

/**
 * mulberry32 — small, fast, decent-quality 32-bit PRNG. Good enough for procedural
 * layout; this is not for anything security-sensitive.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const range = (min: number, max: number): number => min + next() * (max - min);
  const int = (min: number, max: number): number => Math.floor(range(min, max + 1));
  const chance = (p: number): boolean => next() < p;

  return { next, range, int, chance };
}
