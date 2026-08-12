/**
 * Characterization tests, written ahead of three planned refactors to `Line`/`Stop`
 * (studio/docs/design/save-format.md §5):
 *
 *   1. Hoist stops out of `Line` — `Line.stops: Stop[]` becomes a top-level `stops[]` with
 *      `line.stopIds: number[]`, so a stop shared by two lines is stored once.
 *   2. Stable ids — stop and line ids stop being array indices and become monotonic,
 *      never-reused ids drawn from a persisted counter (`nextIds`).
 *   3. `roadClass` on `Stop`, plus derived `orphaned`/`movedM`, so a saved stop re-anchors by
 *      position rather than by `edgeId`.
 *
 * These change the shape of `Line` and `Stop` everywhere at once. The type system won't catch a
 * behavioural drift — everything still compiles — so every test here pins an *observable*
 * property (ordering, totals, independence, geometry-only dependence) rather than the current
 * representation, and says in a comment which of the three refactors could plausibly break it.
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
import type { Draft, Line } from './types';

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

function toLine(id: number, name: string, draft: Draft): Line {
  return { id, name, stops: draft.stops, legs: draft.legs, totalLengthM: draft.totalLengthM };
}

// ── 1. Stop ordering is route order ─────────────────────────────────────────────────────────

describe('stop ordering along a line is the route order', () => {
  // Protects: refactor 1 (hoisting stops out of Line) and refactor 2 (stable ids). Today
  // `legs[i]` connects `stops[i]` to `stops[i+1]` by array position; after the hoist, `stops`
  // becomes a top-level array and a line only carries `stopIds[]`, and after stable ids, `id`
  // stops being the array index. This asserts the *relationship* — leg i's endpoints are stop i
  // and stop i+1, identified by id, not by trusting array position — so it still means something
  // once ids are no longer indices and stops live outside the line.
  const line = toLine(1, 'Test Line', summarizeDraft(buildSeededDraft(city.graph)));

  it('has exactly stops.length - 1 legs', () => {
    expect(line.legs.length).toBe(line.stops.length - 1);
  });

  it('legs[i] connects stops[i] to stops[i+1], by id, for every consecutive pair', () => {
    expect(line.stops.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < line.legs.length; i++) {
      const leg = line.legs[i]!;
      const fromStop = line.stops[i]!;
      const toStop = line.stops[i + 1]!;
      expect(leg.fromStopId).toBe(fromStop.id);
      expect(leg.toStopId).toBe(toStop.id);
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
  // This is the case refactor 1 exists to fix: today every draft numbers its own stops from 0,
  // so two *independently drawn* lines that happen to click the same spot end up with colliding
  // ids and fully duplicated Stop data — nothing here is shared. Pinning that precisely, so the
  // refactor has a documented "before" to diff against.
  const clickA = midpointOf(city.graph, city.graph.edges[0]!);
  const clickB = midpointOf(city.graph, city.graph.edges[50]!);

  function draftFromClicks(clicks: readonly LngLat[]): Draft {
    let state = startDraft(city.graph);
    for (const click of clicks) {
      const result = addStop(state, click);
      if (!result.ok) throw new Error(`draftFromClicks: ${result.reason}`);
      state = result.state;
    }
    return summarizeDraft(state);
  }

  const lineA = toLine(1, 'Line A', draftFromClicks([clickA, clickB]));
  const lineB = toLine(2, 'Line B', draftFromClicks([clickA, clickB]));

  it('today: the two lines are independent objects with no shared references', () => {
    expect(lineA).not.toBe(lineB);
    expect(lineA.stops).not.toBe(lineB.stops);
    expect(lineA.stops[0]).not.toBe(lineB.stops[0]);
  });

  it('today: their first stops land at the identical snapped position and edge (same click)', () => {
    expect(lineA.stops[0]!.position).toEqual(lineB.stops[0]!.position);
    expect(lineA.stops[0]!.edgeId).toBe(lineB.stops[0]!.edgeId);
    expect(lineA.stops[0]!.edgeT).toBe(lineB.stops[0]!.edgeT);
    // Fully duplicated data, not merely equal-looking: every field matches.
    expect(lineA.stops[0]).toEqual(lineB.stops[0]);
  });

  it('today: their first stops collide on id, because ids are numbered per-draft (array position), not globally', () => {
    // EXPECTED TO CHANGE by refactor 2 (stable ids drawn from a persisted `nextIds.stop`
    // counter): once ids are global and never reused, two independently created lines can never
    // land on the same stop id again — this assertion should flip to `.not.toBe(...)`, and if
    // refactor 1 also dedups by location, `lineA.stops[0]` and `lineB.stops[0]` may become the
    // *same* top-level stop object (`toBe`, not just `toEqual`) referenced by both lines'
    // `stopIds`. Either change is correct; this assertion exists so it's a deliberate, visible
    // diff instead of an unnoticed side effect.
    expect(lineA.stops[0]!.id).toBe(lineB.stops[0]!.id);
    expect(lineA.stops[0]!.id).toBe(0);
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
  const lineFirst = toLine(1, 'First', draft);
  const lineLast = toLine(9999, 'Last', draft);

  const scheduleFirst = buildRouteSchedule(lineFirst, city.graph, CRUISE_SPEED_KMH);
  const scheduleLast = buildRouteSchedule(lineLast, city.graph, CRUISE_SPEED_KMH);

  it('round-trip duration is identical regardless of the line id', () => {
    expect(scheduleFirst.roundTripDurationS).toBe(scheduleLast.roundTripDurationS);
  });

  it('every leg (timing, polyline, distances) is identical apart from the lineId that tags the schedule', () => {
    expect(scheduleFirst.legs).toEqual(scheduleLast.legs);
    expect(scheduleFirst.cruiseSpeedMs).toBe(scheduleLast.cruiseSpeedMs);
    expect(scheduleFirst.lineId).not.toBe(scheduleLast.lineId);
  });
});
