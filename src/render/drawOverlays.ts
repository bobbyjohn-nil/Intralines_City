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

import type { City, LngLat } from '../game/types';
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
  BUS_STRIPE_WIDTH_PX,
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

function routeWidthPx(viewport: Viewport): number {
  const motorwayWidthPx = Math.max(ROAD_MIN_WIDTH_PX.motorway, ROAD_WIDTH_M.motorway * viewport.scale());
  return motorwayWidthPx * ROUTE_WIDTH_MULTIPLIER;
}

/** Strokes every leg's edges as one path + one `stroke()` call, matching `drawCity`'s
 * one-call-per-layer discipline. Draws full edges (not clipped to a stop's fractional position on
 * its first/last edge) — the route is infrastructure, not a precise bus path; `busPositionAt`
 * (via `drawBuses` below) is what places a bus exactly. */
function drawLineRoute(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  cache: RenderCache,
  legs: readonly RouteLeg[],
  color: string,
): void {
  if (legs.length === 0) return;

  ctx.beginPath();
  let drewAny = false;
  for (const leg of legs) {
    for (const edgeId of leg.edgeIds) {
      const edge = cache.edgeIndex.get(edgeId);
      if (!edge) continue;
      const fromNode = cache.nodeIndex.get(edge.from);
      const toNode = cache.nodeIndex.get(edge.to);
      if (!fromNode || !toNode) continue;
      const p0 = viewport.project(fromNode.pos[0], fromNode.pos[1], scratchA);
      const p1 = viewport.project(toNode.pos[0], toNode.pos[1], scratchB);
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      drewAny = true;
    }
  }
  if (!drewAny) return;

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

/** One bus per `busPositionAt` call, oriented triangle body in the "brand" color plus a
 * full-length stripe in the line's color down its centerline (SPEC, `studio/GAME.md`: "Buses
 * wear the company brand color with a full-length stripe in the line's color"). Reuses
 * `busPositionScratch` and `busMarkerScratch` across every bus, every line, every frame — never
 * allocates in this loop. */
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

  for (const entry of schedules) {
    if (entry.busCount <= 0) continue;
    const stripeColor = getLineColor(palette, entry.lineId);

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
    for (const line of lines) {
      drawLineRoute(ctx, viewport, cache, line.legs, getLineColor(palette, line.id));
    }
  }

  if (hasDraft) {
    // Preview the draft in the color it will actually take once created — the next unused line
    // id, i.e. how many lines already exist — rather than an arbitrary "drafting" color, so the
    // confirmed portion honestly previews what the player is about to commit to.
    const draftLineId = lines ? lines.length : 0;
    const draftColor = getLineColor(palette, draftLineId);
    drawLineRoute(ctx, viewport, cache, draft.legs, draftColor);
    drawRubberBand(ctx, viewport, draftColor, draft, hoverLngLat);
  }

  if (hasLines || hasDraft) {
    drawStops(ctx, viewport, palette, lines, stops ?? EMPTY_STOPS_MAP, hasDraft ? draft.stops : undefined);
  }

  if (hasSchedules) {
    drawBuses(ctx, viewport, palette, schedules, totalMinutes);
  }
}
