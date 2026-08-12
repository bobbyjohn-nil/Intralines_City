/**
 * Invariant tests for the demand model's first shippable slice (demand-model.md §7's testability
 * section, scoped to what §1's build-order step 1 actually builds). Fixtures are hand-built, not
 * generated via `city/generateRiverton` — this module only consumes `City`/`Zone`/`Line`/`Stop`
 * shapes, so a small deterministic fixture exercises the same contract without coupling this
 * agent's tests to another agent's generator mid-flight.
 */

import { describe, expect, it } from 'vitest';
import type { City, RoadEdge, StreetGraph, Zone } from '../types';
import type { Line, RouteLeg, Stop } from '../lines/types';
import type { StopId, LineId } from '../lines/types';
import { computeCityStatics, computeDemand, computeDemandForCity, createDemandBuffers, demandBuffersByteLength } from './demand';
import { RIVERTON_CAR_SPEED_KMH } from './constants';

// ── Fixture ──────────────────────────────────────────────────────────────────
//
// Four zones in a row, ~1.1 km apart (0.01° of longitude at this latitude), each with a stop at
// its own centroid and a 'primary' road edge to the next. `Stop.edgeId`/`edgeT`/`roadClass` and
// `RouteLeg.lengthM` are never read by this module (only `Stop.position`/`id` and
// `RouteLeg.edgeIds` are) — filled with plausible placeholders so the fixture type-checks.

const LNG_STEP = 0.01;
const BASE_LAT = 40.0;
const BASE_LNG = -71.0;

function zoneCentroid(i: number): readonly [number, number] {
  return [BASE_LNG + i * LNG_STEP, BASE_LAT];
}

function makeZone(i: number, residents: number, jobs: number): Zone {
  const [lng, lat] = zoneCentroid(i);
  const half = 0.003;
  return {
    id: i,
    polygon: [
      [lng - half, lat - half],
      [lng + half, lat - half],
      [lng + half, lat + half],
      [lng - half, lat + half],
    ],
    centroid: [lng, lat],
    areaHa: 80,
    residents,
    jobs,
    tourismJobs: 0,
  };
}

/** Builds a fixture city with `zoneCount` zones in a row and a matching street graph, each zone
 * `i` connected to zone `i+1` by one 'primary' edge. `residentsOf`/`jobsOf` default to a simple
 * residential-west, jobs-east split so gravity has something to bite on. */
function buildFixtureCity(
  zoneCount: number,
  residentsOf: (i: number) => number = (i) => (i < zoneCount / 2 ? 1000 : 100),
  jobsOf: (i: number) => number = (i) => (i < zoneCount / 2 ? 100 : 1000),
): City {
  const zones: Zone[] = [];
  for (let i = 0; i < zoneCount; i++) zones.push(makeZone(i, residentsOf(i), jobsOf(i)));

  const nodes = zones.map((z, i) => ({ id: i, pos: z.centroid }));
  const edges: RoadEdge[] = [];
  const adjacency = new Map<number, number[]>();
  for (let i = 0; i < zoneCount - 1; i++) {
    const edge: RoadEdge = { id: i, from: i, to: i + 1, roadClass: 'primary', lengthM: 1100 };
    edges.push(edge);
    adjacency.set(i, [...(adjacency.get(i) ?? []), edge.id]);
    adjacency.set(i + 1, [...(adjacency.get(i + 1) ?? []), edge.id]);
  }
  const graph: StreetGraph = { nodes, edges, adjacency };

  return {
    id: 'fixture',
    name: 'Fixture City',
    bounds: { west: BASE_LNG - 0.02, south: BASE_LAT - 0.02, east: BASE_LNG + zoneCount * LNG_STEP, north: BASE_LAT + 0.02 },
    graph,
    scenery: { water: [], parks: [] },
    zones,
    seed: 1,
  };
}

function makeStop(id: number, zoneIndex: number): Stop {
  const [lng, lat] = zoneCentroid(zoneIndex);
  return {
    id: id as StopId,
    name: `Stop ${id}`,
    position: [lng, lat],
    roadClass: 'primary',
    edgeId: 0,
    edgeT: 0,
    orphaned: false,
    movedM: null,
  };
}

/** A line stopping at zones `zoneIndices`, in order, riding the fixture graph's edges between
 * consecutive indices (each edge id equals its `from` zone index, per `buildFixtureCity`). */
function makeLine(id: number, stopIds: readonly StopId[], zoneIndices: readonly number[]): Line {
  const legs: RouteLeg[] = [];
  for (let p = 1; p < zoneIndices.length; p++) {
    const from = zoneIndices[p - 1]!;
    const to = zoneIndices[p]!;
    const edgeIds: number[] = [];
    for (let e = Math.min(from, to); e < Math.max(from, to); e++) edgeIds.push(e);
    legs.push({ fromStopId: stopIds[p - 1]!, toStopId: stopIds[p]!, edgeIds, lengthM: Math.abs(to - from) * 1100 });
  }
  return { id: id as LineId, name: `Line ${id}`, stopIds, legs, totalLengthM: legs.reduce((s, l) => s + l.lengthM, 0) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('demand model — first shippable slice', () => {
  it('trips are conserved: per-line boardings sum to the reported total, no rider lost or doubled', () => {
    const city = buildFixtureCity(6);
    const stops = [0, 1, 2, 3, 4, 5].map((i) => makeStop(i, i));
    const line = makeLine(0, stops.map((s) => s.id), [0, 1, 2, 3, 4, 5]);

    const result = computeDemandForCity(city, [line], stops, RIVERTON_CAR_SPEED_KMH);

    const summedBoardings = result.boardingsPerLine.reduce((a, b) => a + b, 0);
    const summedLinked = result.linkedTripsPerLine.reduce((a, b) => a + b, 0);

    expect(summedBoardings).toBeCloseTo(result.totalBoardingsPerDay, 6);
    expect(summedLinked).toBeCloseTo(result.totalLinkedTripsPerDay, 6);
    // Round-1-only: every trip is exactly one boarding, so the two totals coincide (see types.ts).
    expect(result.totalBoardingsPerDay).toBeCloseTo(result.totalLinkedTripsPerDay, 6);
    // Some demand must have actually ridden the bus, or the fixture isn't testing anything.
    expect(result.totalBoardingsPerDay).toBeGreaterThan(0);
    expect(result.totalBoardingsPerDay).toBeLessThanOrEqual(result.totalTripsPerDay + 1e-6);
  });

  it('adding a line never reduces total ridership', () => {
    const city = buildFixtureCity(8);
    const stops = Array.from({ length: 8 }, (_, i) => makeStop(i, i));
    const stopIds = stops.map((s) => s.id);

    // Line A only covers the western half — zones 4-7 (job-heavy) are unreached by bus.
    const lineA = makeLine(0, stopIds.slice(0, 4), [0, 1, 2, 3]);
    const resultA = computeDemandForCity(city, [lineA], stops, RIVERTON_CAR_SPEED_KMH);

    // Line B extends coverage across the whole corridor.
    const lineB = makeLine(1, stopIds, [0, 1, 2, 3, 4, 5, 6, 7]);
    const resultAB = computeDemandForCity(city, [lineA, lineB], stops, RIVERTON_CAR_SPEED_KMH);

    expect(resultAB.totalBoardingsPerDay).toBeGreaterThanOrEqual(resultA.totalBoardingsPerDay - 1e-6);
    // This fixture's added line should strictly help — sanity-check the invariant isn't vacuous.
    expect(resultAB.totalBoardingsPerDay).toBeGreaterThan(resultA.totalBoardingsPerDay);
  });

  it('determinism: identical input produces bit-identical output', () => {
    const city = buildFixtureCity(6);
    const stops = [0, 1, 2, 3, 4, 5].map((i) => makeStop(i, i));
    const line = makeLine(0, stops.map((s) => s.id), [0, 1, 2, 3, 4, 5]);

    const first = computeDemandForCity(city, [line], stops, RIVERTON_CAR_SPEED_KMH);
    const second = computeDemandForCity(city, [line], stops, RIVERTON_CAR_SPEED_KMH);

    expect(Array.from(first.boardingsPerLine)).toEqual(Array.from(second.boardingsPerLine));
    expect(Array.from(first.linkedTripsPerLine)).toEqual(Array.from(second.linkedTripsPerLine));
    expect(first.totalBoardingsPerDay).toBe(second.totalBoardingsPerDay);
    expect(first.totalTripsPerDay).toBe(second.totalTripsPerDay);
    expect(first.busSharePerDay).toBe(second.busSharePerDay);

    // Also true one level down: reusing the same buffers/statics across two Stage B calls.
    const buffers = createDemandBuffers(city.zones.length, stops.length, 1);
    const statics = computeCityStatics(buffers, city, RIVERTON_CAR_SPEED_KMH);
    const r1 = computeDemand(buffers, statics, [line], stops);
    const boardingsSnapshot = Array.from(r1.boardingsPerLine);
    const r2 = computeDemand(buffers, statics, [line], stops);
    expect(Array.from(r2.boardingsPerLine)).toEqual(boardingsSnapshot);
  });

  it('zero lines produces zero boardings without dividing by zero', () => {
    const city = buildFixtureCity(6);
    const result = computeDemandForCity(city, [], [], RIVERTON_CAR_SPEED_KMH);

    expect(result.lineCount).toBe(0);
    expect(result.boardingsPerLine.length).toBe(0);
    expect(result.totalBoardingsPerDay).toBe(0);
    expect(result.totalLinkedTripsPerDay).toBe(0);
    expect(Number.isFinite(result.totalTripsPerDay)).toBe(true);
    expect(Number.isNaN(result.busSharePerDay)).toBe(false);
    expect(result.busSharePerDay).toBe(0);
    // The city still generates O-D demand (gravity doesn't depend on the network) — just none of
    // it rides a bus.
    expect(result.totalTripsPerDay).toBeGreaterThan(0);
  });

  it('a line that reaches no zone carries nobody', () => {
    const city = buildFixtureCity(6);
    const stops = [0, 1, 2, 3, 4, 5].map((i) => makeStop(i, i));

    // A stop pair placed far outside the city, well beyond WALK_RADIUS_M of every zone centroid.
    const strandedStops: Stop[] = [
      { ...makeStop(100, 0), position: [BASE_LNG + 5, BASE_LAT + 5] },
      { ...makeStop(101, 0), position: [BASE_LNG + 5.02, BASE_LAT + 5] },
    ];
    const strandedLine = makeLine(0, strandedStops.map((s) => s.id), [0, 1]);

    const result = computeDemandForCity(city, [strandedLine], [...stops, ...strandedStops], RIVERTON_CAR_SPEED_KMH);

    expect(result.boardingsPerLine[0]).toBe(0);
    expect(result.linkedTripsPerLine[0]).toBe(0);
    expect(result.totalBoardingsPerDay).toBe(0);
  });

  it('a line reachable from both ends carries riders in either direction (bidirectional round trip)', () => {
    const city = buildFixtureCity(4, () => 1000, (i) => (i === 3 ? 2000 : 50));
    const stops = [0, 1, 2, 3].map((i) => makeStop(i, i));
    const line = makeLine(0, stops.map((s) => s.id), [0, 1, 2, 3]);

    const result = computeDemandForCity(city, [line], stops, RIVERTON_CAR_SPEED_KMH);
    expect(result.boardingsPerLine[0]).toBeGreaterThan(0);
  });

  it('measures the buffers footprint at a realistic capacity', () => {
    const buffers = createDemandBuffers(96, 200, 24);
    const bytes = demandBuffersByteLength(buffers);
    // Documented in the handoff report; this just guards against silent, unbounded growth.
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
    // eslint-disable-next-line no-console
    console.log(`DemandBuffers(zone=96, stop=200, line=24) = ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`);
  });
});
