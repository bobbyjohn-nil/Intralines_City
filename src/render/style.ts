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
 *
 * Widened from the original 0.3-0.4px step table (playtest finding: hierarchy unreadable at a
 * glance) to a monotonically *growing* step — 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9px between
 * neighbours, smallest gap at the bottom of the ladder, largest at the top — so the pair the
 * player most needs to tell apart at a glance (motorway vs. trunk, i.e. "is this an arterial")
 * gets the biggest jump (0.4px -> 0.9px), not the smallest. This is a rendering-only floor, not
 * the represented road width (`ROAD_WIDTH_M`, unchanged — that is real-world data and stays
 * true-scale). TUNE
 */
export const ROAD_MIN_WIDTH_PX: Record<RoadClass, number> = {
  motorway: 5.0,
  trunk: 4.1,
  primary: 3.3,
  secondary: 2.6,
  tertiary: 2.0,
  residential: 1.5,
  service: 1.1,
  living_street: 0.8,
};

/**
 * Blend factor from `--ink` (0) to `--muted` (1), by class — heavier roads read darker/heavier,
 * lighter classes fade toward the muted tone.
 *
 * Evenly spaced at 1/7 steps (was an uneven 0.05-0.20 step table whose smallest gap — motorway to
 * trunk, 0.05 — put the two most important classes only ~6 RGB units apart, functionally the same
 * color; see the RGB-distance table in the playtest fix notes). Even spacing makes every adjacent
 * pair's step the *same* size (~17 RGB units at noon), so no class-to-class boundary is weaker
 * than any other — width (`ROAD_MIN_WIDTH_PX`) carries the emphasis at the top of the hierarchy,
 * this carries uniform baseline separation everywhere. Value is the standard cartographic answer
 * to hierarchy at a glance because, unlike width, it survives the night tint at a predictable,
 * uniform ratio (the tint is a flat alpha composite, so it scales every pairwise distance by the
 * same factor regardless of hue). TUNE
 */
export const ROAD_COLOR_MIX: Record<RoadClass, number> = {
  motorway: 0,
  trunk: 0.14,
  primary: 0.29,
  secondary: 0.43,
  tertiary: 0.57,
  residential: 0.71,
  service: 0.86,
  living_street: 1.0,
};

// ── Scenery ──────────────────────────────────────────────────────────────────

/**
 * Water fill opacity, blended over `--blue`. Raised from 0.55 — water already had strong contrast
 * against paper (~164 RGB units at noon) but the playtest's "reads as graph paper, not a city"
 * verdict named it as underselling anyway; a deeper fill reads more like a body of water and less
 * like a flat blue swatch, with no legibility cost (still a single unambiguous polygon layer under
 * every gameplay overlay). TUNE
 */
export const WATER_ALPHA = 0.62;

/**
 * Park fill opacity, blended over the mixed park color (see `PARK_COLOR_MIX_T` below). Raised from
 * 0.35 — playtest finding: parks were unlocatable by eye across a whole session. The alpha alone
 * was never the real problem (0.35 is not that low); `PARK_COLOR_MIX_T` is the actual fix, because
 * pure `--amber` is nearly the same *lightness* as `--paper`, so no alpha of amber-over-paper can
 * separate them much. Alpha is still raised alongside the color-mix change for headroom. TUNE
 */
export const PARK_ALPHA = 0.5;

/**
 * Blend factor from `--amber` (0) to `--muted` (1) for the park fill base color, mixed *before*
 * `PARK_ALPHA` is applied. Pulling amber toward muted desaturates and darkens it into an
 * olive/khaki tone that sits well below paper's lightness — see the RGB-distance table in the
 * playtest fix notes: old amber-over-paper park fill was ~20 RGB units from paper at noon (and
 * ~16 at night, i.e. nearly gone); this mix is ~69 at noon and ~54 at night. Stays on the amber
 * hue family already used for parks/bike-mode elsewhere, so it doesn't collide with `--blue`
 * water or read as a new invented color. Composited as a translucent *area fill*, so it never
 * approaches the darkness of an opaque road stroke even at `living_street`'s pure-muted color —
 * area fills and line strokes occupy different lightness bands by construction. TUNE
 */
export const PARK_COLOR_MIX_T = 0.55;

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
