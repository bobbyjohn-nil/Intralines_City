/**
 * Small local-projection geometry used to place and orient a bus along a leg's polyline.
 *
 * Kept self-contained inside `buses/` (this module owns nothing outside this directory) rather
 * than importing `lines/geo.ts` or `city/generateRiverton`'s own copy of the same math — they
 * each own their local-projection helpers for their own purpose, and this directory's ownership
 * boundary means it doesn't reach into either.
 *
 * All of it is a flat-earth tangent-plane projection around a caller-supplied origin, fine at
 * the few-kilometre scale a single city spans. The functions used from `position.ts`'s hot path
 * (`bearingBetween`, `lerpInto`, `offsetRightInto`) take a mutable `out` and write into it in
 * place — no object or array allocation per call.
 */

import type { LngLat } from '../types';

/** Approximate metres per degree of latitude — matches the approximation the rest of the sim
 * uses, so distances agree with `RoadEdge.lengthM`. */
const METERS_PER_DEG_LAT = 111_320;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Straight-line distance between two points, metres. Allocation-free (no intermediate object),
 * but only cheap enough to call from schedule-build time — not the per-tick position path. */
export function metersBetween(a: LngLat, b: LngLat): number {
  const cosLat = Math.cos(toRad(a[1]));
  const dx = (b[0] - a[0]) * METERS_PER_DEG_LAT * cosLat;
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Compass bearing facing from `a` toward `b`, degrees clockwise from north in `[0, 360)` —
 * matches MapLibre's `bearing` convention. Pure arithmetic, no allocation. */
export function bearingBetween(a: LngLat, b: LngLat): number {
  const cosLat = Math.cos(toRad(a[1]));
  const dx = (b[0] - a[0]) * METERS_PER_DEG_LAT * cosLat;
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT;
  if (dx === 0 && dy === 0) return 0;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Point a fraction `t` (0..1) along the straight segment `a`→`b`, written into `out` in place. */
export function lerpInto(a: LngLat, b: LngLat, t: number, out: [number, number]): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
}

/**
 * Shifts `point` `offsetM` metres to the right of the direction of travel `a`→`b` (right-hand
 * traffic — manual §15: "they keep to the right of the centreline so opposing buses pass instead
 * of colliding"), written into `out` in place. `point` and `out` may safely be the same array.
 */
export function offsetRightInto(a: LngLat, b: LngLat, point: LngLat, offsetM: number, out: [number, number]): void {
  const cosLat = Math.cos(toRad(a[1]));
  const dx = (b[0] - a[0]) * METERS_PER_DEG_LAT * cosLat;
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    out[0] = point[0];
    out[1] = point[1];
    return;
  }
  // Right-hand perpendicular of a (dx, dy) heading, in a plane where +x = east, +y = north.
  const rightXm = (dy / len) * offsetM;
  const rightYm = (-dx / len) * offsetM;
  const px = point[0] + rightXm / (METERS_PER_DEG_LAT * cosLat);
  const py = point[1] + rightYm / METERS_PER_DEG_LAT;
  out[0] = px;
  out[1] = py;
}
