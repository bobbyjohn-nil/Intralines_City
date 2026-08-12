/**
 * Dead-heading (depots-and-timetables.md §3): where a bus is stabled costs real money before a
 * rider ever boards, and that's what makes siting a real decision — this module is the proof.
 * Buses pull out from the nearest depot *with parking free*, by driving time over the road
 * graph, never straight-line distance: a depot 30 m away across a park with no bridge can lose
 * to one 2 km away that sits right on the arterial, and that's the whole point of the check.
 *
 * `allocateNearestDepot` reuses a `PathfindContext` built once per graph (see
 * `lines/pathfind.ts`'s doc comment) across every candidate depot in a single call — same idiom
 * as `lines/draft.ts`'s `routeLeg`, no allocation inside the search itself.
 */

import type { LngLat, StreetGraph } from '../types';
import type { BusModelSpec } from '../constants';
import { DRIVER_WAGE_PER_HOUR_USD } from '../constants';
import { createPathfindContext, findPath, type PathfindContext } from '../lines/pathfind';
import { DEADHEAD_FALLBACK_SPEED_KMH } from './constants';
import { depotCapacity } from './economics';
import { metersBetween } from './geo';
import type { Depot, DepotId } from './types';

// Re-exported so a caller only needs `deadhead.ts` to build the context this module's own
// functions expect — `createPathfindContext` itself is `lines/pathfind.ts`'s, never
// reimplemented here.
export { createPathfindContext };
export type { PathfindContext };

const KMH_TO_MS = 1000 / 3600;
const METERS_PER_KM = 1000;
const SECONDS_PER_HOUR = 3600;

export interface DeadheadRoute {
  readonly depotId: DepotId;
  readonly deadheadKm: number;
  readonly deadheadTimeS: number;
  /** `false` when the depot's access node and the line's terminus node aren't connected in the
   * road graph and the great-circle/25 km/h fallback was used instead — the caller should log
   * this, per §3: "Unroutable → great-circle ÷ 25 km/h, logged; never leave a bus unallocated." */
  readonly routedOverRoadGraph: boolean;
}

export type AllocateDepotResult =
  | ({ readonly ok: true } & DeadheadRoute)
  | { readonly ok: false; readonly reason: 'no_depot_with_free_parking' };

/** Driving time (not distance) from `depot`'s access node to `terminusNodeId`, scaled by
 * `congestionMultiplier` for the pull-out hour — "free-flow × the pull-out hour's congestion
 * multiplier" (§3) — falling back to great-circle ÷ 25 km/h if the two aren't connected in the
 * graph. Distance itself is never congestion-scaled: congestion slows a bus, it doesn't lengthen
 * the road. */
function routeToTerminus(
  ctx: PathfindContext,
  graph: StreetGraph,
  depot: Depot,
  terminusNodeId: number,
  terminusPosition: LngLat,
  congestionMultiplier: number
): DeadheadRoute {
  const path = findPath(ctx, graph, depot.accessNodeId, terminusNodeId);
  if (path !== null) {
    return {
      depotId: depot.id,
      deadheadKm: path.totalLengthM / METERS_PER_KM,
      deadheadTimeS: path.totalTimeS * congestionMultiplier,
      routedOverRoadGraph: true,
    };
  }

  const fallbackM = metersBetween(depot.position, terminusPosition);
  const fallbackSpeedMs = DEADHEAD_FALLBACK_SPEED_KMH * KMH_TO_MS;
  return {
    depotId: depot.id,
    deadheadKm: fallbackM / METERS_PER_KM,
    deadheadTimeS: fallbackM / fallbackSpeedMs,
    routedOverRoadGraph: false,
  };
}

/**
 * Allocates one bus pulling out to serve a line whose first terminus is `terminusNodeId` (at
 * `terminusPosition`, used only by the unroutable fallback). Considers every depot with parking
 * free (`busesParked < depotCapacity(level)`) and picks whichever is reachable in the least
 * driving time; ties break to more free parking, then lower `DepotId` — "so saves stay stable"
 * (§3). Never returns "unallocated" for want of a route: an unroutable depot still gets a
 * great-circle/25 km/h estimate and competes on that basis. Recompute this on line create, bus
 * assign, or depot build/remove — never per tick.
 */
export function allocateNearestDepot(
  ctx: PathfindContext,
  graph: StreetGraph,
  terminusNodeId: number,
  terminusPosition: LngLat,
  depots: readonly Depot[],
  congestionMultiplier = 1
): AllocateDepotResult {
  let best: (DeadheadRoute & { readonly freeParking: number }) | null = null;

  for (const depot of depots) {
    const freeParking = depotCapacity(depot.level) - depot.busesParked;
    if (freeParking <= 0) continue;

    const route = routeToTerminus(ctx, graph, depot, terminusNodeId, terminusPosition, congestionMultiplier);

    const better =
      best === null ||
      route.deadheadTimeS < best.deadheadTimeS ||
      (route.deadheadTimeS === best.deadheadTimeS &&
        (freeParking > best.freeParking || (freeParking === best.freeParking && depot.id < best.depotId)));

    if (better) best = { ...route, freeParking };
  }

  if (best === null) return { ok: false, reason: 'no_depot_with_free_parking' };
  const { freeParking: _freeParking, ...route } = best;
  return { ok: true, ...route };
}

// ── Cost (§3: "it costs money") ───────────────────────────────────────────────

export interface DeadheadCost {
  readonly fuelUsd: number;
  readonly maintenanceUsd: number;
  readonly wagesUsd: number;
  /** Sum of the three lines above. Finance breaks this out as its own row, "Dead-head", beside
   * Fuel — never folded silently into revenue-km fuel/maintenance/wages. */
  readonly totalUsd: number;
}

/**
 * Dead-head kilometres and minutes cost exactly what revenue kilometres cost — the same per-km
 * fuel and maintenance rate as `economy/ledger.ts`'s `accrue` applies to revenue driving, the
 * same per-minute driver wage — "free dead-head would delete the reason siting exists" (§3).
 * Pure and deliberately outside `economy/ledger.ts`: dead-head cost isn't a discrete `spend`, it
 * accrues continuously the way revenue-km fuel/maintenance/wages already do, so the caller folds
 * `totalUsd` into whatever ledger period it's tracking rather than this module touching a
 * `Treasury` directly.
 */
export function deadheadCostUsd(deadheadKm: number, deadheadTimeS: number, busModel: BusModelSpec): DeadheadCost {
  const fuelUsd = deadheadKm * busModel.fuelPerKmUsd;
  const maintenanceUsd = deadheadKm * (busModel.costPerKmUsd - busModel.fuelPerKmUsd);
  const wagesUsd = (deadheadTimeS / SECONDS_PER_HOUR) * DRIVER_WAGE_PER_HOUR_USD;
  return { fuelUsd, maintenanceUsd, wagesUsd, totalUsd: fuelUsd + maintenanceUsd + wagesUsd };
}
