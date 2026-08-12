/**
 * Flat-earth tangent-plane projection, one fixed origin per city. Deliberately not imported from
 * `src/game/lines/geo.ts`, which solves a related-but-different problem: that module re-derives a
 * fresh tangent plane per call (fine for a one-off point-to-segment check), where this one needs
 * every zone and stop expressed against the *same* plane before a Euclidean distance between two
 * projected points means anything — the Z×Z gravity table only conserves trips if `zoneDistM[i][j]`
 * and `zoneDistM[j][i]` are computed from the same coordinate system. Self-contained rather than
 * shared, mirroring `lines/geo.ts`'s own reasoning for not importing across `src/game/*` sibling
 * modules ("this module owns nothing outside that directory").
 *
 * Accurate to centimetres at the few-kilometre scale a single city spans (Riverton; also true of
 * the real-city packs demand-model.md targets) — nowhere near the error budget that would call for
 * a true equal-area projection.
 */

import type { LngLat } from '../types';

/** Approximate metres per degree of latitude — matches `src/game/lines/geo.ts`'s
 * `METERS_PER_DEG_LAT`, so distances measured here agree with `RoadEdge.lengthM`. */
const METERS_PER_DEG_LAT = 111_320;

/** A tangent plane fixed at one city-wide origin. `metersPerDegLng` bakes in the origin's
 * latitude scaling once so every projection call is a single multiply-add, no trig. */
export interface Projection {
  readonly originLngDeg: number;
  readonly originLatDeg: number;
  readonly metersPerDegLng: number;
}

export function makeProjection(origin: LngLat): Projection {
  const latRad = (origin[1] * Math.PI) / 180;
  return {
    originLngDeg: origin[0],
    originLatDeg: origin[1],
    metersPerDegLng: METERS_PER_DEG_LAT * Math.cos(latRad),
  };
}

/** Projects `point` into metres on `projection`'s plane. The origin maps to `(0, 0)`. Pure
 * arithmetic, no allocation beyond the returned pair — safe to call inside a hot loop. */
export function projectToMeters(projection: Projection, point: LngLat): { readonly xM: number; readonly yM: number } {
  const xM = (point[0] - projection.originLngDeg) * projection.metersPerDegLng;
  const yM = (point[1] - projection.originLatDeg) * METERS_PER_DEG_LAT;
  return { xM, yM };
}
