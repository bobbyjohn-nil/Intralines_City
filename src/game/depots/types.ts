/**
 * Save-facing shapes for depots (depots-and-timetables.md §1-§3). Deliberately flat, same
 * reasoning as `lines/types.ts` — these are what a save (once the save format grows a depot
 * section) would serialize, so no class instances, no `Map`/`Set`.
 *
 * Milestone scope: this module builds placement (§1) and dead-heading (§3) only. Timetables
 * (§4) and add-ons (§2's Workshop/Wash bay/Chargers) are not built here — `DepotLevel` and the
 * cost/capacity/upkeep ladder exist because placement needs to price a depot and dead-heading
 * needs to know how much parking it has, not because upgrades or add-ons are wired in yet.
 */

import type { LngLat } from '../types';

/** Branded so a raw `number` — an array index, a loop counter — can never be passed where a
 * depot id is expected. Same convention as `lines/types.ts`'s `StopId`/`LineId`. */
export type DepotId = number & { readonly __brand: 'DepotId' };

/** Mints the next branded depot id. Mirrors `lines/types.ts`'s `nextId`, kept as a local copy
 * rather than imported — this directory owns nothing outside itself, the same convention
 * `buses/geo.ts` follows against `lines/geo.ts` (see that file's header comment). */
export function nextDepotId(id: DepotId): DepotId {
  return ((id as number) + 1) as DepotId;
}

/** 1 = base, 2 = expanded, 3 = full yard (§2). */
export type DepotLevel = 1 | 2 | 3;

/**
 * A depot as sited and leveled. `accessNodeId` is the routable road node nearest the depot's
 * gate, resolved once by `isDepotSitable`'s check 3 at placement time and reused by every later
 * dead-head allocation rather than re-snapped per call (§3: "recomputed on line create, bus
 * assign, depot build/remove, never per tick").
 */
export interface Depot {
  readonly id: DepotId;
  readonly name: string;
  readonly position: LngLat;
  readonly level: DepotLevel;
  readonly accessNodeId: number;
  /** Buses currently parked here. The dead-head allocator's "parking free" test reads this
   * against the level's capacity (`economics.ts`'s `depotCapacity`). Owned by whichever system
   * assigns buses to depots (not built here) — this module only ever reads it. */
  readonly busesParked: number;
}
