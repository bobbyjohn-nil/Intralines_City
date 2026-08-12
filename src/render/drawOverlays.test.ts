import { describe, expect, it } from 'vitest';
import { mixHex, type PaperPalette } from './paperPalette';
import {
  buildLegWaypoints,
  busMarkerLengthPx,
  busMarkerWidthPx,
  busStrokeWidthPx,
  computeBusMarkerPoints,
  createBusMarkerPointsScratch,
  getBusStripeColor,
  getLineColor,
  lerpLngLat,
  pointerMovedPastClickThreshold,
  routeWidthPx,
  sharedNodeId,
  stopRadiusPx,
} from './drawOverlays';
import { getTimeOfDayTint } from './timeOfDay';
import { MAX_ZOOM, MIN_ZOOM, Viewport } from './projection';
import type { RoadEdge, RoadNode } from '../game/types';
import type { RouteLeg, Stop, StopId } from '../game/lines/types';
import {
  BUS_BODY_COLOR_MIX,
  BUS_MARKER_LENGTH_MAX_PX,
  BUS_MARKER_LENGTH_MIN_PX,
  BUS_MARKER_WIDTH_MAX_PX,
  BUS_MARKER_WIDTH_MIN_PX,
  BUS_STROKE_WIDTH_RATIO,
  LINE_COLOR_MIX_STOPS,
  ROAD_COLOR_MIX,
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

/** Parses the `rgb(r, g, b)` / `rgba(r, g, b, a)` strings `mixHex`/`getTimeOfDayTint` return, into
 * plain `[r, g, b]` components — the RGB-distance regression tests below need to compare actual
 * rendered colors, not the hex/mix inputs that produced them. */
function parseRgb(css: string): readonly [number, number, number] {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!match) throw new Error(`not an rgb()/rgba() string: ${css}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Straight-line RGB distance — the same metric `studio/GAME.md`'s "playtest fix notes" already
 * use elsewhere in this codebase (see `ROAD_COLOR_MIX`'s and `PARK_COLOR_MIX_T`'s doc comments in
 * `style.ts`) to defend a color choice numerically instead of by eye. */
function rgbDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** `paper` composited under the deepest night tint (`getTimeOfDayTint` at minute 0, which the
 * keyframe table holds at `NIGHT_ALPHA_MAX` — see `timeOfDay.ts`), the same "over" alpha compositing
 * `ctx.fillRect` with an `rgba(...)` fill actually performs. Buses are drawn as an overlay *after*
 * this tint rect (see `drawOverlays.ts`'s module comment on draw order), so a bus's own colors are
 * never tinted — only the paper/road backdrop it must stay visible against darkens. */
function paperUnderNightTint(palette: PaperPalette): readonly [number, number, number] {
  const paper = parseRgb(mixHex(palette.paper, palette.paper, 0));
  const tint = getTimeOfDayTint(0, palette);
  const [tr, tg, tb] = parseRgb(tint.color);
  const a = tint.alpha;
  return [tr * a + paper[0] * (1 - a), tg * a + paper[1] * (1 - a), tb * a + paper[2] * (1 - a)];
}

const busBodyColor = parseRgb(mixHex(PALETTE.muted, PALETTE.amber, BUS_BODY_COLOR_MIX));
const busStrokeColor = parseRgb(mixHex(PALETTE.ink, PALETTE.ink, 0)); // == palette.ink, as rgb(...)

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

  describe('the floor governs at planning zoom; true scale takes over only at street level, not before', () => {
    // The real default zoom (see `TYPICAL_PLAY_ZOOMS`'s comment further down for why 14.955, not a
    // synthetic viewport's own fit) and a couple of representative "the player zoomed in a bit"
    // steps from it — the floor must still be what renders at every one of these, or the exaggerated
    // "larger than scale, deliberately" size this task asked for silently stops applying right where
    // it matters most.
    const PLANNING_ZOOMS = [14.955, 16, 18];

    it('renders at exactly the floor (not a shrunk true-scale value) at planning zoom', () => {
      for (const zoom of PLANNING_ZOOMS) {
        expect(busMarkerLengthPx(viewportAtZoom(zoom))).toBeCloseTo(BUS_MARKER_LENGTH_MIN_PX, 6);
        expect(busMarkerWidthPx(viewportAtZoom(zoom))).toBeCloseTo(BUS_MARKER_WIDTH_MIN_PX, 6);
      }
    });

    // Confirms the other half of the requirement: zoomed in far enough to be street level (not just
    // "one notch past the default"), the marker is no longer pinned to the planning-zoom floor —
    // true scale has taken over (and the ceiling has already reined it back in), so a bus does not
    // stay a fixed-size sticker all the way to the closest zoom the game allows.
    it('has moved off the floor by street-level zoom — the crossover actually happens, it is not ' +
      'just a number in a comment', () => {
      // Past both the length crossover (~18.6) and the width crossover (~20.1) — see
      // `BUS_MARKER_WIDTH_MIN_PX`'s and `BUS_MARKER_LENGTH_MIN_PX`'s doc comments in `style.ts`.
      const streetLevelZoom = 21.5;
      expect(busMarkerLengthPx(viewportAtZoom(streetLevelZoom))).toBeGreaterThan(BUS_MARKER_LENGTH_MIN_PX);
      expect(busMarkerWidthPx(viewportAtZoom(streetLevelZoom))).toBeGreaterThan(BUS_MARKER_WIDTH_MIN_PX);
      // ...but is still bounded by the ceiling, not the ~307px an uncapped true-scale render would
      // produce this close to MAX_ZOOM — this is the "does not become a bus-shaped billboard" half
      // of the requirement.
      expect(busMarkerLengthPx(viewportAtZoom(streetLevelZoom))).toBeLessThanOrEqual(BUS_MARKER_LENGTH_MAX_PX);
      expect(busMarkerWidthPx(viewportAtZoom(streetLevelZoom))).toBeLessThanOrEqual(BUS_MARKER_WIDTH_MAX_PX);
    });
  });
});

describe('busStrokeWidthPx', () => {
  // Regression coverage for the second, independent defect the sizing fix above did not touch:
  // `drawBuses` used to fill the bus triangle and never stroke it at all. `drawStops`'s established
  // fill-plus-stroke idiom is what actually makes a marker read against a variety of backdrops
  // (paper, roads, route lines) — a stroke with no zoom response would just be `BUS_MARKER_*_PX`'s
  // original bug in miniature, so this must scale with the already-zoom-responsive marker width,
  // not be a fixed screen-pixel constant.

  it('scales linearly with the marker width it is derived from', () => {
    expect(busStrokeWidthPx(10)).toBeCloseTo(10 * BUS_STROKE_WIDTH_RATIO, 6);
    expect(busStrokeWidthPx(20)).toBeCloseTo(20 * BUS_STROKE_WIDTH_RATIO, 6);
    expect(busStrokeWidthPx(0)).toBe(0);
  });

  it('is a sane fraction of the marker — visible but never dominating the fill', () => {
    // Neither a hairline (illegible) nor thick enough to swallow the body fill it is meant to
    // outline.
    expect(BUS_STROKE_WIDTH_RATIO).toBeGreaterThan(0.05);
    expect(BUS_STROKE_WIDTH_RATIO).toBeLessThan(0.5);
  });

  it('inherits the marker width\'s zoom response — grows monotonically across the zoom range, ' +
    'never a fixed pixel value', () => {
    let previous = busStrokeWidthPx(busMarkerWidthPx(viewportAtZoom(MIN_ZOOM)));
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.5) {
      const strokeWidth = busStrokeWidthPx(busMarkerWidthPx(viewportAtZoom(zoom)));
      expect(strokeWidth).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = strokeWidth;
    }
  });

  it('spans the same min/max ratio as BUS_MARKER_WIDTH_MIN_PX/_MAX_PX at the zoom extremes', () => {
    expect(busStrokeWidthPx(busMarkerWidthPx(viewportAtZoom(MIN_ZOOM))))
      .toBeCloseTo(BUS_MARKER_WIDTH_MIN_PX * BUS_STROKE_WIDTH_RATIO, 6);
    expect(busStrokeWidthPx(busMarkerWidthPx(viewportAtZoom(MAX_ZOOM))))
      .toBeCloseTo(BUS_MARKER_WIDTH_MAX_PX * BUS_STROKE_WIDTH_RATIO, 6);
  });
});

describe('routeWidthPx vs. busMarkerWidthPx (regression: "bus optically merged into its own route ' +
  'line" — the route stroke was nearly as wide as the bus riding on it at the zoom range most play ' +
  'happens in, so the vehicle read as a notch on the line, not a distinct object)', () => {
  // The real default zoom the game actually opens on (a whole-city `fitToBounds` view), per the
  // sixth playtest's exact numbers — *not* the ~13.16 a synthetic small test viewport happens to
  // fit to below. `ROAD_MIN_WIDTH_PX.motorway` stops governing `routeWidthPx` at zoom ≈15.185 (the
  // point where `ROAD_WIDTH_M.motorway * scale` first exceeds its own legibility floor), which is
  // only 0.23 zoom levels above this — close enough that the previous `TYPICAL_PLAY_ZOOMS` array
  // (which stopped at 14) never actually exercised the zoom a player opens the game at, let alone
  // the crossover just past it. Every test below now runs against this number directly, not just a
  // discrete sample that happened to land under it.
  const REAL_DEFAULT_ZOOM = 14.955;
  // Exactly the zoom range the playtest diagnosis names, extended past `REAL_DEFAULT_ZOOM` and the
  // ≈15.185 route-floor crossover so a future constant tweak that shifts either number cannot slip
  // through on a gap between sample points the way the old array (topping out at 14) did. 15.955 is
  // one full zoom level in from the default — the first "zoom in one notch" a player takes — and is
  // itself past the crossover, so it also stands in for "zoomed in a little from default", not just
  // "exactly at default". Above this range a route's *true-scale* width can legitimately exceed a
  // bus's (a real motorway genuinely is many times a bus's width up close) — that is correct
  // cartography at street-level zoom, not this defect, so this regression is deliberately scoped to
  // where the bug actually manifested rather than the full zoom range.
  const TYPICAL_PLAY_ZOOMS = [MIN_ZOOM, MIN_ZOOM + 2, 8, 10, 12, 14, REAL_DEFAULT_ZOOM, 15.955];
  // Chosen below the *measured* ratio at the fix (2.88x at the default zoom, see
  // `BUS_MARKER_WIDTH_MIN_PX`'s doc comment in `style.ts`) with headroom for a future palette/
  // constant tweak, but far above the pre-fix measured ratio (1.18) — a regression back toward
  // "barely bigger" fails loudly instead of by eye.
  const MIN_BUS_TO_ROUTE_WIDTH_RATIO = 1.5;
  // How far past `REAL_DEFAULT_ZOOM` the ratio must still hold above `MIN_BUS_TO_ROUTE_WIDTH_RATIO`
  // — the exact continuous guarantee the sixth playtest's diagnosis asked for ("a change to
  // `REFERENCE_PIXELS_PER_METER`, `ROAD_WIDTH_M.motorway` or `ROAD_MIN_WIDTH_PX.motorway` could
  // push the crossover below the default and silently reintroduce the camouflage bug while every
  // test stays green"). A discrete sample list can always be defeated by a constant change that
  // moves the failure point into the gap between two sample zooms; this margin check instead scans
  // continuously from the default zoom and cannot be fooled that way.
  const MIN_ZOOM_MARGIN_PAST_DEFAULT = 0.5;
  const MARGIN_SCAN_STEP = 0.01;

  it('the bus marker is unambiguously wider than the route it rides on, across typical play zooms', () => {
    for (const zoom of TYPICAL_PLAY_ZOOMS) {
      const viewport = viewportAtZoom(zoom);
      const ratio = busMarkerWidthPx(viewport) / routeWidthPx(viewport);
      expect(ratio).toBeGreaterThan(MIN_BUS_TO_ROUTE_WIDTH_RATIO);
    }
  });

  it('holds at the default fit-to-bounds zoom for a representative city-sized viewport — the exact ' +
    'scenario the playtest flagged', () => {
    const viewport = Viewport.fitToBounds({ west: -71.2, east: -71.0, south: 42.3, north: 42.4 }, 1000, 700);
    const ratio = busMarkerWidthPx(viewport) / routeWidthPx(viewport);
    expect(ratio).toBeGreaterThan(MIN_BUS_TO_ROUTE_WIDTH_RATIO);
  });

  it('holds continuously (not just at sampled points) for at least ' +
    `${MIN_ZOOM_MARGIN_PAST_DEFAULT} zoom levels past the real default zoom — regression guard for ` +
    'a crossover shift silently reintroducing the camouflage bug between two discrete test zooms', () => {
    for (let zoom = REAL_DEFAULT_ZOOM; zoom <= REAL_DEFAULT_ZOOM + MIN_ZOOM_MARGIN_PAST_DEFAULT; zoom += MARGIN_SCAN_STEP) {
      const viewport = viewportAtZoom(zoom);
      const ratio = busMarkerWidthPx(viewport) / routeWidthPx(viewport);
      expect(ratio).toBeGreaterThan(MIN_BUS_TO_ROUTE_WIDTH_RATIO);
    }
  });
});

describe('getBusStripeColor (regression: the stripe used to be drawn in the exact same color as ' +
  'the route beneath the bus — RGB distance 0 — which is what let the vehicle camouflage into its ' +
  'own line)', () => {
  // Well below the measured minimum (~91, the closest of the eight `LINE_COLOR_MIX_STOPS` entries
  // — see `BUS_STRIPE_CONTRAST_MIX_T`'s doc comment) but far above 0, so a regression back toward
  // "identical to the route" fails loudly instead of by eye.
  const MIN_STRIPE_VS_ROUTE_DISTANCE = 50;

  it('differs from the route color it is drawn over, for every line in the color cycle', () => {
    for (let lineId = 0; lineId < LINE_COLOR_MIX_STOPS.length; lineId++) {
      const routeColor = parseRgb(getLineColor(PALETTE, lineId));
      const stripeColor = parseRgb(getBusStripeColor(PALETTE, lineId));
      expect(rgbDistance(stripeColor, routeColor)).toBeGreaterThan(MIN_STRIPE_VS_ROUTE_DISTANCE);
    }
  });

  it('is deterministic and cycles the same way getLineColor does', () => {
    expect(getBusStripeColor(PALETTE, 3)).toBe(getBusStripeColor(PALETTE, 3));
    for (let id = 0; id < LINE_COLOR_MIX_STOPS.length; id++) {
      expect(getBusStripeColor(PALETTE, id)).toBe(getBusStripeColor(PALETTE, id + LINE_COLOR_MIX_STOPS.length * 100));
    }
  });

  it('never invents a color outside the palette-mix format (always an rgb(...) string)', () => {
    for (let id = 0; id < LINE_COLOR_MIX_STOPS.length; id++) {
      expect(getBusStripeColor(PALETTE, id)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    }
  });
});

describe('bus colors are actually visible (regression: the fill-only bus used to sit a few RGB ' +
  'units from paper, invisible in every screenshot two playtests took)', () => {
  // Thresholds are well below the measured values (see the render task's numeric defense: ~106
  // units from paper at noon, ~52 under the night tint, ~126 from the nearest road class, ~56 from
  // the nearest route line color, ~245 between the stroke and the fill) — enough headroom that a
  // future palette or mix-ratio tweak doesn't make this flaky, but a regression back toward "a few
  // RGB units" fails loudly.
  const MIN_PAPER_DISTANCE_NOON = 60;
  const MIN_PAPER_DISTANCE_NIGHT = 35;
  const MIN_ROAD_DISTANCE = 80;
  const MIN_LINE_DISTANCE = 40;
  const MIN_STROKE_VS_FILL_DISTANCE = 100;

  it('the bus body fill differs from the paper background at noon by more than the threshold', () => {
    const paperNoon = parseRgb(mixHex(PALETTE.paper, PALETTE.paper, 0));
    expect(rgbDistance(busBodyColor, paperNoon)).toBeGreaterThan(MIN_PAPER_DISTANCE_NOON);
  });

  it('the bus body fill differs from the paper background under the night tint by more than the ' +
    'threshold — the night tint darkens paper toward the fill, so this is the tighter of the two', () => {
    const paperNight = paperUnderNightTint(PALETTE);
    expect(rgbDistance(busBodyColor, paperNight)).toBeGreaterThan(MIN_PAPER_DISTANCE_NIGHT);
  });

  it('the ink stroke differs from paper (noon and night) by a wide margin — the outline always reads', () => {
    const paperNoon = parseRgb(mixHex(PALETTE.paper, PALETTE.paper, 0));
    const paperNight = paperUnderNightTint(PALETTE);
    expect(rgbDistance(busStrokeColor, paperNoon)).toBeGreaterThan(MIN_PAPER_DISTANCE_NOON * 2);
    expect(rgbDistance(busStrokeColor, paperNight)).toBeGreaterThan(MIN_PAPER_DISTANCE_NIGHT * 2);
  });

  it('the bus stroke differs from the bus fill — a hard edge frames the marker, following ' +
    'drawStops\'s fill-plus-stroke idiom', () => {
    expect(rgbDistance(busStrokeColor, busBodyColor)).toBeGreaterThan(MIN_STROKE_VS_FILL_DISTANCE);
  });

  it('the bus body fill differs from every road class it can be drawn over, at noon', () => {
    for (const t of Object.values(ROAD_COLOR_MIX)) {
      const roadColor = parseRgb(mixHex(PALETTE.ink, PALETTE.muted, t));
      expect(rgbDistance(busBodyColor, roadColor)).toBeGreaterThan(MIN_ROAD_DISTANCE);
    }
  });

  it('the bus body fill differs from every route line color it can be drawn over', () => {
    for (const [from, to, t] of LINE_COLOR_MIX_STOPS) {
      const lineColor = parseRgb(mixHex(PALETTE[from], PALETTE[to], t));
      expect(rgbDistance(busBodyColor, lineColor)).toBeGreaterThan(MIN_LINE_DISTANCE);
    }
  });

  it('the bus body fill differs from a stop marker\'s fill (--panel) — size and shape also carry ' +
    'this distinction, but the color itself is not a near-match either', () => {
    const panel = parseRgb(mixHex(PALETTE.panel, PALETTE.panel, 0));
    expect(rgbDistance(busBodyColor, panel)).toBeGreaterThan(MIN_ROAD_DISTANCE);
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

describe('route geometry (regression: the coloured route stroke overshot its first/last stop, ' +
  'and doubled back on itself at any intermediate stop that sits mid-edge at a turn — both are the ' +
  'same underlying defect: `RouteLeg.edgeIds` names whole road edges, but a `Stop` sits at `edgeT`, ' +
  'a fraction *along* one, and the old code drew every edge end-to-end, ignoring that fraction ' +
  'entirely)', () => {
  // A minimal "L" street: A(0,0) --E1--> B(10,0) --E2--> C(10,10). Degrees stand in for lng/lat —
  // these helpers are pure arithmetic on `[lng, lat]` tuples, never a live `Viewport`.
  const nodeA: RoadNode = { id: 1, pos: [0, 0] };
  const nodeB: RoadNode = { id: 2, pos: [10, 0] };
  const nodeC: RoadNode = { id: 3, pos: [10, 10] };
  const nodeIndex = new Map<number, RoadNode>([
    [nodeA.id, nodeA],
    [nodeB.id, nodeB],
    [nodeC.id, nodeC],
  ]);

  const edge1: RoadEdge = { id: 1, from: nodeA.id, to: nodeB.id, roadClass: 'residential', lengthM: 10 };
  const edge2: RoadEdge = { id: 2, from: nodeB.id, to: nodeC.id, roadClass: 'residential', lengthM: 10 };
  const edgeIndex = new Map<number, RoadEdge>([
    [edge1.id, edge1],
    [edge2.id, edge2],
  ]);

  function makeStop(id: number, edgeId: number, edgeT: number, position: readonly [number, number]): Stop {
    return {
      id: id as StopId,
      name: `Stop ${id}`,
      position,
      roadClass: 'residential',
      edgeId,
      edgeT,
      orphaned: false,
      movedM: null,
    };
  }

  describe('sharedNodeId', () => {
    it('finds the node two consecutive edges share, regardless of which ends they store it as', () => {
      expect(sharedNodeId(edge1, edge2)).toBe(nodeB.id); // edge1.to === edge2.from
      expect(sharedNodeId(edge2, edge1)).toBe(nodeB.id); // order-independent
    });

    it('returns undefined for edges that share no node', () => {
      const farEdge: RoadEdge = { id: 99, from: 100, to: 101, roadClass: 'residential', lengthM: 5 };
      expect(sharedNodeId(edge1, farEdge)).toBeUndefined();
    });
  });

  describe('lerpLngLat', () => {
    it('returns `from` at t=0 and `to` at t=1', () => {
      expect(lerpLngLat(nodeA.pos, nodeB.pos, 0)).toEqual([0, 0]);
      expect(lerpLngLat(nodeA.pos, nodeB.pos, 1)).toEqual([10, 0]);
    });

    it('interpolates linearly in between', () => {
      const [lng, lat] = lerpLngLat(nodeA.pos, nodeB.pos, 0.25);
      expect(lng).toBeCloseTo(2.5, 9);
      expect(lat).toBeCloseTo(0, 9);
    });
  });

  describe('buildLegWaypoints', () => {
    const TOLERANCE = 9; // decimal places — tight, since these are exact tuple constructions

    it('a single-edge leg begins and ends exactly at its two stops, not the edge\'s nodes', () => {
      const s0 = makeStop(0, edge1.id, 0.2, [2, 0]);
      const s1 = makeStop(1, edge1.id, 0.8, [8, 0]);
      const leg: RouteLeg = { fromStopId: s0.id, toStopId: s1.id, edgeIds: [edge1.id], lengthM: 6 };

      const out: Array<readonly [number, number]> = [];
      buildLegWaypoints(leg, s0, s1, edgeIndex, nodeIndex, out);

      expect(out.length).toBe(2);
      expect(out[0]![0]).toBeCloseTo(s0.position[0], TOLERANCE);
      expect(out[0]![1]).toBeCloseTo(s0.position[1], TOLERANCE);
      expect(out[out.length - 1]![0]).toBeCloseTo(s1.position[0], TOLERANCE);
      expect(out[out.length - 1]![1]).toBeCloseTo(s1.position[1], TOLERANCE);
      // Regression guard for the termini-overshoot half of the bug: the old code drew all the way
      // to the edge's own nodes (0,0) and (10,0) regardless of where the stops actually sat.
      expect(out[0]).not.toEqual(nodeA.pos);
      expect(out[out.length - 1]).not.toEqual(nodeB.pos);
    });

    it('a multi-edge leg is clipped at both ends and passes through the shared node in between', () => {
      const s0 = makeStop(0, edge1.id, 0.8, [8, 0]);
      const s1 = makeStop(1, edge2.id, 0.5, [10, 5]);
      const leg: RouteLeg = { fromStopId: s0.id, toStopId: s1.id, edgeIds: [edge1.id, edge2.id], lengthM: 7 };

      const out: Array<readonly [number, number]> = [];
      buildLegWaypoints(leg, s0, s1, edgeIndex, nodeIndex, out);

      expect(out.length).toBe(3);
      expect(out[0]).toEqual([8, 0]); // clipped entry, not node A or B
      expect(out[1]).toEqual(nodeB.pos); // the real joint between edge1 and edge2
      expect(out[2]).toEqual([10, 5]); // clipped exit, not node C
    });

    it(
      'the whole-line polyline begins/ends exactly at the terminus stops and never doubles back ' +
        'over a shared edge at a mid-edge intermediate stop (the second half of the reported bug — ' +
        'a stop shared by two legs used to have both legs draw that edge in full)',
      () => {
        // S0 sits exactly at node A; S1 sits mid-edge on edge1 (the turn); S2 sits mid-edge on
        // edge2. Leg1 = S0→S1 (edge1 only). Leg2 = S1→S2 (edge1's remainder, then edge2) — S1's
        // own edge (edge1) is `leg1`'s last edge *and* `leg2`'s first edge, exactly the shared-edge
        // case the bug report calls out.
        const s0 = makeStop(0, edge1.id, 0, [0, 0]);
        const s1 = makeStop(1, edge1.id, 0.8, [8, 0]);
        const s2 = makeStop(2, edge2.id, 0.5, [10, 5]);
        const leg1: RouteLeg = { fromStopId: s0.id, toStopId: s1.id, edgeIds: [edge1.id], lengthM: 8 };
        const leg2: RouteLeg = {
          fromStopId: s1.id,
          toStopId: s2.id,
          edgeIds: [edge1.id, edge2.id],
          lengthM: 7,
        };

        // Mirrors exactly what `drawLineRoute` does: concatenate every leg's waypoints into one
        // continuous polyline (see its own comment on why legs share a subpath).
        const polyline: Array<readonly [number, number]> = [];
        buildLegWaypoints(leg1, s0, s1, edgeIndex, nodeIndex, polyline);
        buildLegWaypoints(leg2, s1, s2, edgeIndex, nodeIndex, polyline);

        const first = polyline[0]!;
        const last = polyline[polyline.length - 1]!;
        expect(first[0]).toBeCloseTo(s0.position[0], TOLERANCE);
        expect(first[1]).toBeCloseTo(s0.position[1], TOLERANCE);
        expect(last[0]).toBeCloseTo(s2.position[0], TOLERANCE);
        expect(last[1]).toBeCloseTo(s2.position[1], TOLERANCE);

        // No point after S1 (x=8) ever falls back below it — a monotonic march along the L, not a
        // reversal back toward node A. The pre-fix bug would have re-drawn edge1 in full for leg2
        // (A(0,0) → B(10,0)), reintroducing node A's x=0 after S1's x=8: a literal backtrack.
        const s1Index = polyline.findIndex((p) => p[0] === s1.position[0] && p[1] === s1.position[1]);
        expect(s1Index).toBeGreaterThanOrEqual(0);
        for (let i = s1Index; i < polyline.length; i++) {
          expect(polyline[i]![0]).toBeGreaterThanOrEqual(s1.position[0] - 1e-9);
        }
        // Node A must not reappear anywhere after S1 — the exact signature of the old bug (leg2
        // drawing edge1's far node again instead of stopping/starting at S1).
        for (let i = s1Index + 1; i < polyline.length; i++) {
          expect(polyline[i]).not.toEqual(nodeA.pos);
        }
      },
    );

    it('degrades to the edge\'s own node instead of throwing when the expected stop is missing ' +
      '(a caller bug, not a player-reachable state — matches this file\'s existing skip-and-continue ' +
      'idiom elsewhere)', () => {
      const leg: RouteLeg = { fromStopId: 0 as StopId, toStopId: 1 as StopId, edgeIds: [edge1.id], lengthM: 10 };
      const out: Array<readonly [number, number]> = [];
      expect(() => buildLegWaypoints(leg, undefined, undefined, edgeIndex, nodeIndex, out)).not.toThrow();
      expect(out).toEqual([nodeA.pos, nodeB.pos]);
    });
  });
});
