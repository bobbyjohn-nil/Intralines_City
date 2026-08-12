/**
 * Stage B — network recompute (demand-model.md §1, first-slice scope: B1 + a direct-only B5 +
 * B6 + B7) and the module's public entry points.
 *
 * Everything in this file reruns on every player edit — this is the ~250 ms debounce's payload —
 * so nothing here allocates. `stops`/`lines` are re-read from scratch each call (they're the only
 * things that change); Stage A's zone statics are read-only inputs, computed once and passed in.
 *
 * **What round-1-only buys, structurally.** B5 seeds `walkSeedArrival` from walk access only and
 * only ever *reads* from it when boarding a line; a line's relaxed result lands in the separate
 * `bestArrivalAtStop`, which is never itself read as a boarding source. That asymmetry is what
 * makes "no transfers" true by construction rather than by a rule the search has to remember —
 * round 2 (demand-model.md §4 step 4) would simply reseed a second pair of arrays from round 1's
 * results and repeat, which is why this shape was chosen over a simpler one-array relaxation.
 *
 * **What this slice does not attempt.** The real spec (§4) runs one seeded RAPTOR pass per origin
 * zone in `O((K + S·3) · Z)`, exploiting `stopLines` (≤ 3 lines/stop) and earliest-improving-label
 * bookkeeping to stay near-linear at `S = 600`. This file gets the same *answer* for round-1-only
 * by brute-checking every stop pair on every line against every zone's access list — `O(Z · L ·
 * P²)` for the ride search plus `O(Z² · A)` for egress (`P` = stops/line, `A` = avg access
 * stops/zone) — which is fine at Riverton's `Z = 96` and a handful of short lines, and is not
 * claimed to hold at `S = 600`. Swap this for real RAPTOR when round 2 (transfers) lands; don't
 * before, per "do not build past the slice."
 */

import type { City } from '../types';
import type { Line, Stop } from '../lines/types';
import type { CityDemandStatics, DemandBuffers, DemandResult } from './types';
import { projectToMeters } from './geo';
import { computeCityStatics } from './stageA';
import {
  ASSUMED_HEADWAY_MIN,
  CAPTIVE_SHARE,
  LOGIT_SCALE_FACTOR,
  LOGIT_SENSITIVITY_MIN,
  TRIPS_PER_COMMUTER_PER_DAY,
  WAIT_CAP_MIN,
} from './constants';
import { WALK_MINUTES_PER_KM, WALK_RADIUS_M } from '../constants';

export type { CityDemandStatics, DemandBuffers, DemandResult } from './types';
export { computeCityStatics } from './stageA';

// ── Buffer lifecycle ────────────────────────────────────────────────────────

/**
 * Allocates every array `computeCityStatics`/`computeDemand` write into, sized once. Call this
 * at city load (`zoneCapacity` must equal the city's zone count) with generous `stopCapacity`/
 * `lineCapacity` headroom for the session's network to grow into; `computeDemand` throws rather
 * than silently truncating if the network ever exceeds them (see its doc comment) — the caller's
 * fix is a fresh, bigger `DemandBuffers`, not a resize this module doesn't perform.
 */
export function createDemandBuffers(zoneCapacity: number, stopCapacity: number, lineCapacity: number): DemandBuffers {
  const zz = zoneCapacity * zoneCapacity;
  const zoneStopCap = zoneCapacity * stopCapacity;
  const lineStopCap = lineCapacity * stopCapacity;

  return {
    zoneCapacity,
    stopCapacity,
    lineCapacity,

    zoneXM: new Float64Array(zoneCapacity),
    zoneYM: new Float64Array(zoneCapacity),
    zoneProd: new Float64Array(zoneCapacity),
    zoneDistM: new Float32Array(zz),
    carMinutes: new Float32Array(zz),
    odCommute: new Float64Array(zz),

    zoneAccessOffset: new Int32Array(zoneCapacity + 1),
    zoneAccessStopIndex: new Int32Array(zoneStopCap),
    zoneAccessWalkMin: new Float32Array(zoneStopCap),

    stopXM: new Float32Array(stopCapacity),
    stopYM: new Float32Array(stopCapacity),

    lineOffset: new Int32Array(lineCapacity + 1),
    lineStop: new Int32Array(lineStopCap),
    lineCumMin: new Float32Array(lineStopCap),

    walkSeedArrival: new Float32Array(stopCapacity),
    bestArrivalAtStop: new Float32Array(stopCapacity),
    bestLineAtStop: new Int32Array(stopCapacity),

    busMin: new Float32Array(zz),
    bestLineForOD: new Int32Array(zz),

    boardingsPerLine: new Float64Array(lineCapacity),
    linkedTripsPerLine: new Float64Array(lineCapacity),
  };
}

/** Sum of every typed array's `byteLength` in `buffers` — the module's actual, measured memory
 * footprint at whatever capacity it was created with. Not itself part of a recompute; safe to
 * call whenever (once at city load, from a debug panel, from a test). */
export function demandBuffersByteLength(buffers: DemandBuffers): number {
  let total = 0;
  for (const value of Object.values(buffers)) {
    if (ArrayBuffer.isView(value)) total += value.byteLength;
  }
  return total;
}

// ── Stage B ──────────────────────────────────────────────────────────────────

/**
 * The debounced recompute. `buffers` must come from `createDemandBuffers` with capacity for at
 * least `stops.length`/`lines.length`/`statics.zoneCount`; `statics` must come from
 * `computeCityStatics` called on the *same* `buffers` for the *same* city. Mutates `buffers` in
 * place (B1, B2, B5's scratch, `busMin`, `bestLineForOD`, the two per-line totals) and returns a
 * fresh `DemandResult` header referencing views into it — no per-zone or per-stop object is ever
 * allocated.
 */
export function computeDemand(
  buffers: DemandBuffers,
  statics: CityDemandStatics,
  lines: readonly Line[],
  stops: readonly Stop[],
): DemandResult {
  const z = statics.zoneCount;
  if (z !== buffers.zoneCapacity) {
    throw new Error(`computeDemand: statics.zoneCount (${z}) does not match buffers.zoneCapacity (${buffers.zoneCapacity})`);
  }
  if (stops.length > buffers.stopCapacity) {
    throw new Error(`computeDemand: ${stops.length} stops exceeds buffer capacity ${buffers.stopCapacity}`);
  }
  if (lines.length > buffers.lineCapacity) {
    throw new Error(`computeDemand: ${lines.length} lines exceeds buffer capacity ${buffers.lineCapacity}`);
  }

  projectStops(buffers, statics, stops);
  buildZoneAccessCsr(buffers, z, stops);
  buildLineTables(buffers, statics, lines, stops);
  computeBusMinutes(buffers, z, lines.length, stops.length);
  const totals = assignModeAndAggregate(buffers, z, lines.length);

  return {
    lineCount: lines.length,
    zoneCount: z,
    boardingsPerLine: buffers.boardingsPerLine.subarray(0, lines.length),
    linkedTripsPerLine: buffers.linkedTripsPerLine.subarray(0, lines.length),
    totalBoardingsPerDay: totals.totalBoardings,
    totalLinkedTripsPerDay: totals.totalBoardings, // identical this slice — see types.ts
    totalTripsPerDay: totals.totalTrips,
    busSharePerDay: totals.totalTrips > 0 ? totals.totalBoardings / totals.totalTrips : 0,
  };
}

/** Refreshes the stop-position scratch (`stopXM`/`stopYM`) from `stops`, projected onto the
 * city's fixed tangent plane so distances agree with `zoneXM`/`zoneYM`. */
function projectStops(buffers: DemandBuffers, statics: CityDemandStatics, stops: readonly Stop[]): void {
  for (let k = 0; k < stops.length; k++) {
    const { xM, yM } = projectToMeters(statics.projection, stops[k]!.position);
    buffers.stopXM[k] = xM;
    buffers.stopYM[k] = yM;
  }
}

/** B1: zone→stop walk access as CSR, two passes (count, then fill) over the same preallocated
 * `zoneAccessStopIndex`/`zoneAccessWalkMin` — no allocation, capacity bounded by `zoneCapacity *
 * stopCapacity` at buffer-creation time. No stop-tier bonus this slice (§9 tiers are out of
 * scope): every stop reaches exactly `WALK_RADIUS_M`, perceived at a flat `WALK_MINUTES_PER_KM`. */
function buildZoneAccessCsr(buffers: DemandBuffers, z: number, stops: readonly Stop[]): void {
  const s = stops.length;

  buffers.zoneAccessOffset[0] = 0;
  for (let i = 0; i < z; i++) {
    let count = 0;
    for (let k = 0; k < s; k++) {
      if (walkDistanceM(buffers, i, k) <= WALK_RADIUS_M) count++;
    }
    buffers.zoneAccessOffset[i + 1] = buffers.zoneAccessOffset[i]! + count;
  }

  // Fill pass: each row's cursor starts at its own offset and advances as entries are written. A
  // dedicated Int32Array scratch (sized to zoneCapacity) would do the same job with one more
  // buffer for a single throwaway pass; a plain per-row local is simpler and is not itself an
  // allocation (`cursor` is a number, not a typed array).
  for (let i = 0; i < z; i++) {
    let cursor = buffers.zoneAccessOffset[i]!;
    for (let k = 0; k < s; k++) {
      const distM = walkDistanceM(buffers, i, k);
      if (distM <= WALK_RADIUS_M) {
        buffers.zoneAccessStopIndex[cursor] = k;
        buffers.zoneAccessWalkMin[cursor] = (distM / 1000) * WALK_MINUTES_PER_KM;
        cursor++;
      }
    }
  }
}

function walkDistanceM(buffers: DemandBuffers, zoneIdx: number, stopIdx: number): number {
  const dx = buffers.stopXM[stopIdx]! - buffers.zoneXM[zoneIdx]!;
  const dy = buffers.stopYM[stopIdx]! - buffers.zoneYM[zoneIdx]!;
  return Math.hypot(dx, dy);
}

/** B2 (free-flow only — congestion, §15, is out of scope this slice): per-line cumulative
 * minutes at each stop position, CSR. Resolves each line's `StopId`s against `stops` once per
 * call via a `Map<StopId, index>` — the one intentional exception to "no allocation in B1–B9"
 * (studio/GAME.md's rule targets the 60 fps tick; this runs at most 4×/s, and the alternative is
 * an O(S) linear scan per stop reference, worse in the case that matters, many stops on few
 * lines). A `StopId` not found in `stops` marks its `lineStop` entry -1 (orphaned reference — the
 * line just carries nobody there; never a crash — see `computeBusMinutes`'s -1 checks). */
function buildLineTables(buffers: DemandBuffers, statics: CityDemandStatics, lines: readonly Line[], stops: readonly Stop[]): void {
  const stopIndexById = new Map<number, number>();
  for (let k = 0; k < stops.length; k++) stopIndexById.set(stops[k]!.id, k);

  buffers.lineOffset[0] = 0;
  let cursor = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    let cumMin = 0;
    for (let p = 0; p < line.stopIds.length; p++) {
      if (p > 0) {
        const leg = line.legs[p - 1];
        let legMin = 0;
        if (leg !== undefined) {
          for (const edgeId of leg.edgeIds) legMin += statics.edgeTimeMinById.get(edgeId) ?? 0;
        }
        cumMin += legMin;
      }
      const stopIdx = stopIndexById.get(line.stopIds[p]!);
      buffers.lineStop[cursor] = stopIdx ?? -1;
      buffers.lineCumMin[cursor] = cumMin;
      cursor++;
    }
    buffers.lineOffset[li + 1] = cursor;
  }
}

const WAIT_MIN = Math.min(WAIT_CAP_MIN, 0.5 * ASSUMED_HEADWAY_MIN);

/** B5, direct-only (round 1, no transfers, no clusters): for every origin zone, seed
 * `walkSeedArrival` from B1's access list, relax every line's stop pairs once into
 * `bestArrivalAtStop`/`bestLineAtStop` (reading only the seed, writing only the result — see this
 * file's header comment for why that's what makes it round-1-only), then egress into `busMin`/
 * `bestLineForOD` for every destination zone. */
function computeBusMinutes(buffers: DemandBuffers, z: number, lineCount: number, stopCount: number): void {
  buffers.busMin.fill(Infinity, 0, z * z);
  buffers.bestLineForOD.fill(-1, 0, z * z);

  for (let i = 0; i < z; i++) {
    buffers.walkSeedArrival.fill(Infinity, 0, stopCount);
    buffers.bestArrivalAtStop.fill(Infinity, 0, stopCount);
    buffers.bestLineAtStop.fill(-1, 0, stopCount);

    const iStart = buffers.zoneAccessOffset[i]!;
    const iEnd = buffers.zoneAccessOffset[i + 1]!;
    for (let e = iStart; e < iEnd; e++) {
      const stopIdx = buffers.zoneAccessStopIndex[e]!;
      buffers.walkSeedArrival[stopIdx] = buffers.zoneAccessWalkMin[e]!;
    }

    for (let li = 0; li < lineCount; li++) {
      const lStart = buffers.lineOffset[li]!;
      const lEnd = buffers.lineOffset[li + 1]!;
      for (let a = lStart; a < lEnd; a++) {
        const stopA = buffers.lineStop[a]!;
        if (stopA < 0) continue;
        const boardArrival = buffers.walkSeedArrival[stopA]!;
        if (!Number.isFinite(boardArrival)) continue;
        const cumA = buffers.lineCumMin[a]!;

        for (let b = lStart; b < lEnd; b++) {
          if (b === a) continue;
          const stopB = buffers.lineStop[b]!;
          if (stopB < 0) continue;
          const onboardMin = Math.abs(buffers.lineCumMin[b]! - cumA);
          const candidate = boardArrival + WAIT_MIN + onboardMin;
          if (candidate < buffers.bestArrivalAtStop[stopB]!) {
            buffers.bestArrivalAtStop[stopB] = candidate;
            buffers.bestLineAtStop[stopB] = li;
          }
        }
      }
    }

    for (let j = 0; j < z; j++) {
      const jStart = buffers.zoneAccessOffset[j]!;
      const jEnd = buffers.zoneAccessOffset[j + 1]!;
      let best = Infinity;
      let bestLine = -1;
      for (let e = jStart; e < jEnd; e++) {
        const stopIdx = buffers.zoneAccessStopIndex[e]!;
        const arrival = buffers.bestArrivalAtStop[stopIdx]!;
        if (!Number.isFinite(arrival)) continue;
        const total = arrival + buffers.zoneAccessWalkMin[e]!;
        if (total < best) {
          best = total;
          bestLine = buffers.bestLineAtStop[stopIdx]!;
        }
      }
      const idx = i * z + j;
      buffers.busMin[idx] = best;
      buffers.bestLineForOD[idx] = bestLine;
    }
  }
}

/** B6 (mode-choice logit + captive floor) and B7 (flat all-day assignment, aggregated straight to
 * B9's per-line totals — there is no intermediate per-hour or per-stop assignment this slice).
 * Captive riders "ride if any path exists; if `busMin` is infinite they are stranded, not riders"
 * (demand-model.md §3) — an infinite `busMin` contributes 0 share, full stop, never the 0.13
 * floor.
 *
 * `odCommute[i][j]` is Stage A's one-way *commuter* flow (conserves to `zoneProd[i]`, per its own
 * doc comment) — the point this function reads it is deliberately the only place
 * `TRIPS_PER_COMMUTER_PER_DAY` (out and back) gets applied, so `odCommute` itself keeps
 * conserving to `prod[i]`, not `2 * prod[i]` (demand-model.md §7's conservation test). */
function assignModeAndAggregate(buffers: DemandBuffers, z: number, lineCount: number): { totalTrips: number; totalBoardings: number } {
  buffers.boardingsPerLine.fill(0, 0, lineCount);
  buffers.linkedTripsPerLine.fill(0, 0, lineCount);

  let totalTrips = 0;
  let totalBoardings = 0;

  for (let i = 0; i < z; i++) {
    for (let j = 0; j < z; j++) {
      const idx = i * z + j;
      const odTrips = buffers.odCommute[idx]! * TRIPS_PER_COMMUTER_PER_DAY;
      totalTrips += odTrips;
      if (odTrips <= 0) continue;

      const busMinVal = buffers.busMin[idx]!;
      if (!Number.isFinite(busMinVal)) continue; // stranded, not captive — see doc comment above

      const carMinVal = buffers.carMinutes[idx]!;
      const share =
        CAPTIVE_SHARE +
        ((1 - CAPTIVE_SHARE) * LOGIT_SCALE_FACTOR) / (1 + Math.exp((busMinVal - carMinVal) / LOGIT_SENSITIVITY_MIN));
      const busTrips = odTrips * share;

      const lineIdx = buffers.bestLineForOD[idx]!;
      if (lineIdx < 0) continue; // shouldn't happen when busMinVal is finite; fail soft, not loud

      buffers.boardingsPerLine[lineIdx] = buffers.boardingsPerLine[lineIdx]! + busTrips;
      buffers.linkedTripsPerLine[lineIdx] = buffers.linkedTripsPerLine[lineIdx]! + busTrips;
      totalBoardings += busTrips;
    }
  }

  return { totalTrips, totalBoardings };
}

// ── Convenience entry point ─────────────────────────────────────────────────

/**
 * The whole pipeline (Stage A + Stage B) in one call, for tests and any caller that doesn't need
 * to hold a `DemandBuffers` across calls. Reruns Stage A's O(Z²) gravity table every time it's
 * called, so **this is not the production path** — a real caller (the worker wiring, not owned by
 * this module) should call `createDemandBuffers` once at city load, `computeCityStatics` once per
 * city, and `computeDemand` on every debounce, reusing both across calls. This function exists so
 * "one entry point that takes the city, the lines and the stops" also has a literal, single-call
 * answer.
 */
export function computeDemandForCity(
  city: City,
  lines: readonly Line[],
  stops: readonly Stop[],
  cityCarSpeedKmh: number,
): DemandResult {
  const buffers = createDemandBuffers(city.zones.length, Math.max(stops.length, 1), Math.max(lines.length, 1));
  const statics = computeCityStatics(buffers, city, cityCarSpeedKmh);
  return computeDemand(buffers, statics, lines, stops);
}
