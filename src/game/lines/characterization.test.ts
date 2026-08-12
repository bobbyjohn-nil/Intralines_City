/**
 * Characterization tests, written ahead of three planned refactors to `Line`/`Stop`
 * (studio/docs/design/save-format.md §5), now landed:
 *
 *   1. Hoist stops out of `Line` — `Line.stops: Stop[]` became a top-level `stops[]` with
 *      `line.stopIds: StopId[]`, so a stop shared by two lines is stored once. (The top-level
 *      collection itself lives in `App.tsx`, alongside `lines`; this file builds its own small
 *      one per test, the same shape, to stay independent of the app layer.)
 *   2. Stable ids — stop and line ids stopped being array indices and became monotonic,
 *      never-reused ids (`StopId`/`LineId`, branded) drawn from a counter threaded across drafts
 *      (`DraftState.nextStopId`) that will eventually be the persisted `nextIds`.
 *   3. `roadClass` on `Stop`, plus derived `orphaned`/`movedM`, so a saved stop can eventually
 *      re-anchor by position rather than by `edgeId` (the re-anchor pass itself is still out of
 *      scope — only the fields it needs exist so far).
 *
 * These changed the shape of `Line` and `Stop` everywhere at once. The type system alone
 * wouldn't have caught a behavioural drift — everything can still compile with the wrong
 * numbers — so every test here pins an *observable* property (ordering, totals, independence,
 * geometry-only dependence) rather than the representation, and says in a comment which of the
 * three refactors could plausibly break it. One assertion (§4) was expected to flip once ids
 * went global, and did — see its comment for what's true now and why.
 *
 * Fixture: a hand-built 3x3 rectilinear `StreetGraph` (`buildGridGraph`, below) — not
 * `generateRiverton`. This file used to build every draft against `generateRiverton(RIVERTON_SEED)`,
 * and its one pinned number (`totalLengthM`) broke three times in one day for reasons that had
 * nothing to do with the draft/line behaviour this file exists to protect: the diagonal avenue's
 * extension, the stop-hoisting refactor's shape change, and enlarged parks carving new interior
 * streets each moved which physical edges the seeded click indices happened to land on, without
 * any of the ordering/undo/id/schedule logic actually changing. This file is not the city
 * generator's test — `city/generateRiverton.test.ts` owns that, comprehensively — and has no
 * business re-breaking every time the city does. A small graph this file owns outright (nine
 * nodes, twelve 500 m residential blocks, no diagonal, nothing generated) makes every number here
 * arithmetic over geometry nobody but this file can change, so the pins mean what they say again.
 * Coverage of drafting/scheduling against the *real* generated city already lives elsewhere —
 * `integration.test.ts` ("determinism: generate -> draft -> line -> schedule -> position, end to
 * end", "line/schedule consistency", "pathfinding invariants across many seeded random node
 * pairs") and `city/generateRiverton.test.ts` itself — so nothing is lost by moving this file off
 * it; nothing here was actually exercising the city generator, only riding on top of it.
 */
import { describe, expect, it } from 'vitest';
import type { LngLat, RoadEdge, RoadNode, StreetGraph } from '../types';
import { BUS_DWELL_SECONDS, BUS_LAYOVER_MINUTES, BUS_MODELS, STARTING_BUS_MODEL, STOP_PLACEMENT_COST_USD } from '../constants';
import { addStop, startDraft, summarizeDraft, undoLastStop, type DraftState } from './draft';
import { buildRouteSchedule } from '../buses/schedule';
import { metersBetween } from '../buses/geo';
import { fromLocalMeters } from './geo';
import type { Draft, Line, LineId, Stop, StopId } from './types';

// ── Fixture: a small, hand-built grid this file owns outright ──────────────────────────────
//
//   6 ── 7 ── 8      row 2
//   │    │    │
//   3 ── 4 ── 5      row 1
//   │    │    │
//   0 ── 1 ── 2      row 0
//
// Nine nodes, twelve 500 m blocks, every edge `residential` — one road class, so Dijkstra's
// time-weighting reduces to plain distance and every route below is hand-checkable. Edge ids:
// 0-1 are row 0's horizontals (left to right), 2-3 row 1's, 4-5 row 2's; 6-7 are column 0's
// verticals (bottom to top), 8-9 column 1's, 10-11 column 2's.

const GRID_ORIGIN: LngLat = [-89.5, 41.0];
const BLOCK_M = 500;

function buildGridGraph(): StreetGraph {
  const nodeId = (col: number, row: number): number => row * 3 + col;

  const nodes: RoadNode[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      nodes.push({ id: nodeId(col, row), pos: fromLocalMeters(GRID_ORIGIN, col * BLOCK_M, row * BLOCK_M) });
    }
  }

  const edgeEndpoints: readonly (readonly [from: number, to: number])[] = [
    [nodeId(0, 0), nodeId(1, 0)],
    [nodeId(1, 0), nodeId(2, 0)],
    [nodeId(0, 1), nodeId(1, 1)],
    [nodeId(1, 1), nodeId(2, 1)],
    [nodeId(0, 2), nodeId(1, 2)],
    [nodeId(1, 2), nodeId(2, 2)],
    [nodeId(0, 0), nodeId(0, 1)],
    [nodeId(0, 1), nodeId(0, 2)],
    [nodeId(1, 0), nodeId(1, 1)],
    [nodeId(1, 1), nodeId(1, 2)],
    [nodeId(2, 0), nodeId(2, 1)],
    [nodeId(2, 1), nodeId(2, 2)],
  ];

  const edges: RoadEdge[] = edgeEndpoints.map(([from, to], id) => ({
    id,
    from,
    to,
    roadClass: 'residential',
    lengthM: BLOCK_M,
  }));

  const adjacency = new Map<number, number[]>(nodes.map((n) => [n.id, [] as number[]]));
  for (const edge of edges) {
    adjacency.get(edge.from)!.push(edge.id);
    adjacency.get(edge.to)!.push(edge.id);
  }

  return { nodes, edges, adjacency };
}

const grid = buildGridGraph();
const CRUISE_SPEED_KMH = BUS_MODELS[STARTING_BUS_MODEL]!.cruiseSpeedKmh;

/** Midpoint of an edge's two endpoints — a deterministic click guaranteed to snap to that edge
 * (mirrors the helper of the same name in `draft.test.ts` and `integration.test.ts`). */
function midpointOf(graph: StreetGraph, edge: RoadEdge): LngLat {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const from = nodeById.get(edge.from)!;
  const to = nodeById.get(edge.to)!;
  return [(from.pos[0] + to.pos[0]) / 2, (from.pos[1] + to.pos[1]) / 2];
}

/** Four edges chosen to force genuine multi-block routing between every consecutive pair, rather
 * than four points that happen to lie on one street: edge 0 (row 0, left), edge 3 (row 1,
 * right), edge 7 (column 0, top), edge 10 (column 2, bottom). See "totals the recorded length..."
 * below for the routed lengths this produces, worked by hand against the grid above. */
const SEEDED_EDGE_INDICES = [0, 3, 7, 10] as const;

/** Draws a line over `graph` via the real draft state machine, from a fixed sequence of clicks,
 * the same way a player would — not a hand-built `Draft` literal. */
function buildSeededDraft(graph: StreetGraph, edgeIndices: readonly number[] = SEEDED_EDGE_INDICES): DraftState {
  let state = startDraft(graph);
  for (const edgeIndex of edgeIndices) {
    const result = addStop(state, midpointOf(graph, graph.edges[edgeIndex]!));
    if (!result.ok) throw new Error(`buildSeededDraft: could not place a stop — ${result.reason}`);
    state = result.state;
  }
  return state;
}

function toLine(id: LineId, name: string, draft: Draft): Line {
  return { id, name, stopIds: draft.stops.map((stop) => stop.id), legs: draft.legs, totalLengthM: draft.totalLengthM };
}

// ── 1. Stop ordering is route order ─────────────────────────────────────────────────────────

describe('stop ordering along a line is the route order', () => {
  // Protects: refactor 1 (hoisting stops out of Line) and refactor 2 (stable ids). Before the
  // hoist, `legs[i]` connected `stops[i]` to `stops[i+1]` by array position; now `stops` lives in
  // a top-level collection and a line only carries `stopIds[]`, and ids are no longer array
  // indices either. This asserts the *relationship* that survives both changes — leg i's
  // endpoints are stopIds i and i+1, identified by id, not by trusting array position.
  const draft = summarizeDraft(buildSeededDraft(grid));
  const line = toLine(1 as LineId, 'Test Line', draft);

  it('has exactly stopIds.length - 1 legs', () => {
    expect(line.legs.length).toBe(line.stopIds.length - 1);
  });

  it('legs[i] connects stopIds[i] to stopIds[i+1], for every consecutive pair', () => {
    expect(line.stopIds.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < line.legs.length; i++) {
      const leg = line.legs[i]!;
      expect(leg.fromStopId).toBe(line.stopIds[i]);
      expect(leg.toStopId).toBe(line.stopIds[i + 1]);
    }
  });
});

// ── 2. A specific seeded draft's summary numbers ────────────────────────────────────────────

describe('a seeded draft\'s summary numbers on the hand-built grid fixture', () => {
  // Protects: all three refactors. `summarizeDraft` folds stop count, geometry (totalLengthM,
  // round-trip minutes) and placement cost from a fixed, deterministic click sequence
  // (`SEEDED_EDGE_INDICES` against the grid fixture above). Every number below is arithmetic over
  // that fixture, not a measurement of a generated city — see the module comment for why that
  // distinction is the whole point of this file living on its own graph now.
  const draft = summarizeDraft(buildSeededDraft(grid));

  it('places exactly 4 stops', () => {
    expect(draft.stopCount).toBe(4);
    expect(draft.stops.length).toBe(4);
  });

  it('totals the recorded length, round-trip time and placement cost', () => {
    // Boundary, not a pin: routed length can never be shorter than the straight-line sum between
    // consecutive stops (triangle inequality) — a real lower bound, not a guess — and a 500 m-block
    // grid shouldn't ever need more than a few times that to actually drive it. This catches
    // totalLengthM being wrong by an order of magnitude (wrong units, a duplicated leg, a route
    // through the wrong graph) independently of whatever its pinned value below happens to be.
    const straightLineSumM = draft.stops
      .slice(1)
      .reduce((sum, stop, i) => sum + metersBetween(draft.stops[i]!.position, stop.position), 0);
    expect(draft.totalLengthM).toBeGreaterThanOrEqual(straightLineSumM);
    expect(draft.totalLengthM).toBeLessThanOrEqual(straightLineSumM * 3);

    // The pin itself, now arithmetic over a graph this file owns rather than a measurement of a
    // generated city. In local metres from the grid's origin, the four seeded stops land at
    // (250, 0), (750, 500), (0, 750), (1000, 250) — midpoints of edges 0, 3, 7, 10. With one
    // residential road class, Dijkstra's time-weighting is just distance, so each leg's shortest
    // route is checkable by hand:
    //   stop1 -> stop2: (250,0) -> node1(500,0) -> node4(500,500) -> (750,500)  =  250+500+250 = 1000 m
    //   stop2 -> stop3: (750,500) -> node4(500,500) -> node3(0,500) -> (0,750)  =  250+500+250 = 1000 m
    //   stop3 -> stop4: (0,750) -> node3(0,500) -> node4(500,500) -> node5(1000,500) -> (1000,250)
    //                  =  250+500+500+250 = 1500 m
    // Total: 1000 + 1000 + 1500 = 3500 m exactly. A future change to Riverton cannot move this,
    // because nothing here depends on Riverton — only a change to routing/ordering/geometry logic
    // itself, or to this fixture, can.
    expect(draft.totalLengthM).toBeCloseTo(3500, 6);

    // Round-trip minutes is checked *relationally* rather than as a second independent pinned
    // float: it must equal the same arithmetic a reviewer would do by hand from the pinned length
    // above, the starting bus model's cruise speed, and the dwell/layover constants — driving both
    // directions, both intermediate stops' dwell counted twice, and a layover at each terminus
    // counted twice (see `summarizeDraft`'s own comment in `draft.ts`). A purely geometric change
    // now moves this number automatically along with totalLengthM instead of needing its own
    // re-pin, while a change to the *formula* — wrong speed, a dropped ×2, a swapped dwell/layover
    // constant — still fails loudly, because it would no longer match this independently-derived
    // expectation.
    const intermediateStopCount = draft.stopCount - 2;
    const cruiseSpeedMs = (CRUISE_SPEED_KMH * 1000) / 3600;
    const expectedRoundTripMinutes =
      (2 * draft.totalLengthM) / cruiseSpeedMs / 60 +
      (2 * intermediateStopCount * BUS_DWELL_SECONDS) / 60 +
      2 * BUS_LAYOVER_MINUTES;
    expect(draft.estimatedRoundTripMinutes).toBeCloseTo(expectedRoundTripMinutes, 6);

    // Placement cost read live from the constant, not a second literal that would need updating in
    // lockstep with STOP_PLACEMENT_COST_USD every time that number tunes.
    expect(draft.placementCostUsd).toBe(draft.stopCount * STOP_PLACEMENT_COST_USD);
  });
});

// ── 3. Undo is exactly inverse to add ───────────────────────────────────────────────────────

describe('undo is exactly inverse to add', () => {
  // Protects: refactor 2 (stable ids) most directly — a monotonic, never-reused id counter means
  // "undo three times" must not merely empty the stop list, it must return to a state that is
  // indistinguishable from a draft that never placed anything (in particular, the *next* stop
  // placed afterward must not skip or reuse ids because three were burned and rolled back).
  // Also guards refactor 1: once stops live in a separate top-level array, undo must still leave
  // that array (and the line's stopIds) exactly where a fresh draft started, not just "empty".
  it('adding three stops then undoing three times equals the fresh draft, not merely an empty one', () => {
    const initial = startDraft(grid);
    const edgeIndices = SEEDED_EDGE_INDICES.slice(0, 3);

    let state = initial;
    for (const edgeIndex of edgeIndices) {
      const result = addStop(state, midpointOf(grid, grid.edges[edgeIndex]!));
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    }
    expect(state.stops.length).toBe(3);

    state = undoLastStop(state);
    state = undoLastStop(state);
    state = undoLastStop(state);

    // Not just "stops is empty" — deep-equal to the actual fresh draft state captured before any
    // stop was placed, including the parts an "empty check" alone would miss.
    expect(state).toEqual(initial);
  });
});

// ── 4. Two lines sharing a stop location ────────────────────────────────────────────────────

describe('two lines whose stops snap to the same road position', () => {
  // This was the case refactor 1+2 exist to fix: before stable ids, every draft numbered its own
  // stops from 0, so two *independently drawn* lines that happened to click the same spot ended
  // up with colliding ids despite fully duplicated (never shared) Stop data. `nextStopId` is now
  // threaded from one draft to the next — draft A "commits" its ending counter to draft B's
  // start — the same way `App.tsx`'s `handleCreate` advances its own counter only once a draft
  // actually becomes a line.
  const clickA = midpointOf(grid, grid.edges[0]!);
  const clickB = midpointOf(grid, grid.edges[5]!);

  let nextStopId = 0 as StopId;

  function draftFromClicks(clicks: readonly LngLat[]): Draft {
    let state = startDraft(grid, nextStopId);
    for (const click of clicks) {
      const result = addStop(state, click);
      if (!result.ok) throw new Error(`draftFromClicks: ${result.reason}`);
      state = result.state;
    }
    nextStopId = state.nextStopId;
    return summarizeDraft(state);
  }

  const draftA = draftFromClicks([clickA, clickB]);
  const draftB = draftFromClicks([clickA, clickB]);
  const lineA = toLine(1 as LineId, 'Line A', draftA);
  const lineB = toLine(2 as LineId, 'Line B', draftB);

  it('the two lines are independent objects with no shared references', () => {
    expect(lineA).not.toBe(lineB);
    expect(draftA.stops).not.toBe(draftB.stops);
    expect(draftA.stops[0]).not.toBe(draftB.stops[0]);
  });

  it('their first stops land at the identical snapped position, edge and roadClass (same click) — position alone still does not imply identity', () => {
    expect(draftA.stops[0]!.position).toEqual(draftB.stops[0]!.position);
    expect(draftA.stops[0]!.edgeId).toBe(draftB.stops[0]!.edgeId);
    expect(draftA.stops[0]!.edgeT).toBe(draftB.stops[0]!.edgeT);
    expect(draftA.stops[0]!.roadClass).toBe(draftB.stops[0]!.roadClass);
    // Everything except id matches — refactor 1 hoists stops to a shared collection but doesn't
    // dedup by location, so these are still two distinct records, not one shared stop.
    const { id: idA, ...restA }: Stop = draftA.stops[0]!;
    const { id: idB, ...restB }: Stop = draftB.stops[0]!;
    expect(restA).toEqual(restB);
    expect(idA).not.toBe(idB);
  });

  it('FLIPPED by refactor 2 (stable ids): their first stops no longer collide on id', () => {
    // Was: `expect(lineA.stops[0]!.id).toBe(lineB.stops[0]!.id)` and `.toBe(0)` — every draft
    // numbered its own stops from 0 (a per-draft counter, `id: state.stops.length`), so two
    // independently created lines' first stops always landed on the same id despite being fully
    // distinct records (see the `it` above). Now ids are global and monotonic
    // (`DraftState.nextStopId`, mirroring the persisted `nextIds.stop` from save-format.md §5),
    // threaded from draft to draft rather than reset — so two lines can never again share a stop
    // id. Draft A above spent ids 0 and 1 on its two stops, so draft B's first stop starts at 2.
    expect(lineA.stopIds[0]).not.toBe(lineB.stopIds[0]);
    expect(lineA.stopIds[0]).toBe(0 as StopId);
    expect(lineB.stopIds[0]).toBe(2 as StopId);
  });
});

// ── 5. A schedule depends only on the line's geometry ───────────────────────────────────────

describe("a line's schedule depends only on its geometry, not its id or position in a collection", () => {
  // Protects: refactor 2 (stable ids) directly — `buildRouteSchedule` must derive timing purely
  // from stop positions/legs, never from `line.id` happening to be small, sequential, or first in
  // some array. Also guards refactor 1: once stops move out of the line, the schedule builder
  // must still see "the same route" regardless of where in the (now-shared) stops array those
  // stops live.
  const draft = summarizeDraft(buildSeededDraft(grid));
  const stopsById = new Map(draft.stops.map((stop) => [stop.id, stop] as const));
  const lineFirst = toLine(1 as LineId, 'First', draft);
  const lineLast = toLine(9999 as LineId, 'Last', draft);

  const scheduleFirst = buildRouteSchedule(lineFirst, stopsById, grid, CRUISE_SPEED_KMH);
  const scheduleLast = buildRouteSchedule(lineLast, stopsById, grid, CRUISE_SPEED_KMH);

  it('round-trip duration is identical regardless of the line id', () => {
    expect(scheduleFirst.roundTripDurationS).toBe(scheduleLast.roundTripDurationS);
  });

  it('every leg (timing, polyline, distances) is identical apart from the lineId that tags the schedule', () => {
    expect(scheduleFirst.legs).toEqual(scheduleLast.legs);
    expect(scheduleFirst.cruiseSpeedMs).toBe(scheduleLast.cruiseSpeedMs);
    expect(scheduleFirst.lineId).not.toBe(scheduleLast.lineId);
  });
});
