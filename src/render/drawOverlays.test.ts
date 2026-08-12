import { describe, expect, it } from 'vitest';
import type { PaperPalette } from './paperPalette';
import {
  busMarkerLengthPx,
  busMarkerWidthPx,
  computeBusMarkerPoints,
  createBusMarkerPointsScratch,
  getLineColor,
  pointerMovedPastClickThreshold,
  stopRadiusPx,
} from './drawOverlays';
import { MAX_ZOOM, MIN_ZOOM, Viewport } from './projection';
import {
  BUS_MARKER_LENGTH_MAX_PX,
  BUS_MARKER_LENGTH_MIN_PX,
  BUS_MARKER_WIDTH_MAX_PX,
  BUS_MARKER_WIDTH_MIN_PX,
  STOP_RADIUS_MAX_PX,
} from './style';

/** A viewport at `zoom`; `Viewport.scale()` (what `busMarkerLengthPx`/`busMarkerWidthPx` and
 * `stopRadiusPx` ultimately key off) depends only on `zoom`, so center/width/height are
 * arbitrary placeholders here. */
function viewportAtZoom(zoom: number): Viewport {
  return new Viewport(0, 0, zoom, 800, 600);
}

// Same fallback palette `paperPalette.ts` uses when CSS custom properties aren't available —
// lets these tests call palette-consuming helpers directly, no DOM required.
const PALETTE: PaperPalette = {
  paper: '#f6f1e1',
  panel: '#fffdf6',
  ink: '#2c2a24',
  muted: '#7a7259',
  blue: '#1d3f7a',
  amber: '#ffe9a8',
  red: '#c94f35',
};

describe('pointerMovedPastClickThreshold', () => {
  const THRESHOLD_PX = 6;

  it('is false when the pointer never moved', () => {
    expect(pointerMovedPastClickThreshold(100, 100, 100, 100, THRESHOLD_PX)).toBe(false);
  });

  it('is false for movement at or under the threshold (a click, not a drag)', () => {
    expect(pointerMovedPastClickThreshold(0, 0, THRESHOLD_PX, 0, THRESHOLD_PX)).toBe(false);
    expect(pointerMovedPastClickThreshold(0, 0, THRESHOLD_PX - 1, 0, THRESHOLD_PX)).toBe(false);
  });

  it('is true once straight-line movement exceeds the threshold', () => {
    expect(pointerMovedPastClickThreshold(0, 0, THRESHOLD_PX + 1, 0, THRESHOLD_PX)).toBe(true);
  });

  it('measures straight-line (Pythagorean) distance, not per-axis distance', () => {
    // 3-4-5 triangle: each axis alone is under a threshold of 4.5, but the combined distance (5)
    // is over it — a diagonal drag must still count as a drag.
    expect(pointerMovedPastClickThreshold(0, 0, 3, 4, 4.5)).toBe(true);
    expect(pointerMovedPastClickThreshold(0, 0, 3, 0, 4.5)).toBe(false);
    expect(pointerMovedPastClickThreshold(0, 0, 0, 4, 4.5)).toBe(false);
  });

  it('is symmetric under negative deltas (drag direction does not matter)', () => {
    expect(pointerMovedPastClickThreshold(50, 50, 40, 45, 6)).toBe(
      pointerMovedPastClickThreshold(50, 50, 60, 55, 6),
    );
  });

  it('a real click never fires onMapClick-suppressing logic for sub-pixel jitter', () => {
    // Regression guard for the exact bug the task calls out: "every pan would drop a stop" if
    // this were wrong the other way (too permissive) or "the map unusable" if too strict.
    expect(pointerMovedPastClickThreshold(200, 300, 201, 300, 6)).toBe(false);
  });
});

describe('stopRadiusPx', () => {
  it('is the minimum radius at MIN_ZOOM', () => {
    expect(stopRadiusPx(MIN_ZOOM)).toBeCloseTo(3, 6);
  });

  it('is the maximum radius at MAX_ZOOM', () => {
    expect(stopRadiusPx(MAX_ZOOM)).toBeCloseTo(6, 6);
  });

  it('is monotonically non-decreasing across the zoom range', () => {
    let previous = stopRadiusPx(MIN_ZOOM);
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.5) {
      const radius = stopRadiusPx(zoom);
      expect(radius).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = radius;
    }
  });

  it('grows faster than linear near MIN_ZOOM (square-root curve, not a straight ramp)', () => {
    const mid = MIN_ZOOM + (MAX_ZOOM - MIN_ZOOM) / 2;
    const linearMid = 3 + (6 - 3) * 0.5;
    expect(stopRadiusPx(mid)).toBeGreaterThan(linearMid);
  });

  it('clamps below MIN_ZOOM and above MAX_ZOOM instead of extrapolating', () => {
    expect(stopRadiusPx(MIN_ZOOM - 10)).toBeCloseTo(3, 6);
    expect(stopRadiusPx(MAX_ZOOM + 10)).toBeCloseTo(6, 6);
  });
});

describe('busMarkerLengthPx / busMarkerWidthPx', () => {
  it('is the minimum size at MIN_ZOOM', () => {
    expect(busMarkerLengthPx(viewportAtZoom(MIN_ZOOM))).toBeCloseTo(BUS_MARKER_LENGTH_MIN_PX, 6);
    expect(busMarkerWidthPx(viewportAtZoom(MIN_ZOOM))).toBeCloseTo(BUS_MARKER_WIDTH_MIN_PX, 6);
  });

  it('is the maximum size at MAX_ZOOM', () => {
    expect(busMarkerLengthPx(viewportAtZoom(MAX_ZOOM))).toBeCloseTo(BUS_MARKER_LENGTH_MAX_PX, 6);
    expect(busMarkerWidthPx(viewportAtZoom(MAX_ZOOM))).toBeCloseTo(BUS_MARKER_WIDTH_MAX_PX, 6);
  });

  it('is monotonically non-decreasing across the zoom range', () => {
    let prevLength = busMarkerLengthPx(viewportAtZoom(MIN_ZOOM));
    let prevWidth = busMarkerWidthPx(viewportAtZoom(MIN_ZOOM));
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.5) {
      const length = busMarkerLengthPx(viewportAtZoom(zoom));
      const width = busMarkerWidthPx(viewportAtZoom(zoom));
      expect(length).toBeGreaterThanOrEqual(prevLength - 1e-9);
      expect(width).toBeGreaterThanOrEqual(prevWidth - 1e-9);
      prevLength = length;
      prevWidth = width;
    }
  });

  it('clamps below MIN_ZOOM and above MAX_ZOOM instead of extrapolating', () => {
    expect(busMarkerLengthPx(viewportAtZoom(MIN_ZOOM - 10))).toBeCloseTo(BUS_MARKER_LENGTH_MIN_PX, 6);
    expect(busMarkerLengthPx(viewportAtZoom(MAX_ZOOM + 10))).toBeCloseTo(BUS_MARKER_LENGTH_MAX_PX, 6);
    expect(busMarkerWidthPx(viewportAtZoom(MIN_ZOOM - 10))).toBeCloseTo(BUS_MARKER_WIDTH_MIN_PX, 6);
    expect(busMarkerWidthPx(viewportAtZoom(MAX_ZOOM + 10))).toBeCloseTo(BUS_MARKER_WIDTH_MAX_PX, 6);
  });

  // Regression coverage for the confirmed defect: `BUS_MARKER_LENGTH_PX`/`_WIDTH_PX` used to be
  // fixed CSS pixels with no zoom response at all, making a bus a "sub-1% speck" at the default
  // fit-to-bounds zoom where a player actually looks. Compared here as each marker's largest
  // on-screen extent: the bus triangle's length (its longest dimension — by construction always
  // >= its width, since `BUS_MARKER_LENGTH_MIN_PX`/`_MAX_PX` exceed `BUS_MARKER_WIDTH_MIN_PX`/
  // `_MAX_PX` at the same min:max ratio) against the stop circle's diameter (its only dimension).
  it('a bus marker is strictly larger than a stop marker at the same zoom, across several zooms', () => {
    const zooms = [MIN_ZOOM, MIN_ZOOM + 2, 10, 14, 18, MAX_ZOOM - 2, MAX_ZOOM];
    for (const zoom of zooms) {
      const busLength = busMarkerLengthPx(viewportAtZoom(zoom));
      const stopDiameter = stopRadiusPx(zoom) * 2;
      expect(busLength).toBeGreaterThan(stopDiameter);
    }
  });

  it('a bus marker is strictly larger than a stop marker at the default fit-to-bounds zoom for a ' +
    'representative city-sized viewport — the exact scenario the playtest flagged', () => {
    const viewport = Viewport.fitToBounds({ west: -71.2, east: -71.0, south: 42.3, north: 42.4 }, 1000, 700);
    const busLength = busMarkerLengthPx(viewport);
    const stopDiameter = stopRadiusPx(viewport.zoom) * 2;
    expect(busLength).toBeGreaterThan(stopDiameter);
  });

  it('the bus marker length floor alone (independent of any particular zoom) already exceeds the ' +
    'largest a stop marker can ever get, guaranteeing the ordering holds at every zoom', () => {
    expect(BUS_MARKER_LENGTH_MIN_PX).toBeGreaterThan(STOP_RADIUS_MAX_PX * 2);
  });
});

describe('getLineColor', () => {
  it('is deterministic for a given palette and line id', () => {
    expect(getLineColor(PALETTE, 3)).toBe(getLineColor(PALETTE, 3));
  });

  it('cycles rather than repeating the same color for every line', () => {
    const colors = new Set(Array.from({ length: 8 }, (_, id) => getLineColor(PALETTE, id)));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('wraps around for ids beyond the cycle length the same as their modulo', () => {
    // Whatever the cycle length actually is, id and id + cycle-length*N must land on the same
    // color — probe a few large ids against their small-id equivalents via id % 8, which is >=
    // the true cycle length check indirectly (if this ever fails because the cycle length
    // changed, it means the wrap itself broke, not that 8 was the wrong guess).
    for (let id = 0; id < 8; id++) {
      expect(getLineColor(PALETTE, id)).toBe(getLineColor(PALETTE, id + 800));
    }
  });

  it('never invents a color outside the palette-mix format (always an rgb(...) string)', () => {
    for (let id = 0; id < 8; id++) {
      expect(getLineColor(PALETTE, id)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    }
  });
});

describe('computeBusMarkerPoints', () => {
  it('points the tip north (up, -y) when bearing is 0', () => {
    const out = createBusMarkerPointsScratch();
    computeBusMarkerPoints(100, 100, 0, 10, 6, out);
    expect(out.tipX).toBeCloseTo(100, 6);
    expect(out.tipY).toBeLessThan(100);
  });

  it('points the tip east (+x) when bearing is 90', () => {
    const out = createBusMarkerPointsScratch();
    computeBusMarkerPoints(100, 100, 90, 10, 6, out);
    expect(out.tipX).toBeGreaterThan(100);
    expect(out.tipY).toBeCloseTo(100, 6);
  });

  it('points the tip south (+y) when bearing is 180', () => {
    const out = createBusMarkerPointsScratch();
    computeBusMarkerPoints(100, 100, 180, 10, 6, out);
    expect(out.tipX).toBeCloseTo(100, 6);
    expect(out.tipY).toBeGreaterThan(100);
  });

  it('points the tip west (-x) when bearing is 270', () => {
    const out = createBusMarkerPointsScratch();
    computeBusMarkerPoints(100, 100, 270, 10, 6, out);
    expect(out.tipX).toBeLessThan(100);
    expect(out.tipY).toBeCloseTo(100, 6);
  });

  it('places the tip exactly lengthPx/2 from center, for any bearing', () => {
    const out = createBusMarkerPointsScratch();
    for (const bearing of [0, 37, 90, 145, 200, 315]) {
      computeBusMarkerPoints(50, 50, bearing, 10, 6, out);
      const dist = Math.hypot(out.tipX - 50, out.tipY - 50);
      expect(dist).toBeCloseTo(5, 6);
    }
  });

  it('keeps the two tail corners symmetric around the centerline and widthPx apart', () => {
    const out = createBusMarkerPointsScratch();
    computeBusMarkerPoints(0, 0, 37, 10, 6, out);
    const midX = (out.leftX + out.rightX) / 2;
    const midY = (out.leftY + out.rightY) / 2;
    // The tail midpoint sits directly behind the tip through the center, at lengthPx/2 the other
    // way — i.e. midpoint and tip are lengthPx apart and center lies exactly between them.
    expect(Math.hypot(out.tipX - midX, out.tipY - midY)).toBeCloseTo(10, 6);
    const cornerSpread = Math.hypot(out.leftX - out.rightX, out.leftY - out.rightY);
    expect(cornerSpread).toBeCloseTo(6, 6);
  });

  it('never allocates a new points object — writes into the provided `out`', () => {
    const out = createBusMarkerPointsScratch();
    const result = computeBusMarkerPoints(1, 2, 45, 10, 6, out);
    expect(result).toBe(out);
  });
});
