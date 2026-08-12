/**
 * `RouteSchedule` — everything about how one round trip of a `Line` unfolds in time, built once
 * from the line, the street graph and a cruise speed, then cached and read many times by
 * `position.ts`. This module does the (comparatively expensive) geometry and speed-profile work
 * up front so the per-tick path in `position.ts` never allocates and never walks the road graph.
 *
 * A round trip is: layover at the first stop, drive+dwell out to the last stop, layover there,
 * drive+dwell back to the first stop — mirroring the draft bar's round-trip estimate in
 * `lines/draft.ts` (`summarizeDraft`), but resolved leg by leg instead of as one aggregate total,
 * because `position.ts` needs to know *where in the schedule* a given moment falls.
 */

import type { LngLat, RoadEdge, RoadNode, StreetGraph } from '../types';
import type { Line, RouteLeg } from '../lines/types';
import { BUS_ACCEL_MS2, BUS_BRAKE_MS2, BUS_DWELL_SECONDS, BUS_LAYOVER_MINUTES } from '../constants';
import { buildSpeedProfile, type SpeedProfile } from './kinematics';
import { metersBetween } from './geo';

const KMH_TO_MS = 1000 / 3600;
const SECONDS_PER_MINUTE = 60;

export type WaitKind = 'dwelling' | 'layover';

/** One directed traversal of a leg — either an original `RouteLeg` driven forward, or the same
 * leg driven in reverse on the way back. */
export interface LegSchedule {
  readonly fromStopId: number;
  readonly toStopId: number;
  readonly lengthM: number;
  readonly profile: SpeedProfile;
  /** Time spent stopped at `fromStopId` before this leg departs — dwell at an intermediate stop,
   * layover at either terminus. */
  readonly waitDurationS: number;
  readonly waitKind: WaitKind;
  /** Cumulative seconds, from round-trip start, at which the bus departs `fromStopId`. */
  readonly departS: number;
  /** Cumulative seconds, from round-trip start, at which the bus arrives at `toStopId`
   * (`departS + profile.totalTimeS`). */
  readonly arriveS: number;
  /** Vertices from `fromStopId` to `toStopId`, in travel order — `[stopPos, ...viaNodes,
   * stopPos]`, length >= 2. Straight sub-segments between consecutive vertices (edges in this
   * game's `StreetGraph` are drawn as straight lines between two `RoadNode`s). */
  readonly polyline: readonly LngLat[];
  /** Cumulative straight-line distance along `polyline` from `polyline[0]`, metres. Same length
   * as `polyline`; `cumDistM[0] === 0`. Used to place a bus by *fraction* of the leg travelled
   * (`profile`-driven distance ÷ `lengthM`) rather than by this array's own total, since the
   * polyline's straight-segment sum and the graph's great-circle `lengthM` need not match to the
   * millimetre. */
  readonly cumDistM: readonly number[];
}

export interface RouteSchedule {
  readonly lineId: number;
  readonly cruiseSpeedMs: number;
  /** Total time for one full out-and-back round trip, seconds — `legs[legs.length - 1].arriveS`. */
  readonly roundTripDurationS: number;
  /** `2 * (line.stops.length - 1)` legs: the line's own legs driven forward, then the same legs
   * driven in reverse, in round-trip order. */
  readonly legs: readonly LegSchedule[];
}

/** Reconstructs the ordered vertex chain a bus actually drives along `leg`, from `fromPos` to
 * `toPos`. `RouteLeg.edgeIds` is an undirected chain of edges with no stored travel direction, so
 * consecutive edges are threaded together by the node they share; a single-edge leg (both stops
 * on the same street segment) is just the straight sub-segment between the two stops. */
function reconstructPolyline(
  edgeById: ReadonlyMap<number, RoadEdge>,
  nodeById: ReadonlyMap<number, RoadNode>,
  leg: RouteLeg,
  fromPos: LngLat,
  toPos: LngLat
): LngLat[] {
  const edgeIds = leg.edgeIds;
  if (edgeIds.length <= 1) return [fromPos, toPos];

  const vertices: LngLat[] = [fromPos];
  for (let i = 0; i < edgeIds.length - 1; i++) {
    const aId = edgeIds[i];
    const bId = edgeIds[i + 1];
    const a = aId === undefined ? undefined : edgeById.get(aId);
    const b = bId === undefined ? undefined : edgeById.get(bId);
    if (a === undefined || b === undefined) {
      // The graph passed in doesn't match the one this leg was routed against — an impossible
      // upstream state, not a player-reachable one, so this fails loud rather than drawing a
      // route through nowhere.
      throw new Error(
        `schedule: leg ${leg.fromStopId}->${leg.toStopId} references an edge missing from the graph`
      );
    }
    const sharedNodeId = a.from === b.from || a.from === b.to ? a.from : a.to;
    const node = nodeById.get(sharedNodeId);
    if (node === undefined) {
      throw new Error(`schedule: graph is missing node ${sharedNodeId} referenced by a route leg`);
    }
    vertices.push(node.pos);
  }
  vertices.push(toPos);
  return vertices;
}

function cumulativeDistances(polyline: readonly LngLat[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    const prev = polyline[i - 1];
    const cur = polyline[i];
    const prevCum = cum[i - 1];
    if (prev === undefined || cur === undefined || prevCum === undefined) continue; // unreachable
    cum.push(prevCum + metersBetween(prev, cur));
  }
  return cum;
}

/**
 * Builds the round-trip schedule for `line` at `cruiseSpeedKmh`. Pure and comparatively
 * expensive (walks the whole route, builds a polyline per leg) — call it once per line (or once
 * per line + bus-model pairing, since cruise speed varies by model) and cache the result; never
 * call it from a per-tick or per-frame path.
 */
export function buildRouteSchedule(line: Line, graph: StreetGraph, cruiseSpeedKmh: number): RouteSchedule {
  const stopCount = line.stops.length;
  if (stopCount < 2 || line.legs.length !== stopCount - 1) {
    throw new Error(
      `buildRouteSchedule: line ${line.id} has ${stopCount} stops and ${line.legs.length} legs — a schedulable line needs >= 2 stops and stops.length - 1 legs`
    );
  }

  const cruiseSpeedMs = cruiseSpeedKmh * KMH_TO_MS;
  const edgeById = new Map(graph.edges.map((e) => [e.id, e] as const));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));

  const firstStopId = line.stops[0]!.id;
  const lastStopId = line.stops[stopCount - 1]!.id;

  const legCount = 2 * (stopCount - 1);
  const legs: LegSchedule[] = [];
  let cursorS = 0;

  for (let i = 0; i < legCount; i++) {
    const forward = i <= stopCount - 2;
    // Forward legs walk line.legs[0..n-2] in order; return legs walk the same legs backward —
    // see the schedule.ts module comment for the derivation of this index.
    const originalLegIndex = forward ? i : 2 * stopCount - 3 - i;
    const originalLeg = line.legs[originalLegIndex]!;
    const originFromStop = line.stops[originalLegIndex]!;
    const originToStop = line.stops[originalLegIndex + 1]!;
    const fromStop = forward ? originFromStop : originToStop;
    const toStop = forward ? originToStop : originFromStop;

    const forwardPolyline = reconstructPolyline(
      edgeById,
      nodeById,
      originalLeg,
      originFromStop.position,
      originToStop.position
    );
    const polyline = forward ? forwardPolyline : [...forwardPolyline].reverse();
    const cumDistM = cumulativeDistances(polyline);

    const lengthM = originalLeg.lengthM;
    const profile = buildSpeedProfile(lengthM, cruiseSpeedMs, BUS_ACCEL_MS2, BUS_BRAKE_MS2);

    const isTerminusStart = fromStop.id === firstStopId || fromStop.id === lastStopId;
    const waitDurationS = isTerminusStart ? BUS_LAYOVER_MINUTES * SECONDS_PER_MINUTE : BUS_DWELL_SECONDS;
    const waitKind: WaitKind = isTerminusStart ? 'layover' : 'dwelling';

    const departS = cursorS + waitDurationS;
    const arriveS = departS + profile.totalTimeS;

    legs.push({
      fromStopId: fromStop.id,
      toStopId: toStop.id,
      lengthM,
      profile,
      waitDurationS,
      waitKind,
      departS,
      arriveS,
      polyline,
      cumDistM,
    });

    cursorS = arriveS;
  }

  return { lineId: line.id, cruiseSpeedMs, roundTripDurationS: cursorS, legs };
}
