/**
 * Small local-projection helpers used by line drawing. Kept self-contained inside
 * `src/game/lines/` (this module owns nothing outside that directory) rather than importing
 * from `city/generateRiverton`, which owns the same math for a different purpose.
 *
 * All of it is a flat-earth tangent-plane projection around a caller-supplied origin — fine
 * at the few-kilometre scale a single city spans, and cheap enough to call from a click
 * handler without a second thought.
 */

import type { LngLat } from '../types';

/** Approximate metres per degree of latitude; matches the same approximation used to generate
 * Riverton, so distances measured here agree with `RoadEdge.lengthM`. */
const METERS_PER_DEG_LAT = 111_320;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Projects `point` into metres on a plane tangent at `origin`. Origin maps to (0, 0). */
export function toLocalMeters(origin: LngLat, point: LngLat): { readonly x: number; readonly y: number } {
  const [lng0, lat0] = origin;
  const [lng, lat] = point;
  const latRad = toRad(lat0);
  const x = (lng - lng0) * METERS_PER_DEG_LAT * Math.cos(latRad);
  const y = (lat - lat0) * METERS_PER_DEG_LAT;
  return { x, y };
}

/** Inverse of `toLocalMeters` — turns a local-plane offset from `origin` back into lng/lat. */
export function fromLocalMeters(origin: LngLat, x: number, y: number): LngLat {
  const [lng0, lat0] = origin;
  const latRad = toRad(lat0);
  const lng = lng0 + x / (METERS_PER_DEG_LAT * Math.cos(latRad));
  const lat = lat0 + y / METERS_PER_DEG_LAT;
  return [lng, lat];
}

export interface NearestPointOnSegment {
  /** Fraction along the segment, clamped to [0, 1]. 0 = `a`, 1 = `b`. */
  readonly t: number;
  readonly position: LngLat;
  readonly distanceM: number;
}

/** Closest point to `point` on the segment `a`–`b`, clamped to the segment (never overshoots). */
export function nearestPointOnSegment(point: LngLat, a: LngLat, b: LngLat): NearestPointOnSegment {
  // Project everything into a plane tangent at `point` itself, so `point` sits at local (0, 0)
  // and the distance from it is just the hypotenuse — no separate haversine call needed.
  const pa = toLocalMeters(point, a);
  const pb = toLocalMeters(point, b);
  const abx = pb.x - pa.x;
  const aby = pb.y - pa.y;
  const lenSq = abx * abx + aby * aby;

  const rawT = lenSq > 0 ? (-pa.x * abx + -pa.y * aby) / lenSq : 0;
  const t = Math.max(0, Math.min(1, rawT));

  const x = pa.x + abx * t;
  const y = pa.y + aby * t;
  const distanceM = Math.hypot(x, y);
  const position = fromLocalMeters(point, x, y);

  return { t, position, distanceM };
}
