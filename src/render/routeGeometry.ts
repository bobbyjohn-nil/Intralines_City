/**
 * Route geometry: turns a `Line`'s (or `Draft`'s) `legs` into ordered lng/lat waypoints, clipped
 * to each leg's *stops* rather than the raw edges those stops sit on. Pure and renderer-agnostic —
 * the WebGL route ribbon (`three/routeRibbons.ts`) and the old Canvas basemap both need exactly
 * this geometry, just fed to a different drawing backend.
 *
 * Bug fix (owner report, carried over from the Canvas renderer): the coloured route stroke used to
 * run past a leg's first/last stop out to that edge's far *node*, because `RouteLeg.edgeIds` names
 * whole road edges but a `Stop` sits at `edgeT`, a fraction *along* one — drawing every edge
 * end-to-end always overshot both termini, and the same defect hit every intermediate stop that
 * happens to sit mid-edge at a turn (a stop shared by two consecutive legs used to have both legs
 * draw that same edge in full — a real, visible spur backtracking from the corner). Fixed by
 * clipping every leg's first and last edge to the fractional `edgeT` position of its own stop.
 */

import type { LngLat, RoadEdge, RoadNode } from '../game/types';
import type { RouteLeg, Stop, StopId } from '../game/lines/types';
import type { RenderCache } from './cityIndex';

/** The node id shared by two directly-connected edges — `undefined` if they don't actually share
 * one. Should never be `undefined` for edges taken from the same contiguous `RouteLeg.edgeIds`
 * chain, but checked rather than assumed. */
export function sharedNodeId(a: RoadEdge, b: RoadEdge): number | undefined {
  if (a.from === b.from || a.from === b.to) return a.from;
  if (a.to === b.from || a.to === b.to) return a.to;
  return undefined;
}

/** Linearly interpolates between two lng/lat points at fraction `t` (0 = `from`, 1 = `to`). */
export function lerpLngLat(from: LngLat, to: LngLat, t: number): LngLat {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

function edgeTerminusPoint(
  edge: RoadEdge,
  edgeId: number,
  stop: Stop | undefined,
  fallbackNodeId: number,
  nodeIndex: ReadonlyMap<number, RoadNode>,
): LngLat | undefined {
  if (stop && stop.edgeId === edgeId) {
    const fromNode = nodeIndex.get(edge.from);
    const toNode = nodeIndex.get(edge.to);
    if (!fromNode || !toNode) return undefined;
    return lerpLngLat(fromNode.pos, toNode.pos, stop.edgeT);
  }
  return nodeIndex.get(fallbackNodeId)?.pos;
}

/** Appends one leg's ordered lng/lat waypoints to `out`. */
export function buildLegWaypoints(
  leg: RouteLeg,
  fromStop: Stop | undefined,
  toStop: Stop | undefined,
  edgeIndex: ReadonlyMap<number, RoadEdge>,
  nodeIndex: ReadonlyMap<number, RoadNode>,
  out: LngLat[],
): void {
  const edgeIds = leg.edgeIds;
  const n = edgeIds.length;
  for (let i = 0; i < n; i++) {
    const edgeId = edgeIds[i]!;
    const edge = edgeIndex.get(edgeId);
    if (!edge) continue;
    const isLast = i === n - 1;

    if (i === 0) {
      const entry = edgeTerminusPoint(edge, edgeId, fromStop, edge.from, nodeIndex);
      if (entry) out.push(entry);
    }

    if (isLast) {
      const exit = edgeTerminusPoint(edge, edgeId, toStop, edge.to, nodeIndex);
      if (exit) out.push(exit);
    } else {
      const nextEdge = edgeIndex.get(edgeIds[i + 1]!);
      const shared = nextEdge ? sharedNodeId(edge, nextEdge) : undefined;
      const jointNodeId = shared !== undefined ? shared : edge.to;
      const joint = nodeIndex.get(jointNodeId);
      if (joint) out.push(joint.pos);
    }
  }
}

function isStopArray(source: ReadonlyMap<StopId, Stop> | readonly Stop[]): source is readonly Stop[] {
  return Array.isArray(source);
}

function resolveStop(source: ReadonlyMap<StopId, Stop> | readonly Stop[], id: StopId): Stop | undefined {
  if (isStopArray(source)) {
    for (const stop of source) {
      if (stop.id === id) return stop;
    }
    return undefined;
  }
  return source.get(id);
}

/** Per-line route geometry (lng/lat waypoints per leg), cached by `legs` array identity — a
 * `Line`'s/`Draft`'s `legs` are treated as immutable (every edit produces a new array), so a cache
 * hit reliably means "unchanged since last build." */
const legWaypointsCache = new WeakMap<readonly RouteLeg[], readonly (readonly LngLat[])[]>();

export function getLineWaypoints(
  legs: readonly RouteLeg[],
  stopsSource: ReadonlyMap<StopId, Stop> | readonly Stop[],
  cache: RenderCache,
): readonly (readonly LngLat[])[] {
  let perLeg = legWaypointsCache.get(legs);
  if (!perLeg) {
    perLeg = legs.map((leg) => {
      const waypoints: LngLat[] = [];
      buildLegWaypoints(
        leg,
        resolveStop(stopsSource, leg.fromStopId),
        resolveStop(stopsSource, leg.toStopId),
        cache.edgeIndex,
        cache.nodeIndex,
        waypoints,
      );
      return waypoints;
    });
    legWaypointsCache.set(legs, perLeg);
  }
  return perLeg;
}

/** Flattens every leg's waypoints into one continuous polyline — legs are always contiguous
 * (`leg[i].toStopId === leg[i + 1].fromStopId` by construction), so a whole line is one connected
 * path, not per-edge islands. */
export function getLinePolyline(
  legs: readonly RouteLeg[],
  stopsSource: ReadonlyMap<StopId, Stop> | readonly Stop[],
  cache: RenderCache,
): readonly LngLat[] {
  const perLeg = getLineWaypoints(legs, stopsSource, cache);
  const out: LngLat[] = [];
  for (const waypoints of perLeg) {
    for (const point of waypoints) {
      out.push(point);
    }
  }
  return out;
}
