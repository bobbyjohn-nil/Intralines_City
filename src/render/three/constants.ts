/**
 * WebGL-scene-only tunable constants — camera math, layer elevations, screen-space pixel-width
 * shader targets, the bus world-scale multiplier, the lighting envelope and the id-buffer palette.
 * Palette-derived colors and true-world sizes that are renderer-agnostic stay in `../style.ts`;
 * this file holds only what exists because the scene is now real 3D geometry with a movable
 * camera. Every number here is a `# tune` unless noted otherwise. See
 * `studio/docs/design/renderer-3d.md` for the spec each constant is quoting.
 */

// ── Camera (renderer-3d.md §1) ────────────────────────────────────────────────

/** Vertical FOV, fixed — narrow enough to read almost like a plan view while still giving
 * buildings (step 3+) parallax. SPEC. */
export const CAMERA_FOV_DEG = 30;

/** Step 1 build order (renderer-3d.md §8, step 1): "Camera pitch locked at 0°, no yaw." Camera
 * unlock (0°–60° pitch, free yaw) is step 2. SPEC-for-step-1. */
export const CAMERA_PITCH_DEG = 0;
export const CAMERA_YAW_DEG = 0;

// ── Layer elevations (renderer-3d.md §2) ──────────────────────────────────────
// Real geometry on the ground plane, shaded flat. Small positive Y offsets only — enough that
// depth testing resolves draw order deterministically (heavier layers sit visibly "above" lighter
// ones, matching the old Canvas draw-order contract), never enough to read as actual relief.

export const Y_GROUND = 0;
export const Y_WATER = 0.02;
export const Y_PARK = 0.04;
export const Y_ROAD = 0.06;
export const Y_NIGHT_TINT = 0.08;
export const Y_ROUTE = 0.1;
export const Y_STOP = 0.12;
export const Y_BUS_BASE = 0;
/** The out-of-bounds mask sits far above every other layer and is drawn with depth testing off —
 * it must occlude anything, per the draw-order contract (renderer-3d.md §7 "also carried over":
 * "mask last, above everything"). */
export const Y_MASK = 50;

// ── Screen-space pixel-width lines (roads, routes, the draft rubber band, the dashed boundary) ──
// Renderer-3d.md §2: "Route lines: ground-hugging world-space ribbons with screen-space width...
// resolved in the vertex shader against a pixel target." The same technique is reused for road
// ribbons (so a road class never disappears zoomed out, matching the old `ROAD_MIN_WIDTH_PX`
// floor) via three.js's own `Line2`/`LineMaterial` (fat-lines) implementation.

/** How often (world-zoom-driven) line-width uniforms are recomputed — on viewport zoom change
 * only, never per animation frame (no per-frame allocation/recompute, GAME.md). */
export const LINE_WIDTH_RECOMPUTE_ON_ZOOM_ONLY = true;

// ── Bus sizing — renderer-3d.md §7, cause 1 fix ───────────────────────────────
// "Fix: per-frame world-scale multiplier max(1, minPx / projectedPx) targeting a 30 px major-axis
// footprint (the same number that finally worked), capped at 8x exaggeration."

/** Target on-screen major-axis (length) footprint, in CSS pixels, at the default framing. SPEC
 * value ("the same number that finally worked" — DECISIONS #62's sixth playtest fix). */
export const BUS_TARGET_FOOTPRINT_PX = 30;

/** Ceiling on the world-scale multiplier — a true-scale bus is never exaggerated past this, so it
 * does not become a bus-shaped billboard once zoomed in far enough that true scale alone would
 * already exceed the target footprint. SPEC. */
export const BUS_MAX_EXAGGERATION = 8;

// ── Screen-space outline (renderer-3d.md §7, cause 2 fix) ────────────────────
// "Vehicles and stop markers get a screen-space outline..., 1.5 px at a 30 px footprint, in
// `--ink`." Implemented as an inverted-hull outline (a backface-culled, slightly enlarged copy of
// the mesh, flat `--ink`, rendered behind the real faces) — cheap, per-object, and scales with the
// same world-scale multiplier the footprint itself uses, so the ratio below always holds.

export const OUTLINE_PX_AT_TARGET_FOOTPRINT = 1.5;
export const STOP_OUTLINE_TARGET_FOOTPRINT_PX = 30;

// ── Lighting envelope (renderer-3d.md §3) ─────────────────────────────────────
// "The luminance multiplier applied to any lit material's base colour stays within [0.75, 1.15] on
// every surface normal at every clock minute." Buildings/vehicles/furniture only — never a data
// layer (DECISIONS #66).

export const HEMI_SKY_INTENSITY = 0.55;
export const HEMI_GROUND_INTENSITY = 0.25;
export const KEY_LIGHT_INTENSITY = 0.45;
/** Elevation never drops below this — "so no raking near-black faces." SPEC. */
export const KEY_LIGHT_MIN_ELEVATION_DEG = 25;

/**
 * Compensates for three.js's physically-based light units — since three.js removed the
 * non-physical "legacy lights" mode, `THREE.Light.intensity` feeds a Lambertian diffuse response
 * that divides irradiance by π (the physically correct radiance-from-irradiance conversion), so a
 * light of intensity 1.0 does *not* read back as "the surface's own color, unattenuated" the way
 * the spec's 0.55/0.25/0.45 multipliers are written to mean. `HEMI_SKY_INTENSITY` etc. stay the
 * spec's own documented numbers unchanged (quoted directly from renderer-3d.md §3); this is the
 * one extra factor applied only where those numbers actually become a `THREE.Light.intensity`
 * (`lighting.ts`), calibrated against the rendered lighting-envelope test rather than assumed. TUNE
 */
export const PHYSICAL_LIGHT_UNIT_SCALE = Math.PI * 1.5;

export const LIGHTING_ENVELOPE_MIN_RATIO = 0.75;
export const LIGHTING_ENVELOPE_MAX_RATIO = 1.15;

// ── Void-share budget (renderer-3d.md §1) ─────────────────────────────────────

export const VOID_SHARE_DEFAULT_MAX = 0.02;
export const VOID_SHARE_CLAMPED_MAX = 0.35;

// ── Id-buffer palette (renderer-3d.md §3) ─────────────────────────────────────
// Flat, unique, unlit colors painted into a second offscreen target so the rendered-pixel contrast
// tests can segment "which pixels are the bus" without knowing what a bus looks like. Never
// rendered to the screen the player sees.

export const ID_COLOR_BACKGROUND = 0x000000;
export const ID_COLOR_BUS = 0x0000ff;
export const ID_COLOR_STOP = 0x00ff00;
export const ID_COLOR_MASK = 0xff00ff;
export const ID_COLOR_PARK = 0x00ffff;
export const ID_COLOR_WATER = 0xffff00;
/** Road-class id colors are derived at runtime (`three/scene.ts`) — one per `ROAD_DRAW_ORDER`
 * entry, one per route ribbon, so no two classes collide. Both step sizes below are chosen well
 * clear of `segmentByIdColor`'s matching tolerance (± a handful of 8-bit units) — a 1-unit step (a
 * bare `0x000100` increment, this constant's first-draft mistake) would put two adjacent road
 * classes within tolerance of each other in the id buffer, silently merging their segmentation. */
export const ID_COLOR_ROAD_BASE = 0x100000;
export const ID_COLOR_ROAD_STEP = 0x002000;
export const ID_COLOR_ROUTE_BASE = 0x400000;
export const ID_COLOR_ROUTE_STEP = 0x002000;
