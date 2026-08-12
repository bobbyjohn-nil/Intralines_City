/**
 * Gameplay overlays for the offline Canvas 2D basemap — routes, stops, the in-progress line
 * draft (confirmed legs + rubber-band preview to the cursor), and buses in motion. Drawn by
 * `MapCanvas` after `drawCity` (basemap + time-of-day tint) and before `drawMask` (the
 * out-of-bounds mask + dashed boundary), so gameplay content never bleeds into the masked area
 * and the boundary always reads on top of everything. See `drawCity.ts`'s module comment for the
 * full draw-order contract.
 *
 * `drawOverlays` draws only what it's given — every field of `DrawOverlaysOptions` is optional,
 * and with none supplied it does nothing (no basemap change at all), matching `MapCanvas`'s own
 * "no overlay props = renders exactly as it does today" contract.
 *
 * This module also owns several small pure helpers that have nothing to do with drawing but need
 * to live somewhere testable without a DOM: `pointerMovedPastClickThreshold` (click-vs-drag
 * discrimination for `MapCanvas`'s pointer handling) and `computeBusMarkerPoints` / `stopRadiusPx`
 * / `busMarkerLengthPx` / `busMarkerWidthPx` (the geometry the draw calls below turn into paths).
 * All are exported and covered by `drawOverlays.test.ts`.
 *
 * Performance contract, same as `drawCity.ts`: no allocation inside a call that can run every
 * frame (buses moving forces exactly that — see `MapCanvas`'s redraw gate). Every reusable point
 * is a module-scoped scratch object mutated in place; every palette-derived color is cached by
 * palette object identity so a theme flip recomputes it once, not every frame.
 */

import type { City, LngLat, RoadEdge, RoadNode } from '../game/types';
import type { Draft, Line, RouteLeg, Stop, StopId } from '../game/lines/types';
import type { RouteSchedule } from '../game/buses/schedule';
import { busPositionAt, createBusPositionScratch, type BusPosition } from '../game/buses/position';
import { getRenderCache, type RenderCache } from './drawCity';
import { mixHex, readPaperPalette, type PaperPalette } from './paperPalette';
import { MAX_ZOOM, MIN_ZOOM, type ScreenPoint, type Viewport } from './projection';
import {
  BUS_BODY_COLOR_MIX,
  BUS_LENGTH_M,
  BUS_MARKER_LENGTH_MAX_PX,
  BUS_MARKER_LENGTH_MIN_PX,
  BUS_MARKER_WIDTH_MAX_PX,
  BUS_MARKER_WIDTH_MIN_PX,
  BUS_STRIPE_CONTRAST_MIX_T,
  BUS_STRIPE_WIDTH_PX,
  BUS_STROKE_WIDTH_RATIO,
  BUS_WIDTH_M,
  DRAFT_RUBBER_BAND_DASH_PATTERN,
  DRAFT_RUBBER_BAND_WIDTH_PX,
  LINE_COLOR_MIX_STOPS,
  ROAD_MIN_WIDTH_PX,
  ROAD_WIDTH_M,
  ROUTE_WIDTH_MULTIPLIER,
  STOP_OUTLINE_WIDTH_PX,
  STOP_RADIUS_MAX_PX,
  STOP_RADIUS_MIN_PX,
} from './style';

// ── Pointer interaction: click-vs-drag ──────────────────────────────────────
// Lives here (not in `MapCanvas.tsx`) purely so it's a plain function `drawOverlays.test.ts` can
// call without a DOM — the actual pointerdown/pointerup wiring stays in `MapCanvas`.

/**
 * True if the pointer moved farther than `thresholdPx` (straight-line) between down and up —
 * `MapCanvas` uses this to suppress `onMapClick` at the end of a drag/pan gesture. Getting this
 * wrong makes the map unusable (every pan would drop a stop), so it's kept pure and tested in
 * isolation rather than inlined into the pointer-event handler.
 */
export function pointerMovedPastClickThreshold(
  downX: number,
  downY: number,
  upX: number,
  upY: number,
  thresholdPx: number,
): boolean {
  const dx = upX - downX;
  const dy = upY - downY;
  return dx * dx + dy * dy > thresholdPx * thresholdPx;
}

// ── Line color cycle ─────────────────────────────────────────────────────────

const lineColorCache = new WeakMap<PaperPalette, readonly string[]>();

function getLineColorPalette(palette: PaperPalette): readonly string[] {
  let colors = lineColorCache.get(palette);
  if (!colors) {
    colors = LINE_COLOR_MIX_STOPS.map(([from, to, t]) => mixHex(palette[from], palette[to], t));
    lineColorCache.set(palette, colors);
  }
  return colors;
}

/** The stroke color for line `lineId`, cycling through `LINE_COLOR_MIX_STOPS` so consecutive
 * lines stay visually distinct. Exported for the draft's "preview the color it will actually get"
 * behavior below and for direct testing. */
export function getLineColor(palette: PaperPalette, lineId: number): string {
  const colors = getLineColorPalette(palette);
  const index = ((lineId % colors.length) + colors.length) % colors.length;
  return colors[index]!;
}

const busBodyColorCache = new WeakMap<PaperPalette, string>();

function getBusBodyColor(palette: PaperPalette): string {
  let color = busBodyColorCache.get(palette);
  if (!color) {
    color = mixHex(palette.muted, palette.amber, BUS_BODY_COLOR_MIX);
    busBodyColorCache.set(palette, color);
  }
  return color;
}

// ── Bus stripe color (contrast-tinted, never identical to the route it rides on) ────────────────
// See `BUS_STRIPE_CONTRAST_MIX_T`'s doc comment in `style.ts` for the full playtest-fix rationale:
// the stripe used to be drawn in the exact same color as the route beneath the bus
// (`getLineColor(palette, lineId)`, called by both `drawLineRoute` and this stripe), which is what
// let the bus's own centerline optically fuse with its route. `mixHex` only accepts hex palette
// colors, but `getLineColor` returns an already-mixed `rgb(...)` string, so the tint-toward-`panel`
// step below works on parsed RGB triples directly instead of re-entering `mixHex` — still entirely
// palette-derived (every input is either a `getLineColor` output or `palette.panel` itself), never
// an invented hex.

const RGB_PATTERN = /^rgb\((\d+), (\d+), (\d+)\)$/;

/** Parses the `rgb(r, g, b)` strings `getLineColor`/`mixHex` produce back into components, for the
 * one place in this module that needs to blend an already-mixed color further (as opposed to
 * mixing two raw palette hex values, which `mixHex` already covers). */
function parseRgb(color: string): readonly [number, number, number] {
  const match = RGB_PATTERN.exec(color);
  if (!match) throw new Error(`not an rgb(...) string produced by mixHex: ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Blends two already-resolved `rgb(...)` colors, `t=0` is `from`, `t=1` is `to` — the `rgb(...)`
 * counterpart to `mixHex`'s hex-input blend, used only for `getBusStripeColor` below. */
function mixRgb(from: string, to: string, t: number): string {
  const [r0, g0, b0] = parseRgb(from);
  const [r1, g1, b1] = parseRgb(to);
  const r = Math.round(r0 + (r1 - r0) * t);
  const g = Math.round(g0 + (g1 - g0) * t);
  const b = Math.round(b0 + (b1 - b0) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

const busStripeColorCache = new WeakMap<PaperPalette, readonly string[]>();

function getBusStripeColorPalette(palette: PaperPalette): readonly string[] {
  let colors = busStripeColorCache.get(palette);
  if (!colors) {
    const panel = mixHex(palette.panel, palette.panel, 0); // palette.panel as an rgb(...) string
    colors = getLineColorPalette(palette).map((routeColor) =>
      mixRgb(routeColor, panel, BUS_STRIPE_CONTRAST_MIX_T),
    );
    busStripeColorCache.set(palette, colors);
  }
  return colors;
}

/** The bus centerline stripe color for line `lineId` — a `--panel`-tinted variant of
 * `getLineColor(palette, lineId)`, deliberately *not* identical to the route color it is drawn
 * over (see `BUS_STRIPE_CONTRAST_MIX_T`'s doc comment). Exported for direct testing of the
 * stripe-vs-route RGB distance regression. */
export function getBusStripeColor(palette: PaperPalette, lineId: number): string {
  const colors = getBusStripeColorPalette(palette);
  const index = ((lineId % colors.length) + colors.length) % colors.length;
  return colors[index]!;
}

// ── Zoom-responsive stop radius ──────────────────────────────────────────────

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Stop marker radius at `zoom`, clamped between `STOP_RADIUS_MIN_PX` (legible zoomed all the way
 * out) and `STOP_RADIUS_MAX_PX` (never a blob zoomed all the way in), scaled by square root of
 * zoom progress like this game's other size-by-zoom responses. Pure — exported for testing. */
export function stopRadiusPx(zoom: number): number {
  const span = MAX_ZOOM - MIN_ZOOM;
  const t = span > 0 ? clamp01((zoom - MIN_ZOOM) / span) : 0;
  return STOP_RADIUS_MIN_PX + (STOP_RADIUS_MAX_PX - STOP_RADIUS_MIN_PX) * Math.sqrt(t);
}

// ── Zoom-responsive bus marker size ──────────────────────────────────────────

/** Bus marker length (nose-to-tail) at `viewport`'s current zoom: `BUS_LENGTH_M` rendered at
 * `viewport.scale()` the same way `routeWidthPx` renders a road's true-metres width, then clamped
 * between `BUS_MARKER_LENGTH_MIN_PX` and `BUS_MARKER_LENGTH_MAX_PX` — see those constants' doc
 * comment in `style.ts` for why the floor is what actually governs legibility at typical play
 * zooms. Pure — exported for testing. */
export function busMarkerLengthPx(viewport: Viewport): number {
  return clamp(BUS_LENGTH_M * viewport.scale(), BUS_MARKER_LENGTH_MIN_PX, BUS_MARKER_LENGTH_MAX_PX);
}

/** Bus marker width, same idiom as `busMarkerLengthPx` — see its doc comment. Pure — exported for
 * testing. */
export function busMarkerWidthPx(viewport: Viewport): number {
  return clamp(BUS_WIDTH_M * viewport.scale(), BUS_MARKER_WIDTH_MIN_PX, BUS_MARKER_WIDTH_MAX_PX);
}

/** Bus marker outline stroke width at a given marker `widthPx` — always `BUS_STROKE_WIDTH_RATIO`
 * of it, so the stroke scales with the marker's own zoom response instead of being a fixed pixel
 * value (see `BUS_STROKE_WIDTH_RATIO`'s doc comment for why a fixed pixel value repeats the
 * original size bug). Pure — exported for testing. */
export function busStrokeWidthPx(widthPx: number): number {
  return widthPx * BUS_STROKE_WIDTH_RATIO;
}

// ── Bus marker geometry ──────────────────────────────────────────────────────

/** A mutable oriented-triangle marker, screen space. Passed as an `out` parameter so the hot draw
 * path never allocates — see `createBusMarkerPointsScratch`. */
export interface BusMarkerPoints {
  tipX: number;
  tipY: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

export function createBusMarkerPointsScratch(): BusMarkerPoints {
  return { tipX: 0, tipY: 0, leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
}

/**
 * Places an oriented triangle marker's three points (nose + two tail corners) `lengthPx` long and
 * `widthPx` wide, centered on `(centerX, centerY)` and pointing along `bearingDeg` (degrees
 * clockwise from north, matching `BusPosition.bearing`), writing into `out` in place. Pure
 * arithmetic — exported and tested directly; the actual draw call reuses one scratch `out` across
 * every bus, every frame.
 */
export function computeBusMarkerPoints(
  centerX: number,
  centerY: number,
  bearingDeg: number,
  lengthPx: number,
  widthPx: number,
  out: BusMarkerPoints,
): BusMarkerPoints {
  const bearingRad = (bearingDeg * Math.PI) / 180;
  // Screen space: bearing 0 (north) points up (-y); bearing increases clockwise, matching how
  // `viewport.project` flips latitude (north = up = -y) — see projection.ts.
  const fwdX = Math.sin(bearingRad);
  const fwdY = -Math.cos(bearingRad);
  // 90 degrees clockwise from forward, i.e. to the marker's right.
  const rightX = fwdY;
  const rightY = -fwdX;

  const halfLen = lengthPx / 2;
  const halfWidth = widthPx / 2;
  const baseX = centerX - fwdX * halfLen;
  const baseY = centerY - fwdY * halfLen;

  out.tipX = centerX + fwdX * halfLen;
  out.tipY = centerY + fwdY * halfLen;
  out.leftX = baseX + rightX * halfWidth;
  out.leftY = baseY + rightY * halfWidth;
  out.rightX = baseX - rightX * halfWidth;
  out.rightY = baseY - rightY * halfWidth;
  return out;
}

// ── Reusable scratch objects — the draw path never allocates ────────────────

const scratchA: ScreenPoint = { x: 0, y: 0 };
const scratchB: ScreenPoint = { x: 0, y: 0 };
const busPositionScratch: BusPosition = createBusPositionScratch();
const busMarkerScratch: BusMarkerPoints = createBusMarkerPointsScratch();

/** Fallback when `lines` is supplied without `stops` — never allocated per call, same idiom as
 * `pathfind.ts`'s `EMPTY_EDGE_IDS`. A caller that draws lines is expected to also supply the
 * collection those lines' `stopIds` resolve against; this just means a missing one draws routes
 * with no stop markers instead of throwing mid-frame. */
const EMPTY_STOPS_MAP: ReadonlyMap<StopId, Stop> = new Map();

// ── Public option shapes ─────────────────────────────────────────────────────

/**
 * One line's worth of buses to animate. `MapCanvas` doesn't own bus-count-per-line or the built
 * `RouteSchedule` (those come from `src/game/buses`), so this is the render-facing shape that
 * pairs a schedule with the line it belongs to (for coloring) and how many buses run it.
 */
export interface LineBusSchedule {
  readonly lineId: number;
  readonly schedule: RouteSchedule;
  readonly busCount: number;
}

export interface DrawOverlaysOptions {
  readonly lines?: readonly Line[];
  /** The top-level stop collection `lines[].stopIds` resolves against (save-format.md §5) — a
   * `Line` no longer nests its own `Stop` objects. Missing while `lines` is present just means no
   * stop markers for those lines (see `EMPTY_STOPS_MAP`), not a thrown error mid-frame. */
  readonly stops?: ReadonlyMap<StopId, Stop>;
  readonly schedules?: readonly LineBusSchedule[];
  readonly draft?: Draft;
  readonly hoverLngLat?: LngLat;
  readonly totalMinutes?: number;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** A route's stroke width at `viewport`'s current zoom — always `ROUTE_WIDTH_MULTIPLIER` times the
 * rendered motorway width (see that constant's doc comment in `style.ts` for why it is *not* a
 * larger multiple: a route only needs to clear the roads it is drawn over, not dominate the
 * vehicles drawn over *it*). Exported for `busMarkerWidthPx` vs. `routeWidthPx` ratio regression
 * testing — see `drawOverlays.test.ts`. */
export function routeWidthPx(viewport: Viewport): number {
  const motorwayWidthPx = Math.max(ROAD_MIN_WIDTH_PX.motorway, ROAD_WIDTH_M.motorway * viewport.scale());
  return motorwayWidthPx * ROUTE_WIDTH_MULTIPLIER;
}

// ── Route geometry: clip legs to their stops, not their edges' nodes ────────────────────────────
// Bug fix (owner report): the coloured route stroke used to run past a leg's first/last stop out
// to that edge's far *node*, because `RouteLeg.edgeIds` names whole road edges but a `Stop` sits
// at `edgeT`, a fraction *along* one — drawing every edge end-to-end (the old `drawLineRoute` body,
// see git history) always overshot both termini. The same defect also hit every *intermediate*
// stop that happens to sit mid-edge at a turn: `routeLeg` (`game/lines/draft.ts`) puts the stop's
// own edge at `leg.edgeIds[0]` (fromStop) or `leg.edgeIds[edgeIds.length - 1]` (toStop), so a stop
// shared by two consecutive legs has *both* legs drawing that same edge in full — a real, visible
// spur backtracking from the corner toward the edge's other node (invisible on a straight road,
// where the duplicate full-edge draw exactly overlaps itself, which is exactly why it went
// unnoticed until a turn made it visible). Fixed below by clipping every leg's first and last edge
// to the fractional `edgeT` position of its own stop, so two legs sharing a stop's edge now compute
// the identical clipped point and terminate exactly there instead of continuing to the shared node.

/** The node id shared by two directly-connected edges (`a`'s far endpoint from a route leg's
 * previous edge, matched against `b`'s two endpoints) — `undefined` if they don't actually share
 * one. Should never be `undefined` for edges taken from the same contiguous `RouteLeg.edgeIds`
 * chain (`routeLeg` always builds a connected path), but checked rather than assumed — see
 * `buildLegWaypoints`'s degrade path. Pure — exported for direct testing. */
export function sharedNodeId(a: RoadEdge, b: RoadEdge): number | undefined {
  if (a.from === b.from || a.from === b.to) return a.from;
  if (a.to === b.from || a.to === b.to) return a.to;
  return undefined;
}

/** Linearly interpolates between two lng/lat points at fraction `t` (0 = `from`, 1 = `to`) — used
 * once per leg terminus, at route-geometry build time, to place a route's clipped end exactly at a
 * mid-edge stop's `edgeT` fraction instead of snapping to that edge's node. Pure — exported for
 * direct testing. Never called on the per-frame draw path (see `getLineWaypoints`'s cache below),
 * so the small tuple allocation here is fine even though the hot draw path itself never allocates. */
export function lerpLngLat(from: LngLat, to: LngLat, t: number): LngLat {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/** The point a route should pass through at one end of `edge` (named `edgeId`, since edges are
 * looked up by id elsewhere and this avoids a second lookup): `stop`'s exact `edgeT` position on
 * this edge if `stop` is actually anchored to it, otherwise `fallbackNodeId`'s node position (an
 * internal joint between two edges, which has no stop and needs no clipping — or a degrade when
 * the expected stop is missing/mismatched, matching this file's existing "skip, don't throw"
 * idiom for a caller bug rather than a player-reachable state). */
function edgeTerminusPoint(
  edge: RoadEdge,
  edgeId: number,
  stop: Stop | undefined,
  fallbackNodeId: number,
  nodeIndex: ReadonlyMap<number, RoadNode>,
): LngLat | undefined {
  if (stop && stop.edgeId === edgeId) {
    const fromNode = nodeIndex.get(edge.from);
    const toNode = nodeIndex.get(edge.to);
    if (!fromNode || !toNode) return undefined;
    return lerpLngLat(fromNode.pos, toNode.pos, stop.edgeT);
  }
  return nodeIndex.get(fallbackNodeId)?.pos;
}

/**
 * Appends one leg's ordered lng/lat waypoints to `out`: `fromStop`'s exact clipped position on the
 * leg's first edge, the shared node at every edge-to-edge joint in between, and `toStop`'s exact
 * clipped position on the last edge — never a raw edge endpoint at either terminus. A single-edge
 * leg (`fromStop`/`toStop` on the same edge) pushes just its two clipped points, a straight
 * sub-segment of that one edge. Degrades edge-by-edge — a missing edge/node in `cache`, or two
 * consecutive edges that turn out not to share a node — by skipping or falling back to that edge's
 * own far endpoint rather than throwing mid-frame, matching every other lookup in this module.
 * Pure and canvas-free — exported for direct testing (the regression test for this bug fix).
 */
export function buildLegWaypoints(
  leg: RouteLeg,
  fromStop: Stop | undefined,
  toStop: Stop | undefined,
  edgeIndex: ReadonlyMap<number, RoadEdge>,
  nodeIndex: ReadonlyMap<number, RoadNode>,
  out: LngLat[],
): void {
  const edgeIds = leg.edgeIds;
  const n = edgeIds.length;
  for (let i = 0; i < n; i++) {
    const edgeId = edgeIds[i]!;
    const edge = edgeIndex.get(edgeId);
    if (!edge) continue;
    const isLast = i === n - 1;

    if (i === 0) {
      const entry = edgeTerminusPoint(edge, edgeId, fromStop, edge.from, nodeIndex);
      if (entry) out.push(entry);
    }

    if (isLast) {
      const exit = edgeTerminusPoint(edge, edgeId, toStop, edge.to, nodeIndex);
      if (exit) out.push(exit);
    } else {
      const nextEdge = edgeIndex.get(edgeIds[i + 1]!);
      const shared = nextEdge ? sharedNodeId(edge, nextEdge) : undefined;
      // Degrade: no shared node found between consecutive edges (data inconsistency — should
      // never happen for a leg `routeLeg` actually built) — fall back to this edge's own far
      // endpoint rather than dropping the joint entirely.
      const jointNodeId = shared !== undefined ? shared : edge.to;
      const joint = nodeIndex.get(jointNodeId);
      if (joint) out.push(joint.pos);
    }
  }
}

/** Looks up a stop by id against either shape `drawLineRoute` receives it in: the caller-owned
 * top-level `stopsById` map (confirmed lines) or a draft's own small `stops` array (`Draft.stops`
 * still nests full `Stop` objects — see `game/lines/types.ts`'s module comment for why). Only ever
 * called from `getLineWaypoints`'s cache-miss branch below — i.e. rebuilding one line's geometry
 * after an actual stop/leg edit, never on the per-frame hot path — so a linear scan for the array
 * case is fine. */
/** Explicit type predicate (not a bare `Array.isArray(source)` check) so both branches below
 * narrow cleanly — `Array.isArray`'s built-in `any[]` predicate doesn't exclude `ReadonlyMap` from
 * the union in the negative branch the way a custom `is` predicate does. */
function isStopArray(source: ReadonlyMap<StopId, Stop> | readonly Stop[]): source is readonly Stop[] {
  return Array.isArray(source);
}

function resolveStop(source: ReadonlyMap<StopId, Stop> | readonly Stop[], id: StopId): Stop | undefined {
  if (isStopArray(source)) {
    for (const stop of source) {
      if (stop.id === id) return stop;
    }
    return undefined;
  }
  return source.get(id);
}

/** Per-line route geometry (lng/lat waypoints per leg), cached by `legs` array identity — the same
 * WeakMap-by-object-identity idiom `lineColorCache`/`cityCache` above already use. This codebase
 * treats a `Line`'s (and a `Draft`'s) `legs` as immutable: every stop/leg edit produces a new
 * `legs` array rather than mutating one in place (`draft.ts` returns a new `DraftState` per call;
 * `App.tsx`'s save-format §5 line collection is rebuilt the same way), so a cache hit here reliably
 * means "this line has not changed since last frame" and a miss means it just did — exactly the
 * moment it's safe to pay for edge/stop lookups and the two clipped-terminus tuple allocations,
 * since the per-frame draw path (`drawLineRoute` below) never does either. */
const legWaypointsCache = new WeakMap<readonly RouteLeg[], readonly (readonly LngLat[])[]>();

function getLineWaypoints(
  legs: readonly RouteLeg[],
  stopsSource: ReadonlyMap<StopId, Stop> | readonly Stop[],
  cache: RenderCache,
): readonly (readonly LngLat[])[] {
  let perLeg = legWaypointsCache.get(legs);
  if (!perLeg) {
    perLeg = legs.map((leg) => {
      const waypoints: LngLat[] = [];
      buildLegWaypoints(
        leg,
        resolveStop(stopsSource, leg.fromStopId),
        resolveStop(stopsSource, leg.toStopId),
        cache.edgeIndex,
        cache.nodeIndex,
        waypoints,
      );
      return waypoints;
    });
    legWaypointsCache.set(legs, perLeg);
  }
  return perLeg;
}

/** Strokes every leg's clipped waypoints as one continuous path + one `stroke()` call, matching
 * `drawCity`'s one-call-per-layer discipline — a line's legs are always contiguous (`leg[i].
 * toStopId === leg[i + 1].fromStopId` by construction, see `game/lines/types.ts`'s `Line.legs`
 * doc comment), so the whole line is drawn as a single subpath rather than per-edge islands; that
 * also gives `lineJoin: 'round'` a real joint to round at every intermediate stop, not just a pair
 * of overlapping round caps. Geometry itself is resolved once per line by `getLineWaypoints`
 * (cached — see its own comment) and clipped to each terminus stop's exact position, not the
 * raw edge nodes either end happens to touch — see this section's module comment for the bug this
 * fixes. `busPositionAt` (via `drawBuses` below) is the thing that places a bus exactly; this is
 * just the infrastructure line under it. */
function drawLineRoute(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  cache: RenderCache,
  legs: readonly RouteLeg[],
  stopsSource: ReadonlyMap<StopId, Stop> | readonly Stop[],
  color: string,
): void {
  if (legs.length === 0) return;

  const perLeg = getLineWaypoints(legs, stopsSource, cache);

  ctx.beginPath();
  let started = false;
  for (const waypoints of perLeg) {
    for (const point of waypoints) {
      const p = viewport.project(point[0], point[1], scratchA);
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
  }
  if (!started) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = routeWidthPx(viewport);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// ── Stops ────────────────────────────────────────────────────────────────────

/** Adds one stop's marker circle to the currently-open path. Returns true so callers can track
 * whether anything was actually added without a separate length check. */
function addStopToPath(ctx: CanvasRenderingContext2D, viewport: Viewport, stop: Stop, radiusPx: number): boolean {
  const p = viewport.project(stop.position[0], stop.position[1], scratchA);
  ctx.moveTo(p.x + radiusPx, p.y);
  ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
  return true;
}

/** Batches every stop from every line, plus the draft's own stops, into one path + one fill +
 * one stroke — never a per-stop draw call, and never an intermediate array of stops (would
 * allocate every frame once buses are moving). Stops are shared infrastructure, not per-line
 * colored — two lines sharing a physical stop just draw the same marker twice in the same style,
 * which is visually identical to drawing it once. */
function drawStops(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  palette: PaperPalette,
  lines: readonly Line[] | undefined,
  stopsById: ReadonlyMap<StopId, Stop>,
  draftStops: readonly Stop[] | undefined,
): void {
  const radiusPx = stopRadiusPx(viewport.zoom);

  ctx.beginPath();
  let drewAny = false;
  if (lines) {
    for (const line of lines) {
      for (const stopId of line.stopIds) {
        const stop = stopsById.get(stopId);
        // A line whose stopIds outrun the caller's collection is a caller bug (stopsById should
        // always be a superset of every drawn line's stops), not a player-reachable state — skip
        // it and keep drawing the rest rather than throwing mid-frame.
        if (stop === undefined) continue;
        drewAny = addStopToPath(ctx, viewport, stop, radiusPx) || drewAny;
      }
    }
  }
  if (draftStops) {
    for (const stop of draftStops) {
      drewAny = addStopToPath(ctx, viewport, stop, radiusPx) || drewAny;
    }
  }
  if (!drewAny) return;

  ctx.fillStyle = palette.panel;
  ctx.fill();
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = STOP_OUTLINE_WIDTH_PX;
  ctx.stroke();
}

// ── Draft rubber band ────────────────────────────────────────────────────────

/** The dashed segment from the draft's last placed stop to the current hover position — the
 * single most important piece of feedback in the line-drawing flow (it's the only thing that
 * shows where the *next* stop would land before the player commits to it). No-op with fewer than
 * one placed stop or no hover position. */
function drawRubberBand(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  color: string,
  draft: Draft,
  hoverLngLat: LngLat | undefined,
): void {
  if (!hoverLngLat) return;
  const lastStop = draft.stops[draft.stops.length - 1];
  if (!lastStop) return;

  const p0 = viewport.project(lastStop.position[0], lastStop.position[1], scratchA);
  const p1 = viewport.project(hoverLngLat[0], hoverLngLat[1], scratchB);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  // `setLineDash` doesn't mutate its argument — the cast (not a spread) avoids allocating a copy
  // of the tunable pattern array every call, matching `drawCity.ts`'s `drawMask`.
  ctx.setLineDash(DRAFT_RUBBER_BAND_DASH_PATTERN as number[]);
  ctx.strokeStyle = color;
  ctx.lineWidth = DRAFT_RUBBER_BAND_WIDTH_PX;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

// ── Buses ────────────────────────────────────────────────────────────────────

/** One bus per `busPositionAt` call, oriented triangle body in the "brand" color, outlined in
 * `--ink` (the same fill-plus-stroke idiom `drawStops` uses — see `BUS_STROKE_WIDTH_RATIO`'s doc
 * comment for why the outline is what actually makes the marker read against paper and roads,
 * not just the fill), plus a full-length centerline stripe tinted from the line's color (SPEC,
 * `studio/GAME.md`: "Buses wear the company brand color with a full-length stripe in the line's
 * color") via `getBusStripeColor`, *not* the raw `getLineColor` the route itself is stroked in —
 * see `BUS_STRIPE_CONTRAST_MIX_T`'s doc comment for why: identical colors is exactly what let a
 * bus camouflage into its own route. Reuses `busPositionScratch` and `busMarkerScratch` across
 * every bus, every line, every frame — never allocates in this loop. */
function drawBuses(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  palette: PaperPalette,
  schedules: readonly LineBusSchedule[],
  totalMinutes: number,
): void {
  const bodyColor = getBusBodyColor(palette);
  // Computed once per draw call (not per bus) — `viewport` doesn't change mid-call, and this
  // keeps the per-bus loop below to pure arithmetic on already-clamped numbers.
  const lengthPx = busMarkerLengthPx(viewport);
  const widthPx = busMarkerWidthPx(viewport);
  const strokeWidthPx = busStrokeWidthPx(widthPx);

  for (const entry of schedules) {
    if (entry.busCount <= 0) continue;
    const stripeColor = getBusStripeColor(palette, entry.lineId);

    for (let busIndex = 0; busIndex < entry.busCount; busIndex++) {
      const pos = busPositionAt(entry.schedule, busIndex, entry.busCount, totalMinutes, busPositionScratch);
      if (!pos) continue; // outside service hours

      const center = viewport.project(pos.lngLat[0], pos.lngLat[1], scratchA);
      const marker = computeBusMarkerPoints(center.x, center.y, pos.bearing, lengthPx, widthPx, busMarkerScratch);

      ctx.beginPath();
      ctx.moveTo(marker.tipX, marker.tipY);
      ctx.lineTo(marker.leftX, marker.leftY);
      ctx.lineTo(marker.rightX, marker.rightY);
      ctx.closePath();
      ctx.fillStyle = bodyColor;
      ctx.fill();
      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = strokeWidthPx;
      ctx.lineJoin = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo((marker.leftX + marker.rightX) / 2, (marker.leftY + marker.rightY) / 2);
      ctx.lineTo(marker.tipX, marker.tipY);
      ctx.strokeStyle = stripeColor;
      ctx.lineWidth = BUS_STRIPE_WIDTH_PX;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Draws every gameplay overlay supplied in `options`. Draws nothing at all if every field is
 * absent (no basemap change), and draws only the pieces it's actually given otherwise — a caller
 * with just `lines` gets routes and stops but no draft or buses.
 */
export function drawOverlays(
  ctx: CanvasRenderingContext2D,
  city: City,
  viewport: Viewport,
  options: DrawOverlaysOptions,
): void {
  const { lines, stops, schedules, draft, hoverLngLat, totalMinutes } = options;
  const hasLines = lines !== undefined && lines.length > 0;
  const hasDraft = draft !== undefined && draft.stops.length > 0;
  const hasSchedules = schedules !== undefined && schedules.length > 0 && totalMinutes !== undefined;
  if (!hasLines && !hasDraft && !hasSchedules) return;

  const palette = readPaperPalette();
  const cache = getRenderCache(city);

  if (hasLines) {
    const stopsSource = stops ?? EMPTY_STOPS_MAP;
    for (const line of lines) {
      drawLineRoute(ctx, viewport, cache, line.legs, stopsSource, getLineColor(palette, line.id));
    }
  }

  if (hasDraft) {
    // Preview the draft in the color it will actually take once created — the next unused line
    // id, i.e. how many lines already exist — rather than an arbitrary "drafting" color, so the
    // confirmed portion honestly previews what the player is about to commit to.
    const draftLineId = lines ? lines.length : 0;
    const draftColor = getLineColor(palette, draftLineId);
    // `Draft.stops` still nests full `Stop` objects (see `game/lines/types.ts`) — passed directly
    // rather than adapted into a `Map`, since `resolveStop` only ever needs it on a cache-miss
    // rebuild (rare — see `getLineWaypoints`'s comment), so a per-frame `Map` build is never paid.
    drawLineRoute(ctx, viewport, cache, draft.legs, draft.stops, draftColor);
    drawRubberBand(ctx, viewport, draftColor, draft, hoverLngLat);
  }

  if (hasLines || hasDraft) {
    drawStops(ctx, viewport, palette, lines, stops ?? EMPTY_STOPS_MAP, hasDraft ? draft.stops : undefined);
  }

  if (hasSchedules) {
    drawBuses(ctx, viewport, palette, schedules, totalMinutes);
  }
}
