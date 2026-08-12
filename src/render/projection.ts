/**
 * The offline-renderer viewport: converts between lng/lat (the game's coordinate system, see
 * `game/types.ts`) and screen pixels. Pure and canvas-free so it can be unit tested directly.
 *
 * Projection model: a local equirectangular approximation centred on the viewport's own centre
 * latitude. City packs cover a single metro area (tens of km across at most), so the curvature
 * error against true Web Mercator is invisible at this scale, and the maths stays a simple,
 * exactly-invertible affine transform — which is what makes the round-trip test below exact
 * rather than approximate.
 */

import type { Bounds, LngLat } from '../game/types';

// ── Tunable constants ─────────────────────────────────────────────────────────

/** Metres per degree of latitude. Constant everywhere (unlike longitude, which foreshortens). */
export const METERS_PER_DEGREE_LAT = 111_320;

/** Zoom level at which `REFERENCE_PIXELS_PER_METER` applies. TUNE */
export const REFERENCE_ZOOM = 14;

/** Pixels per metre at `REFERENCE_ZOOM` — about 10 km fills a 1000 px-wide window. TUNE */
export const REFERENCE_PIXELS_PER_METER = 0.1;

/** Zoom is clamped to this range everywhere it is set. TUNE */
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 22;

/** Padding kept around fitted bounds so the dashed boundary itself is never clipped. TUNE */
export const DEFAULT_FIT_PADDING_PX = 40;

const DEG_TO_RAD = Math.PI / 180;

// ── Types ────────────────────────────────────────────────────────────────────

/** A mutable screen-space point. Passed as an `out` parameter so hot loops never allocate. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** A mutable lng/lat point. Passed as an `out` parameter for the same reason. */
export interface MutableLngLat {
  lng: number;
  lat: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ── Viewport ─────────────────────────────────────────────────────────────────

export class Viewport {
  centerLng: number;
  centerLat: number;
  zoom: number;
  width: number;
  height: number;

  /**
   * Latitude used for the longitude-foreshortening term (`cos(refLat)`). Fixed at construction
   * rather than recomputed from the live `centerLat` on every call: a city pack covers one metro
   * area, so the difference is imperceptible, and holding it fixed makes `project`/`unproject` an
   * exact affine transform (no lat/lng coupling), which is what makes `zoomAt` able to hold its
   * anchor point exactly stationary even when a zoom also shifts the centre latitude.
   */
  private refLat: number;

  constructor(centerLng: number, centerLat: number, zoom: number, width: number, height: number) {
    this.centerLng = centerLng;
    this.centerLat = centerLat;
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.width = width;
    this.height = height;
    this.refLat = centerLat;
  }

  clone(): Viewport {
    const copy = new Viewport(this.centerLng, this.centerLat, this.zoom, this.width, this.height);
    copy.refLat = this.refLat;
    return copy;
  }

  /** Pixels per metre at the current zoom. */
  scale(): number {
    return REFERENCE_PIXELS_PER_METER * 2 ** (this.zoom - REFERENCE_ZOOM);
  }

  /** Metres per degree of longitude at the viewport's (fixed) reference latitude. */
  metersPerDegreeLng(): number {
    return METERS_PER_DEGREE_LAT * Math.cos(this.refLat * DEG_TO_RAD);
  }

  /** Projects lng/lat to a screen point, writing into `out` so callers never allocate. */
  project(lng: number, lat: number, out: ScreenPoint): ScreenPoint {
    const s = this.scale();
    const dxM = (lng - this.centerLng) * this.metersPerDegreeLng();
    const dyM = (lat - this.centerLat) * METERS_PER_DEGREE_LAT;
    out.x = this.width / 2 + dxM * s;
    // Screen y grows downward; latitude grows northward (up) — flip the sign.
    out.y = this.height / 2 - dyM * s;
    return out;
  }

  /** Inverse of `project`, writing into `out` so callers never allocate. */
  unproject(x: number, y: number, out: MutableLngLat): MutableLngLat {
    const s = this.scale();
    const dxM = (x - this.width / 2) / s;
    const dyM = (this.height / 2 - y) / s;
    out.lng = this.centerLng + dxM / this.metersPerDegreeLng();
    out.lat = this.centerLat + dyM / METERS_PER_DEGREE_LAT;
    return out;
  }

  /** Pans the viewport by a screen-pixel delta (positive dx/dy drags the map right/down). */
  panBy(dxPx: number, dyPx: number): void {
    const s = this.scale();
    this.centerLng -= dxPx / s / this.metersPerDegreeLng();
    this.centerLat += dyPx / s / METERS_PER_DEGREE_LAT;
  }

  /**
   * Multiplies zoom by `factor` (>1 zooms in) while keeping the lng/lat under `(screenX, screenY)`
   * stationary on screen — the standard "zoom under the cursor" behaviour.
   */
  zoomAt(factor: number, screenX: number, screenY: number): void {
    const anchor = this.unproject(screenX, screenY, scratchLngLat);
    this.zoom = clamp(this.zoom + Math.log2(factor), MIN_ZOOM, MAX_ZOOM);
    // With the new zoom (and old centre), the anchor now projects somewhere else on screen.
    // `panBy` moves content by exactly its (dx, dy) argument (see its own doc comment), so pan by
    // the vector that carries the anchor's new position back onto the cursor.
    const anchorScreen = this.project(anchor.lng, anchor.lat, scratchScreen);
    this.panBy(screenX - anchorScreen.x, screenY - anchorScreen.y);
  }

  /**
   * The lng/lat rectangle currently visible, expanded by `marginPx` of screen padding. Used to
   * cull scenery before projecting every vertex. Allocates one object — call at most once per
   * draw, not per feature.
   */
  visibleLngLatBounds(marginPx = 0): Bounds {
    const s = this.scale();
    const mLng = this.metersPerDegreeLng();
    const halfWM = (this.width / 2 + marginPx) / s;
    const halfHM = (this.height / 2 + marginPx) / s;
    return {
      west: this.centerLng - halfWM / mLng,
      east: this.centerLng + halfWM / mLng,
      south: this.centerLat - halfHM / METERS_PER_DEGREE_LAT,
      north: this.centerLat + halfHM / METERS_PER_DEGREE_LAT,
    };
  }

  /** A viewport centred on `bounds`, zoomed to fit it inside `width`x`height` minus padding. */
  static fitToBounds(
    bounds: Bounds,
    width: number,
    height: number,
    paddingPx = DEFAULT_FIT_PADDING_PX,
  ): Viewport {
    const centerLng = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;
    const mLng = METERS_PER_DEGREE_LAT * Math.cos(centerLat * DEG_TO_RAD);
    const widthM = Math.max(1, (bounds.east - bounds.west) * mLng);
    const heightM = Math.max(1, (bounds.north - bounds.south) * METERS_PER_DEGREE_LAT);
    const availW = Math.max(1, width - paddingPx * 2);
    const availH = Math.max(1, height - paddingPx * 2);
    const pxPerMeter = Math.min(availW / widthM, availH / heightM);
    // REFERENCE_PIXELS_PER_METER * 2^(zoom - REFERENCE_ZOOM) = pxPerMeter
    const zoom = REFERENCE_ZOOM + Math.log2(pxPerMeter / REFERENCE_PIXELS_PER_METER);
    return new Viewport(centerLng, centerLat, zoom, width, height);
  }
}

// Reused scratch objects for the two-step anchor computation inside `zoomAt`. Module-scoped
// because `zoomAt` is not reentrant (it runs synchronously to completion).
const scratchLngLat: MutableLngLat = { lng: 0, lat: 0 };
const scratchScreen: ScreenPoint = { x: 0, y: 0 };

export function lngLatToTuple(point: MutableLngLat): LngLat {
  return [point.lng, point.lat];
}
