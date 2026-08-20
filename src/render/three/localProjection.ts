/**
 * lng/lat -> local metre-space XZ, the coordinate system every WebGL mesh in this scene is built
 * in. Three.js scenes want real, stable world coordinates (build once, move the camera — not
 * reproject every vertex every frame the way the Canvas renderer had to), so city geometry is
 * projected to a local tangent-plane metre grid exactly once, centered on the city's own bounds
 * center, using the *same* equirectangular approximation `projection.ts` uses for its screen-pixel
 * viewport (same `METERS_PER_DEGREE_LAT`, same `cos(refLat)` longitude foreshortening) — so a
 * distance measured in this space agrees with a distance `Viewport` would compute, which is what
 * lets `three/cameraRig.ts` reuse `Viewport.scale()`'s `pxPerM` unchanged (renderer-3d.md §1: "the
 * far end of a tilted ribbon never thins below its legibility floor... identical semantics to
 * `projection.ts`").
 *
 * Three.js convention: X = east, Z = south (so screen "up" in a top-down view is -Z, matching
 * `projection.ts`'s screen-y-grows-downward / latitude-grows-northward flip), Y = up.
 */

import type { Bounds, LngLat } from '../../game/types';
import { METERS_PER_DEGREE_LAT } from '../projection';

const DEG_TO_RAD = Math.PI / 180;

export interface LocalOrigin {
  readonly originLng: number;
  readonly originLat: number;
  /** Metres per degree of longitude at this origin's latitude — fixed at construction, exactly
   * like `Viewport.refLat`, so the projection stays an exact affine transform. */
  readonly metersPerDegreeLng: number;
}

/** One local origin per city, centered on `bounds` — cached by the caller (`cityGeometry.ts`),
 * same identity-cache idiom as `cityIndex.ts`'s `RenderCache`. */
export function localOriginFromBounds(bounds: Bounds): LocalOrigin {
  const originLng = (bounds.west + bounds.east) / 2;
  const originLat = (bounds.south + bounds.north) / 2;
  return {
    originLng,
    originLat,
    metersPerDegreeLng: METERS_PER_DEGREE_LAT * Math.cos(originLat * DEG_TO_RAD),
  };
}

/** Projects one lng/lat point to local metre-space `[x, z]` (`y` is always the caller's own layer
 * elevation, not part of this function — see `three/constants.ts`'s `Y_*` constants). */
export function toLocalXZ(origin: LocalOrigin, point: LngLat, out: [number, number] = [0, 0]): [number, number] {
  out[0] = (point[0] - origin.originLng) * origin.metersPerDegreeLng;
  out[1] = -(point[1] - origin.originLat) * METERS_PER_DEGREE_LAT;
  return out;
}

/** Inverse of `toLocalXZ` — local metre-space `(x, z)` back to lng/lat. Used by pointer picking
 * (the ground-plane raycast in `MapCanvas.tsx` lands in local XZ; a click/hover callback still
 * hands the rest of the app an `LngLat`, matching every consumer's existing contract). */
export function fromLocalXZ(origin: LocalOrigin, x: number, z: number): LngLat {
  return [origin.originLng + x / origin.metersPerDegreeLng, origin.originLat - z / METERS_PER_DEGREE_LAT];
}
