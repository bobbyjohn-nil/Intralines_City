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
 * One shared city (`generateRiverton(RIVERTON_SEED)`), built once at module scope, keeps this
 * fast — no full-city sweeps, no unseeded randomness.
 */
import { describe, expect, it } from 'vitest';
import { generateRiverton, RIVERTON_SEED } from '../city/generateRiverton';
import type { LngLat, RoadEdge, StreetGraph } from '../types';
import { BUS_MODELS, STARTING_BUS_MODEL, STOP_PLACEMENT_COST_USD } from '../constants';
import { addStop, startDraft, summarizeDraft, undoLastStop, type DraftState } from './draft';
import { buildRouteSchedule } from '../buses/schedule';
import type { Draft, Line, LineId, Stop, StopId } from './types';

const city = generateRiverton(RIVERTON_SEED);
const CRUISE_SPEED_KMH = BUS_MODELS[STARTING_BUS_MODEL]!.cruiseSpeedKmh;

/** Midpoint of an edge's two endpoints — a deterministic click guaranteed to snap to that edge
 * (mirrors the helper of the same name in `draft.test.ts` and `integration.test.ts`). */
function midpointOf(graph: StreetGraph, edge: RoadEdge): LngLat {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const from = nodeById.get(edge.from)!;
  const to = nodeById.get(edge.to)!;
  return [(from.pos[0] + to.pos[0]) / 2, (from.pos[1] + to.pos[1]) / 2];
}

/** Four edges spread across Riverton's grid, chosen the same way `integration.test.ts`'s
 * `testStopEdgeIndices` does (fractions of the edge count, not raw literals, so this keeps
 * working if the generator's edge count ever shifts) — most legs span several edges, exercising
 * real routing rather than one-edge hops. */
function seededStopEdgeIndices(graph: StreetGraph): readonly number[] {
  const edgeCount = graph.edges.length;
  return [0, Math.floor(edgeCount * 0.3), Math.floor(edgeCount * 0.6), edgeCount - 1];
}

/** Draws a line over `graph` via the real draft state machine, from a fixed sequence of clicks,
 * the same way a player would — not a hand-built `Draft` literal. */
function buildSeededDraft(graph: StreetGraph, edgeIndices: readonly number[] = seededStopEdgeIndices(graph)): DraftState {
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
  const draft = summarizeDraft(buildSeededDraft(city.graph));
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

describe("a seeded draft's summary numbers on generateRiverton(RIVERTON_SEED)", () => {
  // Protects: all three refactors. `summarizeDraft` folds stop count, geometry (totalLengthM,
  // round-trip minutes) and placement cost from a fixed, deterministic click sequence
  // (RIVERTON_SEED=42, edges [0, 1079, 2159, 3598] of a 3599-edge graph). These four numbers were
  // read once from the current implementation and hardcoded below; if any refactor changes what
  // a stop or a leg *is* in a way that shifts routing, ordering, or the geometry a leg reports,
  // one of these four moves and the test fails loudly instead of silently.
  const draft = summarizeDraft(buildSeededDraft(city.graph));

  it('places exactly 4 stops', () => {
    expect(draft.stopCount).toBe(4);
    expect(draft.stops.length).toBe(4);
  });

  it('totals the recorded length, round-trip time and placement cost', () => {
    expect(draft.totalLengthM).toBeCloseTo(11079.523720514224, 6);
    expect(draft.estimatedRoundTripMinutes).toBeCloseTo(62.51504719180161, 6);
    expect(draft.placementCostUsd).toBe(4 * STOP_PLACEMENT_COST_USD);
    expect(draft.placementCostUsd).toBe(16000);
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
    const initial = startDraft(city.graph);
    const edgeIndices = seededStopEdgeIndices(city.graph).slice(0, 3);

    let state = initial;
    for (const edgeIndex of edgeIndices) {
      const result = addStop(state, midpointOf(city.graph, city.graph.edges[edgeIndex]!));
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
  const clickA = midpointOf(city.graph, city.graph.edges[0]!);
  const clickB = midpointOf(city.graph, city.graph.edges[50]!);

  let nextStopId = 0 as StopId;

  function draftFromClicks(clicks: readonly LngLat[]): Draft {
    let state = startDraft(city.graph, nextStopId);
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
  const draft = summarizeDraft(buildSeededDraft(city.graph));
  const stopsById = new Map(draft.stops.map((stop) => [stop.id, stop] as const));
  const lineFirst = toLine(1 as LineId, 'First', draft);
  const lineLast = toLine(9999 as LineId, 'Last', draft);

  const scheduleFirst = buildRouteSchedule(lineFirst, stopsById, city.graph, CRUISE_SPEED_KMH);
  const scheduleLast = buildRouteSchedule(lineLast, stopsById, city.graph, CRUISE_SPEED_KMH);

  it('round-trip duration is identical regardless of the line id', () => {
    expect(scheduleFirst.roundTripDurationS).toBe(scheduleLast.roundTripDurationS);
  });

  it('every leg (timing, polyline, distances) is identical apart from the lineId that tags the schedule', () => {
    expect(scheduleFirst.legs).toEqual(scheduleLast.legs);
    expect(scheduleFirst.cruiseSpeedMs).toBe(scheduleLast.cruiseSpeedMs);
    expect(scheduleFirst.lineId).not.toBe(scheduleLast.lineId);
  });
});
