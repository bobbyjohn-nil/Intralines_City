/**
 * Road and route ribbons — ground-hugging world-space geometry with screen-space-floored width,
 * built once per city (roads) or per line (routes) and only ever *resized* (never rebuilt) on
 * zoom change. Uses three.js's own `Line2`/`LineMaterial` ("fat lines") in `worldUnits: true` mode:
 * true-metre width at typical zoom, clamped up to a pixel floor so a road/route class never
 * disappears zoomed out — renderer-3d.md §2's "Width is resolved in the vertex shader against a
 * pixel target" is exactly what `LineMaterial` already does; this module just supplies the right
 * `linewidth` (in metres) for the current `pxPerM`.
 */

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { RoadClass, RoadEdge, RoadNode } from '../../game/types';
import type { LngLat } from '../../game/types';
import type { LocalOrigin } from './localProjection';
import { toLocalXZ } from './localProjection';
import {
  DRAFT_RUBBER_BAND_DASH_PATTERN,
  DRAFT_RUBBER_BAND_WIDTH_PX,
  ROAD_DRAW_ORDER,
  ROAD_MIN_WIDTH_PX,
  ROAD_WIDTH_M,
  ROUTE_WIDTH_MULTIPLIER,
} from '../style';
import { Y_ROUTE, Y_ROAD } from './constants';

/** True-metre width, floored so it never renders thinner than its screen-pixel legibility floor —
 * the exact "true-scale, then clamp up to a floor" idiom `style.ts`'s Canvas-era comments
 * describe, just computed in metres (for a world-space mesh) instead of pixels (for a Canvas
 * stroke). */
function effectiveWidthM(trueWidthM: number, floorPx: number, pxPerM: number): number {
  return Math.max(trueWidthM, floorPx / pxPerM);
}

// ── Roads ────────────────────────────────────────────────────────────────────

export interface RoadLayer {
  readonly group: THREE.Group;
  readonly byClass: ReadonlyMap<RoadClass, { readonly line: LineSegments2; readonly material: LineMaterial }>;
}

export function buildRoadLayer(
  roadBuckets: ReadonlyMap<RoadClass, readonly RoadEdge[]>,
  nodeIndex: ReadonlyMap<number, RoadNode>,
  origin: LocalOrigin,
  colorForClass: (roadClass: RoadClass) => string,
): RoadLayer {
  const group = new THREE.Group();
  const byClass = new Map<RoadClass, { line: LineSegments2; material: LineMaterial }>();
  const scratch: [number, number] = [0, 0];

  for (const roadClass of ROAD_DRAW_ORDER) {
    const edges = roadBuckets.get(roadClass) ?? [];
    const positions: number[] = [];
    for (const edge of edges) {
      const fromNode = nodeIndex.get(edge.from);
      const toNode = nodeIndex.get(edge.to);
      if (!fromNode || !toNode) continue;
      const [x0, z0] = toLocalXZ(origin, fromNode.pos, scratch);
      positions.push(x0, Y_ROAD, z0);
      const [x1, z1] = toLocalXZ(origin, toNode.pos, scratch);
      positions.push(x1, Y_ROAD, z1);
    }
    if (positions.length === 0) continue;

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color: colorForClass(roadClass),
      worldUnits: true,
      linewidth: ROAD_WIDTH_M[roadClass],
      resolution: new THREE.Vector2(1, 1),
    });
    const line = new LineSegments2(geometry, material);
    line.computeLineDistances();
    group.add(line);
    byClass.set(roadClass, { line, material });
  }

  return { group, byClass };
}

/** Recomputes every road class's world-space `linewidth` from the current `pxPerM` — on zoom
 * change only (see this module's doc comment), never per animation frame. */
export function updateRoadWidths(layer: RoadLayer, pxPerM: number): void {
  for (const [roadClass, { material }] of layer.byClass) {
    material.linewidth = effectiveWidthM(ROAD_WIDTH_M[roadClass], ROAD_MIN_WIDTH_PX[roadClass], pxPerM);
  }
}

export function updateLineResolution(materials: Iterable<LineMaterial>, widthPx: number, heightPx: number): void {
  for (const material of materials) {
    material.resolution.set(widthPx, heightPx);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────
// Route width: `ROUTE_WIDTH_MULTIPLIER` times the rendered (floored) motorway width — same rule
// `routeWidthPx` encoded for Canvas, now expressed in metres for a world-space ribbon.

export function routeWidthM(pxPerM: number): number {
  const motorwayWidthM = effectiveWidthM(ROAD_WIDTH_M.motorway, ROAD_MIN_WIDTH_PX.motorway, pxPerM);
  return motorwayWidthM * ROUTE_WIDTH_MULTIPLIER;
}

export interface RouteRibbon {
  readonly line: Line2;
  readonly material: LineMaterial;
}

export function buildRouteRibbon(polyline: readonly LngLat[], origin: LocalOrigin, color: string): RouteRibbon | null {
  if (polyline.length < 2) return null;
  const positions: number[] = [];
  const scratch: [number, number] = [0, 0];
  for (const point of polyline) {
    const [x, z] = toLocalXZ(origin, point, scratch);
    positions.push(x, Y_ROUTE, z);
  }
  const geometry = new LineGeometry();
  geometry.setPositions(positions);
  const material = new LineMaterial({
    color,
    worldUnits: true,
    linewidth: 1,
    resolution: new THREE.Vector2(1, 1),
  });
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  return { line, material };
}

/** Recomputes a route ribbon's world-space width from the current `pxPerM` — on zoom change only. */
export function updateRouteWidth(ribbon: RouteRibbon, pxPerM: number): void {
  ribbon.material.linewidth = routeWidthM(pxPerM);
}

// ── Draft rubber band ────────────────────────────────────────────────────────
// The dashed preview segment from the draft's last placed stop to the cursor — same idiom as the
// out-of-bounds boundary (`maskLayer.ts`), a dashed `Line2` with world-space dash/gap/width so it
// stays legible at every zoom instead of a fixed pixel stroke.

export interface RubberBand {
  readonly line: Line2;
  readonly material: LineMaterial;
}

export function buildRubberBand(color: string): RubberBand {
  const geometry = new LineGeometry();
  geometry.setPositions([0, 0, 0, 0, 0, 0]);
  const material = new LineMaterial({
    color,
    worldUnits: true,
    linewidth: DRAFT_RUBBER_BAND_WIDTH_PX,
    dashed: true,
    dashSize: DRAFT_RUBBER_BAND_DASH_PATTERN[0] ?? 5,
    gapSize: DRAFT_RUBBER_BAND_DASH_PATTERN[1] ?? 4,
    resolution: new THREE.Vector2(1, 1),
  });
  const line = new Line2(geometry, material);
  line.visible = false;
  return { line, material };
}

export function updateRubberBand(
  band: RubberBand,
  from: LngLat,
  to: LngLat,
  origin: LocalOrigin,
  pxPerM: number,
  color: string,
): void {
  const scratch: [number, number] = [0, 0];
  const [x0, z0] = toLocalXZ(origin, from, scratch);
  const [x1, z1] = toLocalXZ(origin, to, [0, 0]);
  band.line.geometry.setPositions([x0, Y_ROUTE, z0, x1, Y_ROUTE, z1]);
  band.line.computeLineDistances();
  band.material.linewidth = DRAFT_RUBBER_BAND_WIDTH_PX / pxPerM;
  band.material.dashSize = (DRAFT_RUBBER_BAND_DASH_PATTERN[0] ?? 5) / pxPerM;
  band.material.gapSize = (DRAFT_RUBBER_BAND_DASH_PATTERN[1] ?? 4) / pxPerM;
  band.material.color.set(color);
  band.line.visible = true;
}
