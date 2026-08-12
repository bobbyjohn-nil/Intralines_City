/**
 * Time-of-day tinting for the offline basemap. SPEC (manual §6): "The map tints with the time of
 * day — compare the pre-dawn and post-sunrise screenshots in this manual — and buses switch on
 * headlights and lit windows at night." This module owns the map tint only; bus lights are the
 * animator's concern elsewhere.
 *
 * The tint is a single translucent rectangle composited over the whole canvas, derived from the
 * paper palette (never an invented hex) via `mixHex`. It is built from a small set of keyframes at
 * fixed minutes-of-day and linearly interpolated in between, so the result is continuous across
 * every minute of the 1440-minute day — see `timeOfDay.test.ts` for the continuity assertion.
 *
 * Hard rule (studio/GAME.md, "data first, beauty second"): the map must stay readable at every
 * hour. `NIGHT_ALPHA_MAX` is the readability cap — streets, water and parks must still read at
 * 03:00 — and every other phase's alpha stays at or below it.
 */

import { MINUTES_PER_DAY } from '../game/constants';
import { mixHex, type PaperPalette } from './paperPalette';

export type TimeOfDayPhase = 'night' | 'preDawn' | 'dawn' | 'day' | 'dusk';

export interface TimeOfDayTint {
  /** CSS color (`rgba(...)`), ready to use as `ctx.fillStyle`. */
  readonly color: string;
  /** 0 = invisible (neutral day), up to `NIGHT_ALPHA_MAX`. */
  readonly alpha: number;
  readonly phase: TimeOfDayPhase;
}

// ── Phase boundaries, minutes of day (0–1439) ───────────────────────────────
// SPEC (manual §6) gives a starting range only: "Dawn around 05:00–07:00 and dusk around
// 18:00–20:00 are reasonable starting points". Split each into two named keyframes (blue lead-in,
// warm peak) so the transition itself reads as a gradient rather than a single jump. # tune

/** Night holds at its deepest until this minute, then starts lightening toward pre-dawn. # tune */
export const NIGHT_HOLD_END_MIN = 4 * 60; // 04:00
/** Night gives way to the cool pre-dawn keyframe. # tune */
export const PRE_DAWN_START_MIN = 5 * 60; // 05:00
/** Pre-dawn gives way to the warm dawn keyframe. # tune */
export const DAWN_START_MIN = 6 * 60; // 06:00
/** Dawn settles into neutral day. # tune */
export const DAY_START_MIN = 7 * 60; // 07:00
/** Day begins warming into dusk. # tune */
export const DUSK_START_MIN = 18 * 60; // 18:00
/** Dusk's warmest point, just before it cools toward night. # tune */
export const DUSK_PEAK_MIN = 19 * 60; // 19:00
/** Dusk gives way to night. # tune */
export const NIGHT_START_MIN = 20 * 60; // 20:00

// ── Tint colors, mixed from the paper palette (never an invented hex) ──────
// Each ratio is a `mixHex(fromHex, toHex, t)` blend factor. # tune

/** Deep night: `--ink` pulled toward `--blue` — cool and dark. # tune */
const NIGHT_INK_BLUE_MIX_T = 0.4;
/** Pre-dawn: `--blue` pulled back toward `--paper` — cool but lighter than night. # tune */
const PRE_DAWN_BLUE_PAPER_MIX_T = 0.5;
/** Dawn/dusk warm glow: `--amber` pulled toward `--red`. # tune */
const WARM_AMBER_RED_MIX_T = 0.35;

// ── Overlay alpha caps, by phase ────────────────────────────────────────────
// SPEC (studio/GAME.md, "data first, beauty second"): the map must stay readable at every hour.
// `NIGHT_ALPHA_MAX` is the hard readability cap other phases must never exceed. Verified by hand
// against the offline basemap: at this alpha, water/park/road fills (already low-alpha layers
// themselves) remain clearly distinguishable at 03:00. # tune
export const NIGHT_ALPHA_MAX = 0.22;
/** # tune */
export const PRE_DAWN_ALPHA_MAX = 0.12;
/** # tune */
export const DAWN_ALPHA_MAX = 0.1;
/** # tune */
export const DUSK_ALPHA_MAX = 0.14;
/** Neutral day: no tint at all. SPEC-adjacent — noon must read as the untinted basemap. */
export const DAY_ALPHA = 0;

// ── Keyframe table, cached per palette identity ─────────────────────────────

interface Keyframe {
  readonly minute: number;
  readonly rgb: readonly [number, number, number];
  readonly alpha: number;
  readonly phase: TimeOfDayPhase;
}

const RGB_PATTERN = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/;

/** Parses the `rgb(r, g, b)` string `mixHex` always returns, back into components. */
function mixHexRgb(fromHex: string, toHex: string, t: number): readonly [number, number, number] {
  const match = RGB_PATTERN.exec(mixHex(fromHex, toHex, t));
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const keyframeTableCache = new WeakMap<PaperPalette, readonly Keyframe[]>();

function buildKeyframeTable(palette: PaperPalette): readonly Keyframe[] {
  const night = mixHexRgb(palette.ink, palette.blue, NIGHT_INK_BLUE_MIX_T);
  const preDawn = mixHexRgb(palette.blue, palette.paper, PRE_DAWN_BLUE_PAPER_MIX_T);
  const warm = mixHexRgb(palette.amber, palette.red, WARM_AMBER_RED_MIX_T);
  const day = mixHexRgb(palette.paper, palette.ink, 0); // = paper, expressed as a mix like the rest

  // Sorted ascending by minute. The table wraps: the segment after the last entry interpolates
  // toward entry 0 (+ MINUTES_PER_DAY). Entry 0, NIGHT_HOLD_END_MIN and the last entry all share
  // the night color/alpha, so the whole 20:00 -> 24:00 -> 04:00 span holds flat at the readability
  // cap — the deepest part of night — before lightening toward pre-dawn, not a jump.
  return [
    { minute: 0, rgb: night, alpha: NIGHT_ALPHA_MAX, phase: 'night' },
    { minute: NIGHT_HOLD_END_MIN, rgb: night, alpha: NIGHT_ALPHA_MAX, phase: 'night' },
    { minute: PRE_DAWN_START_MIN, rgb: preDawn, alpha: PRE_DAWN_ALPHA_MAX, phase: 'preDawn' },
    { minute: DAWN_START_MIN, rgb: warm, alpha: DAWN_ALPHA_MAX, phase: 'dawn' },
    { minute: DAY_START_MIN, rgb: day, alpha: DAY_ALPHA, phase: 'day' },
    { minute: DUSK_START_MIN, rgb: day, alpha: DAY_ALPHA, phase: 'day' },
    { minute: DUSK_PEAK_MIN, rgb: warm, alpha: DUSK_ALPHA_MAX, phase: 'dusk' },
    { minute: NIGHT_START_MIN, rgb: night, alpha: NIGHT_ALPHA_MAX, phase: 'night' },
  ];
}

function getKeyframeTable(palette: PaperPalette): readonly Keyframe[] {
  let table = keyframeTableCache.get(palette);
  if (!table) {
    table = buildKeyframeTable(palette);
    keyframeTableCache.set(palette, table);
  }
  return table;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function normalizeMinute(minuteOfDay: number): number {
  return ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Named phase for a given minute of day — used for tests/labeling, independent of interpolation. */
export function getTimeOfDayPhase(minuteOfDay: number): TimeOfDayPhase {
  const m = normalizeMinute(minuteOfDay);
  if (m < PRE_DAWN_START_MIN) return 'night';
  if (m < DAWN_START_MIN) return 'preDawn';
  if (m < DAY_START_MIN) return 'dawn';
  if (m < DUSK_START_MIN) return 'day';
  if (m < NIGHT_START_MIN) return 'dusk';
  return 'night';
}

/**
 * The tint for a given minute of day, continuous across the full 0–1439 range (including the
 * midnight wrap). Pure function of `minuteOfDay` and the palette — safe to call every redraw, but
 * cheap enough that it does not need its own extra caching beyond the keyframe table.
 */
export function getTimeOfDayTint(minuteOfDay: number, palette: PaperPalette): TimeOfDayTint {
  const table = getKeyframeTable(palette);
  const m = normalizeMinute(minuteOfDay);

  let i = 0;
  for (let k = 0; k < table.length; k++) {
    if (table[k]!.minute <= m) i = k;
    else break;
  }
  const k0 = table[i]!;
  const k1 = table[(i + 1) % table.length]!;

  const span = ((k1.minute - k0.minute + MINUTES_PER_DAY) % MINUTES_PER_DAY) || MINUTES_PER_DAY;
  const elapsed = (m - k0.minute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const t = elapsed / span;

  const r = Math.round(lerp(k0.rgb[0], k1.rgb[0], t));
  const g = Math.round(lerp(k0.rgb[1], k1.rgb[1], t));
  const b = Math.round(lerp(k0.rgb[2], k1.rgb[2], t));
  const alpha = lerp(k0.alpha, k1.alpha, t);

  return {
    color: `rgba(${r}, ${g}, ${b}, ${alpha})`,
    alpha,
    phase: getTimeOfDayPhase(m),
  };
}
