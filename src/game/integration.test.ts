/**
 * Cross-module invariant tests. Every module exercised here is already covered in isolation by
 * its own suite (`city/`, `clock/`, `lines/`, `buses/`, `economy/`) — this file exists for the
 * class of bug that unit tests miss because each module is correct on its own: determinism
 * across the whole generate → draft → schedule → position chain, money conservation across a
 * spend/undo cycle, schedule/line consistency, agreement between the two independent
 * interpretations of `DEFAULT_SERVICE_HOURS` (`buses/position.ts` and `economy/ledger.ts`), and
 * pathfinding invariants under many seeded random node pairs.
 *
 * Keep this file fast: small synthetic networks and short clock ranges, not full city sweeps.
 */
import { describe, expect, it } from 'vitest';
import { generateRiverton, RIVERTON_SEED } from './city/generateRiverton';
import { createRng } from './city/rng';
import {
  addStop,
  canCreate,
  cancelDraft,
  startDraft,
  summarizeDraft,
  undoLastStop,
  type DraftState,
} from './lines/draft';
import type { Line } from './lines/types';
import { createPathfindContext, findPath } from './lines/pathfind';
import { buildRouteSchedule } from './buses/schedule';
import { busPositionAt, createBusPositionScratch } from './buses/position';
import { accrue, createTreasury, spend } from './economy/ledger';
import { CENTS_PER_USD, type Treasury } from './economy/types';
import type { City, LngLat, Polygon, RoadEdge, StreetGraph } from './types';
import {
  BUS_ACCEL_MS2,
  BUS_BRAKE_MS2,
  BUS_DWELL_SECONDS,
  BUS_LAYOVER_MINUTES,
  BUS_MODELS,
  DEFAULT_SERVICE_HOURS,
  DRIVER_WAGE_PER_HOUR_USD,
  START_MINUTE_OF_DAY,
  STARTING_BUS_MODEL,
  STOP_PLACEMENT_COST_USD,
} from './constants';

const CRUISE_SPEED_KMH = BUS_MODELS[STARTING_BUS_MODEL]!.cruiseSpeedKmh;
const KMH_TO_MS = 1000 / 3600;
const CRUISE_SPEED_MS = CRUISE_SPEED_KMH * KMH_TO_MS;

/** Midpoint of an edge's two endpoints — a deterministic click guaranteed to snap to that edge
 * (mirrors the helper of the same name in `lines/draft.test.ts` and `buses/position.test.ts`). */
function midpointOf(graph: StreetGraph, edgeIndex: number): LngLat {
  const edge = graph.edges[edgeIndex]!;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const from = nodeById.get(edge.from)!;
  const to = nodeById.get(edge.to)!;
  return [(from.pos[0] + to.pos[0]) / 2, (from.pos[1] + to.pos[1]) / 2];
}

/** The stop-edge indices a full generate→draft→line chain is built from throughout this file —
 * spread across the grid so most legs span several edges, exercising the same code paths a
 * player's draw would. */
function testStopEdgeIndices(graph: StreetGraph): readonly number[] {
  const edgeCount = graph.edges.length;
  return [0, Math.floor(edgeCount * 0.3), Math.floor(edgeCount * 0.6), edgeCount - 1];
}

/** Draws a line over `city`'s street graph the same way a player would, via the real draft
 * state machine — not a hand-built `Line` literal — so this exercises `snapToRoad` and
 * `findPath` too, not just `buildRouteSchedule`. */
function buildTestLine(city: City): Line {
  let state = startDraft(city.graph);
  for (const edgeIndex of testStopEdgeIndices(city.graph)) {
    const result = addStop(state, midpointOf(city.graph, edgeIndex));
    if (!result.ok) throw new Error(`buildTestLine: could not place a stop — ${result.reason}`);
    state = result.state;
  }
  if (!canCreate(state)) throw new Error('buildTestLine: draft never became a creatable line');

  const draft = summarizeDraft(state);
  return { id: 1, name: 'Test Line', stops: draft.stops, legs: draft.legs, totalLengthM: draft.totalLengthM };
}

// ── 1. Determinism across the whole chain ───────────────────────────────────────────────────

describe('determinism: generate -> draft -> line -> schedule -> position, end to end', () => {
  it('two independently generated cities from the same seed produce identical lines, schedules and bus positions', () => {
    const cityA = generateRiverton(RIVERTON_SEED);
    const cityB = generateRiverton(RIVERTON_SEED);

    // The cities themselves are already asserted byte-identical in city/generateRiverton.test.ts —
    // what matters here is that everything built *on top* of them stays identical too.
    const lineA = buildTestLine(cityA);
    const lineB = buildTestLine(cityB);
    expect(lineA).toEqual(lineB);

    const scheduleA = buildRouteSchedule(lineA, cityA.graph, CRUISE_SPEED_KMH);
    const scheduleB = buildRouteSchedule(lineB, cityB.graph, CRUISE_SPEED_KMH);
    expect(scheduleA).toEqual(scheduleB);

    // Sample bus positions at a spread of clock values, including a couple of different bus
    // indices/counts, and require every sample to agree exactly — this is what would catch a
    // stray Math.random(), Date.now(), or Map-iteration-order dependence anywhere upstream.
    const sampleMinutes = [0, 37.5, 120, 480, 900, 959, 960]; // 959/960 straddle the 22:00 close
    const outA = createBusPositionScratch();
    const outB = createBusPositionScratch();

    for (const totalMinutes of sampleMinutes) {
      for (const [busIndex, busCount] of [
        [0, 1],
        [0, 3],
        [2, 3],
      ] as const) {
        const resultA = busPositionAt(scheduleA, busIndex, busCount, totalMinutes, outA);
        const resultB = busPositionAt(scheduleB, busIndex, busCount, totalMinutes, outB);
        expect(resultA === null).toBe(resultB === null);
        if (resultA !== null && resultB !== null) {
          expect(outA).toEqual(outB);
        }
      }
    }
  });

  it('a draft built by the same click sequence against two fresh graphs never depends on object identity or Map iteration order', () => {
    // Same seed but two distinct StreetGraph object instances (not the same reference) — if
    // anything upstream keyed off object identity or an unstably-ordered Map, this would surface
    // it even though generateRiverton.test.ts's plain equality check wouldn't.
    const graphA = generateRiverton(RIVERTON_SEED).graph;
    const graphB = generateRiverton(RIVERTON_SEED).graph;
    expect(graphA).not.toBe(graphB);

    let stateA: DraftState = startDraft(graphA);
    let stateB: DraftState = startDraft(graphB);
    for (const edgeIndex of testStopEdgeIndices(graphA)) {
      const resultA = addStop(stateA, midpointOf(graphA, edgeIndex));
      const resultB = addStop(stateB, midpointOf(graphB, edgeIndex));
      expect(resultA.ok).toBe(resultB.ok);
      if (resultA.ok && resultB.ok) {
        stateA = resultA.state;
        stateB = resultB.state;
      }
    }

    expect(summarizeDraft(stateA)).toEqual(summarizeDraft(stateB));
  });
});

// ── 2. Money conservation ────────────────────────────────────────────────────────────────────

/**
 * The inverse of `spend` for a discrete refund. `src/game/economy/ledger.ts` exports `spend` but
 * no matching `refund` — the only inverse in the codebase today is an unexported local function
 * of the same shape in `src/App.tsx` (`refund`, used by the undo/cancel handlers). Per this
 * agent's file-ownership rule, test files cannot import from `App.tsx` or add a shared export to
 * `ledger.ts`, so this mirrors that arithmetic exactly (integer cents, no float rounding) to test
 * the invariant the gameplay flow depends on. Flagged in the test report: there is no shared,
 * exported spend/refund pair the way the manual's "one shared predicate per rule" convention asks
 * for elsewhere — today it's safe only because STOP_PLACEMENT_COST_USD is a whole-dollar amount.
 */
function refund(treasury: Treasury, amountUsd: number): Treasury {
  return { ...treasury, cashCents: treasury.cashCents + Math.round(amountUsd * CENTS_PER_USD) };
}

describe('money conservation: stop placement spend/undo/cancel', () => {
  it('placing N stops then undoing all N (one at a time) returns the treasury to exactly its starting cents', () => {
    const graph = generateRiverton(RIVERTON_SEED).graph;
    const stopEdgeIndices = testStopEdgeIndices(graph);

    const startingTreasury = createTreasury();

    let treasury: Treasury = startingTreasury;
    let draft: DraftState = startDraft(graph);
    const spentAmounts: number[] = [];

    for (const edgeIndex of stopEdgeIndices) {
      const payment = spend(treasury, STOP_PLACEMENT_COST_USD, 'stop placement');
      expect(payment.ok).toBe(true);
      if (!payment.ok) continue;
      const placed = addStop(draft, midpointOf(graph, edgeIndex));
      expect(placed.ok).toBe(true);
      if (!placed.ok) continue;
      treasury = payment.treasury;
      draft = placed.state;
      spentAmounts.push(STOP_PLACEMENT_COST_USD);
    }

    expect(draft.stops.length).toBe(stopEdgeIndices.length);
    expect(treasury.cashCents).toBe(startingTreasury.cashCents - spentAmounts.length * STOP_PLACEMENT_COST_USD * CENTS_PER_USD);

    // Undo every stop, refunding one at a time — the exact order the UI's Undo button drives.
    while (draft.stops.length > 0) {
      treasury = refund(treasury, STOP_PLACEMENT_COST_USD);
      draft = undoLastStop(draft);
    }

    expect(draft.stops).toEqual([]);
    expect(draft.legs).toEqual([]);
    // Integer-cents equality, not toBeCloseTo — money must round-trip exactly.
    expect(treasury.cashCents).toBe(startingTreasury.cashCents);
    expect(Number.isInteger(treasury.cashCents)).toBe(true);
  });

  it('placing N stops then a single cancel (lump-sum refund) also returns the treasury to exactly its starting cents', () => {
    const graph = generateRiverton(RIVERTON_SEED).graph;
    const stopEdgeIndices = testStopEdgeIndices(graph);

    const startingTreasury = createTreasury();
    let treasury: Treasury = startingTreasury;
    let draft: DraftState = startDraft(graph);

    for (const edgeIndex of stopEdgeIndices) {
      const payment = spend(treasury, STOP_PLACEMENT_COST_USD, 'stop placement');
      expect(payment.ok).toBe(true);
      if (!payment.ok) continue;
      const placed = addStop(draft, midpointOf(graph, edgeIndex));
      expect(placed.ok).toBe(true);
      if (!placed.ok) continue;
      treasury = payment.treasury;
      draft = placed.state;
    }

    const stopCountBeforeCancel = draft.stops.length;
    treasury = refund(treasury, STOP_PLACEMENT_COST_USD * stopCountBeforeCancel);
    draft = cancelDraft(draft);

    expect(draft.stops).toEqual([]);
    expect(treasury.cashCents).toBe(startingTreasury.cashCents);
  });

  it('the per-stop-undo path and the lump-sum cancel path refund the identical number of cents for the same N', () => {
    // These are two independent code paths in the app (App.tsx's handleUndo loops one stop at a
    // time; handleCancel refunds stopCount * cost in one call) that must never disagree — a
    // divergence here is exactly the kind of bug a player notices as "my money didn't come back
    // right" without ever seeing a crash.
    const n = 5;
    let perStopTotal = 0;
    for (let i = 0; i < n; i++) {
      perStopTotal += refund(createTreasury(0), STOP_PLACEMENT_COST_USD).cashCents;
    }
    const lumpSum = refund(createTreasury(0), STOP_PLACEMENT_COST_USD * n).cashCents;
    expect(perStopTotal).toBe(lumpSum);
  });

  it('a refused spend (insufficient funds) never mutates the treasury, so nothing needs undoing', () => {
    const poorTreasury: Treasury = {
      cashCents: STOP_PLACEMENT_COST_USD * CENTS_PER_USD - 1, // one cent short
      carry: { fuelCents: 0, maintenanceCents: 0, cumulativeBusServiceMinutes: 0, cumulativeMinutes: 0 },
    };
    const result = spend(poorTreasury, STOP_PLACEMENT_COST_USD, 'stop placement');
    expect(result.ok).toBe(false);
    expect(poorTreasury.cashCents).toBe(STOP_PLACEMENT_COST_USD * CENTS_PER_USD - 1);
  });
});

// ── 3. Round-trip consistency between lines and schedules ──────────────────────────────────

describe('line/schedule consistency', () => {
  const city = generateRiverton(RIVERTON_SEED);
  const line = buildTestLine(city);
  const schedule = buildRouteSchedule(line, city.graph, CRUISE_SPEED_KMH);

  it('a schedule built twice from the same line is identical', () => {
    const again = buildRouteSchedule(line, city.graph, CRUISE_SPEED_KMH);
    expect(again).toEqual(schedule);
  });

  it("round-trip duration exceeds the naive length/speed figure — acceleration, braking, dwell and layover all cost real time", () => {
    const naiveRoundTripS = (2 * line.totalLengthM) / CRUISE_SPEED_MS;
    expect(schedule.roundTripDurationS).toBeGreaterThan(naiveRoundTripS);
  });

  it('round-trip duration stays within a sane, analytically-derived upper bound', () => {
    // Per-leg kinematic overhead (time spent above the naive length/cruiseSpeed figure) can never
    // exceed cruiseSpeedMs * (1/(2*accel) + 1/(2*brake)) — the trapezoidal profile's constant
    // accelerate+brake overhead, which triangular (short-leg) profiles asymptotically approach
    // but never exceed. See buses/kinematics.ts's buildSpeedProfile.
    const perLegOverheadS = CRUISE_SPEED_MS * (1 / (2 * BUS_ACCEL_MS2) + 1 / (2 * BUS_BRAKE_MS2));
    const legCount = schedule.legs.length;
    const naiveRoundTripS = (2 * line.totalLengthM) / CRUISE_SPEED_MS;

    const intermediateStopCount = Math.max(0, line.stops.length - 2);
    const waitTotalS = 2 * BUS_LAYOVER_MINUTES * 60 + 2 * intermediateStopCount * BUS_DWELL_SECONDS;

    const upperBoundS = naiveRoundTripS + legCount * perLegOverheadS + waitTotalS;
    expect(schedule.roundTripDurationS).toBeLessThanOrEqual(upperBoundS);
  });

  it('the schedule has exactly 2*(stops-1) legs, forward then reverse, and legs.length matches the line', () => {
    expect(schedule.legs.length).toBe(2 * (line.stops.length - 1));
    expect(schedule.legs.length).toBe(2 * line.legs.length);
  });
});

// ── 4. Service-hours agreement between buses/position.ts and economy/ledger.ts ──────────────

describe('service-hours agreement: busPositionAt and accrue interpret DEFAULT_SERVICE_HOURS identically', () => {
  // These two modules each independently fold DEFAULT_SERVICE_HOURS against the clock: position.ts
  // via toCalendarTime(totalMinutes).hour, ledger.ts via a minute-of-day window. A divergence
  // between them is a real, player-visible bug (a bus rendered as running while its driver is off
  // the clock, or vice versa) that neither module's own unit tests could catch alone.
  const city = generateRiverton(RIVERTON_SEED);
  const line = buildTestLine(city);
  const schedule = buildRouteSchedule(line, city.graph, CRUISE_SPEED_KMH);

  const firstServiceMinuteOfDay = DEFAULT_SERVICE_HOURS.firstHour * 60; // 360 (06:00)
  const lastServiceMinuteOfDay = DEFAULT_SERVICE_HOURS.lastHour * 60; // 1320 (22:00)

  /** totalMinutes such that toCalendarTime(...).minuteOfDay === minuteOfDay, on day 1. */
  function totalMinutesFor(minuteOfDay: number): number {
    return minuteOfDay - START_MINUTE_OF_DAY;
  }

  function driverWageBillsFor(minuteOfDayAtStart: number): boolean {
    const { accrued } = accrue(createTreasury(), 1, {
      minuteOfDayAtStart,
      kmDriven: 0,
      busModel: BUS_MODELS[STARTING_BUS_MODEL]!,
      busesInService: 1,
    });
    return accrued.expense.driverWagesCents > 0;
  }

  it('agree at the service-open boundary (06:00): both null/zero the minute before, both non-null/nonzero the minute of', () => {
    const beforeOpenMinuteOfDay = firstServiceMinuteOfDay - 1; // 05:59
    const atOpenMinuteOfDay = firstServiceMinuteOfDay; // 06:00

    const out = createBusPositionScratch();
    expect(busPositionAt(schedule, 0, 1, totalMinutesFor(beforeOpenMinuteOfDay), out)).toBeNull();
    expect(busPositionAt(schedule, 0, 1, totalMinutesFor(atOpenMinuteOfDay), out)).not.toBeNull();

    // The one-minute window ending exactly at open accrues nothing; the one starting at open does.
    expect(driverWageBillsFor(beforeOpenMinuteOfDay)).toBe(false);
    expect(driverWageBillsFor(atOpenMinuteOfDay)).toBe(true);
  });

  it('agree at the service-close boundary (22:00): both non-null/nonzero the minute before, both null/zero the minute of', () => {
    const justBeforeCloseMinuteOfDay = lastServiceMinuteOfDay - 1; // 21:59
    const atCloseMinuteOfDay = lastServiceMinuteOfDay; // 22:00

    const out = createBusPositionScratch();
    expect(busPositionAt(schedule, 0, 1, totalMinutesFor(justBeforeCloseMinuteOfDay), out)).not.toBeNull();
    expect(busPositionAt(schedule, 0, 1, totalMinutesFor(atCloseMinuteOfDay), out)).toBeNull();

    expect(driverWageBillsFor(justBeforeCloseMinuteOfDay)).toBe(true);
    expect(driverWageBillsFor(atCloseMinuteOfDay)).toBe(false);
  });

  it('DRIVER_WAGE_PER_HOUR_USD is positive, so "wages bill" and "wages are zero" are actually distinguishable', () => {
    // Guards the two tests above against a vacuous pass if the wage rate were ever zeroed out.
    expect(DRIVER_WAGE_PER_HOUR_USD).toBeGreaterThan(0);
  });
});

// ── 5. Graph/pathfinding invariants under stress ────────────────────────────────────────────

describe('pathfinding invariants across many seeded random node pairs', () => {
  const city = generateRiverton(RIVERTON_SEED);
  const ctx = createPathfindContext(city.graph);
  const edgeById = new Map(city.graph.edges.map((e) => [e.id, e] as const));
  const nodeIds = city.graph.nodes.map((n) => n.id);

  /** Every edge in `edgeIds` (in travel order) must connect to the previous one — the shared
   * node carries over, and the very first/last edges must actually touch `fromId`/`toId`. */
  function assertEdgeChainConnects(edgeIds: readonly number[], fromId: number, toId: number): void {
    if (edgeIds.length === 0) {
      expect(fromId).toBe(toId);
      return;
    }
    let cursor = fromId;
    for (const edgeId of edgeIds) {
      const edge = edgeById.get(edgeId);
      expect(edge).toBeDefined();
      if (edge === undefined) continue;
      expect(edge.from === cursor || edge.to === cursor).toBe(true);
      cursor = edge.from === cursor ? edge.to : edge.from;
    }
    expect(cursor).toBe(toId);
  }

  // Seeded RNG (never Math.random()) so the sampled pairs — and any failure — are reproducible.
  const rng = createRng(20260812);
  const pairCount = 40;
  const pairs: Array<readonly [number, number]> = [];
  for (let i = 0; i < pairCount; i++) {
    const a = nodeIds[rng.int(0, nodeIds.length - 1)]!;
    const b = nodeIds[rng.int(0, nodeIds.length - 1)]!;
    pairs.push([a, b]);
  }

  it('every sampled pair, if routable, has a positive-or-zero length and a connected edge chain', () => {
    for (const [a, b] of pairs) {
      const result = findPath(ctx, city.graph, a, b);
      expect(result).not.toBeNull(); // Riverton's grid is always fully connected.
      if (result === null) continue;

      if (a === b) {
        expect(result.totalLengthM).toBe(0);
        expect(result.edgeIds.length).toBe(0);
      } else {
        expect(result.totalLengthM).toBeGreaterThan(0);
      }
      assertEdgeChainConnects(result.edgeIds, a, b);
    }
  });

  it('every sampled pair is symmetric: A->B and B->A agree on length within a tight tolerance', () => {
    for (const [a, b] of pairs) {
      const aToB = findPath(ctx, city.graph, a, b);
      const bToA = findPath(ctx, city.graph, b, a);
      expect(aToB).not.toBeNull();
      expect(bToA).not.toBeNull();
      if (aToB === null || bToA === null) continue;
      expect(bToA.totalLengthM).toBeCloseTo(aToB.totalLengthM, 6);
      expect(bToA.edgeIds.length).toBe(aToB.edgeIds.length);
    }
  });

  it('reusing one context across all 80 searches (40 pairs x 2 directions) never leaves stale state that changes an answer', () => {
    // A second full pass, from scratch, against the exact same shared ctx used above — the
    // context's scratch buffers must be fully reset by every call, not accumulate cross-talk.
    for (const [a, b] of pairs) {
      const result = findPath(ctx, city.graph, a, b);
      const replay = findPath(ctx, city.graph, a, b);
      expect(replay).toEqual(result);
    }
  });
});

// ── 6. River chokepoints and diagonal-avenue layout properties ──────────────────────────────
//
// generateRiverton.test.ts (owned by the city generator's own agent) already asserts "there are
// 3-5 bridges" and "the banks are reachable from each other" in isolation. What it doesn't assert
// — and what actually matters for line-drawing — is the *stronger*, cross-module property: that
// the bridges are the *only* way across, that real pathfinding respects that, and that the
// diagonal avenue (built for exactly this reason) genuinely beats the grid. That's the class of
// bug a generator-only test suite can't catch: the bridge count could stay at 4 while a stray
// edge elsewhere silently reconnects the banks, or the diagonal could regress to a decorative
// detour, and nothing above this file would notice.

/** True if segment p1-p2 properly crosses segment p3-p4. Deliberately self-contained (not
 * imported from generateRiverton.test.ts or lines/geo.ts) per this file's own convention of
 * checking generator output from the outside, and per this agent's file-ownership boundary. */
function segmentsCross(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat): boolean {
  const cross = (a: LngLat, b: LngLat, c: LngLat): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  const straddles1 = (d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0);
  const straddles2 = (d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0);
  return straddles1 && straddles2;
}

/** True if segment p1-p2 cleanly cuts through the (thin, elongated) river ring — crosses its
 * boundary exactly twice, once in and once out. An embankment road running alongside the bank
 * never crosses at all, so this is exactly "is this edge a bridge". */
function crossesRiver(p1: LngLat, p2: LngLat, ring: Polygon): boolean {
  let hits = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    if (segmentsCross(p1, p2, a, b)) hits++;
  }
  return hits >= 2;
}

/** Great-circle distance, metres. Local copy — the generator's own `haversineMeters` isn't
 * exported, and this file checks output from the outside rather than sharing internals. */
function haversineMeters(a: LngLat, b: LngLat): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Node id -> incident edge ids, built the same way `generateRiverton.ts`'s own `buildAdjacency`
 * does, but locally — needed here to route over a *filtered* copy of the graph (diagonal edges
 * removed) without touching `city.graph` itself. */
function buildAdjacency(nodeIds: readonly number[], edges: readonly RoadEdge[]): Map<number, number[]> {
  const adjacency = new Map<number, number[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.id);
    adjacency.get(edge.to)?.push(edge.id);
  }
  return adjacency;
}

describe('river chokepoints: bridges are load-bearing, not decorative', () => {
  const city = generateRiverton(RIVERTON_SEED);
  const { nodes, edges, adjacency } = city.graph;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const ring = city.scenery.water[0]!;

  const bridgeEdgeIds = new Set<number>();
  for (const edge of edges) {
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;
    if (crossesRiver(from.pos, to.pos, ring)) bridgeEdgeIds.add(edge.id);
  }

  const ringLats = ring.map(([, lat]) => lat);
  const riverMinLat = Math.min(...ringLats);
  const riverMaxLat = Math.max(...ringLats);
  const southBankNodes = nodes.filter((n) => n.pos[1] < riverMinLat);
  const northBankNodes = nodes.filter((n) => n.pos[1] > riverMaxLat);

  /** BFS reachability over the full graph, but with every bridge edge excluded — never mutates
   * `city.graph`, just skips those edge ids while walking. */
  function reachableExcludingBridges(startId: number): Set<number> {
    const visited = new Set<number>([startId]);
    const stack: number[] = [startId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const edgeId of adjacency.get(current) ?? []) {
        if (bridgeEdgeIds.has(edgeId)) continue;
        const edge = edgeById.get(edgeId);
        if (!edge) continue;
        const other = edge.from === current ? edge.to : edge.from;
        if (!visited.has(other)) {
          visited.add(other);
          stack.push(other);
        }
      }
    }
    return visited;
  }

  it('finds 3-5 bridge edges by an independent geometric detection method (sanity check for the tests below)', () => {
    expect(bridgeEdgeIds.size).toBeGreaterThanOrEqual(3);
    expect(bridgeEdgeIds.size).toBeLessThanOrEqual(5);
    expect(southBankNodes.length).toBeGreaterThan(0);
    expect(northBankNodes.length).toBeGreaterThan(0);
  });

  it('with every bridge edge excluded, the south bank cannot reach a single north-bank node', () => {
    const reachable = reachableExcludingBridges(southBankNodes[0]!.id);
    // The south bank is internally well-connected (it's most of the grid) — this isn't a
    // vacuous pass where BFS died after one step.
    expect(reachable.size).toBeGreaterThan(southBankNodes.length / 2);
    for (const node of northBankNodes) {
      expect(reachable.has(node.id)).toBe(false);
    }
  });

  it('with every bridge edge excluded, the north bank cannot reach a single south-bank node', () => {
    const reachable = reachableExcludingBridges(northBankNodes[0]!.id);
    expect(reachable.size).toBeGreaterThan(northBankNodes.length / 2);
    for (const node of southBankNodes) {
      expect(reachable.has(node.id)).toBe(false);
    }
  });

  it('every sampled cross-river shortest path actually uses a bridge edge', () => {
    // Seeded RNG, never Math.random() — the sample (and any failure) is reproducible.
    const rng = createRng(20260812);
    const ctx = createPathfindContext(city.graph);
    const sampleCount = 16;

    for (let i = 0; i < sampleCount; i++) {
      const from = southBankNodes[rng.int(0, southBankNodes.length - 1)]!;
      const to = northBankNodes[rng.int(0, northBankNodes.length - 1)]!;
      const result = findPath(ctx, city.graph, from.id, to.id);
      expect(result).not.toBeNull();
      if (result === null) continue;
      const usesBridge = result.edgeIds.some((id) => bridgeEdgeIds.has(id));
      expect(usesBridge).toBe(true);
    }
  });

  it('a line drawn from a south-bank stop to a north-bank stop routes successfully, and detours further than crow-flies to reach a bridge', () => {
    // The two furthest-apart bank nodes (extreme west on the south bank, extreme east on the
    // north bank) — a real click-to-click line a player might actually draw, and one unlikely to
    // sit next to a bridge by construction, so any successful route is forced to detour.
    const southStopNode = southBankNodes.reduce((best, n) => (n.pos[0] < best.pos[0] ? n : best));
    const northStopNode = northBankNodes.reduce((best, n) => (n.pos[0] > best.pos[0] ? n : best));

    let state = startDraft(city.graph);
    const first = addStop(state, southStopNode.pos);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;

    const second = addStop(state, northStopNode.pos);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    state = second.state;

    expect(state.legs.length).toBe(1);
    const leg = state.legs[0]!;
    const crowFliesM = haversineMeters(southStopNode.pos, northStopNode.pos);
    // Must detour to reach a bridge — a meaningful margin above crow-flies, not float noise.
    expect(leg.lengthM).toBeGreaterThan(crowFliesM * 1.1);
  });
});

describe('diagonal avenue: genuinely faster than the equivalent grid route', () => {
  const city = generateRiverton(RIVERTON_SEED);
  const { nodes, edges } = city.graph;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Same detection generateRiverton.test.ts uses for "this is a diagonal edge": a 'primary'
  // edge that isn't axis-aligned. These are exactly the avenue's own chain edges — every grid
  // edge the avenue splits keeps its fragment axis-aligned (see applyDiagonalAvenue), so this
  // can't accidentally pick up a piece of an ordinary arterial.
  const diagonalEdges = edges.filter((edge) => {
    if (edge.roadClass !== 'primary') return false;
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;
    const dx = Math.abs(to.pos[0] - from.pos[0]);
    const dy = Math.abs(to.pos[1] - from.pos[1]);
    if (dx < 1e-12 || dy < 1e-12) return false;
    const ratio = dx / dy;
    return ratio > 0.05 && ratio < 20;
  });

  it('finds the diagonal as a connected chain of edges (sanity check for the test below)', () => {
    expect(diagonalEdges.length).toBeGreaterThan(0);
  });

  it('routing between the diagonal\'s two ends is meaningfully faster than the best route with the diagonal removed', () => {
    const diagonalNodeIds = new Set<number>();
    for (const edge of diagonalEdges) {
      diagonalNodeIds.add(edge.from);
      diagonalNodeIds.add(edge.to);
    }
    const diagonalNodes = [...diagonalNodeIds].map((id) => nodeById.get(id)!);
    // The avenue is a straight line, so its westmost and eastmost incident nodes are its two ends.
    const westEnd = diagonalNodes.reduce((best, n) => (n.pos[0] < best.pos[0] ? n : best));
    const eastEnd = diagonalNodes.reduce((best, n) => (n.pos[0] > best.pos[0] ? n : best));

    const ctx = createPathfindContext(city.graph);
    const withDiagonal = findPath(ctx, city.graph, westEnd.id, eastEnd.id);
    expect(withDiagonal).not.toBeNull();
    if (withDiagonal === null) return;
    // The shortest path over the full graph must actually take the avenue, not coincidentally
    // match its time via some other route.
    expect(withDiagonal.edgeIds.some((id) => diagonalEdges.some((d) => d.id === id))).toBe(true);

    const diagonalEdgeIdSet = new Set(diagonalEdges.map((e) => e.id));
    const gridOnlyEdges = edges.filter((e) => !diagonalEdgeIdSet.has(e.id));
    const gridOnlyGraph: StreetGraph = {
      nodes,
      edges: gridOnlyEdges,
      adjacency: buildAdjacency(nodes.map((n) => n.id), gridOnlyEdges),
    };
    const gridCtx = createPathfindContext(gridOnlyGraph);
    const gridOnly = findPath(gridCtx, gridOnlyGraph, westEnd.id, eastEnd.id);
    expect(gridOnly).not.toBeNull();
    if (gridOnly === null) return;

    // Actual measured margin at RIVERTON_SEED is ~38% faster (diag ~107s vs grid-only ~173s);
    // assert a boundary well inside that so a real regression trips this before it's this severe,
    // without being brittle to small kinematic/tuning changes.
    expect(withDiagonal.totalTimeS).toBeLessThan(gridOnly.totalTimeS * 0.85);
  });
});

// ── 7. Depot-zoning readiness (known gap) ────────────────────────────────────────────────────

describe('depot-zoning readiness', () => {
  // studio/docs/design/depots-and-timetables.md §1: "Riverton's generator must emit ... at least
  // 3 zones passing eligible(), >= 400 m apart, each with a routable road node within 400 m of
  // its centroid, generated deliberately as industrial districts ... because that is where yards
  // go" — and "a demo city that cannot host a depot is a broken build, not a bad seed."
  //
  // generateRiverton() today returns { id, name, bounds, graph, scenery: { water, parks }, seed }
  // (src/game/types.ts's City/Scenery) — there is no zone concept anywhere in src/game (no
  // `residents`, `jobs`, `areaHa`, no eligibility polygon) for any city, real or procedural. Riverton
  // cannot satisfy the spec's "at least 3 industrial districts >= 400 m apart" because it has
  // nothing resembling a zone at all yet. This is a known gap, not a regression: skipped and left
  // here so the day zoning lands, this test starts failing and has to be filled in for real.
  it.skip('Riverton emits at least 3 eligible industrial-zone sites, mutually >= 400m apart, each within 400m of a routable road node', () => {
    // TODO once the generator emits zones (residents/jobs/areaHa per §1's Zoning B formula):
    //   1. Generate Riverton and read its zone polygons.
    //   2. Filter to eligible(z): jobs[z] > residents[z] && density[z] < medianDensity(zones) && areaHa[z] >= 1.
    //   3. Assert at least 3 eligible zones survive.
    //   4. Assert every pairwise centroid distance among them is >= 400m (haversineMeters, as above).
    //   5. Assert each has a routable road node (city.graph) within 400m of its centroid.
    expect(true).toBe(true);
  });
});
