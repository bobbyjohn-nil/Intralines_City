/**
 * The save envelope and everything persisted inside it (studio/docs/design/save-format.md §1, §4).
 *
 * `SaveEnvelope` is the one shape ever written to a save key or an export file — `format` and
 * `savedAtMs` sit at the top level (outside `data`) precisely so a refusal (§1 steps 4-5) never
 * requires parsing the payload underneath. `SaveData` is the §4 persisted boundary: player
 * decisions, non-replayable accumulators, and the ids/seeds needed to rebuild the rest — schedules,
 * bus positions, `edgeId`/`edgeT`, `RouteLeg`s and the city's own graph/scenery are never in here
 * (§4 "Rebuilt on load, never in the file").
 *
 * Scope note: this is the §8 "Milestone 2 cut" — `reports`, `ledgerHistory`, `transactions`, loans
 * and staff are deferred, per that section, and are simply absent from `SaveData` rather than
 * present-with-a-default. Adding any of them later is an additive field in `read.ts`, not a
 * `SAVE_FORMAT` bump (§3's contributor rule).
 */

import type { LngLat, RoadClass } from '../types';
import type { LineId, StopId } from '../lines/types';
import type { Treasury } from '../economy/types';

// ── Ids not yet hoisted elsewhere ───────────────────────────────────────────
// Depots and buses don't have a home in `src/game/` yet (concurrent work); this module still has
// to shape what a save persists for them (§4), so their branded ids live here until that module
// lands and becomes the source of truth — at that point these two lines move, nothing else does.
// `nextId` (lines/types.ts) is generic over any branded number, so it mints these the same way it
// mints `StopId`/`LineId`.

export type DepotId = number & { readonly __brand: 'DepotId' };
export type BusId = number & { readonly __brand: 'BusId' };

// ── The envelope (§1) ────────────────────────────────────────────────────────

export interface SaveEnvelope {
  /** SAVE_FORMAT this envelope was written at, or (on a file read from storage) the format it
   * claims — checked against the module's current `SAVE_FORMAT` before anything else (§1 step 4). */
  readonly format: number;
  /** Display-only. Never branched on — see save-format.md §1. */
  readonly gameVersion: string;
  /** A stable city slug, e.g. `"boston"`, `"riverton"`. Doubles as the storage key suffix. */
  readonly cityId: string;
  /** ≤ `SAVE_COMPANY_NAME_MAX_LENGTH` chars — enforced at input time by the naming UI; `read.ts`
   * only clamps defensively for a hand-edited or imported file. */
  readonly companyName: string;
  /** Permanent for the life of the company (§4) — never toggled after founding. */
  readonly sandbox: boolean;
  /** `Date.now()` at write time, captured by the caller — nothing in this module calls `Date.now()`
   * itself (see write.ts). */
  readonly savedAtMs: number;
  readonly data: SaveData;
}

// ── Persisted pieces (§4) ────────────────────────────────────────────────────

/** Not `GameClock` (`src/game/types.ts`) — `paused` is deliberately absent. Entering a city always
 * starts paused (SPEC §5), so persisting it would just be a second source of truth for a constant. */
export interface SaveClock {
  readonly totalMinutes: number;
  /** Index into `CLOCK_SPEEDS`. */
  readonly speedIndex: number;
}

export interface SaveCompany {
  readonly brandColor: string;
  readonly foundedAtMs: number;
  readonly howToPlaySeen: boolean;
}

/** `seed` regenerates a procedural city (Riverton); `packFormat`/`packBuild`/`packHash` identify
 * the baked pack a real city was last loaded against (§5.4) — read on load to decide whether a
 * rebake happened, not read by this module itself. */
export interface SaveCityIdentity {
  readonly seed: number;
  readonly packFormat: number;
  readonly packBuild: string;
  readonly packHash: string;
}

/** A stop as persisted — the §5.1 anchor `(position, roadClass)` plus identity and the one
 * player-set flag. Deliberately missing `edgeId`/`edgeT`/`orphaned`/`movedM` from `lines/types.ts`'s
 * `Stop` — those are derived-and-rebuilt by the §5.2 re-anchor pass on every load, which is a later
 * piece of work this module hands off to via `LoadSaveInput.rebuildDerived` (see `load.ts`). */
export interface SavedStop {
  readonly id: StopId;
  readonly name: string;
  readonly position: LngLat;
  readonly roadClass: RoadClass;
  readonly orphanAcknowledged: boolean;
}

/** Placeholder shape until the timetable system (depots-and-timetables.md) lands and becomes the
 * source of truth — `mode`/`headwayMinutes` cover "mode + headway" per save-format.md §4 without
 * assuming a specific mode enum this module doesn't own. TUNE (shape, not values) */
export interface SavedTimetable {
  readonly mode: string;
  readonly headwayMinutes: number;
}

/** A line as persisted — `stopIds` order is travel order (§5); `legs`/`totalLengthM`/`isExpress`
 * (`lines/types.ts`'s `Line`) are re-routed on load, one A* per leg, and are never in here. */
export interface SavedLine {
  readonly id: LineId;
  readonly name: string;
  readonly color: string;
  readonly stopIds: readonly StopId[];
  readonly fareCents: number;
  readonly timetable: SavedTimetable;
  readonly assignedBusIds: readonly BusId[];
}

export interface SavedDepot {
  readonly id: DepotId;
  readonly position: LngLat;
  readonly level: number;
  readonly addons: readonly string[];
}

export interface SavedBus {
  readonly id: BusId;
  readonly model: string;
  readonly mk: number;
  readonly depotId: DepotId;
  readonly lineId: LineId | null;
  readonly odometerKm: number;
  readonly wearPoints: number;
  /** Game-clock minutes (`SaveClock.totalMinutes`'s epoch), not `Date.now()`. */
  readonly purchasedAtMinutes: number;
}

/** Monotonic counters, one per branded id type, never decremented and never reused across a
 * save/load cycle (§5: "every persisted entity carries a monotonic integer id ... never reused"). */
export interface NextIds {
  readonly stop: StopId;
  readonly line: LineId;
  readonly bus: BusId;
  readonly depot: DepotId;
}

/**
 * Everything inside the envelope's `data` field. `treasury` carries `Treasury` as-is from
 * `economy/types.ts` — `cashCents` plus all four `LedgerCarry` fields — because the carry is an
 * accumulator, not a derivative; dropping it re-introduces the sub-cent drift `ledger.test.ts`
 * exists to prevent (§4).
 */
export interface SaveData {
  readonly clock: SaveClock;
  readonly company: SaveCompany;
  readonly city: SaveCityIdentity;
  readonly stops: readonly SavedStop[];
  readonly lines: readonly SavedLine[];
  readonly depots: readonly SavedDepot[];
  readonly buses: readonly SavedBus[];
  readonly treasury: Treasury;
  readonly nextIds: NextIds;
}
