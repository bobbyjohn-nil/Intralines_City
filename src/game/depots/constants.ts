/**
 * Depot tunables (depots-and-timetables.md §1-§3). Scoped to `src/game/depots/` per this agent's
 * file-ownership boundary — `src/game/constants.ts` is being edited by other agents concurrently
 * — and every value below is flagged for promotion into that shared file once a second consumer
 * outside this directory needs one of them.
 *
 * NOTE on `DEPOT_MIN_SEPARATION_M` in `city/zones.ts`: that constant is a *different* rule
 * wearing a similar name. It spaces the >= 3 deliberately-generated eligible zones apart at
 * bake time (`generateRiverton.ts`'s `assertDepotSitingViable`, depots-and-timetables.md §1's
 * "Riverton's generator must emit... at least 3 zones passing eligible(), >= 400 m apart") — a
 * generation-time viability check over *candidate zoning*, not depots a player has actually
 * placed. The runtime "too close to an existing depot" check (§1 row 4 of the check table) is
 * its own SPEC figure, 120 m, defined below as `DEPOT_PLACEMENT_MIN_SEPARATION_M`. Reusing the
 * zones.ts constant here would silently apply the wrong number (400 m instead of 120 m) to a
 * rule it was never written for — see `siting.ts`.
 */

import type { DepotLevel } from './types';

// ── Placement (§1) ────────────────────────────────────────────────────────────

/** Row 4 of the §1 check table: "No existing depot within 120 m". SPEC. Distinct from
 * `city/zones.ts`'s `DEPOT_MIN_SEPARATION_M` — see this file's header comment. */
export const DEPOT_PLACEMENT_MIN_SEPARATION_M = 120;

/** Row 2's "60 m kerb tolerance" dilation on the zoning-polygon test. SPEC. Applied at
 * check-time here (point-to-polygon-boundary distance in `geo.ts`) rather than baked into a
 * dissolved-and-dilated polygon layer at pack-generation time the way §1 prescribes — this
 * module doesn't own `city/`, and no such baked layer exists yet to read. The result is
 * identical for any single query; it's only "cheap with a grid index" (the spec's own framing)
 * that's deferred, which is exactly why the tint's 20 Hz pointer-move budget is a `city/`
 * pipeline concern, not this predicate's. */
export const DEPOT_ZONING_KERB_TOLERANCE_M = 60;

// ── Economics (§2) ───────────────────────────────────────────────────────────

/** Price of the Nth depot, 0-indexed by how many a company already owns. Shipped as a literal
 * ladder, not `150_000 * 1.5^n` — the manual's own rounding is authority. SPEC. */
export const DEPOT_COSTS_USD: readonly number[] = [150_000, 225_000, 340_000, 505_000, 760_000];

/** A company may never own more than this many depots. SPEC. */
export const DEPOT_MAX_COUNT = 5;

/** Parking capacity by level. SPEC. */
export const DEPOT_LEVEL_CAPACITY: Readonly<Record<DepotLevel, number>> = { 1: 6, 2: 14, 3: 30 };

/** Cost to upgrade *to* the given level, from the level directly below it. SPEC. */
export const DEPOT_UPGRADE_COST_USD: Readonly<Record<2 | 3, number>> = { 2: 220_000, 3: 450_000 };

/** Daily upkeep by level, USD. SPEC. */
export const DEPOT_LEVEL_UPKEEP_USD_PER_DAY: Readonly<Record<DepotLevel, number>> = { 1: 300, 2: 700, 3: 1_400 };

// ── Dead-heading (§3) ────────────────────────────────────────────────────────

/** Fallback speed for an unroutable depot→line pull-out, so a bus is never left unallocated:
 * "Unroutable → great-circle ÷ 25 km/h, logged." The formula is SPEC; this speed's exact value
 * isn't named beyond that, so it's `# tune` in provenance even though the manual states the
 * formula shape. */
export const DEADHEAD_FALLBACK_SPEED_KMH = 25; // # tune
