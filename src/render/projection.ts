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

/**
 * Padding kept off the filling axis's edge in `fitToBounds`, so the dashed boundary on that side
 * is never clipped flush against the canvas frame. The non-filling axis is not padded — it
 * overflows the viewport by design (see `fitToBounds`) and is reached by panning, not by fitting
 * it on-screen.
 *
 * Resolution-*relative*, not a fixed pixel count (renderer-3d.md §1/§8 step 2 — the void-share
 * budget at default framing is ≤2% of the frame, and a fixed-pixel padding can only ever meet that
 * at one specific viewport size: the old `DEFAULT_FIT_PADDING_PX = 40` measured ~12-15% of a
 * 640x360 test canvas, since two 40px strips are a *shrinking* fraction of area as the canvas grows
 * and a *growing* one as it shrinks — see `contrast.rendered.test.ts`'s void-share cases, which
 * this fraction is chosen to actually pass rather than merely document the gap). A fraction of the
 * frame is a stable fraction of void at every viewport size, which a fixed pixel count structurally
 * cannot be. TUNE
 */
export const FIT_PADDING_FRACTION = 0.015;

/** `fitToBounds`'s default padding, in pixels, for a `width`x`height` viewport — `FIT_PADDING_
 * FRACTION` of the *smaller* axis, so the padding (and the void it produces) never becomes the
 * dominant term on an extreme aspect ratio. */
export function defaultFitPaddingPx(width: number, height: number): number {
  return FIT_PADDING_FRACTION * Math.min(width, height);
}

/**
 * The most empty void `clampToBounds` ever lets the viewport show beyond the city's edge, in
 * screen pixels — the player can pan until only this much grey mask is visible past the dashed
 * boundary, then no further; a hard stop with a little breathing room, not a hard stop flush
 * against the last pixel of paper. Chosen as a multiple of `defaultFitPaddingPx`: comfortably
 * wider than the fit padding alone so the two don't read as the exact same edge, but still small
 * relative to a typical viewport, so it doesn't meaningfully eat into how far the player can pan
 * before hitting it. TUNE
 */
export const PAN_CLAMP_MARGIN_MULTIPLIER = 3;

/** `clampToBounds`'s default margin, in pixels, for a `width`x`height` viewport — see
 * `PAN_CLAMP_MARGIN_MULTIPLIER`. */
export function defaultPanClampMarginPx(width: number, height: number): number {
  return PAN_CLAMP_MARGIN_MULTIPLIER * defaultFitPaddingPx(width, height);
}

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

/**
 * Same as `clamp`, but when `min` exceeds `max` — the clamp range has inverted, which
 * `clampToBounds` hits once the viewport (plus margin) is wider/taller than the city itself —
 * returns their midpoint instead of an arbitrary endpoint. That midpoint always works out to the
 * city's own centre on that axis (the margin and half-viewport terms that produced `min`/`max`
 * cancel out symmetrically), so a single formula both restrains panning while the city
 * overflows the viewport and recentres it once zoomed out past that point, with no branch for
 * "am I zoomed out enough to see it all" needed.
 */
function clampAxis(value: number, min: number, max: number): number {
  return min > max ? (min + max) / 2 : clamp(value, min, max);
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
   * Clamps `centerLng`/`centerLat` so the viewport can never show more than `marginPx` of empty
   * void beyond the city's edge on a given side — the standard "max bounds" pattern (as in e.g.
   * Leaflet's `maxBounds`), expressed directly in this viewport's own coordinates. Exists because
   * `fitToBounds` now fills the viewport rather than fitting inside it (see its own doc comment) —
   * the whole point of a fill is that part of the city sits off-screen, which must stay
   * *recoverable* by panning back, not become a way to pan the city away into void entirely.
   *
   * Not applied inside `panBy`/`zoomAt` themselves — those stay pure, exact, and bounds-agnostic
   * (see their tests, which call them with no bounds at all); callers that have a city's bounds in
   * hand call this once afterward. `zoomAt` in particular must stay unclamped internally, or its
   * own anchor-stays-under-the-cursor guarantee would be silently overridden by a clamp mid-call.
   *
   * The `+halfViewportDeg` (not `-`) is the load-bearing detail: it's what makes the valid
   * `centerLng`/`centerLat` range *shrink* as the viewport grows relative to the city (zooming
   * out), collapsing — via `clampAxis`'s inverted-range fallback — to exactly the city's own
   * centre once the viewport (plus margin) is wide/tall enough to contain the whole city on that
   * axis. That is precisely the zoomed-far-out, whole-city-visible case, so this recentres
   * automatically right when a "show me the whole city" zoom-out needs it to, rather than fighting
   * it with a stale off-centre pan.
   */
  clampToBounds(bounds: Bounds, marginPx: number = defaultPanClampMarginPx(this.width, this.height)): void {
    const s = this.scale();
    const mLng = this.metersPerDegreeLng();
    const halfViewportLngDeg = this.width / 2 / s / mLng;
    const halfViewportLatDeg = this.height / 2 / s / METERS_PER_DEGREE_LAT;
    const marginLngDeg = marginPx / s / mLng;
    const marginLatDeg = marginPx / s / METERS_PER_DEGREE_LAT;

    this.centerLng = clampAxis(
      this.centerLng,
      bounds.west - marginLngDeg + halfViewportLngDeg,
      bounds.east + marginLngDeg - halfViewportLngDeg,
    );
    this.centerLat = clampAxis(
      this.centerLat,
      bounds.south - marginLatDeg + halfViewportLatDeg,
      bounds.north + marginLatDeg - halfViewportLatDeg,
    );
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

  /**
   * A viewport centred on `bounds`, zoomed to *fill* `width`x`height` minus padding — a "cover"
   * fit, not a "contain" fit. Scale is taken from whichever axis needs the *larger* pixels-per-
   * metre ratio to fully cover the viewport on that axis (`Math.max`, not `Math.min`): that is the
   * axis that ends up flush with the (padded) viewport edge, while the other axis necessarily
   * overflows past the viewport's edges, reachable by panning (see `clampToBounds`, which keeps
   * that overflow recoverable rather than lose-the-map-forever).
   *
   * DESIGN (explicit call, not an oversight): a map application fills its window and lets the
   * player pan; boxing the whole city into a fraction of a landscape window — the previous
   * "contain" behaviour — read as a small image floating in a mostly-empty frame and suppressed
   * the legibility of buses, parks and the road hierarchy (independently correct fixes to each of
   * those, all still too small to read at the default view). The zoomed-out whole-city view this
   * replaces is still reachable — it's just a zoom-out gesture away, not the default — see
   * `zoomAt`'s own doc and `projection.test.ts`'s "whole-city view is still reachable" case.
   */
  static fitToBounds(
    bounds: Bounds,
    width: number,
    height: number,
    paddingPx = defaultFitPaddingPx(width, height),
  ): Viewport {
    const centerLng = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;
    const mLng = METERS_PER_DEGREE_LAT * Math.cos(centerLat * DEG_TO_RAD);
    const widthM = Math.max(1, (bounds.east - bounds.west) * mLng);
    const heightM = Math.max(1, (bounds.north - bounds.south) * METERS_PER_DEGREE_LAT);
    const availW = Math.max(1, width - paddingPx * 2);
    const availH = Math.max(1, height - paddingPx * 2);
    const pxPerMeter = Math.max(availW / widthM, availH / heightM);
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

/** Fraction of the *smaller* viewport axis the city's larger axis spans at `zoomFloor` —
 * renderer-3d.md §1: "the zoom at which the city's larger axis spans 0.70 of the smaller viewport
 * axis." SPEC value. */
export const ZOOM_FLOOR_FRACTION = 0.7;

/**
 * The camera's own zoom-out floor (renderer-3d.md §1's camera table: "Zoom | fit | `zoomFloor
 * (city)` … 20") — the whole city fit into `ZOOM_FLOOR_FRACTION` of the smaller viewport axis, so
 * "zoom out to see everything" is reachable but zooming out *further* than that (the old Canvas-era
 * "428 px city in a 1317 px canvas" state) is not. Pure function of `bounds` and viewport size, same
 * pxPerMeter -> zoom conversion `fitToBounds` uses, just against a fixed fraction of one axis
 * instead of a "cover" fit against both — independently clamped to `[MIN_ZOOM, MAX_ZOOM]` so a
 * pathologically tiny city (or viewport) can't push the floor outside the zoom range every other
 * `Viewport` value already respects.
 */
export function zoomFloor(bounds: Bounds, width: number, height: number): number {
  const centerLat = (bounds.south + bounds.north) / 2;
  const mLng = METERS_PER_DEGREE_LAT * Math.cos(centerLat * DEG_TO_RAD);
  const widthM = Math.max(1, (bounds.east - bounds.west) * mLng);
  const heightM = Math.max(1, (bounds.north - bounds.south) * METERS_PER_DEGREE_LAT);
  const largerAxisM = Math.max(widthM, heightM);
  const smallerViewportPx = Math.max(1, Math.min(width, height));
  const pxPerMeter = (smallerViewportPx * ZOOM_FLOOR_FRACTION) / largerAxisM;
  return clamp(REFERENCE_ZOOM + Math.log2(pxPerMeter / REFERENCE_PIXELS_PER_METER), MIN_ZOOM, MAX_ZOOM);
}
