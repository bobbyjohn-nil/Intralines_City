/**
 * Small local-projection geometry for depot siting and dead-head distance. Kept self-contained
 * inside `depots/` — this directory owns nothing outside itself, same convention as
 * `buses/geo.ts` and `lines/geo.ts` (each of the three owns an independent copy of the same
 * flat-earth math for its own purpose; see either file's header for why).
 */

import type { LngLat, Polygon } from '../types';

/** Approximate metres per degree of latitude — matches the approximation every other distance
 * calculation in the sim uses, so distances measured here agree with `RoadEdge.lengthM`. */
const METERS_PER_DEG_LAT = 111_320;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Straight-line distance between two points, metres. Flat-earth tangent-plane approximation —
 * fine at the few-kilometre scale a single city spans, including where the spec calls for
 * "great-circle" in the dead-head fallback (`deadhead.ts`'s unroutable case): the two agree to
 * well under a metre at this scale, and every other module in the sim already treats them as
 * interchangeable at this scale.
 */
export function metersBetween(a: LngLat, b: LngLat): number {
  const cosLat = Math.cos(toRad(a[1]));
  const dx = (b[0] - a[0]) * METERS_PER_DEG_LAT * cosLat;
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Closest distance from `point` to the segment `a`-`b`, metres. Projected into a plane tangent
 * at `point` itself so `point` sits at local (0, 0) — same trick as `lines/geo.ts`'s
 * `nearestPointOnSegment`, but distance-only since siting never needs the nearest position. */
function distanceToSegmentM(point: LngLat, a: LngLat, b: LngLat): number {
  const cosLat = Math.cos(toRad(point[1]));
  const ax = (a[0] - point[0]) * METERS_PER_DEG_LAT * cosLat;
  const ay = (a[1] - point[1]) * METERS_PER_DEG_LAT;
  const bx = (b[0] - point[0]) * METERS_PER_DEG_LAT * cosLat;
  const by = (b[1] - point[1]) * METERS_PER_DEG_LAT;
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  const rawT = lenSq > 0 ? (-ax * abx + -ay * aby) / lenSq : 0;
  const t = Math.max(0, Math.min(1, rawT));
  const x = ax + abx * t;
  const y = ay + aby * t;
  return Math.hypot(x, y);
}

/**
 * True if `point` falls inside `polygon` (ray casting — works for any simple polygon regardless
 * of winding). Longitude/latitude used directly rather than metre-projected: a purely
 * topological test doesn't need the metric accuracy a distance does, and ray casting's crossing
 * count is invariant under any monotonic per-axis reparameterisation, degrees included.
 */
export function isPointInPolygon(point: LngLat, polygon: Polygon): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (pi === undefined || pj === undefined) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Closest distance from `point` to `polygon`'s boundary, metres — 0 if `point` sits exactly on
 * an edge. Backs the §1 check 2 "60 m kerb tolerance" dilation: a point just outside an eligible
 * zone's polygon still counts if it's within that tolerance of the boundary — see
 * `constants.ts`'s `DEPOT_ZONING_KERB_TOLERANCE_M`.
 */
export function distanceToPolygonBoundaryM(point: LngLat, polygon: Polygon): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    const d = distanceToSegmentM(point, a, b);
    if (d < best) best = d;
  }
  return best;
}
