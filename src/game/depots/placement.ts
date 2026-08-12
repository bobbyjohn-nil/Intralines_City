/**
 * Orchestrates one depot purchase: the §1 row-0 arm gate (cap + cash), the §1 rows 1-4 siting
 * check (`isDepotSitable`), and the spend itself (`economy/ledger.ts`'s `spend` — depots cost
 * money, and the ledger's existing spend/refund pair is the one place cash ever moves). Pure: a
 * `Treasury` and the current depot list go in, a new `Treasury` and `Depot` come out, or a
 * discriminated failure naming which gate refused it and why, matching the cursor-chip messages
 * the check table names.
 */

import type { City, LngLat } from '../types';
import type { Treasury } from '../economy/types';
import { CENTS_PER_USD } from '../economy/types';
import { spend } from '../economy/ledger';
import { canArmDepotTool } from './economics';
import { isDepotSitable } from './siting';
import type { Depot, DepotId } from './types';

export type PlaceDepotResult =
  | { readonly ok: true; readonly depot: Depot; readonly treasury: Treasury }
  | { readonly ok: false; readonly stage: 'arm'; readonly reason: 'depot_limit_reached' }
  | {
      readonly ok: false;
      readonly stage: 'arm';
      readonly reason: 'insufficient_funds';
      readonly costUsd: number;
      readonly cashUsd: number;
    }
  | { readonly ok: false; readonly stage: 'site'; readonly reason: 'outside_city' }
  | { readonly ok: false; readonly stage: 'site'; readonly reason: 'not_zoned' }
  | { readonly ok: false; readonly stage: 'site'; readonly reason: 'no_road_access'; readonly nearestRoadDistanceM: number }
  | {
      readonly ok: false;
      readonly stage: 'site';
      readonly reason: 'too_close_to_depot';
      readonly depotId: DepotId;
      readonly depotName: string;
      readonly distanceM: number;
    };

/**
 * Buys and sites one depot at `point`, always level 1 (§8: "Depot placement, level 1, one
 * depot... $150k purchase"). Runs the row-0 arm gate before the siting check — cheapest-first,
 * per the spec's own ordering rationale — then spends only once both agree. `nextId` is the
 * caller-threaded id counter (mirrors `lines/draft.ts`'s `DraftState.nextStopId` — minted
 * outside, never reset per call).
 */
export function placeDepot(
  point: LngLat,
  name: string,
  city: City,
  existingDepots: readonly Depot[],
  treasury: Treasury,
  nextId: DepotId
): PlaceDepotResult {
  const cashUsd = treasury.cashCents / CENTS_PER_USD;
  const arm = canArmDepotTool(existingDepots.length, cashUsd);
  if (!arm.ok) return { ...arm, stage: 'arm' };

  const site = isDepotSitable(point, city, existingDepots);
  if (!site.ok) return { ...site, stage: 'site' };

  const spendResult = spend(treasury, arm.costUsd, `Depot: ${name}`);
  if (!spendResult.ok) {
    // Cash disagreed between the arm check and the spend itself — shouldn't happen within one
    // synchronous call, but never trust two reads of the same treasury to agree silently.
    return { ok: false, stage: 'arm', reason: 'insufficient_funds', costUsd: arm.costUsd, cashUsd };
  }

  const depot: Depot = {
    id: nextId,
    name,
    position: point,
    level: 1,
    accessNodeId: site.accessNodeId,
    busesParked: 0,
  };

  return { ok: true, depot, treasury: spendResult.treasury };
}
