import { describe, expect, it } from 'vitest';
import type { Bounds, City, LngLat, Polygon, RoadEdge, RoadNode, StreetGraph, Zone } from '../types';
import { BUS_MODELS } from '../constants';
import { createTreasury, spend } from '../economy/ledger';
import { DEPOT_COSTS_USD, DEPOT_MAX_COUNT } from './constants';
import { canAddBusToFleet, canArmDepotTool, nextDepotCostUsd, totalDepotCapacity } from './economics';
import { isDepotSitable } from './siting';
import { placeDepot } from './placement';
import { allocateNearestDepot, deadheadCostUsd } from './deadhead';
import { createPathfindContext } from '../lines/pathfind';
import type { Depot, DepotId } from './types';

// ── Fixture geometry ─────────────────────────────────────────────────────────
// Built at latitude 0 so longitude and latitude degrees convert via the same metres-per-degree
// factor the sim uses elsewhere (METERS_PER_DEG_LAT, cos(0) = 1) — lets every fixture below be
// specified directly in metres and stay exact against the metre-denominated SPEC thresholds
// (400 m road access, 120 m depot separation, 60 m kerb tolerance).

const METERS_PER_DEG = 111_320;
const m = (metersVal: number): number => metersVal / METERS_PER_DEG;
/** A point `xM` east, `yM` north of the origin (0, 0). */
const pt = (xM: number, yM: number): LngLat => [m(xM), m(yM)];

function squarePolygon(centerXM: number, centerYM: number, halfWidthM: number): Polygon {
  return [
    pt(centerXM - halfWidthM, centerYM - halfWidthM),
    pt(centerXM + halfWidthM, centerYM - halfWidthM),
    pt(centerXM + halfWidthM, centerYM + halfWidthM),
    pt(centerXM - halfWidthM, centerYM + halfWidthM),
  ];
}

function zone(
  id: number,
  centerXM: number,
  centerYM: number,
  residents: number,
  jobs: number,
  areaHa: number
): Zone {
  return {
    id,
    polygon: squarePolygon(centerXM, centerYM, 100),
    centroid: pt(centerXM, centerYM),
    areaHa,
    residents,
    jobs,
    tourismJobs: 0,
  };
}

/**
 * A minimal siting fixture: bounds spanning ±2000 m; one eligible industrial zone `A` centered
 * at (500, 0) with a road node right on it; a second eligible zone `C` centered at (500, 3000)
 * with no road node anywhere nearby (the "no_road_access" case); an ineligible residential zone
 * `B1` centered at (-500, 0); and a filler zone `B2` that exists only to pull the density median
 * up so `A`/`C` land below it without being the median themselves.
 *
 * Densities (residents+jobs)/areaHa, ascending: C=11, A=13.75, B1=87.5, B2=252.5 → median of the
 * two middle values = 50.625, so A and C (below it) are eligible and B1 (jobs <= residents) and
 * B2 (above the median) are not.
 */
function buildSitingFixture(): City {
  const zones: Zone[] = [
    zone(0, 500, 0, 5, 50, 4), // A: eligible
    zone(1, 500, 3000, 4, 40, 4), // C: eligible, far from any road node
    zone(2, -500, 0, 300, 50, 4), // B1: jobs <= residents, ineligible
    zone(3, -500, 3000, 10, 1000, 4), // B2: above-median density, ineligible; raises the median
  ];

  const nodes: RoadNode[] = [{ id: 0, pos: pt(500, 0) }]; // sits exactly on zone A's centroid
  const graph: StreetGraph = { nodes, edges: [], adjacency: new Map([[0, []]]) };

  const bounds: Bounds = { west: m(-5000), east: m(5000), south: m(-5000), north: m(5000) };

  return {
    id: 'fixture',
    name: 'Fixture City',
    bounds,
    graph,
    scenery: { water: [], parks: [] },
    zones,
    seed: 1,
  };
}

function makeDepot(id: number, xM: number, yM: number, accessNodeId = 0): Depot {
  return { id: id as DepotId, name: `Depot ${id}`, position: pt(xM, yM), level: 1, accessNodeId, busesParked: 0 };
}

// ── §1 placement — isDepotSitable ────────────────────────────────────────────

describe('isDepotSitable', () => {
  it('fails outside_city for a point outside the mapped bounds', () => {
    const city = buildSitingFixture();
    const result = isDepotSitable(pt(50_000, 50_000), city, []);
    expect(result).toEqual({ ok: false, reason: 'outside_city' });
  });

  it('fails not_zoned for a point inside the city but off any eligible zone', () => {
    const city = buildSitingFixture();
    // Deep inside bounds, outside every zone polygon and its 60 m tolerance.
    const result = isDepotSitable(pt(4000, 4000), city, []);
    expect(result).toEqual({ ok: false, reason: 'not_zoned' });
  });

  it('fails not_zoned on an ineligible zone even though checks 3-4 would also fail there', () => {
    const city = buildSitingFixture();
    // Inside ineligible zone B1, far from the only road node, and close to a depot placed right
    // next to it — three violated rules at once. Zoning (check 2) must win, proving order.
    const existing = [makeDepot(0, -500, 10)];
    const result = isDepotSitable(pt(-500, 0), city, existing);
    expect(result).toEqual({ ok: false, reason: 'not_zoned' });
  });

  it('fails no_road_access for a point on eligible zoning with no road node within 400 m', () => {
    const city = buildSitingFixture();
    const result = isDepotSitable(pt(500, 3000), city, []); // zone C's centroid
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_road_access');
      if (result.reason === 'no_road_access') {
        expect(result.nearestRoadDistanceM).toBeGreaterThan(400);
      }
    }
  });

  it('fails too_close_to_depot for a point that clears zoning and road access but sits within 120 m of an existing depot', () => {
    const city = buildSitingFixture();
    const existing = [makeDepot(0, 500, 50)]; // 50 m from the candidate point below
    const result = isDepotSitable(pt(500, 0), city, existing);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'too_close_to_depot') {
      expect(result.depotId).toBe(0);
      expect(result.distanceM).toBeCloseTo(50, 6);
    } else {
      throw new Error(`expected too_close_to_depot, got ${JSON.stringify(result)}`);
    }
  });

  it('passes every check for a point on eligible zoning, near a road node, far from any existing depot', () => {
    const city = buildSitingFixture();
    const result = isDepotSitable(pt(500, -90), city, []);
    expect(result).toEqual({ ok: true, accessNodeId: 0, accessDistanceM: 90 });
  });

  it('the same predicate is what a save loader or map tint would call — no second implementation exists', () => {
    // Not a behavioural assertion beyond the ones above; documents that isDepotSitable is the
    // only exported entry point a consumer needs (siting.ts exports no parallel eligibility fn).
    const city = buildSitingFixture();
    const a = isDepotSitable(pt(500, -90), city, []);
    const b = isDepotSitable(pt(500, -90), city, []);
    expect(a).toEqual(b);
  });
});

// ── §2 economics ──────────────────────────────────────────────────────────────

describe('depot economics', () => {
  it('matches the manual\'s cost ladder exactly at all five depots', () => {
    expect(DEPOT_COSTS_USD).toEqual([150_000, 225_000, 340_000, 505_000, 760_000]);
    expect(nextDepotCostUsd(0)).toBe(150_000);
    expect(nextDepotCostUsd(1)).toBe(225_000);
    expect(nextDepotCostUsd(2)).toBe(340_000);
    expect(nextDepotCostUsd(3)).toBe(505_000);
    expect(nextDepotCostUsd(4)).toBe(760_000);
  });

  it('refuses a sixth depot', () => {
    expect(DEPOT_MAX_COUNT).toBe(5);
    expect(nextDepotCostUsd(5)).toBeNull();
    const arm = canArmDepotTool(5, 10_000_000);
    expect(arm).toEqual({ ok: false, reason: 'depot_limit_reached' });
  });

  it('the arm gate also refuses on insufficient cash, independent of the count gate', () => {
    const arm = canArmDepotTool(0, 100_000);
    expect(arm).toEqual({ ok: false, reason: 'insufficient_funds', costUsd: 150_000, cashUsd: 100_000 });
  });

  it('caps fleet size by total depot capacity across all depots', () => {
    const depots = [makeDepot(0, 0, 0), makeDepot(1, 1000, 0)]; // two level-1 depots, 6 each
    expect(totalDepotCapacity(depots)).toBe(12);
    expect(canAddBusToFleet(depots, 11)).toBe(true);
    expect(canAddBusToFleet(depots, 12)).toBe(false);
  });
});

describe('placeDepot', () => {
  it('spends the correct ladder price and returns a level-1 depot on a clean site', () => {
    const city = buildSitingFixture();
    const treasury = createTreasury(500_000);
    const result = placeDepot(pt(500, -90), 'Fixture Depot', city, [], treasury, 0 as DepotId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.depot.level).toBe(1);
      expect(result.depot.accessNodeId).toBe(0);
      expect(result.treasury.cashCents).toBe(treasury.cashCents - 150_000 * 100);
    }
  });

  it('refuses (stage: site) before ever spending, when the site itself is bad', () => {
    const city = buildSitingFixture();
    const treasury = createTreasury(500_000);
    const result = placeDepot(pt(4000, 4000), 'Bad Site', city, [], treasury, 0 as DepotId);
    expect(result).toEqual({ ok: false, stage: 'site', reason: 'not_zoned' });
  });

  it('refuses (stage: arm) when the fifth depot is already owned, without evaluating the site', () => {
    const city = buildSitingFixture();
    const treasury = createTreasury(10_000_000);
    const fiveDepots = [0, 1, 2, 3, 4].map((i) => makeDepot(i, 10_000 + i * 1000, 10_000));
    const result = placeDepot(pt(500, -90), 'Sixth Depot', city, fiveDepots, treasury, 5 as DepotId);
    expect(result).toEqual({ ok: false, stage: 'arm', reason: 'depot_limit_reached' });
  });
});

// ── §3 dead-heading ───────────────────────────────────────────────────────────
//
// The graph below deliberately makes the straight-line-nearest depot the WRONG answer: depot X
// sits 30 m from the line's terminus as the crow flies, but is only reachable by a 6,060 m
// residential detour (30 km/h). Depot Y sits 2,000 m away as the crow flies — 66x farther — but
// is connected by a single direct 2,000 m primary road (55 km/h). Driving time makes Y the
// correct pull-out depot even though X is the "nearest" depot by any straight-line measure.

function buildDeadheadFixture(): { readonly graph: StreetGraph; readonly depotX: Depot; readonly depotY: Depot } {
  const nodes: RoadNode[] = [
    { id: 0, pos: pt(0, 0) }, // Tn — the line's first terminus
    { id: 1, pos: pt(30, 0) }, // Xn — depot X's access node, 30 m from Tn as the crow flies
    { id: 2, pos: pt(30, 3000) }, // detour waypoint
    { id: 3, pos: pt(-30, 3000) }, // detour waypoint
    { id: 4, pos: pt(2000, 0) }, // Yn — depot Y's access node, 2000 m from Tn as the crow flies
  ];
  const edges: RoadEdge[] = [
    { id: 0, from: 1, to: 2, roadClass: 'residential', lengthM: 3000 },
    { id: 1, from: 2, to: 3, roadClass: 'residential', lengthM: 60 },
    { id: 2, from: 3, to: 0, roadClass: 'residential', lengthM: 3000 },
    { id: 3, from: 4, to: 0, roadClass: 'primary', lengthM: 2000 },
  ];
  const adjacency = new Map<number, readonly number[]>([
    [0, [2, 3]],
    [1, [0]],
    [2, [0, 1]],
    [3, [1, 2]],
    [4, [3]],
  ]);
  const graph: StreetGraph = { nodes, edges, adjacency };

  const depotX: Depot = { id: 0 as DepotId, name: 'X (close, walled off)', position: pt(30, 0), level: 1, accessNodeId: 1, busesParked: 0 };
  const depotY: Depot = { id: 1 as DepotId, name: 'Y (far, direct road)', position: pt(2000, 0), level: 1, accessNodeId: 4, busesParked: 0 };

  return { graph, depotX, depotY };
}

describe('allocateNearestDepot', () => {
  it('picks the depot nearest by driving TIME, not the depot nearest by straight-line distance', () => {
    const { graph, depotX, depotY } = buildDeadheadFixture();
    const ctx = createPathfindContext(graph);
    const terminusPos = pt(0, 0);

    // Confirm the fixture actually is the interesting case: X really is closer as the crow flies.
    const straightLineX = Math.hypot(30, 0);
    const straightLineY = Math.hypot(2000, 0);
    expect(straightLineX).toBeLessThan(straightLineY);

    const result = allocateNearestDepot(ctx, graph, 0, terminusPos, [depotX, depotY]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.depotId).toBe(depotY.id); // the far-by-distance, near-by-time depot wins
      expect(result.routedOverRoadGraph).toBe(true);
      expect(result.deadheadKm).toBeCloseTo(2, 6);
    }
  });

  it('falls back to great-circle / 25 km/h when the depot is unroutable, and never leaves a bus unallocated', () => {
    const nodes: RoadNode[] = [
      { id: 0, pos: pt(0, 0) },
      { id: 1, pos: pt(1000, 0) }, // island, no edge to node 0
    ];
    const graph: StreetGraph = { nodes, edges: [], adjacency: new Map([[0, []], [1, []]]) };
    const ctx = createPathfindContext(graph);
    const depot: Depot = { id: 0 as DepotId, name: 'Island depot', position: pt(1000, 0), level: 1, accessNodeId: 1, busesParked: 0 };

    const result = allocateNearestDepot(ctx, graph, 0, pt(0, 0), [depot]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.routedOverRoadGraph).toBe(false);
      expect(result.deadheadKm).toBeCloseTo(1, 6);
      const expectedTimeS = 1000 / (25 * (1000 / 3600));
      expect(result.deadheadTimeS).toBeCloseTo(expectedTimeS, 3);
    }
  });

  it('refuses allocation when every depot is at capacity', () => {
    const { graph, depotX } = buildDeadheadFixture();
    const ctx = createPathfindContext(graph);
    const full: Depot = { ...depotX, busesParked: 6 }; // level 1 capacity is 6
    const result = allocateNearestDepot(ctx, graph, 0, pt(0, 0), [full]);
    expect(result).toEqual({ ok: false, reason: 'no_depot_with_free_parking' });
  });

  it('ties break to more free parking, then to the lower depot id', () => {
    // Two depots at identical access nodes (identical driving time) but different free parking.
    const nodes: RoadNode[] = [
      { id: 0, pos: pt(0, 0) },
      { id: 1, pos: pt(500, 0) },
    ];
    const edges: RoadEdge[] = [{ id: 0, from: 0, to: 1, roadClass: 'primary', lengthM: 500 }];
    const graph: StreetGraph = { nodes, edges, adjacency: new Map([[0, [0]], [1, [0]]]) };
    const ctx = createPathfindContext(graph);

    const depotA: Depot = { id: 5 as DepotId, name: 'A', position: pt(500, 0), level: 1, accessNodeId: 1, busesParked: 4 }; // 2 free
    const depotB: Depot = { id: 2 as DepotId, name: 'B', position: pt(500, 0), level: 1, accessNodeId: 1, busesParked: 1 }; // 5 free
    const result = allocateNearestDepot(ctx, graph, 0, pt(0, 0), [depotA, depotB]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.depotId).toBe(depotB.id); // more free parking wins the tie

    // Equal free parking now — lower id should win.
    const depotC: Depot = { id: 9 as DepotId, name: 'C', position: pt(500, 0), level: 1, accessNodeId: 1, busesParked: 1 };
    const depotD: Depot = { id: 3 as DepotId, name: 'D', position: pt(500, 0), level: 1, accessNodeId: 1, busesParked: 1 };
    const tieResult = allocateNearestDepot(ctx, graph, 0, pt(0, 0), [depotC, depotD]);
    expect(tieResult.ok).toBe(true);
    if (tieResult.ok) expect(tieResult.depotId).toBe(depotD.id);
  });
});

describe('deadheadCostUsd', () => {
  it('is non-zero and scales with distance and time', () => {
    const model = BUS_MODELS.metro40!;
    const short = deadheadCostUsd(1, 144, model); // 1 km at 25 km/h ~ 144 s
    const long = deadheadCostUsd(5, 720, model); // 5x the distance and time

    expect(short.totalUsd).toBeGreaterThan(0);
    expect(short.fuelUsd).toBeGreaterThan(0);
    expect(short.maintenanceUsd).toBeGreaterThan(0);
    expect(short.wagesUsd).toBeGreaterThan(0);

    expect(long.fuelUsd).toBeCloseTo(short.fuelUsd * 5, 6);
    expect(long.maintenanceUsd).toBeCloseTo(short.maintenanceUsd * 5, 6);
    expect(long.wagesUsd).toBeCloseTo(short.wagesUsd * 5, 6);
    expect(long.totalUsd).toBeGreaterThan(short.totalUsd);
  });

  it('reports fuel, maintenance and wages as separate lines that sum to the total', () => {
    const model = BUS_MODELS.metro40!;
    const cost = deadheadCostUsd(3.4, 500, model);
    expect(cost.fuelUsd + cost.maintenanceUsd + cost.wagesUsd).toBeCloseTo(cost.totalUsd, 9);
  });
});

// Sanity: the ledger's spend/refund pair is what placeDepot uses under the hood, not a
// reimplementation of cash-deduction here.
describe('integration with the ledger', () => {
  it('spend refuses a depot purchase the same way placeDepot does when cash is short', () => {
    const treasury = createTreasury(50_000);
    const direct = spend(treasury, 150_000, 'Depot: test');
    expect(direct.ok).toBe(false);
  });
});
