/**
 * Depot-zoning eligibility — "Zoning B" (depots-and-timetables.md §1): "more jobs than residents
 * at below-median density", for any city pack that carries no OSM land-use layer (Riverton today;
 * any future pack in the same situation).
 *
 * Pulled into its own module, not left inline in `generateRiverton.ts`, because this rule already
 * has one consumer here (the generation-time viability assertion) and will gain at least two more
 * once the depot module lands — the placement tool's tint/click handler and the save loader's
 * legality check. House convention is one shared predicate per rule so those three can never
 * disagree; every future consumer should import `isDepotEligibleZone` rather than reimplement it.
 *
 * The separation (400 m), road-access (400 m) and parcel-floor (1 ha) figures are SPEC
 * (depots-and-timetables.md §1; the parcel floor explicitly reuses the real-city SPEC figure).
 * They live here rather than in `src/game/constants.ts` per this agent's file-ownership boundary —
 * flag for promotion into that shared file once the depot module needs them too.
 */

import type { Zone } from '../types';

export const DEPOT_ZONE_MIN_AREA_HA = 1; // SPEC
export const DEPOT_MIN_SEPARATION_M = 400; // SPEC
export const DEPOT_MAX_ROAD_ACCESS_M = 400; // SPEC

/** `density = (residents + jobs) / areaHa`, the Zoning B formula's density term. Infinity for a
 * zero-area zone, so a degenerate zone can never look artificially eligible via division by zero. */
export function zoneDensityPerHa(zone: Zone): number {
  return zone.areaHa > 0 ? (zone.residents + zone.jobs) / zone.areaHa : Infinity;
}

/** Median density over every zone with `areaHa > 0`, per the spec — compute once per zone set and
 * pass the result to `isDepotEligibleZone`, never recompute it per zone. */
export function medianZoneDensityPerHa(zones: readonly Zone[]): number {
  const densities = zones
    .filter((z) => z.areaHa > 0)
    .map(zoneDensityPerHa)
    .sort((a, b) => a - b);
  if (densities.length === 0) return 0;
  const mid = Math.floor(densities.length / 2);
  return densities.length % 2 === 0 ? (densities[mid - 1]! + densities[mid]!) / 2 : densities[mid]!;
}

/**
 * `eligible(z) = jobs[z] > residents[z] && density[z] < medianDensity && areaHa[z] >= 1` — the
 * exact Zoning B formula (depots-and-timetables.md §1). `medianDensityPerHa` must come from
 * `medianZoneDensityPerHa` over the whole zone set the caller is checking against.
 */
export function isDepotEligibleZone(zone: Zone, medianDensityPerHa: number): boolean {
  return zone.jobs > zone.residents && zoneDensityPerHa(zone) < medianDensityPerHa && zone.areaHa >= DEPOT_ZONE_MIN_AREA_HA;
}
