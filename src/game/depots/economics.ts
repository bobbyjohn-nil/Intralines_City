/**
 * Depot economics (depots-and-timetables.md §2) — the pricing ladder, per-level capacity and
 * upkeep, and the §1 row-0 "tool won't arm" gate (depot cap + cash together). Upgrades are
 * priced here too (needed to reason about a depot once bought) but nothing wires an upgrade
 * purchase yet — add-ons (Workshop/Wash bay/Chargers) aren't built at all; out of this pass's
 * scope per the task brief.
 */

import {
  DEPOT_COSTS_USD,
  DEPOT_LEVEL_CAPACITY,
  DEPOT_LEVEL_UPKEEP_USD_PER_DAY,
  DEPOT_MAX_COUNT,
  DEPOT_UPGRADE_COST_USD,
} from './constants';
import type { Depot, DepotLevel } from './types';

/** Price of the next depot a company with `depotsOwnedCount` already owns would pay. `null`
 * once the cap (`DEPOT_MAX_COUNT`) is reached — never negative-indexes the ladder. */
export function nextDepotCostUsd(depotsOwnedCount: number): number | null {
  if (depotsOwnedCount < 0 || depotsOwnedCount >= DEPOT_MAX_COUNT) return null;
  return DEPOT_COSTS_USD[depotsOwnedCount] ?? null;
}

/** Row 0 of the §1 check table: "Depots owned < 5 · cash >= next price." Kept as its own gate
 * (distinct from `siting.ts`'s `isDepotSitable`) because it needs a cash balance the point-based
 * checks never see, and because it's what decides whether the placement tool arms at all — the
 * spec's own framing ("Tool won't arm"), not a per-click failure. */
export type DepotArmResult =
  | { readonly ok: true; readonly costUsd: number }
  | { readonly ok: false; readonly reason: 'depot_limit_reached' }
  | { readonly ok: false; readonly reason: 'insufficient_funds'; readonly costUsd: number; readonly cashUsd: number };

export function canArmDepotTool(depotsOwnedCount: number, cashUsd: number): DepotArmResult {
  const costUsd = nextDepotCostUsd(depotsOwnedCount);
  if (costUsd === null) return { ok: false, reason: 'depot_limit_reached' };
  if (cashUsd < costUsd) return { ok: false, reason: 'insufficient_funds', costUsd, cashUsd };
  return { ok: true, costUsd };
}

/** Upgrade cost from `currentLevel` to the next level up, or `null` already at the top (L3). */
export function nextUpgradeCostUsd(currentLevel: DepotLevel): number | null {
  if (currentLevel === 1) return DEPOT_UPGRADE_COST_USD[2];
  if (currentLevel === 2) return DEPOT_UPGRADE_COST_USD[3];
  return null;
}

export function depotCapacity(level: DepotLevel): number {
  return DEPOT_LEVEL_CAPACITY[level];
}

export function depotUpkeepUsdPerDay(level: DepotLevel): number {
  return DEPOT_LEVEL_UPKEEP_USD_PER_DAY[level];
}

/** Total parking slots across every owned depot — "Fleet size is capped by *total* depot
 * capacity" (§2). */
export function totalDepotCapacity(depots: readonly Depot[]): number {
  let total = 0;
  for (const depot of depots) total += depotCapacity(depot.level);
  return total;
}

/** Whether a company running `fleetSize` buses across `depots` may buy one more — capacity's
 * predicate form, so a bus-purchase flow (not built here) can call it without re-deriving the
 * arithmetic each time. */
export function canAddBusToFleet(depots: readonly Depot[], fleetSize: number): boolean {
  return fleetSize < totalDepotCapacity(depots);
}
