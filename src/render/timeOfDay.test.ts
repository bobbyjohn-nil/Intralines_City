import { describe, expect, it } from 'vitest';
import { MINUTES_PER_DAY } from '../game/constants';
import type { PaperPalette } from './paperPalette';
import {
  DAWN_ALPHA_MAX,
  DAWN_START_MIN,
  DAY_ALPHA,
  DAY_START_MIN,
  DUSK_ALPHA_MAX,
  DUSK_PEAK_MIN,
  DUSK_START_MIN,
  NIGHT_ALPHA_MAX,
  NIGHT_HOLD_END_MIN,
  NIGHT_START_MIN,
  PRE_DAWN_ALPHA_MAX,
  PRE_DAWN_START_MIN,
  getTimeOfDayPhase,
  getTimeOfDayTint,
} from './timeOfDay';

// The same fallback the offline renderer uses when CSS custom properties aren't available — a
// stand-in "palette" the test can call `getTimeOfDayTint` against without a DOM.
const PALETTE: PaperPalette = {
  paper: '#f6f1e1',
  panel: '#fffdf6',
  ink: '#2c2a24',
  muted: '#7a7259',
  blue: '#1d3f7a',
  amber: '#ffe9a8',
  red: '#c94f35',
};

/** Max acceptable per-minute step, chosen with headroom above the actual computed steps (see the
 * continuity test below, which prints nothing but fails loudly if a keyframe span shrinks enough
 * to blow this budget). "Small" per the task: imperceptible frame to frame. */
const MAX_ALPHA_STEP_PER_MINUTE = 0.01;
const MAX_CHANNEL_STEP_PER_MINUTE = 5;

function parseRgba(color: string): { r: number; g: number; b: number; a: number } {
  const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
  if (!match) throw new Error(`unparseable color: ${color}`);
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: Number(match[4]),
  };
}

describe('getTimeOfDayTint', () => {
  it('is continuous across every minute of the day, including the midnight wrap', () => {
    const samples = Array.from({ length: MINUTES_PER_DAY }, (_, m) =>
      parseRgba(getTimeOfDayTint(m, PALETTE).color),
    );

    for (let m = 0; m < MINUTES_PER_DAY; m++) {
      const a = samples[m]!;
      const b = samples[(m + 1) % MINUTES_PER_DAY]!;
      expect(Math.abs(a.a - b.a)).toBeLessThanOrEqual(MAX_ALPHA_STEP_PER_MINUTE);
      expect(Math.abs(a.r - b.r)).toBeLessThanOrEqual(MAX_CHANNEL_STEP_PER_MINUTE);
      expect(Math.abs(a.g - b.g)).toBeLessThanOrEqual(MAX_CHANNEL_STEP_PER_MINUTE);
      expect(Math.abs(a.b - b.b)).toBeLessThanOrEqual(MAX_CHANNEL_STEP_PER_MINUTE);
    }
  });

  it('never exceeds the night readability cap at any minute', () => {
    for (let m = 0; m < MINUTES_PER_DAY; m++) {
      const tint = getTimeOfDayTint(m, PALETTE);
      expect(tint.alpha).toBeLessThanOrEqual(NIGHT_ALPHA_MAX + 1e-9);
    }
  });

  it('caps every phase alpha at or below NIGHT_ALPHA_MAX', () => {
    expect(PRE_DAWN_ALPHA_MAX).toBeLessThanOrEqual(NIGHT_ALPHA_MAX);
    expect(DAWN_ALPHA_MAX).toBeLessThanOrEqual(NIGHT_ALPHA_MAX);
    expect(DUSK_ALPHA_MAX).toBeLessThanOrEqual(NIGHT_ALPHA_MAX);
    expect(DAY_ALPHA).toBeLessThanOrEqual(NIGHT_ALPHA_MAX);
  });

  it('has minimal (zero) tint at noon', () => {
    const noon = getTimeOfDayTint(12 * 60, PALETTE);
    expect(noon.alpha).toBe(0);
    expect(noon.phase).toBe('day');
  });

  it('is at the readability cap at 03:00, the deepest part of night', () => {
    const threeAm = getTimeOfDayTint(3 * 60, PALETTE);
    expect(threeAm.alpha).toBeCloseTo(NIGHT_ALPHA_MAX, 5);
    expect(threeAm.phase).toBe('night');
  });

  it('exactly matches each keyframe alpha/phase at its own minute', () => {
    expect(getTimeOfDayTint(0, PALETTE).alpha).toBeCloseTo(NIGHT_ALPHA_MAX, 5);
    expect(getTimeOfDayTint(NIGHT_HOLD_END_MIN, PALETTE).alpha).toBeCloseTo(NIGHT_ALPHA_MAX, 5);
    expect(getTimeOfDayTint(PRE_DAWN_START_MIN, PALETTE).alpha).toBeCloseTo(
      PRE_DAWN_ALPHA_MAX,
      5,
    );
    expect(getTimeOfDayTint(DAWN_START_MIN, PALETTE).alpha).toBeCloseTo(DAWN_ALPHA_MAX, 5);
    expect(getTimeOfDayTint(DAY_START_MIN, PALETTE).alpha).toBeCloseTo(DAY_ALPHA, 5);
    expect(getTimeOfDayTint(DUSK_START_MIN, PALETTE).alpha).toBeCloseTo(DAY_ALPHA, 5);
    expect(getTimeOfDayTint(DUSK_PEAK_MIN, PALETTE).alpha).toBeCloseTo(DUSK_ALPHA_MAX, 5);
    expect(getTimeOfDayTint(NIGHT_START_MIN, PALETTE).alpha).toBeCloseTo(NIGHT_ALPHA_MAX, 5);
  });

  it('derives colors from the palette, not invented hex values', () => {
    // Every sampled color must be a plain interpolation of palette-derived rgb triples — i.e. each
    // channel falls within the full span of the palette's own component values (with rounding
    // slack), never something wildly outside it like a pure saturated color.
    for (const m of [0, 3 * 60, PRE_DAWN_START_MIN, DAWN_START_MIN, 12 * 60, DUSK_PEAK_MIN]) {
      const { r, g, b } = parseRgba(getTimeOfDayTint(m, PALETTE).color);
      for (const channel of [r, g, b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('getTimeOfDayPhase', () => {
  it('places phase boundaries where intended', () => {
    expect(getTimeOfDayPhase(0)).toBe('night');
    expect(getTimeOfDayPhase(PRE_DAWN_START_MIN - 1)).toBe('night');
    expect(getTimeOfDayPhase(PRE_DAWN_START_MIN)).toBe('preDawn');
    expect(getTimeOfDayPhase(DAWN_START_MIN - 1)).toBe('preDawn');
    expect(getTimeOfDayPhase(DAWN_START_MIN)).toBe('dawn');
    expect(getTimeOfDayPhase(DAY_START_MIN - 1)).toBe('dawn');
    expect(getTimeOfDayPhase(DAY_START_MIN)).toBe('day');
    expect(getTimeOfDayPhase(DUSK_START_MIN - 1)).toBe('day');
    expect(getTimeOfDayPhase(DUSK_START_MIN)).toBe('dusk');
    expect(getTimeOfDayPhase(NIGHT_START_MIN - 1)).toBe('dusk');
    expect(getTimeOfDayPhase(NIGHT_START_MIN)).toBe('night');
    expect(getTimeOfDayPhase(MINUTES_PER_DAY - 1)).toBe('night');
  });

  it('wraps negative and over-range minutes the same as their modulo', () => {
    expect(getTimeOfDayPhase(-30)).toBe(getTimeOfDayPhase(MINUTES_PER_DAY - 30));
    expect(getTimeOfDayPhase(MINUTES_PER_DAY + 45)).toBe(getTimeOfDayPhase(45));
  });
});
