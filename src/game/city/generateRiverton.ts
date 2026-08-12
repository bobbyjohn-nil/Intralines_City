/**
 * Riverton — the procedurally generated demo city (manual §1, §21).
 *
 * "Demo, Procedurally generated — instant play, no downloads." Everything Riverton needs —
 * streets, water, parks — is generated in-process from a seed; no baked pack, no network.
 * Real cities derive their street graph and scenery from OSM (§21); Riverton stands in for
 * that with a synthetic, non-uniform grid plus a river and a handful of parks.
 *
 * Determinism is the whole point: `generateRiverton(seed)` must return a byte-identical
 * `City` for the same seed, forever. All randomness flows through the seeded `Rng` in
 * `./rng` — never `Math.random()` — and draws happen in a fixed order (grid jitter, then
 * river, then parks) so the call sequence never depends on anything but the seed.
 */

import type { Bounds, City, LngLat, Polygon, RoadClass, RoadEdge, RoadNode, StreetGraph } from '../types';
import { createRng, type Rng } from './rng';

/** The seed the game boots Riverton with by default, so the demo city is stable across sessions. */
export const RIVERTON_SEED = 42;

// ── Geography ────────────────────────────────────────────────────────────────

/** Riverton isn't a real place; this is an arbitrary plains location to center it on. # tune */
const CENTER: LngLat = [-89.4012, 40.7589];

/** Approximate metres per degree of latitude; fine at this scale (a few km). # tune */
const METERS_PER_DEG_LAT = 111_320;
const EARTH_RADIUS_M = 6_371_000;

// ── Street grid ──────────────────────────────────────────────────────────────
// A single non-uniform grid: lines are close together near downtown and spread out toward
// the edges. Because it's one grid (not a coarse grid stitched to a fine one), every node
// has exactly its four neighbours and the graph is trivially fully connected — no T-junction
// stitching required.

/** Grid lines per axis. Odd, so there's a true centre line downtown. # tune */
const GRID_LINE_COUNT = 17;
/** Gap between adjacent grid lines right downtown, metres. # tune */
const DOWNTOWN_GAP_M = 180;
/** Gap between adjacent grid lines at the city's edge, metres. # tune */
const OUTER_GAP_M = 700;
/** How sharply the grid opens up from downtown to the edge. # tune */
const GAP_POWER = 1.6;
/** Per-node position jitter so the grid doesn't look like graph paper, metres. # tune */
const NODE_JITTER_M = 0;

/** Grid-line distance from centre (in line-index units) that still counts as primary. # tune */
const PRIMARY_MAX_LINE_DIST = 1;
/** ...secondary. # tune */
const SECONDARY_MAX_LINE_DIST = 2;
/** ...tertiary. Everything further out is residential. # tune */
const TERTIARY_MAX_LINE_DIST = 3;

/** Padding added around the generated street grid to form the playable bounds, metres. # tune */
const BOUNDS_MARGIN_M = 250;

// ── River ────────────────────────────────────────────────────────────────────
// The street grid does not react to the river — per spec, edges that cross it are simply
// bridges. It only needs to (a) actually cross the map and (b) not disconnect anything,
// and since we never remove edges for the river, (b) is automatic.

const RIVER_WIDTH_M = 90; // tune
const RIVER_AMPLITUDE_BASE_M = 450; // tune
const RIVER_AMPLITUDE_JITTER = 0.3; // tune — fractional +/- on the amplitude
const RIVER_FREQUENCY = 1.3; // tune — sine cycles across the map span
/** How far past the grid's edge the river polygon extends, so it visibly runs off-map. # tune */
const RIVER_MARGIN_M = 500;
const RIVER_SAMPLES = 28; // tune

// ── Parks ────────────────────────────────────────────────────────────────────

const PARK_MIN_COUNT = 2; // tune
const PARK_MAX_COUNT = 4; // tune
const PARK_MIN_RADIUS_M = 70; // tune
const PARK_MAX_RADIUS_M = 200; // tune
const PARK_SIDES = 9; // tune — vertices per park, for a rounded, non-rectangular blob
const PARK_RADIUS_JITTER = 0.22; // tune — fractional +/- per vertex
/** Park centres are placed within this fraction of the grid's half-extent, to stay clear of the edge. # tune */
const PARK_PLACEMENT_FRACTION = 0.85;

// ── Small helpers ────────────────────────────────────────────────────────────

/** Indexes an array, throwing instead of silently returning `undefined` — this is generation-time
 * code and an out-of-bounds index here means the algorithm is broken, not a player-facing edge case. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) {
    throw new Error(`generateRiverton: index ${i} out of bounds (length ${arr.length})`);
  }
  return v;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Projects local metres (relative to `CENTER`) to lng/lat. Flat-earth approximation, fine for a ~6km city. */
function metersToLngLat(xM: number, yM: number): LngLat {
  const [lng0, lat0] = CENTER;
  const latRad = toRad(lat0);
  const dLat = yM / METERS_PER_DEG_LAT;
  const dLng = xM / (METERS_PER_DEG_LAT * Math.cos(latRad));
  return [lng0 + dLng, lat0 + dLat];
}

/** Great-circle distance between two lng/lat points, metres. */
function haversineMeters(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLambda = Math.sin(dLambda / 2);
  const h = sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Street grid generation ───────────────────────────────────────────────────

/** Positions (metres, relative to centre) for one axis of grid lines: dense downtown, sparse at the edge. */
function buildAxisPositions(): number[] {
  const gapCount = GRID_LINE_COUNT - 1;
  const centerIdx = (GRID_LINE_COUNT - 1) / 2;
  const maxDist = centerIdx + 0.5;
  const gaps: number[] = [];
  for (let k = 0; k < gapCount; k++) {
    const gapCenter = k + 0.5;
    const dist = Math.abs(gapCenter - centerIdx);
    const t = dist / maxDist;
    gaps.push(DOWNTOWN_GAP_M + (OUTER_GAP_M - DOWNTOWN_GAP_M) * Math.pow(t, GAP_POWER));
  }
  const totalWidth = gaps.reduce((sum, g) => sum + g, 0);
  const positions: number[] = [-totalWidth / 2];
  let cursor = -totalWidth / 2;
  for (const gap of gaps) {
    cursor += gap;
    positions.push(cursor);
  }
  return positions;
}

/** Road class for the grid line at `index` out of `GRID_LINE_COUNT`, by distance from the centre line. */
function classifyGridLine(index: number): RoadClass {
  const centerIdx = (GRID_LINE_COUNT - 1) / 2;
  const dist = Math.abs(index - centerIdx);
  if (dist <= PRIMARY_MAX_LINE_DIST) return 'primary';
  if (dist <= SECONDARY_MAX_LINE_DIST) return 'secondary';
  if (dist <= TERTIARY_MAX_LINE_DIST) return 'tertiary';
  return 'residential';
}

function buildStreetGraph(rng: Rng): { graph: StreetGraph; halfExtentM: number } {
  const xs = buildAxisPositions();
  const ys = buildAxisPositions();
  const halfExtentM = at(xs, xs.length - 1);

  const nodeId = (i: number, j: number): number => i * GRID_LINE_COUNT + j;

  const nodes: RoadNode[] = [];
  for (let i = 0; i < GRID_LINE_COUNT; i++) {
    for (let j = 0; j < GRID_LINE_COUNT; j++) {
      const jitterX = rng.range(-NODE_JITTER_M, NODE_JITTER_M);
      const jitterY = rng.range(-NODE_JITTER_M, NODE_JITTER_M);
      const xM = at(xs, i) + jitterX;
      const yM = at(ys, j) + jitterY;
      nodes.push({ id: nodeId(i, j), pos: metersToLngLat(xM, yM) });
    }
  }

  const edges: RoadEdge[] = [];
  let nextEdgeId = 0;

  // Vertical edges: fixed x-line i, connecting consecutive j. Classed by the x-line they run along.
  for (let i = 0; i < GRID_LINE_COUNT; i++) {
    const roadClass = classifyGridLine(i);
    for (let j = 0; j < GRID_LINE_COUNT - 1; j++) {
      const from = nodeId(i, j);
      const to = nodeId(i, j + 1);
      edges.push({
        id: nextEdgeId++,
        from,
        to,
        roadClass,
        lengthM: haversineMeters(at(nodes, from).pos, at(nodes, to).pos),
      });
    }
  }

  // Horizontal edges: fixed y-line j, connecting consecutive i. Classed by the y-line they run along.
  for (let j = 0; j < GRID_LINE_COUNT; j++) {
    const roadClass = classifyGridLine(j);
    for (let i = 0; i < GRID_LINE_COUNT - 1; i++) {
      const from = nodeId(i, j);
      const to = nodeId(i + 1, j);
      edges.push({
        id: nextEdgeId++,
        from,
        to,
        roadClass,
        lengthM: haversineMeters(at(nodes, from).pos, at(nodes, to).pos),
      });
    }
  }

  return { graph: { nodes, edges, adjacency: buildAdjacency(nodes, edges) }, halfExtentM };
}

function buildAdjacency(
  nodes: readonly RoadNode[],
  edges: readonly RoadEdge[]
): ReadonlyMap<number, readonly number[]> {
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    at2(adjacency, edge.from).push(edge.id);
    at2(adjacency, edge.to).push(edge.id);
  }
  return adjacency;
}

function at2(adjacency: Map<number, number[]>, id: number): number[] {
  const list = adjacency.get(id);
  if (list === undefined) {
    throw new Error(`generateRiverton: edge references unknown node ${id}`);
  }
  return list;
}

// ── River ────────────────────────────────────────────────────────────────────

function generateRiver(rng: Rng, halfExtentM: number): Polygon {
  const amplitude = RIVER_AMPLITUDE_BASE_M * (1 + rng.range(-RIVER_AMPLITUDE_JITTER, RIVER_AMPLITUDE_JITTER));
  const phase = rng.range(0, Math.PI * 2);
  const spanM = halfExtentM + RIVER_MARGIN_M;

  const centerline: Array<{ x: number; y: number }> = [];
  for (let s = 0; s <= RIVER_SAMPLES; s++) {
    const x = -spanM + (2 * spanM * s) / RIVER_SAMPLES;
    const y = amplitude * Math.sin((x / halfExtentM) * Math.PI * RIVER_FREQUENCY + phase);
    centerline.push({ x, y });
  }

  const half = RIVER_WIDTH_M / 2;
  const top: LngLat[] = [];
  const bottom: LngLat[] = [];
  for (let s = 0; s < centerline.length; s++) {
    const p = at(centerline, s);
    const prev = at(centerline, Math.max(0, s - 1));
    const next = at(centerline, Math.min(centerline.length - 1, s + 1));
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    top.push(metersToLngLat(p.x + nx * half, p.y + ny * half));
    bottom.push(metersToLngLat(p.x - nx * half, p.y - ny * half));
  }

  return [...top, ...bottom.reverse()];
}

// ── Parks ────────────────────────────────────────────────────────────────────

function generatePark(rng: Rng, halfExtentM: number): Polygon {
  const placementRange = halfExtentM * PARK_PLACEMENT_FRACTION;
  const centerX = rng.range(-placementRange, placementRange);
  const centerY = rng.range(-placementRange, placementRange);
  const baseRadius = rng.range(PARK_MIN_RADIUS_M, PARK_MAX_RADIUS_M);

  const points: LngLat[] = [];
  for (let s = 0; s < PARK_SIDES; s++) {
    const angle = (s / PARK_SIDES) * Math.PI * 2;
    const r = baseRadius * (1 + rng.range(-PARK_RADIUS_JITTER, PARK_RADIUS_JITTER));
    points.push(metersToLngLat(centerX + r * Math.cos(angle), centerY + r * Math.sin(angle)));
  }
  return points;
}

// ── Connectivity ─────────────────────────────────────────────────────────────

/** Line-drawing downstream silently breaks on a disconnected graph, so this must never pass silently. */
function assertConnected(graph: StreetGraph): void {
  if (graph.nodes.length === 0) {
    throw new Error('generateRiverton: no nodes generated');
  }

  const edgeById = new Map<number, RoadEdge>();
  for (const edge of graph.edges) edgeById.set(edge.id, edge);

  const startId = at(graph.nodes, 0).id;
  const visited = new Set<number>([startId]);
  const stack: number[] = [startId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const incidentEdgeIds = graph.adjacency.get(current) ?? [];
    for (const edgeId of incidentEdgeIds) {
      const edge = edgeById.get(edgeId);
      if (!edge) continue;
      const other = edge.from === current ? edge.to : edge.from;
      if (!visited.has(other)) {
        visited.add(other);
        stack.push(other);
      }
    }
  }

  if (visited.size !== graph.nodes.length) {
    throw new Error(
      `generateRiverton: street graph is disconnected — reached ${visited.size} of ${graph.nodes.length} nodes`
    );
  }
}

// ── Bounds ───────────────────────────────────────────────────────────────────

function computeBounds(nodes: readonly RoadNode[]): Bounds {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const node of nodes) {
    const [lng, lat] = node.pos;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  const latRad = toRad(CENTER[1]);
  const marginLngDeg = BOUNDS_MARGIN_M / (METERS_PER_DEG_LAT * Math.cos(latRad));
  const marginLatDeg = BOUNDS_MARGIN_M / METERS_PER_DEG_LAT;

  return {
    west: west - marginLngDeg,
    east: east + marginLngDeg,
    south: south - marginLatDeg,
    north: north + marginLatDeg,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Generates Riverton, the procedural demo city, from a seed. Deterministic: the same seed
 * always produces a byte-identical `City`.
 */
export function generateRiverton(seed: number): City {
  const rng = createRng(seed);

  // Draw order is fixed so the same seed always consumes the RNG the same way: grid jitter,
  // then the river, then parks.
  const { graph, halfExtentM } = buildStreetGraph(rng);
  assertConnected(graph);

  const water = [generateRiver(rng, halfExtentM)];
  const parkCount = rng.int(PARK_MIN_COUNT, PARK_MAX_COUNT);
  const parks: Polygon[] = [];
  for (let i = 0; i < parkCount; i++) parks.push(generatePark(rng, halfExtentM));

  return {
    id: 'riverton',
    name: 'Riverton',
    bounds: computeBounds(graph.nodes),
    graph,
    scenery: { water, parks },
    seed,
  };
}
