/**
 * Zoom-responsive screen-space marker sizing shared by every consumer of `Viewport.zoom` /
 * `Viewport.scale()` — stops (a screen-space billboard even under WebGL, renderer-3d.md §2) and
 * (for the *pixel-floor* half of their sizing — see `three/busScale.ts` for the full rule) buses.
 */

import { MAX_ZOOM, MIN_ZOOM } from './projection';
import { STOP_RADIUS_MAX_PX, STOP_RADIUS_MIN_PX } from './style';

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Stop marker radius at `zoom`, clamped between `STOP_RADIUS_MIN_PX` and `STOP_RADIUS_MAX_PX`,
 * scaled by square root of zoom progress like this game's other size-by-zoom responses. */
export function stopRadiusPx(zoom: number): number {
  const span = MAX_ZOOM - MIN_ZOOM;
  const t = span > 0 ? clamp01((zoom - MIN_ZOOM) / span) : 0;
  return STOP_RADIUS_MIN_PX + (STOP_RADIUS_MAX_PX - STOP_RADIUS_MIN_PX) * Math.sqrt(t);
}
