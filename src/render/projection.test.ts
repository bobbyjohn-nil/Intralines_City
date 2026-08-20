import { describe, expect, it } from 'vitest';
import {
  defaultFitPaddingPx,
  defaultPanClampMarginPx,
  MAX_ZOOM,
  METERS_PER_DEGREE_LAT,
  MIN_ZOOM,
  REFERENCE_PIXELS_PER_METER,
  REFERENCE_ZOOM,
  Viewport,
  zoomFloor,
  ZOOM_FLOOR_FRACTION,
} from './projection';
import type { MutableLngLat, ScreenPoint } from './projection';
import type { Bounds } from '../game/types';

function makeViewport(): Viewport {
  // Riverton-ish demo coordinates and a mid-range zoom, non-trivial center latitude so the
  // longitude foreshortening term is actually exercised.
  return new Viewport(-71.05, 41.6, 15, 1024, 768);
}

describe('lng/lat <-> screen round-trip', () => {
  const cases: ReadonlyArray<[number, number, number]> = [
    [0, 0, 12], // screen center
    [512, 384, 12], // canvas center
    [100, 200, 8],
    [900, 700, 18],
    [1024, 768, 15],
    [-50, -50, 20],
  ];

  it('screen -> lng/lat -> screen is lossless within tolerance', () => {
    for (const [x, y, zoom] of cases) {
      const viewport = makeViewport();
      viewport.zoom = zoom;
      const lngLatOut: MutableLngLat = { lng: 0, lat: 0 };
      const screenOut: ScreenPoint = { x: 0, y: 0 };

      const lngLat = viewport.unproject(x, y, lngLatOut);
      const screen = viewport.project(lngLat.lng, lngLat.lat, screenOut);

      expect(screen.x).toBeCloseTo(x, 6);
      expect(screen.y).toBeCloseTo(y, 6);
    }
  });

  it('lng/lat -> screen -> lng/lat is lossless within tolerance', () => {
    const lngLatSamples: ReadonlyArray<[number, number, number]> = [
      [-71.05, 41.6, 15], // viewport center itself
      [-71.02, 41.62, 15],
      [-71.1, 41.55, 10],
      [-71.06, 41.605, 19],
    ];
    for (const [lng, lat, zoom] of lngLatSamples) {
      const viewport = makeViewport();
      viewport.zoom = zoom;
      const screenOut: ScreenPoint = { x: 0, y: 0 };
      const lngLatOut: MutableLngLat = { lng: 0, lat: 0 };

      const screen = viewport.project(lng, lat, screenOut);
      const roundTripped = viewport.unproject(screen.x, screen.y, lngLatOut);

      expect(roundTripped.lng).toBeCloseTo(lng, 9);
      expect(roundTripped.lat).toBeCloseTo(lat, 9);
    }
  });
});

describe('zoomAt', () => {
  it('keeps the lng/lat under the screen point stationary on screen', () => {
    const anchors: ReadonlyArray<[number, number]> = [
      [512, 384], // canvas center — trivial case
      [200, 150], // off-center
      [900, 700],
      [50, 720],
    ];
    for (const [screenX, screenY] of anchors) {
      const viewport = makeViewport();
      const before: MutableLngLat = { lng: 0, lat: 0 };
      viewport.unproject(screenX, screenY, before);
      const anchorLng = before.lng;
      const anchorLat = before.lat;

      viewport.zoomAt(2, screenX, screenY);

      const after: ScreenPoint = { x: 0, y: 0 };
      viewport.project(anchorLng, anchorLat, after);

      expect(after.x).toBeCloseTo(screenX, 6);
      expect(after.y).toBeCloseTo(screenY, 6);
    }
  });

  it('zooming in increases zoom and zooming out decreases it, clamped to bounds', () => {
    const viewport = makeViewport();
    const startZoom = viewport.zoom;

    viewport.zoomAt(2, 512, 384);
    expect(viewport.zoom).toBeGreaterThan(startZoom);

    viewport.zoomAt(0.5, 512, 384);
    viewport.zoomAt(0.5, 512, 384);
    expect(viewport.zoom).toBeLessThan(startZoom + Math.log2(2));

    for (let i = 0; i < 100; i++) viewport.zoomAt(0.1, 512, 384);
    expect(viewport.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);

    for (let i = 0; i < 100; i++) viewport.zoomAt(10, 512, 384);
    expect(viewport.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });
});

describe('panBy', () => {
  it('panning by a screen delta and back returns the original center (single-axis, no lat/lng coupling)', () => {
    // Pan each axis independently: a combined diagonal pan changes centerLat, which in turn
    // changes the longitude scale (metersPerDegreeLng depends on latitude) — so a diagonal
    // pan-and-back is only approximately reversible, not exactly. Single-axis pans have no such
    // coupling and should round-trip to full double precision.
    const viewport = makeViewport();
    const startLng = viewport.centerLng;
    const startLat = viewport.centerLat;

    viewport.panBy(120, 0);
    viewport.panBy(-120, 0);
    viewport.panBy(0, -80);
    viewport.panBy(0, 80);

    expect(viewport.centerLng).toBeCloseTo(startLng, 9);
    expect(viewport.centerLat).toBeCloseTo(startLat, 9);
  });

  it('panning right (positive dx) moves the center longitude east under the cursor convention', () => {
    const viewport = makeViewport();
    const startLng = viewport.centerLng;
    viewport.panBy(100, 0);
    // Dragging the viewport by +dx slides world content by -dx on screen, i.e. the center moves
    // toward smaller x in world terms — here that means centerLng decreases (west).
    expect(viewport.centerLng).toBeLessThan(startLng);
  });
});

/** Bounds whose real-world extent is a perfect square in metres — matching this game's actual
 * city packs (see `generateRiverton`), so scale is isotropic (the same pixels-per-metre on both
 * axes) regardless of the viewport's own aspect ratio, making the assertions below unambiguous. */
function squareBounds(centerLat: number, sideM: number): Bounds {
  const halfLatDeg = sideM / 2 / METERS_PER_DEGREE_LAT;
  const mLng = METERS_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180);
  const halfLngDeg = sideM / 2 / mLng;
  return {
    west: -halfLngDeg,
    east: halfLngDeg,
    south: centerLat - halfLatDeg,
    north: centerLat + halfLatDeg,
  };
}

describe('fitToBounds', () => {
  it('centers on the bounds and scales from the filling (not the fitting) axis', () => {
    const bounds = { west: -71.1, south: 41.55, east: -71.0, north: 41.65 };
    const width = 1000;
    const height = 800;
    const padding = 40;
    const viewport = Viewport.fitToBounds(bounds, width, height, padding);

    expect(viewport.centerLng).toBeCloseTo((bounds.west + bounds.east) / 2, 9);
    expect(viewport.centerLat).toBeCloseTo((bounds.south + bounds.north) / 2, 9);

    // Recompute the expected "cover" scale directly (the larger of the two axis ratios, not the
    // smaller) and check the viewport actually used it.
    const centerLat = (bounds.south + bounds.north) / 2;
    const mLng = METERS_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180);
    const widthM = (bounds.east - bounds.west) * mLng;
    const heightM = (bounds.north - bounds.south) * METERS_PER_DEGREE_LAT;
    const expectedPxPerMeter = Math.max((width - padding * 2) / widthM, (height - padding * 2) / heightM);

    expect(viewport.scale()).toBeCloseTo(expectedPxPerMeter, 6);
  });

  // Regression guard for the "initial scale" bug and its follow-up letterbox fix: `fitToBounds`
  // itself was never wrong at the maths level (see the render task's writeup), but nothing
  // asserted that its *result* actually fills most of the viewport — first because a bug
  // elsewhere fed it a stale rect, then because the "contain" fit it used to compute was itself
  // the wrong default for a map the player is meant to pan around (SPEC: "a map application fills
  // its window ... this is a map"). This is the assertion that encodes that intent directly: at
  // several viewport shapes, including the exact 1317x507 case from the bug report, the city must
  // cover a stated fraction of the viewport's *area* — never a speck (or a boxed square) centered
  // in a void.
  describe('fills the viewport it is given (regression: initial-scale / letterbox bug)', () => {
    /** A city covering less than this fraction of the viewport's *area* still reads as boxed-in
     * at a glance — this is the number that should fail if excess margin is reintroduced (a stale
     * rect upstream, a much bigger padding constant, reverting to a "contain" fit, etc). Measured
     * fraction across the cases below ranges ~0.81 (the square-viewport case, where the window's
     * aspect ratio exactly matches the city's own and both axes bind simultaneously — cover and
     * contain coincide there, which is the true worst case, not a bug) to ~0.97 (21:9); 0.8 stays
     * a real regression trip-wire without failing that legitimate worst case. TUNE */
    const MIN_FIT_AREA_FRACTION = 0.8;

    // ~6.4km on a side, the same order of magnitude as the real Riverton pack.
    const bounds = squareBounds(41.6, 6400);

    const viewportSizes: ReadonlyArray<readonly [string, number, number]> = [
      ['the reported bug case (wide, short)', 1317, 507],
      ['16:9', 1600, 900],
      ['21:9 ultrawide', 2560, 1097],
      ['tall narrow (portrait)', 500, 1000],
      ['square', 800, 800],
    ];

    for (const [label, width, height] of viewportSizes) {
      it(`at ${label} (${width}x${height})`, () => {
        const viewport = Viewport.fitToBounds(bounds, width, height);
        const nw: ScreenPoint = { x: 0, y: 0 };
        const se: ScreenPoint = { x: 0, y: 0 };
        viewport.project(bounds.west, bounds.north, nw);
        viewport.project(bounds.east, bounds.south, se);
        const fittedWidth = se.x - nw.x;
        const fittedHeight = se.y - nw.y;

        // Isotropic scale on square bounds: the fitted rectangle is itself a square, on every
        // viewport shape, whether or not that square is bigger than the viewport on either axis.
        expect(fittedWidth).toBeCloseTo(fittedHeight, 1);

        // The city fills at least one axis completely (that's the point of "cover") and is at
        // worst padding-inset on the other — never boxed into a fraction of the canvas.
        const coveredWidth = Math.min(fittedWidth, width);
        const coveredHeight = Math.min(fittedHeight, height);
        const areaFraction = (coveredWidth * coveredHeight) / (width * height);

        expect(areaFraction).toBeGreaterThanOrEqual(MIN_FIT_AREA_FRACTION);
        // And the larger fitted dimension must reach all the way out to the padded edge of its
        // viewport axis — the defining trait of "cover" versus "contain": one dimension always
        // meets the (padded) viewport bound, never both falling short simultaneously the way a
        // contain fit's non-binding axis used to.
        const largestAvailAxis = Math.max(width, height) - defaultFitPaddingPx(width, height) * 2;
        expect(Math.max(fittedWidth, fittedHeight)).toBeCloseTo(largestAvailAxis, 1);
      });
    }
  });

  it('the reachable zoom range comfortably brackets a whole-city (contain-style) view below the default fill', () => {
    // The zoom-out escape (see the `clampToBounds` describe block below) depends on there being
    // room, between the cover-fit default and MIN_ZOOM, for a "whole city visible at once" zoom —
    // this pins that down independent of any pan/zoom simulation.
    const bounds = squareBounds(41.6, 6400);
    const width = 1317;
    const height = 507;
    const viewport = Viewport.fitToBounds(bounds, width, height);

    const centerLat = (bounds.south + bounds.north) / 2;
    const mLng = METERS_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180);
    const widthM = (bounds.east - bounds.west) * mLng;
    const heightM = (bounds.north - bounds.south) * METERS_PER_DEGREE_LAT;
    // The old "contain" formula, unpadded (a generous/largest-possible contain zoom) — used only
    // to locate where a whole-city view sits, not as a claim about current default behaviour.
    const containPxPerMeter = Math.min(width / widthM, height / heightM);
    const containZoom = REFERENCE_ZOOM + Math.log2(containPxPerMeter / REFERENCE_PIXELS_PER_METER);

    expect(containZoom).toBeGreaterThan(MIN_ZOOM);
    expect(containZoom).toBeLessThan(viewport.zoom);
  });
});

describe('clampToBounds', () => {
  it('caps the void shown beyond the city edge (and so keeps the bounds intersecting the viewport) after an extreme pan', () => {
    const bounds = squareBounds(41.6, 6400);
    const viewport = Viewport.fitToBounds(bounds, 1317, 507);

    // An unreasonably large drag in both axes — the kind of input a real pointer drag never
    // produces in one event, but the clamp must hold regardless of how it got there.
    viewport.panBy(1_000_000, 1_000_000);
    viewport.clampToBounds(bounds);

    const nw: ScreenPoint = { x: 0, y: 0 };
    const se: ScreenPoint = { x: 0, y: 0 };
    viewport.project(bounds.west, bounds.north, nw);
    viewport.project(bounds.east, bounds.south, se);

    // The city's bounding rectangle must still overlap the viewport at all...
    expect(se.x).toBeGreaterThan(0);
    expect(nw.x).toBeLessThan(viewport.width);
    expect(se.y).toBeGreaterThan(0);
    expect(nw.y).toBeLessThan(viewport.height);

    // ...and specifically, the void this particular (positive, positive) drag pushed the city
    // away from — its near (north-west) edge — must sit exactly `defaultPanClampMarginPx` inside
    // the viewport, not have drifted arbitrarily further off toward the edge the drag was headed.
    const expectedMargin = defaultPanClampMarginPx(viewport.width, viewport.height);
    expect(nw.x).toBeCloseTo(expectedMargin, 2);
    expect(nw.y).toBeCloseTo(expectedMargin, 2);
  });

  it('does not fight the zoom-out escape: zooming toward MIN_ZOOM still reaches a whole-city view', () => {
    const bounds = squareBounds(41.6, 6400);
    const viewport = Viewport.fitToBounds(bounds, 1317, 507);
    const cityCenterLng = (bounds.west + bounds.east) / 2;
    const cityCenterLat = (bounds.south + bounds.north) / 2;

    // Pan off-center first, the way a real session would before reaching for the zoom-out escape,
    // clamping after each step the way `MapCanvas` does after every user pan/zoom.
    viewport.panBy(4000, -3000);
    viewport.clampToBounds(bounds);

    for (let i = 0; i < 200 && viewport.zoom > MIN_ZOOM; i++) {
      viewport.zoomAt(0.85, viewport.width / 2, viewport.height / 2);
      viewport.clampToBounds(bounds);
    }

    expect(viewport.zoom).toBeCloseTo(MIN_ZOOM, 5);

    // At MIN_ZOOM the whole city must be visible — the clamp must have recentred rather than
    // pinned the camera at whatever off-center position the pan/zoom-out sequence left it at.
    const nw: ScreenPoint = { x: 0, y: 0 };
    const se: ScreenPoint = { x: 0, y: 0 };
    viewport.project(bounds.west, bounds.north, nw);
    viewport.project(bounds.east, bounds.south, se);
    expect(nw.x).toBeGreaterThanOrEqual(-0.5);
    expect(nw.y).toBeGreaterThanOrEqual(-0.5);
    expect(se.x).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(se.y).toBeLessThanOrEqual(viewport.height + 0.5);

    expect(viewport.centerLng).toBeCloseTo(cityCenterLng, 6);
    expect(viewport.centerLat).toBeCloseTo(cityCenterLat, 6);
  });
});

describe('zoomFloor', () => {
  it('is the zoom at which the larger city axis spans ZOOM_FLOOR_FRACTION of the smaller viewport axis', () => {
    const bounds = squareBounds(41.6, 6400);
    const width = 1317;
    const height = 507;
    const floor = zoomFloor(bounds, width, height);
    const centerLng = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;

    const viewport = new Viewport(centerLng, centerLat, floor, width, height);
    const nw: ScreenPoint = { x: 0, y: 0 };
    const se: ScreenPoint = { x: 0, y: 0 };
    viewport.project(bounds.west, bounds.north, nw);
    viewport.project(bounds.east, bounds.south, se);

    const largerFittedAxis = Math.max(se.x - nw.x, se.y - nw.y);
    const smallerViewportAxis = Math.min(width, height);
    expect(largerFittedAxis).toBeCloseTo(smallerViewportAxis * ZOOM_FLOOR_FRACTION, 1);
  });

  it('is comfortably below the default (fit) zoom, so zooming out from the default is real headroom', () => {
    const bounds = squareBounds(41.6, 6400);
    const width = 1317;
    const height = 507;
    const fitted = Viewport.fitToBounds(bounds, width, height);
    expect(zoomFloor(bounds, width, height)).toBeLessThan(fitted.zoom);
  });

  it('never drops below MIN_ZOOM for a pathologically small city or viewport', () => {
    const tinyBounds = squareBounds(41.6, 5);
    expect(zoomFloor(tinyBounds, 1, 1)).toBeGreaterThanOrEqual(MIN_ZOOM);
  });
});
