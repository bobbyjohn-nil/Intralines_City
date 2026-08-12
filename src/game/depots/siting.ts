/**
 * `isDepotSitable` — the §1 ordered check (depots-and-timetables.md), rows 1-4 of the check
 * table. Row 0 (the tool's arm/cash gate) lives in `economics.ts`'s `canArmDepotTool` since it
 * needs a treasury balance this function never sees.
 *
 * One shared predicate, per the project's house rule (studio/GAME.md: "one shared predicate per
 * rule... follow that pattern for every rule with more than one consumer") — the map tint, the
 * click handler, and the save loader's legality check must all call this and nothing else, so
 * they can never disagree. The manual makes the same point about check 2 specifically ("the same
 * polygons check 2 tests"), and this predicate is written to generalise that to every row.
 *
 * Fails on the first check that fails, in the spec's stated order — "cheapest-first, and the
 * order a real siting review runs": inside the city, zoned, street access, separation from an
 * existing depot.
 */

import type { City, LngLat } from '../types';
import { DEPOT_MAX_ROAD_ACCESS_M, isDepotEligibleZone, medianZoneDensityPerHa } from '../city/zones';
import { DEPOT_PLACEMENT_MIN_SEPARATION_M, DEPOT_ZONING_KERB_TOLERANCE_M } from './constants';
import type { Depot, DepotId } from './types';
import { distanceToPolygonBoundaryM, isPointInPolygon, metersBetween } from './geo';

export type DepotSitingResult =
  | { readonly ok: true; readonly accessNodeId: number; readonly accessDistanceM: number }
  | { readonly ok: false; readonly reason: 'outside_city' }
  | { readonly ok: false; readonly reason: 'not_zoned' }
  | { readonly ok: false; readonly reason: 'no_road_access'; readonly nearestRoadDistanceM: number }
  | {
      readonly ok: false;
      readonly reason: 'too_close_to_depot';
      readonly depotId: DepotId;
      readonly depotName: string;
      readonly distanceM: number;
    };

/** Row 1: "Click inside the mapped city." A simple bounding-box test — `City.bounds` is already
 * the playable-area mask everything outside renders as grey/dashed (types.ts's own doc comment). */
function isInsideBounds(point: LngLat, city: City): boolean {
  const [lng, lat] = point;
  const { west, east, south, north } = city.bounds;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

/** Row 2: point-in-polygon against every eligible zone, dilated by the 60 m kerb tolerance — see
 * `constants.ts`'s `DEPOT_ZONING_KERB_TOLERANCE_M` doc comment for why the dilation is computed
 * here rather than read from a pre-baked layer. `isDepotEligibleZone`/`medianZoneDensityPerHa`
 * are `city/zones.ts`'s shared eligibility predicate — never reimplemented here. */
function isOnEligibleZoning(point: LngLat, city: City): boolean {
  const medianDensityPerHa = medianZoneDensityPerHa(city.zones);
  for (const zone of city.zones) {
    if (!isDepotEligibleZone(zone, medianDensityPerHa)) continue;
    if (isPointInPolygon(point, zone.polygon)) return true;
    if (distanceToPolygonBoundaryM(point, zone.polygon) <= DEPOT_ZONING_KERB_TOLERANCE_M) return true;
  }
  return false;
}

/** Row 3: nearest routable road node, straight-line — siting only asks "is there a kerb nearby
 * to build a gate on", not driving time, which is `deadhead.ts`'s question once the depot
 * exists. Returns `null` only for a graph with zero nodes, an impossible-in-practice city. */
function nearestRoadNode(point: LngLat, city: City): { readonly nodeId: number; readonly distanceM: number } | null {
  let best: { nodeId: number; distanceM: number } | null = null;
  for (const node of city.graph.nodes) {
    const d = metersBetween(point, node.pos);
    if (best === null || d < best.distanceM) best = { nodeId: node.id, distanceM: d };
  }
  return best;
}

/**
 * The §1 ordered check. `existingDepots` is whatever the caller currently owns — empty for a
 * first depot, read (never mutated) for every later one. Row 0 (depot cap / cash) is not this
 * function's concern — see the module doc comment and `economics.ts`'s `canArmDepotTool`.
 */
export function isDepotSitable(point: LngLat, city: City, existingDepots: readonly Depot[]): DepotSitingResult {
  if (!isInsideBounds(point, city)) return { ok: false, reason: 'outside_city' };

  if (!isOnEligibleZoning(point, city)) return { ok: false, reason: 'not_zoned' };

  const nearestRoad = nearestRoadNode(point, city);
  if (nearestRoad === null || nearestRoad.distanceM > DEPOT_MAX_ROAD_ACCESS_M) {
    return { ok: false, reason: 'no_road_access', nearestRoadDistanceM: nearestRoad?.distanceM ?? Infinity };
  }

  for (const depot of existingDepots) {
    const distanceM = metersBetween(point, depot.position);
    if (distanceM < DEPOT_PLACEMENT_MIN_SEPARATION_M) {
      return { ok: false, reason: 'too_close_to_depot', depotId: depot.id, depotName: depot.name, distanceM };
    }
  }

  return { ok: true, accessNodeId: nearestRoad.nodeId, accessDistanceM: nearestRoad.distanceM };
}
