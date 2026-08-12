/**
 * Tunable constants for the offline Canvas 2D basemap. All colors are *mixes* of the paper
 * palette read live from CSS custom properties (see `paperPalette.ts`) — nothing here is a hex
 * literal, so light/dark theming and any future palette edit apply automatically.
 */

import type { RoadClass } from '../game/types';

// ── Streets ──────────────────────────────────────────────────────────────────

/**
 * Draw order, least to most important. Iterated in this order so heavier classes paint on top of
 * lighter ones and read correctly at intersections. SPEC (§6): "widest/most important last so
 * they read on top".
 */
export const ROAD_DRAW_ORDER: readonly RoadClass[] = [
  'living_street',
  'service',
  'residential',
  'tertiary',
  'secondary',
  'primary',
  'trunk',
  'motorway',
];

/** True-scale road width in metres, by class. Rendered at `viewport.scale()`. TUNE */
export const ROAD_WIDTH_M: Record<RoadClass, number> = {
  motorway: 22,
  trunk: 18,
  primary: 14,
  secondary: 11,
  tertiary: 9,
  residential: 7,
  service: 5,
  living_street: 4.5,
};

/**
 * Legibility floor in screen pixels — true-scale width clamps up to this when zoomed out, so a
 * class never disappears, and heavier classes keep a visibly thicker floor than lighter ones.
 * TUNE
 */
export const ROAD_MIN_WIDTH_PX: Record<RoadClass, number> = {
  motorway: 3.2,
  trunk: 2.8,
  primary: 2.4,
  secondary: 2.0,
  tertiary: 1.6,
  residential: 1.2,
  service: 0.9,
  living_street: 0.9,
};

/**
 * Blend factor from `--ink` (0) to `--muted` (1), by class — heavier roads read darker/heavier,
 * lighter classes fade toward the muted tone. TUNE
 */
export const ROAD_COLOR_MIX: Record<RoadClass, number> = {
  motorway: 0,
  trunk: 0.05,
  primary: 0.15,
  secondary: 0.3,
  tertiary: 0.45,
  residential: 0.65,
  service: 0.85,
  living_street: 1.0,
};

// ── Scenery ──────────────────────────────────────────────────────────────────

/** Water fill opacity, blended over `--blue`. TUNE */
export const WATER_ALPHA = 0.55;

/** Park fill opacity, blended over `--amber`. TUNE */
export const PARK_ALPHA = 0.35;

// ── Out-of-bounds mask ───────────────────────────────────────────────────────

/** Opacity of the grey mask painted outside `city.bounds`. SPEC (§6): "masked grey". TUNE alpha */
export const MASK_ALPHA = 0.65;

/** Dash pattern for the boundary stroke, in CSS-canvas pixels. SPEC (§6): "dashed boundary". */
export const MASK_DASH_PATTERN: readonly number[] = [8, 6];

/** Width of the dashed boundary stroke, in CSS pixels. TUNE */
export const MASK_DASH_WIDTH_PX = 1.5;

// ── Culling ──────────────────────────────────────────────────────────────────

/** Extra screen-pixel margin kept around the viewport before geometry is culled. TUNE */
export const CULL_MARGIN_PX = 64;

// ── Gameplay overlays (drawCity.ts + drawOverlays.ts) ────────────────────────
// Drawn after the basemap and time-of-day tint, before the out-of-bounds mask — see
// `drawOverlays.ts`'s module comment for the full draw-order contract.

/** The palette color fields a line color may be mixed from. Kept separate from `PaperPalette`'s
 * own key list so this file doesn't need to import the interface just to name its keys. */
export type PaletteColorKey = 'paper' | 'panel' | 'ink' | 'muted' | 'blue' | 'amber' | 'red';

/**
 * Confirmed lines (and the active draft, previewed in the color it will take once created) cycle
 * through this list keyed by `line.id % LINE_COLOR_MIX_STOPS.length` — every entry is a
 * `mixHex(fromKey, toKey, t)` blend of two palette tones, never an invented hex, chosen so
 * consecutive entries stay visually distinct from each other and from the road/water/park fills
 * they're drawn over. TUNE
 */
export const LINE_COLOR_MIX_STOPS: ReadonlyArray<readonly [PaletteColorKey, PaletteColorKey, number]> = [
  ['blue', 'blue', 0],
  ['red', 'red', 0],
  ['amber', 'ink', 0.4],
  ['blue', 'red', 0.5],
  ['blue', 'amber', 0.5],
  ['red', 'amber', 0.4],
  ['blue', 'ink', 0.35],
  ['red', 'ink', 0.3],
];

/**
 * A drawn route is always this multiple of the rendered motorway width (`ROAD_WIDTH_M.motorway` /
 * `ROAD_MIN_WIDTH_PX.motorway`, the heaviest street class), so a line reads as "infrastructure on
 * top of the map" — SPEC (task): "clearly heavier than any street" — at every zoom level, not just
 * the one it happened to be tuned at. TUNE
 */
export const ROUTE_WIDTH_MULTIPLIER = 1.7;

/**
 * Stop marker radius clamps between these two screen-pixel bounds — legible when zoomed all the
 * way out, never a blob when zoomed all the way in — and is scaled between them by
 * `sqrt((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM))`, matching this game's other "size by square
 * root" zoom responses (see `drawOverlays.ts`'s `stopRadiusPx`). TUNE
 */
export const STOP_RADIUS_MIN_PX = 3;
export const STOP_RADIUS_MAX_PX = 6;

/** Stop marker ring stroke width, screen pixels — constant regardless of the marker's own radius
 * so the ring itself always reads. TUNE */
export const STOP_OUTLINE_WIDTH_PX = 1.25;

/** Dash pattern for the draft's rubber-band preview segment, CSS-canvas pixels. Deliberately a
 * different rhythm than the out-of-bounds mask's dash (`MASK_DASH_PATTERN`) so the two dashed
 * lines never read as the same kind of thing. TUNE */
export const DRAFT_RUBBER_BAND_DASH_PATTERN: readonly number[] = [5, 4];

/** Rubber-band stroke width, screen pixels. TUNE */
export const DRAFT_RUBBER_BAND_WIDTH_PX = 2.5;

/**
 * Bus marker true-world size in metres — roughly a standard 40 ft transit bus — rendered at
 * `viewport.scale()` the same way `routeWidthPx` renders `ROAD_WIDTH_M`, then clamped (see the
 * `BUS_MARKER_*_MIN_PX` / `_MAX_PX` pairs below) so it never disappears zoomed out and never
 * blobs zoomed in. TUNE
 */
export const BUS_LENGTH_M = 12;
export const BUS_WIDTH_M = 2.6;

/**
 * Bus marker length (nose-to-tail) clamps between these two screen-pixel bounds, same
 * "true-metres scaled, then clamped" idiom as `stopRadiusPx`. The floor is the number that
 * matters most: at typical play zooms (including the default fit-to-bounds view of a whole city)
 * `BUS_LENGTH_M * viewport.scale()` is sub-pixel, so the floor is what actually renders — it is
 * set well above `STOP_RADIUS_MAX_PX * 2` (12px, the largest a stop marker can ever get) so a bus
 * reads as unmistakably bigger than a stop at *every* zoom, not just the one this was tuned
 * against. The ceiling keeps it from becoming a blob once zoomed in far enough for the true-scale
 * size to exceed it. TUNE
 */
export const BUS_MARKER_LENGTH_MIN_PX = 18;
export const BUS_MARKER_LENGTH_MAX_PX = 36;

/** Bus marker width clamps, same idiom as `BUS_MARKER_LENGTH_MIN_PX` / `_MAX_PX` above — held at
 * the same min:max ratio (5:9) as the length bounds so the marker's proportions (and therefore
 * its "pointed triangle", not "blob", read) stay constant across the whole zoom range. TUNE */
export const BUS_MARKER_WIDTH_MIN_PX = 10;
export const BUS_MARKER_WIDTH_MAX_PX = 20;

/**
 * Blend factor from `--muted` (0) to `--amber` (1) for the bus "company brand color" (per
 * `studio/GAME.md`: "Buses wear the company brand color with a full-length stripe in the line's
 * color"). Deliberately built from a palette-key pair neither `ROAD_COLOR_MIX` nor
 * `LINE_COLOR_MIX_STOPS` ever uses together — `ROAD_COLOR_MIX` only ever blends `ink`→`muted`,
 * and every `LINE_COLOR_MIX_STOPS` entry blends among `blue`/`red`/`amber`/`ink` but never
 * touches `muted` — so a bus body can't land on the same hue axis as a road or a route line by
 * construction. Fixes the collision where this used to equal `ROAD_COLOR_MIX.primary` (both 0.15
 * on the ink→muted axis), making a bus body and a primary road numerically the same color. TUNE
 */
export const BUS_BODY_COLOR_MIX = 0.5;

/** Width of the full-length line-color stripe drawn down the bus marker's body, screen pixels.
 * TUNE */
export const BUS_STRIPE_WIDTH_PX = 2;
