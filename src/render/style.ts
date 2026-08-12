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
