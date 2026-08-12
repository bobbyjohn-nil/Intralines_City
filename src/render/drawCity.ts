/**
 * The offline/demo basemap renderer — "a fully self-rendered basemap built from the city pack
 * itself: streets by class, water, parks" (manual §6). Canvas 2D, no dependency.
 *
 * Draw order (back to front): water -> parks -> streets by class, lightest to heaviest -> the
 * time-of-day tint. That's what `drawCity` itself draws. Gameplay overlays (routes, stops, the
 * draft, buses — `drawOverlays.ts`, owned by the renderer, not this module) and the
 * out-of-bounds mask + dashed boundary (`drawMask`, exported below) both come after this, in that
 * order — `MapCanvas` is the one place that knows the full sequence and calls all three. No text
 * is drawn on the map anywhere in that stack — the manual is explicit that the map shows shapes
 * and panels show numbers.
 *
 * Performance contract: off-screen geometry is culled before it is projected, per-city derived
 * data (node lookup, edge lookup, road buckets, scenery bounding boxes) is built once and cached
 * by object identity (`getRenderCache`, exported so `drawOverlays.ts` can resolve the same
 * `RouteLeg.edgeIds` against the same node/edge lookups without rebuilding them), and each road
 * class is drawn as a single path + single `stroke()` call rather than one call per edge.
 */

import type { Bounds, City, Polygon, RoadClass, RoadEdge, RoadNode } from '../game/types';
import { readPaperPalette, mixHex, mixHexAlpha, withAlpha, type PaperPalette } from './paperPalette';
import type { ScreenPoint } from './projection';
import { Viewport } from './projection';
import {
  CULL_MARGIN_PX,
  MASK_ALPHA,
  MASK_DASH_PATTERN,
  MASK_DASH_WIDTH_PX,
  PARK_ALPHA,
  PARK_COLOR_MIX_T,
  ROAD_COLOR_MIX,
  ROAD_DRAW_ORDER,
  ROAD_MIN_WIDTH_PX,
  ROAD_WIDTH_M,
  WATER_ALPHA,
} from './style';
import { getTimeOfDayTint } from './timeOfDay';

// ── Per-city derived data, cached by object identity ────────────────────────

export interface RenderCache {
  readonly nodeIndex: ReadonlyMap<number, RoadNode>;
  /** Edge lookup by id — not needed by this module (road buckets are enough for drawing the
   * basemap itself) but built once here anyway so `drawOverlays.ts` can resolve a
   * `RouteLeg.edgeIds` chain against the same cache, keyed on the same `City` identity, rather
   * than building its own duplicate index. */
  readonly edgeIndex: ReadonlyMap<number, RoadEdge>;
  readonly roadBuckets: ReadonlyMap<RoadClass, readonly RoadEdge[]>;
  readonly waterBounds: readonly Bounds[];
  readonly parkBounds: readonly Bounds[];
}

const cityCache = new WeakMap<City, RenderCache>();

function computePolygonBounds(polygon: Polygon): Bounds {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lng, lat] of polygon) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, east, south, north };
}

function buildRenderCache(city: City): RenderCache {
  const nodeIndex = new Map<number, RoadNode>();
  for (const node of city.graph.nodes) {
    nodeIndex.set(node.id, node);
  }

  const edgeIndex = new Map<number, RoadEdge>();
  const roadBuckets = new Map<RoadClass, RoadEdge[]>();
  for (const roadClass of ROAD_DRAW_ORDER) {
    roadBuckets.set(roadClass, []);
  }
  for (const edge of city.graph.edges) {
    edgeIndex.set(edge.id, edge);
    roadBuckets.get(edge.roadClass)?.push(edge);
  }

  const waterBounds = city.scenery.water.map(computePolygonBounds);
  const parkBounds = city.scenery.parks.map(computePolygonBounds);

  return { nodeIndex, edgeIndex, roadBuckets, waterBounds, parkBounds };
}

export function getRenderCache(city: City): RenderCache {
  let cache = cityCache.get(city);
  if (!cache) {
    cache = buildRenderCache(city);
    cityCache.set(city, cache);
  }
  return cache;
}

// ── Per-theme derived data (road colors), cached by palette object identity ─

const roadColorCache = new WeakMap<PaperPalette, readonly string[]>();

function getRoadColors(palette: PaperPalette): readonly string[] {
  let colors = roadColorCache.get(palette);
  if (!colors) {
    colors = ROAD_DRAW_ORDER.map((roadClass) =>
      mixHex(palette.ink, palette.muted, ROAD_COLOR_MIX[roadClass]),
    );
    roadColorCache.set(palette, colors);
  }
  return colors;
}

// ── Reusable scratch objects — the draw loop never allocates ────────────────

const scratchA: ScreenPoint = { x: 0, y: 0 };
const scratchB: ScreenPoint = { x: 0, y: 0 };

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

/** True if both projected endpoints fall outside the padded canvas rect. Cheap 2-point cull. */
function edgeIsOffscreen(p0: ScreenPoint, p1: ScreenPoint, width: number, height: number): boolean {
  const xMin = p0.x < p1.x ? p0.x : p1.x;
  const xMax = p0.x > p1.x ? p0.x : p1.x;
  if (xMax < -CULL_MARGIN_PX || xMin > width + CULL_MARGIN_PX) return true;
  const yMin = p0.y < p1.y ? p0.y : p1.y;
  const yMax = p0.y > p1.y ? p0.y : p1.y;
  if (yMax < -CULL_MARGIN_PX || yMin > height + CULL_MARGIN_PX) return true;
  return false;
}

export function drawCity(
  ctx: CanvasRenderingContext2D,
  city: City,
  viewport: Viewport,
  minuteOfDay?: number,
): void {
  const { width, height } = viewport;
  const palette = readPaperPalette();
  const cache = getRenderCache(city);
  const roadColors = getRoadColors(palette);
  const visible = viewport.visibleLngLatBounds(CULL_MARGIN_PX);
  const scale = viewport.scale();

  // Erase. The canvas retains last frame's pixels otherwise.
  ctx.fillStyle = palette.paper;
  ctx.fillRect(0, 0, width, height);

  // ── Water ──────────────────────────────────────────────────────────────
  drawPolygonLayer(
    ctx,
    viewport,
    city.scenery.water,
    cache.waterBounds,
    visible,
    withAlpha(palette.blue, WATER_ALPHA),
  );

  // ── Parks ──────────────────────────────────────────────────────────────
  // Mixed toward `--muted` before alpha, not pure amber-over-paper — see `PARK_COLOR_MIX_T`'s
  // comment in style.ts: pure amber is nearly paper's own lightness, so no alpha of it alone
  // separates a park from the page it's printed on.
  drawPolygonLayer(
    ctx,
    viewport,
    city.scenery.parks,
    cache.parkBounds,
    visible,
    mixHexAlpha(palette.amber, palette.muted, PARK_COLOR_MIX_T, PARK_ALPHA),
  );

  // ── Streets, lightest class first so heavier classes paint on top ───────
  for (let i = 0; i < ROAD_DRAW_ORDER.length; i++) {
    const roadClass = ROAD_DRAW_ORDER[i]!;
    const edges = cache.roadBuckets.get(roadClass);
    if (!edges || edges.length === 0) continue;

    const widthM = ROAD_WIDTH_M[roadClass];
    const minWidthPx = ROAD_MIN_WIDTH_PX[roadClass];
    const widthPx = Math.max(minWidthPx, widthM * scale);

    ctx.beginPath();
    let drewAny = false;
    for (const edge of edges) {
      const fromNode = cache.nodeIndex.get(edge.from);
      const toNode = cache.nodeIndex.get(edge.to);
      if (!fromNode || !toNode) continue;
      const p0 = viewport.project(fromNode.pos[0], fromNode.pos[1], scratchA);
      const p1 = viewport.project(toNode.pos[0], toNode.pos[1], scratchB);
      if (edgeIsOffscreen(p0, p1, width, height)) continue;
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      drewAny = true;
    }
    if (drewAny) {
      ctx.strokeStyle = roadColors[i]!;
      ctx.lineWidth = widthPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  // ── Time-of-day tint, composited after the basemap so the whole basemap (not just streets)
  // shifts with it. Absent minuteOfDay = neutral day, no overlay drawn at all. SPEC (manual §6):
  // "The map tints with the time of day". Gameplay overlays and the out-of-bounds mask are drawn
  // after this by the caller — see this module's doc comment — so the masked area stays neutral
  // grey and the dashed boundary stays legible on top of everything, tint included.
  if (minuteOfDay !== undefined) {
    const tint = getTimeOfDayTint(minuteOfDay, palette);
    if (tint.alpha > 0) {
      ctx.fillStyle = tint.color;
      ctx.fillRect(0, 0, width, height);
    }
  }
}

/** Projects and fills a polygon layer (water or parks) as one path, one `fill()` call. */
function drawPolygonLayer(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  polygons: readonly Polygon[],
  polygonBounds: readonly Bounds[],
  visible: Bounds,
  fillStyle: string,
): void {
  ctx.beginPath();
  let drewAny = false;
  for (let i = 0; i < polygons.length; i++) {
    const bounds = polygonBounds[i];
    const polygon = polygons[i];
    if (!bounds || !polygon || polygon.length < 3) continue;
    if (!boundsIntersect(bounds, visible)) continue;
    drewAny = true;
    for (let v = 0; v < polygon.length; v++) {
      const vertex = polygon[v]!;
      const p = viewport.project(vertex[0], vertex[1], scratchA);
      if (v === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }
  if (drewAny) {
    ctx.fillStyle = fillStyle;
    ctx.fill('evenodd');
  }
}

/**
 * The grey out-of-bounds mask and dashed playable-area boundary. Exported and called separately
 * by `MapCanvas` (last, after `drawCity` and `drawOverlays`) rather than from inside `drawCity` —
 * see this module's doc comment for why the mask has to be the very last thing painted.
 */
export function drawMask(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  bounds: Bounds,
  palette: PaperPalette,
): void {
  const { width, height } = viewport;
  const nw = viewport.project(bounds.west, bounds.north, scratchA);
  const nwX = nw.x;
  const nwY = nw.y;
  const se = viewport.project(bounds.east, bounds.south, scratchB);
  const rectX = Math.min(nwX, se.x);
  const rectY = Math.min(nwY, se.y);
  const rectW = Math.abs(se.x - nwX);
  const rectH = Math.abs(se.y - nwY);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(rectX, rectY, rectW, rectH);
  ctx.fillStyle = withAlpha(palette.muted, MASK_ALPHA);
  ctx.fill('evenodd');
  ctx.restore();

  ctx.save();
  ctx.setLineDash(MASK_DASH_PATTERN as number[]);
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = MASK_DASH_WIDTH_PX;
  ctx.strokeRect(rectX, rectY, rectW, rectH);
  ctx.restore();
}
