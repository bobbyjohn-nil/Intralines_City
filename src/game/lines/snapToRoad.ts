/**
 * Nearest-point-on-road snapping for line drawing (manual §9): a click snaps to the closest
 * point on the closest *eligible* street. "Stops can't sit on roads faster than 55 km/h" is a
 * hard rule, so ineligible edges (`roadClass` faster than `STOP_MAX_ROAD_SPEED_KMH`) are
 * skipped entirely rather than merely deprioritized — a click deep in motorway territory with
 * no eligible street nearby must refuse, not snap to the motorway anyway.
 */

import type { LngLat, RoadEdge, RoadNode, StreetGraph } from '../types';
import { ROAD_SPEED_KMH, STOP_MAX_ROAD_SPEED_KMH } from '../constants';
import { nearestPointOnSegment } from './geo';

/** Clicks further than this from every eligible edge find nothing to snap to. # tune */
export const SNAP_MAX_DISTANCE_M = 60;

export interface SnapResult {
  readonly edgeId: number;
  /** Fraction along the edge, 0 = `edge.from`, 1 = `edge.to`. */
  readonly t: number;
  readonly position: LngLat;
  readonly distanceM: number;
}

/** The one shared predicate for "can a stop go here" — the draft, the line editor's move/upgrade
 * tools, and anything else that place a stop must all agree with this, not re-derive it. */
export function isStopEligibleRoad(edge: RoadEdge): boolean {
  return ROAD_SPEED_KMH[edge.roadClass] <= STOP_MAX_ROAD_SPEED_KMH;
}

/**
 * Finds the nearest point on the nearest eligible edge to `click`. Returns `null` if nothing
 * eligible is within `SNAP_MAX_DISTANCE_M`, so the caller can refuse the click outright.
 */
export function snapToRoad(click: LngLat, graph: StreetGraph): SnapResult | null {
  const nodeById = new Map<number, RoadNode>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  let best: SnapResult | null = null;

  for (const edge of graph.edges) {
    if (!isStopEligibleRoad(edge)) continue;

    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (from === undefined || to === undefined) continue; // malformed graph, not this function's problem to throw over

    const nearest = nearestPointOnSegment(click, from.pos, to.pos);
    if (nearest.distanceM > SNAP_MAX_DISTANCE_M) continue;
    if (best === null || nearest.distanceM < best.distanceM) {
      best = { edgeId: edge.id, t: nearest.t, position: nearest.position, distanceM: nearest.distanceM };
    }
  }

  return best;
}
