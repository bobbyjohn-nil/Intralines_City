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
 * embankment rows to it — then bridge placement, then parks, then last the zone lattice's
 * per-site jitter (see "Zones" below). That order never depends on anything but the seed, so
 * the same seed always produces the same draws; appending the zone jitter last means it can
 * never perturb any earlier geometry.
 *
 * Zones are Riverton's census-block-group equivalent (demand-model.md §5,
 * depots-and-timetables.md §1): a Voronoi diagram over a jittered lattice, each cell carrying
 * `residents`, `jobs`, `tourismJobs` and `areaHa`. Depot siting's Zoning B fallback and the
 * demand model's Stage A both read this table — see `./zones` for the shared eligibility
 * predicate, and the "Zones" section below for the generation itself.
 */

import type { Bounds, City, LngLat, Polygon, RoadClass, RoadEdge, RoadNode, StreetGraph, Zone } from '../types';
import { createRng, type Rng } from './rng';
import { DEPOT_MAX_ROAD_ACCESS_M, DEPOT_MIN_SEPARATION_M, isDepotEligibleZone, medianZoneDensityPerHa } from './zones';

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
// never has to reason about the bent embankment rows or the bridges — a real diagonal spine
// still doesn't need to cross water to read as major, and staying south keeps BRIDGE_COUNT and
// every bridge-related test untouched. It's built by literally splitting every grid edge it
// crosses at the crossing point and wiring a new node in — real intersections, not a line drawn
// on top — which is what produces the triangular blocks.
//
// Previously this spanned only 10 of the grid's 43 columns, confined to a narrow band well
// south of centre, with both ends resolving to arbitrary residential intersections mid-grid —
// technically connected but reading as a stray scratch, not an avenue. It now runs the grid's
// entire east-west extent, column 0 to column GRID_LINE_COUNT-1, so both ends terminate at the
// city's west/east edge exactly (not a boundary approximation — literally the same longitude as
// the outermost grid column), and it covers most of the southern half's row span rather than a
// fifth of it.

/** Columns each side of centre the diagonal spans. Set to CENTER_LINE itself so the avenue's
 * endpoints land exactly on column 0 and column GRID_LINE_COUNT-1 — the grid's own west/east
 * edges — instead of dangling at some arbitrary interior column. */
const DIAGONAL_HALF_SPAN_COLUMNS = CENTER_LINE;
/** Row-offsets (south of centre; negative) the diagonal's two ends sit at, in BLOCK_SPACING_M
 * units — a 5:14 rise:run, chosen so the avenue re-meets the grid at real nodes twice more
 * along its length (not just at its edge-terminated ends) while still leaving most crossings as
 * genuine mid-edge splits, which is what carves the triangular blocks. Both stay a few rows
 * clear of the river band and the south boundary — close enough to use most of the southern
 * half, far enough that the avenue never has to reason about the bent embankment rows. # tune */
const DIAGONAL_START_ROW_OFFSET = -18;
const DIAGONAL_END_ROW_OFFSET = -3;
/** Cells this far (metres) from the diagonal's bounding box are kept clear of parks, so a
 * park never lands on the new avenue or the fragments it slices out of the grid. # tune */
const DIAGONAL_PARK_EXCLUSION_MARGIN_M = 70;

/** Floating-point crossings that land within this distance of an axis line are treated as
 * landing exactly on it (the diagonal's 5:14 slope makes this happen for real, not just as a
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

// ── Zones ────────────────────────────────────────────────────────────────────
// Riverton's census-block-group equivalent: a Voronoi diagram over a jittered lattice of sites.
// See demand-model.md §5 for the SPEC figures this section implements.

/** Lattice dimensions: 12 x 8 = Z = 96, demand-model.md §5's zone count. Not required to be
 * square — the city's footprint already is, so any factor pair works; this one keeps individual
 * cells closer to square than the alternatives. # tune */
const ZONE_LATTICE_COLS = 12;
const ZONE_LATTICE_ROWS = 8;
/** Fraction of a lattice cell's half-width/half-height a site may jitter off centre, each axis
 * independently — keeps every site inside its own cell (no risk of a degenerate neighbour
 * ordering) while still reading as organic rather than a rigid grid. # tune */
const ZONE_JITTER_FRACTION = 0.6;

/** Population density falloff length shared by the core and the three secondary nodes
 * (demand-model.md §5: "density(r) = exp(-r/1800m)"). SPEC. */
const ZONE_DENSITY_DECAY_M = 1800;
/** Weight of each secondary density node relative to the core (weight 1). SPEC. */
const ZONE_SECONDARY_WEIGHT = 0.45;
/** The three secondary nodes' distance and bearing from the core. The spec states their count and
 * weight but not their placement, so they're set here at even 120° spacing and a radius on the
 * order of the decay length above — far enough to read as distinct sub-centres, not just a
 * shoulder on the core's own falloff. Pure geometry, no RNG — same reasoning as the diagonal
 * avenue: this is a planned city's structure, not a roll of the dice. # tune */
const ZONE_SECONDARY_HUB_RADIUS_M = 1800;
const ZONE_SECONDARY_HUB_BEARINGS_DEG = [90, 210, 330] as const;

/** Total residents Riverton's zones sum to, before per-zone rounding/flooring
 * (demand-model.md §5: "population 42,000"). SPEC. */
const ZONE_TOTAL_POPULATION = 42_000;
/** Per-zone population floor, so a trough between density nodes never rounds a zone to zero
 * residents. SPEC (demand-model.md §5). */
const ZONE_POPULATION_FLOOR = 120;

/** Job-weight falloff from the core alone (demand-model.md §5: "jobWeight(r) = 0.35 +
 * 1.9*exp(-r/1100m)") — deliberately a single core, not the three-node density shape above, which
 * is what makes the core read as job-heavy and the edge as resident-heavy even where a secondary
 * population hub sits. SPEC. */
const ZONE_JOBWEIGHT_BASELINE = 0.35;
const ZONE_JOBWEIGHT_PEAK = 1.9;
const ZONE_JOBWEIGHT_DECAY_M = 1100;

/** Tourism jobs: 12% of jobs, confined to the 4 zones nearest the core. SPEC (demand-model.md §5). */
const ZONE_TOURISM_SHARE = 0.12;
const ZONE_TOURISM_CORE_ZONE_COUNT = 4;

// ── Industrial districts ─────────────────────────────────────────────────────
// depots-and-timetables.md §1 requires Riverton to *deliberately* place >= 3 industrial districts
// (jobs 4-8x residents, density in the bottom tercile), not hope the radial density shape produces
// them by accident. Real cities put industry near rail, water and arterials; Riverton has a river
// and two arterial spines (the grid's own primary streets and the diagonal avenue), so the three
// targets below sit at the diagonal avenue's west and east termini — both already at the city edge
// and on a primary road by construction — and at the north edge on a primary grid column, across
// the river from the (south-only) diagonal, so the three read as spread around the city rather
// than clustered on one side. Each target is thousands of metres from the other two regardless of
// seed, comfortably clearing the >= 400m separation the spec asks for. The nearest zone site to
// each target is designated industrial; *which* physical zone that ends up being still varies with
// the seed (the lattice itself is jittered) — only the deliberate targets are fixed.
const ZONE_INDUSTRIAL_NORTH_TARGET_COLUMN = Math.floor(CENTER_LINE / ARTERIAL_INTERVAL) * ARTERIAL_INTERVAL;
const ZONE_INDUSTRIAL_TARGETS_M: ReadonlyArray<{ readonly x: number; readonly y: number }> = [
  { x: -CENTER_LINE * BLOCK_SPACING_M, y: DIAGONAL_START_ROW_OFFSET * BLOCK_SPACING_M }, // west: diagonal's west terminus
  { x: CENTER_LINE * BLOCK_SPACING_M, y: DIAGONAL_END_ROW_OFFSET * BLOCK_SPACING_M }, // east: diagonal's east terminus
  { x: (ZONE_INDUSTRIAL_NORTH_TARGET_COLUMN - CENTER_LINE) * BLOCK_SPACING_M, y: CENTER_LINE * BLOCK_SPACING_M }, // north edge
];

/** Residents per hectare assigned to a deliberate industrial zone — low enough to land in the
 * bottom density tercile against the rest of the city (a typical zone here runs on the order of
 * 20-30 residents+jobs per hectare; this and the jobs figure below give ~7/ha). # tune */
const ZONE_INDUSTRIAL_RESIDENTS_PER_HA = 1;
/** Jobs per hectare for a deliberate industrial zone. The ratio to the line above is exactly the
 * multiplier below, landing inside depots-and-timetables.md §1's "jobs 4-8x residents". # tune */
const ZONE_INDUSTRIAL_JOB_MULTIPLIER = 6;
const ZONE_INDUSTRIAL_JOBS_PER_HA = ZONE_INDUSTRIAL_RESIDENTS_PER_HA * ZONE_INDUSTRIAL_JOB_MULTIPLIER;
/** Floor so even a small sliver zone near a target still gets a well-defined, strictly
 * jobs-over-residents industrial profile. # tune */
const ZONE_INDUSTRIAL_MIN_RESIDENTS = 10;

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
// exactly on an existing intersection (it does, twice more beyond the two edge-terminated ends,
// given the 5:14 slope below), that node is reused instead of minting a duplicate. The new
// nodes, in line order, are then chained together with fresh 'primary' edges — the avenue itself.

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
  // above (those coincide with a column crossing exactly where the diagonal's 5:14 slope realigns
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

// ── Zones ────────────────────────────────────────────────────────────────────

interface Point2 {
  readonly x: number;
  readonly y: number;
}

const ZONE_CORE_M: Point2 = { x: 0, y: 0 };

function pointDistanceM(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The core plus three secondary sub-centres, in local metres. Pure geometry — see the constants
 * section above for why these aren't RNG-placed. */
function buildSecondaryHubsM(): Point2[] {
  return ZONE_SECONDARY_HUB_BEARINGS_DEG.map((deg) => {
    const rad = toRad(deg);
    return { x: ZONE_SECONDARY_HUB_RADIUS_M * Math.sin(rad), y: ZONE_SECONDARY_HUB_RADIUS_M * Math.cos(rad) };
  });
}

/** Unnormalised population density weight at `p`: the core (weight 1) plus each secondary hub
 * (weight ZONE_SECONDARY_WEIGHT), each falling off as `exp(-r/ZONE_DENSITY_DECAY_M)`. */
function populationDensityWeight(p: Point2, hubs: readonly Point2[]): number {
  let weight = Math.exp(-pointDistanceM(p, ZONE_CORE_M) / ZONE_DENSITY_DECAY_M);
  for (const hub of hubs) weight += ZONE_SECONDARY_WEIGHT * Math.exp(-pointDistanceM(p, hub) / ZONE_DENSITY_DECAY_M);
  return weight;
}

/** Unnormalised job weight at `p`: core-only falloff, per demand-model.md §5. */
function jobWeightAt(p: Point2): number {
  return ZONE_JOBWEIGHT_BASELINE + ZONE_JOBWEIGHT_PEAK * Math.exp(-pointDistanceM(p, ZONE_CORE_M) / ZONE_JOBWEIGHT_DECAY_M);
}

/** Jittered lattice sites in local metres, `ZONE_LATTICE_COLS x ZONE_LATTICE_ROWS` = Z sites
 * covering the same square footprint as the street grid. This is the one place zone generation
 * draws from the RNG (see file header: last in the fixed draw order, after parks). */
function buildZoneLatticeM(rng: Rng, halfExtentM: number): Point2[] {
  const colWidth = (2 * halfExtentM) / ZONE_LATTICE_COLS;
  const rowHeight = (2 * halfExtentM) / ZONE_LATTICE_ROWS;
  const sites: Point2[] = [];
  for (let row = 0; row < ZONE_LATTICE_ROWS; row++) {
    for (let col = 0; col < ZONE_LATTICE_COLS; col++) {
      const cx = -halfExtentM + colWidth * (col + 0.5);
      const cy = -halfExtentM + rowHeight * (row + 0.5);
      const jitterX = rng.range(-colWidth / 2, colWidth / 2) * ZONE_JITTER_FRACTION;
      const jitterY = rng.range(-rowHeight / 2, rowHeight / 2) * ZONE_JITTER_FRACTION;
      sites.push({ x: cx + jitterX, y: cy + jitterY });
    }
  }
  return sites;
}

/** Clips a convex polygon to the half-plane `dot(p - mid, dir) <= 0` — the side closer to the
 * Voronoi cell's own site than to the neighbour `dir` points at. Standard Sutherland-Hodgman
 * single-plane clip; orientation-independent, so the input polygon's winding doesn't matter. */
function clipConvexPolygonHalfPlane(poly: readonly Point2[], mid: Point2, dir: Point2): Point2[] {
  const value = (p: Point2): number => (p.x - mid.x) * dir.x + (p.y - mid.y) * dir.y;
  const result: Point2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = at(poly, i);
    const prev = at(poly, (i - 1 + poly.length) % poly.length);
    const currVal = value(curr);
    const prevVal = value(prev);
    const currIn = currVal <= 0;
    const prevIn = prevVal <= 0;
    if (currIn !== prevIn) {
      const t = prevVal / (prevVal - currVal);
      result.push({ x: prev.x + t * (curr.x - prev.x), y: prev.y + t * (curr.y - prev.y) });
    }
    if (currIn) result.push(curr);
  }
  return result;
}

/** The Voronoi cell for `sites[siteIndex]`, clipped to the `[-halfExtentM, halfExtentM]` square —
 * the same square the lattice sites are drawn from, so every cell lands strictly inside
 * `city.bounds` (which pads further out by BOUNDS_MARGIN_M). O(n) half-plane clips against every
 * other site; at Z=96 this is a generation-time cost only, never touched per frame. */
function buildVoronoiCellM(siteIndex: number, sites: readonly Point2[], halfExtentM: number): Point2[] {
  let poly: Point2[] = [
    { x: -halfExtentM, y: -halfExtentM },
    { x: halfExtentM, y: -halfExtentM },
    { x: halfExtentM, y: halfExtentM },
    { x: -halfExtentM, y: halfExtentM },
  ];
  const site = at(sites, siteIndex);
  for (let j = 0; j < sites.length && poly.length > 0; j++) {
    if (j === siteIndex) continue;
    const other = at(sites, j);
    const mid: Point2 = { x: (site.x + other.x) / 2, y: (site.y + other.y) / 2 };
    const dir: Point2 = { x: other.x - site.x, y: other.y - site.y };
    poly = clipConvexPolygonHalfPlane(poly, mid, dir);
  }
  if (poly.length < 3) {
    throw new Error(`generateRiverton: zone ${siteIndex} collapsed to a degenerate Voronoi cell`);
  }
  return poly;
}

/** Signed-area shoelace centroid and area (metres²) of a simple polygon. */
function polygonAreaAndCentroidM(poly: readonly Point2[]): { readonly areaM2: number; readonly centroid: Point2 } {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p0 = at(poly, i);
    const p1 = at(poly, (i + 1) % poly.length);
    const cross = p0.x * p1.y - p1.x * p0.y;
    area2 += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  if (Math.abs(area2) < 1e-9) {
    throw new Error('generateRiverton: zone polygon has zero area');
  }
  return { areaM2: Math.abs(area2) / 2, centroid: { x: cx / (3 * area2), y: cy / (3 * area2) } };
}

/**
 * Builds Riverton's zone table: Voronoi cells over a jittered lattice, radial population and job
 * density (demand-model.md §5), and >= 3 deliberately-placed industrial districts
 * (depots-and-timetables.md §1). Consumes RNG only for the lattice jitter — everything after that
 * (density evaluation, industrial overrides) is pure geometry over the resulting sites, so it
 * never perturbs the RNG stream past what the lattice itself draws.
 */
function buildZones(rng: Rng, halfExtentM: number): Zone[] {
  const sites = buildZoneLatticeM(rng, halfExtentM);
  const hubs = buildSecondaryHubsM();

  const cellsM = sites.map((_, i) => buildVoronoiCellM(i, sites, halfExtentM));
  const geometry = cellsM.map((cell) => polygonAreaAndCentroidM(cell));
  const areaHa = geometry.map((g) => g.areaM2 / 10_000);
  const centroidsM = geometry.map((g) => g.centroid);

  // Population: density weight x area, normalised to ZONE_TOTAL_POPULATION, floored per zone.
  const rawPop = centroidsM.map((c, i) => populationDensityWeight(c, hubs) * at(areaHa, i));
  const rawPopTotal = rawPop.reduce((sum, v) => sum + v, 0);
  const popScale = rawPopTotal > 0 ? ZONE_TOTAL_POPULATION / rawPopTotal : 0;
  const residents = rawPop.map((v) => Math.max(ZONE_POPULATION_FLOOR, Math.round(v * popScale)));
  const residentsTotal = residents.reduce((sum, v) => sum + v, 0);

  // Jobs: job-weight x area, normalised so sum(jobs) == sum(residents) — SPEC.
  const rawJobs = centroidsM.map((c, i) => jobWeightAt(c) * at(areaHa, i));
  const rawJobsTotal = rawJobs.reduce((sum, v) => sum + v, 0);
  const jobScale = rawJobsTotal > 0 ? residentsTotal / rawJobsTotal : 0;
  const jobs = rawJobs.map((v) => Math.round(v * jobScale));

  // Tourism: 12% of jobs, confined to the 4 zones nearest the core.
  const tourismJobs = jobs.map(() => 0);
  const coreNearest = centroidsM
    .map((c, i) => ({ i, r: pointDistanceM(c, ZONE_CORE_M) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, ZONE_TOURISM_CORE_ZONE_COUNT);
  for (const { i } of coreNearest) tourismJobs[i] = Math.round(ZONE_TOURISM_SHARE * at(jobs, i));

  // Industrial districts: nearest zone to each deliberate target, overridden to a low-density,
  // strongly jobs-over-residents profile.
  const industrialIndices = ZONE_INDUSTRIAL_TARGETS_M.map((target) => {
    let bestIndex = 0;
    let bestDistM = Infinity;
    for (let i = 0; i < centroidsM.length; i++) {
      const d = pointDistanceM(at(centroidsM, i), target);
      if (d < bestDistM) {
        bestDistM = d;
        bestIndex = i;
      }
    }
    return bestIndex;
  });
  if (new Set(industrialIndices).size !== industrialIndices.length) {
    throw new Error('generateRiverton: two industrial-district targets resolved to the same zone');
  }
  for (const i of industrialIndices) {
    const zoneAreaHa = at(areaHa, i);
    const industrialResidents = Math.max(ZONE_INDUSTRIAL_MIN_RESIDENTS, Math.round(ZONE_INDUSTRIAL_RESIDENTS_PER_HA * zoneAreaHa));
    residents[i] = industrialResidents;
    jobs[i] = Math.max(industrialResidents * ZONE_INDUSTRIAL_JOB_MULTIPLIER, Math.round(ZONE_INDUSTRIAL_JOBS_PER_HA * zoneAreaHa));
    tourismJobs[i] = 0; // industrial, not tourism — never one of the core-nearest 4 by target choice
  }

  return sites.map((_, i) => ({
    id: i,
    polygon: at(cellsM, i).map(({ x, y }) => metersToLngLat(x, y)),
    centroid: metersToLngLat(at(centroidsM, i).x, at(centroidsM, i).y),
    areaHa: at(areaHa, i),
    residents: at(residents, i),
    jobs: at(jobs, i),
    tourismJobs: at(tourismJobs, i),
  }));
}

/** depots-and-timetables.md §1: "a bake-time post-check that fails the build loudly if fewer than
 * 3 [eligible sites] survive — a demo city that cannot host a depot is a broken build, not a bad
 * seed." Same discipline as `assertConnected` below: this must never pass silently. */
function assertDepotSitingViable(zones: readonly Zone[], graph: StreetGraph): void {
  const medianDensityPerHa = medianZoneDensityPerHa(zones);
  const eligible = zones.filter((z) => isDepotEligibleZone(z, medianDensityPerHa));
  if (eligible.length < 3) {
    throw new Error(
      `generateRiverton: only ${eligible.length} zones pass depot eligibility (need >= 3) — see depots-and-timetables.md §1`
    );
  }

  // Greedy mutually->=400m-apart subset, in zone-id order (deterministic).
  const spaced: Zone[] = [];
  for (const zone of eligible) {
    if (spaced.every((s) => haversineMeters(s.centroid, zone.centroid) >= DEPOT_MIN_SEPARATION_M)) spaced.push(zone);
  }
  if (spaced.length < 3) {
    throw new Error(
      `generateRiverton: only ${spaced.length} depot-eligible zones are >= ${DEPOT_MIN_SEPARATION_M}m apart (need >= 3)`
    );
  }

  for (const zone of spaced) {
    const hasRoadAccess = graph.nodes.some((n) => haversineMeters(n.pos, zone.centroid) <= DEPOT_MAX_ROAD_ACCESS_M);
    if (!hasRoadAccess) {
      throw new Error(`generateRiverton: eligible zone ${zone.id} has no routable road node within ${DEPOT_MAX_ROAD_ACCESS_M}m`);
    }
  }
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

  // Fixed draw order (see file header): river shape, then bridge placement, then parks, then the
  // zone lattice's jitter — last, so it can never perturb any earlier geometry.
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

  const zones = buildZones(rng, grid.halfExtentM);
  assertDepotSitingViable(zones, graph);

  return {
    id: 'riverton',
    name: 'Riverton',
    bounds: computeBounds(graph.nodes),
    graph,
    scenery: { water, parks },
    zones,
    seed,
  };
}
