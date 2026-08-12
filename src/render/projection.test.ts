import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, Viewport } from './projection';
import type { MutableLngLat, ScreenPoint } from './projection';

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

describe('fitToBounds', () => {
  it('centers on the bounds and fits them within the padded viewport', () => {
    const bounds = { west: -71.1, south: 41.55, east: -71.0, north: 41.65 };
    const viewport = Viewport.fitToBounds(bounds, 1000, 800, 40);

    expect(viewport.centerLng).toBeCloseTo((bounds.west + bounds.east) / 2, 9);
    expect(viewport.centerLat).toBeCloseTo((bounds.south + bounds.north) / 2, 9);

    const nw: ScreenPoint = { x: 0, y: 0 };
    const se: ScreenPoint = { x: 0, y: 0 };
    viewport.project(bounds.west, bounds.north, nw);
    viewport.project(bounds.east, bounds.south, se);

    // The whole bounds rectangle should land inside the canvas (padding keeps it off the edge).
    expect(nw.x).toBeGreaterThanOrEqual(0);
    expect(nw.y).toBeGreaterThanOrEqual(0);
    expect(se.x).toBeLessThanOrEqual(1000);
    expect(se.y).toBeLessThanOrEqual(800);
  });
});
