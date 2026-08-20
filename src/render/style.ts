/**
 * Palette-derived tunable constants shared by the WebGL scene (`three/`) — colors, true-world
 * sizes and pixel floors that are renderer-agnostic. All colors are *mixes* of the paper palette
 * read live from CSS custom properties (see `paperPalette.ts`) — nothing here is a hex literal, so
 * light/dark theming and any future palette edit apply automatically. Screen-space pixel sizing
 * that is specific to the WebGL scene (the bus world-scale multiplier, the id-buffer outline, the
 * camera) lives in `three/constants.ts` instead — see that file's module comment for the split.
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

// ── Gameplay overlays ──────────────────────────────────────────────────────
// Drawn after the basemap and time-of-day tint, before the out-of-bounds mask — see
// `renderer-3d.md`'s draw-order contract (carried over from the Canvas renderer, §7 "also carried
// over").

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
 * the one it happened to be tuned at.
 *
 * Lowered from 1.7 (playtest fix — "bus optically merged into its own route line"). At 1.7, a
 * route at the floor-dominated zoom range where most play happens (the default fit-to-bounds view
 * of a whole city and everything zoomed out from it, i.e. below the zoom where a motorway's true
 * scale overtakes its own legibility floor) rendered `ROAD_MIN_WIDTH_PX.motorway * 1.7` ≈ 8.5px —
 * nearly as wide as the 10px-wide bus marker riding on it (ratio 1.18, i.e. barely bigger), so the
 * vehicle read as a notch on the line rather than a distinct object. A route does not need to be
 * dramatically thicker than a road to read as "infrastructure on top of the map": it is already
 * drawn after every road layer (see `drawOverlays.ts`'s draw-order contract) and in a saturated
 * cycling color no road ever uses (`LINE_COLOR_MIX_STOPS`), so width only has to clear the roads it
 * sits over, not dominate the vehicles that sit over *it*. 1.25 still clears every road class's
 * floor by a wide margin (1.52x trunk, the next-heaviest class, up to 1.89x primary) while giving
 * the floor-dominated route width of ~6.25px a 2.88x ratio against the 18px bus marker width floor
 * (`BUS_MARKER_WIDTH_MIN_PX`) — see `drawOverlays.test.ts`'s `routeWidthPx` vs. `busMarkerWidthPx`
 * regression for the measured ratio across the zoom range this actually matters at. Above that
 * zoom range, a route's true-scale width can still be narrower than a bus is wide relative to it
 * (a real motorway genuinely is many times a bus's width up close) — that is correct cartography
 * at street-level zoom, not this defect, and
 * is not what this constant is tuned against. TUNE
 */
export const ROUTE_WIDTH_MULTIPLIER = 1.25;

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
 * Bus true-world size in metres — roughly a standard 40 ft transit bus. This is now the *only*
 * bus-size constant in this file: the Canvas renderer's screen-pixel clamp pair
 * (`BUS_MARKER_LENGTH/WIDTH_MIN/MAX_PX`) is superseded by the per-frame world-scale multiplier in
 * `three/constants.ts` (renderer-3d.md §7, cause 1 — "a true-scale bus shrinks with distance and
 * has no floor at all" is the *worse* version of the old bug, not a fixed one, so the fix is now a
 * multiplier applied to the true-scale mesh rather than a screen-space clamp on a 2D marker). TUNE
 */
export const BUS_LENGTH_M = 12;
export const BUS_WIDTH_M = 2.6;

/**
 * Blend factor from `--muted` (0) to `--amber` (1) for the bus "company brand color" (per
 * `studio/GAME.md`: "Buses wear the company brand color with a full-length stripe in the line's
 * color"). Deliberately built from a palette-key pair neither `ROAD_COLOR_MIX` nor
 * `LINE_COLOR_MIX_STOPS` ever uses together — `ROAD_COLOR_MIX` only ever blends `ink`→`muted`,
 * and every `LINE_COLOR_MIX_STOPS` entry blends among `blue`/`red`/`amber`/`ink` but never
 * touches `muted` — so a bus body can't land on the same hue axis as a road or a route line by
 * construction. Fixes the collision where this used to equal `ROAD_COLOR_MIX.primary` (both 0.15
 * on the ink→muted axis), making a bus body and a primary road numerically the same color.
 *
 * Raised from 0.5 to 0.65 (second playtest fix — the first, `BUS_MARKER_*_MIN_PX`, made the
 * marker the right *size* but did nothing about a second, independent bug: the fill alone, with no
 * stroke, sat too close to the paper background once the night tint (`NIGHT_ALPHA_MAX`,
 * `timeOfDay.ts`) darkens paper toward it — `drawBuses` now also strokes the body in `--ink`,
 * matching `drawStops`'s fill-plus-stroke idiom, but the fill was retuned too since the stroke
 * alone doesn't fix the fill's weakest pairing (see below). 0.65 was chosen as the maximin point
 * across every pair this body color must stay clear of at once — pushing it further toward `amber`
 * keeps gaining separation from roads and route lines but *loses* separation from the night-tinted
 * paper (amber is close in lightness to paper; the night tint doesn't touch overlay colors, only
 * the basemap under them, so a lighter fill closes that gap), while pulling it back toward `muted`
 * does the opposite and risks approaching `ROAD_COLOR_MIX.living_street` (pure `muted`) again. RGB
 * distances at this value (measured, not estimated — see `drawOverlays.test.ts`'s bus-color
 * regression and the render task's numeric defense): ~106 from paper at noon, ~52 from paper under
 * the night tint, ~126 from the nearest road class (`living_street`), ~56 from the nearest route
 * line color (`amber`→`ink` @ 0.4, the closest of the eight `LINE_COLOR_MIX_STOPS` entries). TUNE
 */
export const BUS_BODY_COLOR_MIX = 0.65;

/** Width of the full-length line-color stripe drawn down the bus marker's body, screen pixels.
 * TUNE */
export const BUS_STRIPE_WIDTH_PX = 2;

/**
 * Blend factor mixing a route's own color toward `--panel` (0 = the route's raw color, 1 = pure
 * `--panel`) to derive the bus's centerline stripe color. Playtest fix, the second half of the
 * "bus optically merged into its own route line" defect: `drawBuses` used to stripe a bus in the
 * *exact* color returned by `getLineColor` for that line — identical, at RGB distance 0, to the
 * route stroke the bus sits on top of (`drawLineRoute` colors a leg with the same `getLineColor`
 * call). The stripe's job — showing which line a bus belongs to — is worth keeping, but not at the
 * cost of making the vehicle's centerline read as a literal continuation of the road beneath it.
 *
 * `--panel` (not `--ink` or the bus body color) is the mix target because it is the only anchor
 * that stays a large, roughly *uniform* RGB distance from every one of the eight
 * `LINE_COLOR_MIX_STOPS` entries regardless of hue: those entries range from deeply saturated
 * (pure `--blue`, pure `--red`) to already ink-heavy (`blue`→`ink` @ 0.35), and a route color that
 * already leans dark is closer to `--ink` to start with, so mixing *toward* `--ink` shrinks the gap
 * fastest for exactly the routes that need it most. `--panel` is light and low-saturation, so
 * mixing toward it opens a large gap against every entry alike. Measured at 0.5 (this value) across
 * all eight `LINE_COLOR_MIX_STOPS` entries: minimum stripe-vs-route RGB distance ~91 (worst case,
 * `amber`→`ink` @ 0.4), maximum ~167 — see `drawOverlays.test.ts`'s stripe-vs-route regression,
 * which is exactly the assertion this defect needed and never had. The stripe still visibly carries
 * the route's hue (a tint of it, not an unrelated color), so "which line is this" is still legible
 * at a glance — it is just no longer camouflage. TUNE
 */
export const BUS_STRIPE_CONTRAST_MIX_T = 0.5;

// ── Procedural buildings (renderer-3d.md §8 step 3) ──────────────────────────

/**
 * Blend factor from `--paper` (0) to `--muted` (1) for the flat base color every procedural
 * building shares (one material, one `InstancedMesh`, one draw call — `buildingLayer.ts`).
 * Deliberately its own axis: not `ROAD_COLOR_MIX`'s `ink`→`muted`, not any `LINE_COLOR_MIX_STOPS`
 * entry, not `BUS_BODY_COLOR_MIX`'s `muted`→`amber` — so massing can never land on the same hue a
 * road, a route or a bus already owns. This is lit geometry (renderer-3d.md §2), so the
 * [0.75, 1.15] lighting envelope already adds real light/shadow contrast across a building's own
 * faces — a low-chroma base color keeps that shading the *only* thing separating one building from
 * the next, so the network drawn on top (unlit, full palette saturation) stays the obviously
 * "louder" layer at a glance.
 *
 * **Raised from 0.35 to 0.7** (playtest fix — a drifting-tree lead confirmed by adding the pair
 * the original tuning never checked: `contrast.rendered.test.ts`'s new bus-body/outline/route
 * vs-building-wall cases). 0.35 measured only 20-51 RGB units from the bus body — worse than every
 * other bus-vs-neighbour floor in the file (55-70) — because `--paper`→`--muted` is a warm-to-grey
 * line that, under this scene's own warm key light (`#fff8e8`), still renders visibly warm at the
 * low-t end, close enough to the bus's own warm tan (`mixHex(muted, amber, 0.65)`) under the same
 * light. **The fix direction was found empirically, not by the RGB-only, unlit-corner reasoning a
 * first pass at this comment used** — lit surfaces under a warm key light don't separate the way
 * flat swatches would predict, so every candidate value was actually re-rendered and measured
 * (`--use-gl=swiftshader`, the same pipeline the gate itself uses) rather than computed from the
 * palette hexes alone. Measured across all 4 pitch/time-of-day states, worst case each: t=0.1 (the
 * lightest, most "paper" option) only reaches 22-64; t=0.7 reaches 76-88 on bus-vs-building and
 * 107+ / 118+ on the (already-comfortable) route/outline pairs; t=1.0 (pure `--muted`, rejected —
 * collides with `ROAD_COLOR_MIX`'s own `living_street`, also pure `--muted`) reaches 128-141 but
 * isn't worth the new road collision when 0.7 already clears every floor with margin. TUNE
 */
export const BUILDING_COLOR_MIX_T = 0.7;
