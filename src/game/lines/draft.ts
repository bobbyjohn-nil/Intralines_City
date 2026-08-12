/**
 * Pure state machine for a line being drawn (manual §9): "Choose New line, then click along
 * streets. Each click places a stop ($4,000) snapped to the road network; the route between
 * consecutive stops follows real streets... Undo, Cancel, and Create line (needs ≥ 2 stops)."
 *
 * Every function here takes a `DraftState` and returns a new one — no hidden mutation, no
 * class instance to go stale. The one exception is the `PathfindContext` a draft carries:
 * its scratch buffers are mutated in place by design (that's the whole point of reusing them
 * across the many searches one draft performs), but nothing about the *draft's own* state
 * depends on that mutation being visible — two draft sessions against the same graph never
 * share a context, and a cancelled draft keeps its context to avoid rebuilding it.
 */

import type { LngLat, StreetGraph } from '../types';
import {
  BUS_DWELL_SECONDS,
  BUS_LAYOVER_MINUTES,
  BUS_MODELS,
  MIN_STOPS_TO_CREATE_LINE,
  STARTING_BUS_MODEL,
  STOP_MAX_ROAD_SPEED_KMH,
  STOP_PLACEMENT_COST_USD,
} from '../constants';
import { createPathfindContext, findPath, type PathfindContext } from './pathfind';
import { snapToRoad, SNAP_MAX_DISTANCE_M } from './snapToRoad';
import { nextId, type Draft, type RouteLeg, type Stop, type StopId } from './types';

/** The id `startDraft` mints from when the caller doesn't have a counter to thread yet (every
 * unit test that draws exactly one draft, and any draft's very first stop in a fresh company). */
const FIRST_STOP_ID = 0 as StopId;

const SECONDS_PER_MINUTE = 60;
const KMH_TO_MS = 1000 / 3600;

/** "Driving time at the baseline bus speed" (manual §9's line editor uses the slowest assigned
 * model; a fresh draft has no buses assigned yet, so it previews against the model every
 * company starts with). # tune — the manual doesn't name a specific model for the draft-bar
 * preview, only for the finished line editor. */
const STARTING_BUS_MODEL_SPEC = BUS_MODELS[STARTING_BUS_MODEL];
if (STARTING_BUS_MODEL_SPEC === undefined) {
  // Impossible unless constants.ts itself is inconsistent — fail loud rather than silently
  // dividing by an undefined speed later.
  throw new Error(`draft: STARTING_BUS_MODEL '${STARTING_BUS_MODEL}' is missing from BUS_MODELS`);
}
const BASELINE_BUS_SPEED_MS = STARTING_BUS_MODEL_SPEC.cruiseSpeedKmh * KMH_TO_MS;

export interface DraftState {
  readonly graph: StreetGraph;
  /** Reused across every leg this draft routes — see the module comment. */
  readonly pathfindContext: PathfindContext;
  readonly stops: readonly Stop[];
  /** `legs.length === max(0, stops.length - 1)`. */
  readonly legs: readonly RouteLeg[];
  /** The id `addStop` will assign next. Threaded in from the caller (`App.tsx` passes its own
   * running counter, mirroring the persisted `nextIds.stop` from save-format.md §5) rather than
   * reset to 0 per draft — that per-draft reset was the bug where two independently drawn lines'
   * first stops both got id 0. `undoLastStop`/`cancelDraft` roll this back exactly as far as the
   * stops they remove, since an unconfirmed stop's id was never actually committed to anything —
   * see those functions' comments. */
  readonly nextStopId: StopId;
}

export function startDraft(graph: StreetGraph, nextStopId: StopId = FIRST_STOP_ID): DraftState {
  return { graph, pathfindContext: createPathfindContext(graph), stops: [], legs: [], nextStopId };
}

export type AddStopResult =
  | { readonly ok: true; readonly state: DraftState }
  | { readonly ok: false; readonly reason: string };

/**
 * Routes from `from` to `to`, both arbitrary points along the road graph (a stop needn't sit
 * on an intersection). Tries all four combinations of "which end of each stop's edge to pass
 * through" and keeps the shortest that's actually routable — a stop near the middle of a long
 * block genuinely could be faster reached via either end. Returns `null` if no combination
 * routes, meaning the leg is unroutable full stop.
 */
function routeLeg(graph: StreetGraph, ctx: PathfindContext, from: Stop, to: Stop): RouteLeg | null {
  const edgeA = ctx.edgeById.get(from.edgeId);
  const edgeB = ctx.edgeById.get(to.edgeId);
  if (edgeA === undefined || edgeB === undefined) return null; // stop points at an edge the graph doesn't have — refuse, don't throw

  if (from.edgeId === to.edgeId) {
    const lengthM = Math.abs(to.edgeT - from.edgeT) * edgeA.lengthM;
    return { fromStopId: from.id, toStopId: to.id, edgeIds: [edgeA.id], lengthM };
  }

  const ends = [
    { nodeId: edgeA.from, distM: from.edgeT * edgeA.lengthM },
    { nodeId: edgeA.to, distM: (1 - from.edgeT) * edgeA.lengthM },
  ] as const;
  const otherEnds = [
    { nodeId: edgeB.from, distM: to.edgeT * edgeB.lengthM },
    { nodeId: edgeB.to, distM: (1 - to.edgeT) * edgeB.lengthM },
  ] as const;

  let bestLengthM = Infinity;
  let bestEdgeIds: readonly number[] | null = null;

  for (const start of ends) {
    for (const end of otherEnds) {
      const path = findPath(ctx, graph, start.nodeId, end.nodeId);
      if (path === null) continue;
      const lengthM = start.distM + path.totalLengthM + end.distM;
      if (lengthM < bestLengthM) {
        bestLengthM = lengthM;
        bestEdgeIds = [edgeA.id, ...path.edgeIds, edgeB.id];
      }
    }
  }

  if (bestEdgeIds === null) return null;
  return { fromStopId: from.id, toStopId: to.id, edgeIds: bestEdgeIds, lengthM: bestLengthM };
}

/**
 * Places a stop at `click`, snapped to the road network, and routes it from the previous stop
 * (if any). Refused with a reason string — never silently dropped — if the click doesn't snap
 * to any eligible street, or if the leg from the previous stop can't be routed.
 */
export function addStop(state: DraftState, click: LngLat): AddStopResult {
  const snap = snapToRoad(click, state.graph);
  if (snap === null) {
    return {
      ok: false,
      reason: `No street within ${SNAP_MAX_DISTANCE_M} m of that click is slow enough for a stop — stops need a road at ${STOP_MAX_ROAD_SPEED_KMH} km/h or under (no motorway stops). Click closer to a slower street.`,
    };
  }

  const stop: Stop = {
    id: state.nextStopId,
    // Real city packs carry OSM street names (manual §9: "named after their streets"); the
    // road graph here has none, so this is a placeholder until that data exists. # tune
    name: `Stop ${state.stops.length + 1}`,
    position: snap.position,
    roadClass: snap.roadClass,
    edgeId: snap.edgeId,
    edgeT: snap.t,
    orphaned: false,
    movedM: null,
  };

  const previous = state.stops[state.stops.length - 1];
  if (previous === undefined) {
    return { ok: true, state: { ...state, stops: [stop], nextStopId: nextId(state.nextStopId) } };
  }

  const leg = routeLeg(state.graph, state.pathfindContext, previous, stop);
  if (leg === null) {
    return {
      ok: false,
      reason: `No road connects ${previous.name} to this point — try a different point, or undo this stop.`,
    };
  }

  return {
    ok: true,
    state: {
      ...state,
      stops: [...state.stops, stop],
      legs: [...state.legs, leg],
      nextStopId: nextId(state.nextStopId),
    },
  };
}

/** Removes the most recently added stop and the leg that reached it. A no-op on an empty draft.
 * Rolls `nextStopId` back to the id of the stop it just removed, since that id was never
 * committed to anything outside this draft — the next `addStop` reuses it rather than burning
 * one, which is what makes "add three, undo three" restore the exact fresh-draft state
 * (`characterization.test.ts`'s "undo is exactly inverse to add"). */
export function undoLastStop(state: DraftState): DraftState {
  if (state.stops.length === 0) return state;
  const removed = state.stops[state.stops.length - 1]!;
  return {
    ...state,
    stops: state.stops.slice(0, -1),
    legs: state.legs.slice(0, -1),
    nextStopId: removed.id,
  };
}

/** Drops every stop and leg. Keeps the draft's `PathfindContext` — its scratch buffers don't
 * belong to any particular set of stops, so there's nothing about them worth discarding. Also
 * rolls `nextStopId` back to where it stood before this draft placed anything, same reasoning as
 * `undoLastStop` — a cancelled draft never committed any of its ids. */
export function cancelDraft(state: DraftState): DraftState {
  const nextStopId = state.stops.length > 0 ? state.stops[0]!.id : state.nextStopId;
  return { ...state, stops: [], legs: [], nextStopId };
}

export function canCreate(state: DraftState): boolean {
  return state.stops.length >= MIN_STOPS_TO_CREATE_LINE;
}

/**
 * The draft bar's live totals (manual §9): stop count, length, round-trip time preview, and
 * running placement cost. Round trip = there and back along the drafted route, so both the
 * driving time and each intermediate stop's dwell count twice; layover happens once at each
 * end (twice total) per round trip.
 */
export function summarizeDraft(state: DraftState): Draft {
  let totalLengthM = 0;
  for (const leg of state.legs) totalLengthM += leg.lengthM;

  const stopCount = state.stops.length;
  const intermediateStopCount = Math.max(0, stopCount - 2);

  const roundTripDrivingMinutes = (2 * totalLengthM) / BASELINE_BUS_SPEED_MS / SECONDS_PER_MINUTE;
  const roundTripDwellMinutes = (2 * intermediateStopCount * BUS_DWELL_SECONDS) / SECONDS_PER_MINUTE;
  const roundTripLayoverMinutes = 2 * BUS_LAYOVER_MINUTES;

  const estimatedRoundTripMinutes = roundTripDrivingMinutes + roundTripDwellMinutes + roundTripLayoverMinutes;
  const placementCostUsd = stopCount * STOP_PLACEMENT_COST_USD;

  return {
    stops: state.stops,
    legs: state.legs,
    totalLengthM,
    stopCount,
    estimatedRoundTripMinutes,
    placementCostUsd,
  };
}
