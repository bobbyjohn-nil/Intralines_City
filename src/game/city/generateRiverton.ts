/**
 * Riverton — the procedurally generated demo city (manual §1, §21).
 *
 * "Demo, Procedurally generated — instant play, no downloads." Everything Riverton needs —
 * streets, water, parks — is generated in-process from a seed; no baked pack, no network.
 * Real cities derive their street graph and scenery from OSM (§21); Riverton stands in for
 * that with a synthetic city that reads like something a planner laid out around a river:
 * a uniform block grid, embankment roads that curve with the river, a handful of deliberate
 * bridges, one diagonal avenue cutting across the grid, and parks sized to actually be seen.
 *
 * Determinism is the whole point: `generateRiverton(seed)` must return a byte-identical
 * `City` for the same seed, forever. All randomness flows through the seeded `Rng` in
 * `./rng` — never `Math.random()`. The grid itself and the diagonal avenue are pure geometry
 * (no randomness at all — a planned city's grid doesn't roll dice). The RNG is consumed in a
 * fixed order: river shape (amplitude, phase) first — needed before the grid can bend the
 * embankment rows to it — then bridge placement, then parks. That order never depends on
 * anything but the seed, so the same seed always produces the same draws.
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
// A single uniform grid — every gap between adjacent lines is the same size, so the city
// reads as consistent blocks rather than a density gradient. Two rows are bent to hug the
// river as embankment roads (see "River" below); everything else is perfectly rectilinear.

/** Grid lines per axis. Odd, so there's a true centre line downtown, and large enough that
 * uniform BLOCK_SPACING_M blocks still span a city a few km across. # tune */
const GRID_LINE_COUNT = 43;
/** Gap between every pair of adjacent grid lines — a normal city block, metres. Uniform
 * throughout: no downtown/edge falloff. # tune */
const BLOCK_SPACING_M = 140;
/** Index of the centre grid line on either axis (GRID_LINE_COUNT is odd, so this is exact). */
const CENTER_LINE = (GRID_LINE_COUNT - 1) / 2;

/** Every ARTERIAL_INTERVAL-th grid line is a primary arterial (spec: every 5th–7th street).
 * The line halfway between two arterials is a secondary; everything else is residential. # tune */
const ARTERIAL_INTERVAL = 6;
const SECONDARY_OFFSET = Math.floor(ARTERIAL_INTERVAL / 2);

/** Padding added around the generated street grid to form the playable bounds, metres. # tune */
const BOUNDS_MARGIN_M = 250;

// ── River ────────────────────────────────────────────────────────────────────
// The river runs between two adjacent grid rows (the "bank rows"), which are bent — only
// those two rows — to hug the river's curve instead of sitting on their nominal straight
// line. Those bent rows are the embankment roads. A handful of the grid's north–south streets
// keep their crossing of the river band as an explicit bridge; every other crossing is cut,
// so the two banks are connected only at those chokepoints.

/** The bank rows straddle the grid's centre line, so the river runs through the middle third
 * of the city rather than clipping an edge. */
const RIVER_ROW_SOUTH = CENTER_LINE;
const RIVER_ROW_NORTH = CENTER_LINE + 1;
/** Nominal (unbent) midline between the two bank rows, metres from centre. */
const RIVER_MIDLINE_Y_M = BLOCK_SPACING_M / 2;

const RIVER_WIDTH_M = 70; // tune — must comfortably fit inside one row-gap band with the banks
const RIVER_AMPLITUDE_BASE_M = 35; // tune — kept well under BLOCK_SPACING_M so the bent bank
// rows never swing far enough to collide with their neighbouring row
const RIVER_AMPLITUDE_JITTER = 0.3; // tune — fractional +/- on the amplitude
const RIVER_FREQUENCY = 1.3; // tune — sine cycles across the map span
/** How far past the grid's edge the river polygon extends, so it visibly runs off-map. # tune */
const RIVER_MARGIN_M = 500;
const RIVER_SAMPLES = 28; // tune
/** Gap kept between the water's edge and the embankment road built along its bank, metres. # tune */
const EMBANKMENT_OFFSET_M = 18;

/** How many streets are allowed to actually cross the river; every other crossing is cut.
 * Spec: 3–5, a deliberate handful of chokepoints, not a bridge on every block. # tune */
const BRIDGE_COUNT = 4;
/** Bridges land near evenly spaced columns, nudged by up to this many columns of RNG jitter so
 * the crossings don't look mechanically regular. # tune */
const BRIDGE_JITTER_COLUMNS = 2;

// ── Diagonal avenue ──────────────────────────────────────────────────────────
// One straight avenue cutting across the grid at an angle, entirely south of the river so it
// never has to reason about the bent embankment rows or the bridges. It's built by literally
// splitting every grid edge it crosses at the crossing point and wiring a new node in — real
// intersections, not a line drawn on top — which is what produces the triangular blocks.

/** Columns each side of centre the diagonal spans. # tune */
const DIAGONAL_HALF_SPAN_COLUMNS = 5;
/** Row-offsets (south of centre; negative) the diagonal's two ends sit at, in BLOCK_SPACING_M
 * units — chosen as a 3:5 rise:run so the avenue re-meets the grid at real nodes partway
 * along its length, not just at its ends. Both stay well clear of the river band and the
 * south boundary. # tune */
const DIAGONAL_START_ROW_OFFSET = -13;
const DIAGONAL_END_ROW_OFFSET = -7;
/** Cells this far (metres) from the diagonal's bounding box are kept clear of parks, so a
 * park never lands on the new avenue or the fragments it slices out of the grid. # tune */
const DIAGONAL_PARK_EXCLUSION_MARGIN_M = 70;

/** Floating-point crossings that land within this distance of an axis line are treated as
 * landing exactly on it (the diagonal's 3:5 slope makes this happen for real, not just as a
 * rounding artefact). Metres. */
const AXIS_SNAP_EPSILON_M = 1e-6;

// ── Parks ────────────────────────────────────────────────────────────────────
// Parks are sized and centred to fill most of a single block's interior, clear of the streets
// bounding it, rather than floating free over the grid. Spec: 3–5 of them, at least one on the
// riverbank.

const PARK_MIN_COUNT = 3; // tune
const PARK_MAX_COUNT = 5; // tune
const PARK_MIN_RADIUS_M = 38; // tune
const PARK_MAX_RADIUS_M = 50; // tune
const PARK_SIDES = 9; // tune — vertices per park, for a rounded, non-rectangular blob
const PARK_RADIUS_JITTER = 0.15; // tune — fractional +/- per vertex; small enough that even the
// largest jittered vertex (PARK_MAX_RADIUS_M * (1 + PARK_RADIUS_JITTER)) plus PARK_STREET_MARGIN_M
// stays inside half a block, so a park can never reach the streets bounding its cell
const PARK_STREET_MARGIN_M = 10; // tune — clearance kept from the block's bounding streets

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

function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K, what: string): V {
  const v = map.get(key);
  if (v === undefined) {
    throw new Error(`generateRiverton: missing ${what} for key ${String(key)}`);
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

/** Mints ids past the base grid's own — the base grid uses `[0, GRID_LINE_COUNT^2)` for nodes
 * and `[0, edges.length)` for edges, so every later step (diagonal splits, bridge upgrades)
 * mints from a shared counter that starts just past those. */
interface IdGen {
  node: number;
  edge: number;
}

// ── Street grid: axis + classification ───────────────────────────────────────

/** Uniform axis positions (metres, relative to centre) — every gap is BLOCK_SPACING_M. */
function buildAxisPositions(): number[] {
  const positions: number[] = [];
  for (let k = 0; k < GRID_LINE_COUNT; k++) positions.push((k - CENTER_LINE) * BLOCK_SPACING_M);
  return positions;
}

/** Road class for the grid line at `index`, by its position in the arterial interval. */
function classifyGridLine(index: number): RoadClass {
  const m = index % ARTERIAL_INTERVAL;
  if (m === 0) return 'primary';
  if (m === SECONDARY_OFFSET) return 'secondary';
  return 'residential';
}

// ── River shape ──────────────────────────────────────────────────────────────
// One shared centreline function, reused for bending the embankment rows and for drawing the
// water polygon, so the roads and the water are always geometrically consistent with each other.

function riverCenterlineYM(xM: number, amplitude: number, phase: number, halfExtentM: number): number {
  return RIVER_MIDLINE_Y_M + amplitude * Math.sin((xM / halfExtentM) * Math.PI * RIVER_FREQUENCY + phase);
}

function southBankYM(xM: number, amplitude: number, phase: number, halfExtentM: number): number {
  return riverCenterlineYM(xM, amplitude, phase, halfExtentM) - RIVER_WIDTH_M / 2 - EMBANKMENT_OFFSET_M;
}

function northBankYM(xM: number, amplitude: number, phase: number, halfExtentM: number): number {
  return riverCenterlineYM(xM, amplitude, phase, halfExtentM) + RIVER_WIDTH_M / 2 + EMBANKMENT_OFFSET_M;
}

// ── Street grid generation ───────────────────────────────────────────────────

interface BaseGrid {
  readonly nodes: RoadNode[];
  readonly edges: RoadEdge[];
  /** (column, lower row) → edge id, for the vertical edge spanning that row gap on that column. */
  readonly verticalEdgeId: ReadonlyMap<number, number>;
  /** (row, lower column) → edge id, for the horizontal edge spanning that column gap on that row. */
  readonly horizontalEdgeId: ReadonlyMap<number, number>;
  readonly halfExtentM: number;
}

const nodeId = (i: number, j: number): number => i * GRID_LINE_COUNT + j;
const encode = (a: number, b: number): number => a * GRID_LINE_COUNT + b;

/** Builds the uniform grid, bending the two river-bank rows to the already-drawn river shape. */
function buildBaseGrid(riverAmplitude: number, riverPhase: number, axis: readonly number[]): BaseGrid {
  const halfExtentM = at(axis, axis.length - 1);

  const nodes: RoadNode[] = [];
  for (let i = 0; i < GRID_LINE_COUNT; i++) {
    for (let j = 0; j < GRID_LINE_COUNT; j++) {
      const xM = at(axis, i);
      let yM = at(axis, j);
      if (j === RIVER_ROW_SOUTH) yM = southBankYM(xM, riverAmplitude, riverPhase, halfExtentM);
      else if (j === RIVER_ROW_NORTH) yM = northBankYM(xM, riverAmplitude, riverPhase, halfExtentM);
      nodes.push({ id: nodeId(i, j), pos: metersToLngLat(xM, yM) });
    }
  }

  const edges: RoadEdge[] = [];
  const verticalEdgeId = new Map<number, number>();
  const horizontalEdgeId = new Map<number, number>();
  let nextEdgeId = 0;

  // Vertical edges: fixed column i, connecting consecutive rows. Classed by their column.
  for (let i = 0; i < GRID_LINE_COUNT; i++) {
    const roadClass = classifyGridLine(i);
    for (let j = 0; j < GRID_LINE_COUNT - 1; j++) {
      const from = nodeId(i, j);
      const to = nodeId(i, j + 1);
      const id = nextEdgeId++;
      edges.push({ id, from, to, roadClass, lengthM: haversineMeters(at(nodes, from).pos, at(nodes, to).pos) });
      verticalEdgeId.set(encode(i, j), id);
    }
  }

  // Horizontal edges: fixed row j, connecting consecutive columns. Classed by their row, except
  // the two river-bank rows, which are embankment arterials regardless of where they'd otherwise
  // fall in the arterial interval — riverside roads are major roads in real cities.
  for (let j = 0; j < GRID_LINE_COUNT; j++) {
    const roadClass: RoadClass = j === RIVER_ROW_SOUTH ? 'secondary' : j === RIVER_ROW_NORTH ? 'primary' : classifyGridLine(j);
    for (let i = 0; i < GRID_LINE_COUNT - 1; i++) {
      const from = nodeId(i, j);
      const to = nodeId(i + 1, j);
      const id = nextEdgeId++;
      edges.push({ id, from, to, roadClass, lengthM: haversineMeters(at(nodes, from).pos, at(nodes, to).pos) });
      horizontalEdgeId.set(encode(j, i), id);
    }
  }

  return { nodes, edges, verticalEdgeId, horizontalEdgeId, halfExtentM };
}

// ── Diagonal avenue ──────────────────────────────────────────────────────────
// Pure geometry: a straight line is walked across the grid, and every grid edge it crosses is
// split at the crossing point into two edges plus a new node. Where the line happens to land
// exactly on an existing intersection (it does, twice, given the 3:5 slope below), that node is
// reused instead of minting a duplicate. The new nodes, in line order, are then chained together
// with fresh 'primary' edges — the avenue itself.

interface DiagonalPathPoint {
  readonly xM: number;
  readonly resolvedNodeId: number;
}

function applyDiagonalAvenue(
  grid: BaseGrid,
  axis: readonly number[],
  idGen: IdGen,
  removedEdgeIds: Set<number>
): void {
  const iStart = CENTER_LINE - DIAGONAL_HALF_SPAN_COLUMNS;
  const iEnd = CENTER_LINE + DIAGONAL_HALF_SPAN_COLUMNS;
  const xStart = at(axis, iStart);
  const xEnd = at(axis, iEnd);
  const yStart = DIAGONAL_START_ROW_OFFSET * BLOCK_SPACING_M;
  const yEnd = DIAGONAL_END_ROW_OFFSET * BLOCK_SPACING_M;
  const slope = (yEnd - yStart) / (xEnd - xStart);

  const edgeById = new Map<number, RoadEdge>();
  for (const edge of grid.edges) edgeById.set(edge.id, edge);

  /** Given a point that must land on the diagonal, resolves it to either an existing grid node
   * (if it lands exactly on an axis intersection) or a freshly minted node that splits whichever
   * grid edge it falls in the middle of. */
  function resolvePoint(xM: number, yM: number): number {
    const iNearest = Math.round(xM / BLOCK_SPACING_M + CENTER_LINE);
    const jNearest = Math.round(yM / BLOCK_SPACING_M + CENTER_LINE);
    const onAxisX = Math.abs(xM - at(axis, iNearest)) < AXIS_SNAP_EPSILON_M;
    const onAxisY = Math.abs(yM - at(axis, jNearest)) < AXIS_SNAP_EPSILON_M;

    if (onAxisX && onAxisY) return nodeId(iNearest, jNearest); // a real intersection — reuse it

    if (onAxisX) {
      // Falls mid-edge on vertical column `iNearest`, between two rows.
      const jLower = Math.floor((yM - at(axis, 0)) / BLOCK_SPACING_M);
      const edgeId = mustGet(grid.verticalEdgeId, encode(iNearest, jLower), 'vertical edge for diagonal split');
      return splitEdge(edgeId, xM, yM);
    }

    // Falls mid-edge on horizontal row `jNearest`, between two columns.
    const iLower = Math.floor((xM - at(axis, 0)) / BLOCK_SPACING_M);
    const edgeId = mustGet(grid.horizontalEdgeId, encode(jNearest, iLower), 'horizontal edge for diagonal split');
    return splitEdge(edgeId, xM, yM);
  }

  function splitEdge(edgeId: number, xM: number, yM: number): number {
    const edge = mustGet(edgeById, edgeId, 'edge to split for diagonal avenue');
    const newId = idGen.node++;
    const newPos = metersToLngLat(xM, yM);
    grid.nodes.push({ id: newId, pos: newPos });

    const fromPos = at(grid.nodes, edge.from).pos;
    const toPos = at(grid.nodes, edge.to).pos;
    const first: RoadEdge = {
      id: idGen.edge++,
      from: edge.from,
      to: newId,
      roadClass: edge.roadClass,
      lengthM: haversineMeters(fromPos, newPos),
    };
    const second: RoadEdge = {
      id: idGen.edge++,
      from: newId,
      to: edge.to,
      roadClass: edge.roadClass,
      lengthM: haversineMeters(newPos, toPos),
    };
    grid.edges.push(first, second);
    removedEdgeIds.add(edgeId);
    return newId;
  }

  // Every column the diagonal spans gives one crossing (its start and end points are the i =
  // iStart / i = iEnd columns, included here — no separate endpoint handling needed).
  const points: DiagonalPathPoint[] = [];
  for (let i = iStart; i <= iEnd; i++) {
    const xM = at(axis, i);
    const yM = yStart + slope * (xM - xStart);
    points.push({ xM, resolvedNodeId: resolvePoint(xM, yM) });
  }
  // Rows strictly between the two ends add any crossing that isn't already one of the columns
  // above (those coincide with a column crossing exactly where the diagonal's 3:5 slope realigns
  // it with the grid, and resolvePoint already dedupes that case to the same node id).
  for (let j = 0; j < GRID_LINE_COUNT; j++) {
    const axisY = at(axis, j);
    if (axisY <= Math.min(yStart, yEnd) || axisY >= Math.max(yStart, yEnd)) continue;
    const xM = xStart + (axisY - yStart) / slope;
    points.push({ xM, resolvedNodeId: resolvePoint(xM, axisY) });
  }

  points.sort((a, b) => a.xM - b.xM);

  // Chain consecutive resolved nodes with the avenue itself, skipping accidental repeats (a
  // column crossing and a row crossing landing on the same real intersection resolve to the
  // same node id and end up adjacent after the sort).
  let previousNodeId: number | null = null;
  for (const point of points) {
    if (previousNodeId !== null && previousNodeId !== point.resolvedNodeId) {
      const fromPos = at(grid.nodes, previousNodeId).pos;
      const toPos = at(grid.nodes, point.resolvedNodeId).pos;
      grid.edges.push({
        id: idGen.edge++,
        from: previousNodeId,
        to: point.resolvedNodeId,
        roadClass: 'primary',
        lengthM: haversineMeters(fromPos, toPos),
      });
    }
    previousNodeId = point.resolvedNodeId;
  }
}

// ── Bridges ──────────────────────────────────────────────────────────────────

/** Picks BRIDGE_COUNT roughly-evenly-spaced columns to keep as river crossings. */
function chooseBridgeColumns(rng: Rng): Set<number> {
  const columns = new Set<number>();
  for (let k = 0; k < BRIDGE_COUNT; k++) {
    const target = Math.round(((k + 0.5) / BRIDGE_COUNT) * (GRID_LINE_COUNT - 1));
    const jitter = rng.int(-BRIDGE_JITTER_COLUMNS, BRIDGE_JITTER_COLUMNS);
    let column = Math.min(GRID_LINE_COUNT - 1, Math.max(0, target + jitter));
    while (columns.has(column)) column = Math.min(GRID_LINE_COUNT - 1, column + 1); // resolve rare collisions
    columns.add(column);
  }
  return columns;
}

/** Cuts every river-crossing street except the chosen bridge columns. Kept residential crossings
 * are upgraded to secondary — a bridge is never the sleepiest street in town. */
function cutRiverCrossings(grid: BaseGrid, bridgeColumns: ReadonlySet<number>, idGen: IdGen, removedEdgeIds: Set<number>): void {
  const edgeById = new Map<number, RoadEdge>();
  for (const edge of grid.edges) edgeById.set(edge.id, edge);

  for (let i = 0; i < GRID_LINE_COUNT; i++) {
    const edgeId = mustGet(grid.verticalEdgeId, encode(i, RIVER_ROW_SOUTH), 'river-crossing edge');
    if (removedEdgeIds.has(edgeId)) continue; // already gone (shouldn't happen — diagonal never reaches the river)

    if (!bridgeColumns.has(i)) {
      removedEdgeIds.add(edgeId);
      continue;
    }
    const edge = mustGet(edgeById, edgeId, 'bridge edge');
    if (edge.roadClass === 'residential') {
      removedEdgeIds.add(edgeId);
      grid.edges.push({ ...edge, id: idGen.edge++, roadClass: 'secondary' });
    }
  }
}

function buildAdjacency(nodes: readonly RoadNode[], edges: readonly RoadEdge[]): ReadonlyMap<number, readonly number[]> {
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    mustGetList(adjacency, edge.from).push(edge.id);
    mustGetList(adjacency, edge.to).push(edge.id);
  }
  return adjacency;
}

function mustGetList(adjacency: Map<number, number[]>, id: number): number[] {
  const list = adjacency.get(id);
  if (list === undefined) {
    throw new Error(`generateRiverton: edge references unknown node ${id}`);
  }
  return list;
}

// ── River polygon ────────────────────────────────────────────────────────────

function buildRiverPolygon(amplitude: number, phase: number, halfExtentM: number): Polygon {
  const spanM = halfExtentM + RIVER_MARGIN_M;

  const centerline: Array<{ x: number; y: number }> = [];
  for (let s = 0; s <= RIVER_SAMPLES; s++) {
    const x = -spanM + (2 * spanM * s) / RIVER_SAMPLES;
    const y = riverCenterlineYM(x, amplitude, phase, halfExtentM);
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

interface Cell {
  readonly i: number;
  readonly j: number;
}

function cellCenterM(cell: Cell, axis: readonly number[]): { readonly x: number; readonly y: number } {
  return {
    x: (at(axis, cell.i) + at(axis, cell.i + 1)) / 2,
    y: (at(axis, cell.j) + at(axis, cell.j + 1)) / 2,
  };
}

function isInDiagonalBoundingBox(cell: Cell, axis: readonly number[]): boolean {
  const { x, y } = cellCenterM(cell, axis);
  const xStart = at(axis, CENTER_LINE - DIAGONAL_HALF_SPAN_COLUMNS) - DIAGONAL_PARK_EXCLUSION_MARGIN_M;
  const xEnd = at(axis, CENTER_LINE + DIAGONAL_HALF_SPAN_COLUMNS) + DIAGONAL_PARK_EXCLUSION_MARGIN_M;
  const yLo = Math.min(DIAGONAL_START_ROW_OFFSET, DIAGONAL_END_ROW_OFFSET) * BLOCK_SPACING_M - DIAGONAL_PARK_EXCLUSION_MARGIN_M;
  const yHi = Math.max(DIAGONAL_START_ROW_OFFSET, DIAGONAL_END_ROW_OFFSET) * BLOCK_SPACING_M + DIAGONAL_PARK_EXCLUSION_MARGIN_M;
  return x >= xStart && x <= xEnd && y >= yLo && y <= yHi;
}

/** Rounded, non-rectangular park polygon centred on `centerM`, sized to sit inside a single
 * block's interior with PARK_STREET_MARGIN_M to spare — never touches the streets around it. */
function generateParkPolygon(rng: Rng, centerM: { readonly x: number; readonly y: number }): Polygon {
  const baseRadius = rng.range(PARK_MIN_RADIUS_M, PARK_MAX_RADIUS_M);
  const points: LngLat[] = [];
  for (let s = 0; s < PARK_SIDES; s++) {
    const angle = (s / PARK_SIDES) * Math.PI * 2;
    const r = baseRadius * (1 + rng.range(-PARK_RADIUS_JITTER, PARK_RADIUS_JITTER));
    points.push(metersToLngLat(centerM.x + r * Math.cos(angle), centerM.y + r * Math.sin(angle)));
  }
  return points;
}

/** Fisher–Yates shuffle through the seeded RNG (never `Array.sort` with a random comparator —
 * that isn't a uniform shuffle and isn't guaranteed stable across engines). */
function shuffleInPlace<T>(rng: Rng, items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = at(items, i);
    items[i] = at(items, j);
    items[j] = tmp;
  }
}

function drawParks(rng: Rng, axis: readonly number[]): Polygon[] {
  const riverside: Cell[] = [];
  const general: Cell[] = [];

  for (let i = 0; i < GRID_LINE_COUNT - 1; i++) {
    for (let j = 0; j < GRID_LINE_COUNT - 1; j++) {
      const cell: Cell = { i, j };
      if (j === RIVER_ROW_SOUTH) continue; // the water/embankment band itself — never a park
      if (isInDiagonalBoundingBox(cell, axis)) continue;
      if (j === RIVER_ROW_SOUTH - 1 || j === RIVER_ROW_NORTH) riverside.push(cell);
      else general.push(cell);
    }
  }

  shuffleInPlace(rng, riverside);
  shuffleInPlace(rng, general);

  const count = rng.int(PARK_MIN_COUNT, PARK_MAX_COUNT);
  const cells: Cell[] = [];
  if (riverside.length > 0) cells.push(at(riverside, 0)); // spec: at least one park on the riverbank
  for (const cell of general) {
    if (cells.length >= count) break;
    cells.push(cell);
  }
  // Fall back to remaining riverside cells if the general pool somehow ran out (shouldn't, at
  // this grid size, but never silently ship fewer parks than the count promised).
  for (let k = 1; k < riverside.length && cells.length < count; k++) cells.push(at(riverside, k));

  return cells.map((cell) => generateParkPolygon(rng, cellCenterM(cell, axis)));
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

  // Fixed draw order (see file header): river shape, then bridge placement, then parks.
  const riverAmplitude = RIVER_AMPLITUDE_BASE_M * (1 + rng.range(-RIVER_AMPLITUDE_JITTER, RIVER_AMPLITUDE_JITTER));
  const riverPhase = rng.range(0, Math.PI * 2);

  const axis = buildAxisPositions();
  const grid = buildBaseGrid(riverAmplitude, riverPhase, axis);

  const removedEdgeIds = new Set<number>();
  const idGen: IdGen = { node: GRID_LINE_COUNT * GRID_LINE_COUNT, edge: grid.edges.length };

  applyDiagonalAvenue(grid, axis, idGen, removedEdgeIds);

  const bridgeColumns = chooseBridgeColumns(rng);
  cutRiverCrossings(grid, bridgeColumns, idGen, removedEdgeIds);

  const finalEdges = grid.edges.filter((edge) => !removedEdgeIds.has(edge.id));
  const graph: StreetGraph = { nodes: grid.nodes, edges: finalEdges, adjacency: buildAdjacency(grid.nodes, finalEdges) };
  assertConnected(graph);

  const water = [buildRiverPolygon(riverAmplitude, riverPhase, grid.halfExtentM)];
  const parks = drawParks(rng, axis);

  return {
    id: 'riverton',
    name: 'Riverton',
    bounds: computeBounds(graph.nodes),
    graph,
    scenery: { water, parks },
    seed,
  };
}
