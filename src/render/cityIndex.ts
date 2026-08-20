/**
 * Per-city derived data, cached by object identity — node/edge lookups, roads bucketed by class,
 * and precomputed bounding boxes for water/park polygons. Renderer-agnostic (no Canvas, no
 * three.js): the Canvas 2D basemap used this to avoid rebuilding a lookup every frame, and the
 * WebGL scene builder (`three/cityGeometry.ts`) needs the exact same lookups to build its static
 * meshes and to resolve a `RouteLeg.edgeIds` chain against the same node/edge indices — see
 * `routeGeometry.ts`.
 */

import type { Bounds, City, Polygon, RoadClass, RoadEdge, RoadNode } from '../game/types';
import { ROAD_DRAW_ORDER } from './style';

export interface RenderCache {
  readonly nodeIndex: ReadonlyMap<number, RoadNode>;
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
