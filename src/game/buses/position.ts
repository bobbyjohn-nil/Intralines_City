/**
 * `busPositionAt` — the one function the renderer calls to find out where a bus is. Manual §15 /
 * `studio/GAME.md`: a bus's position is a **pure function of the game clock**, not something
 * integrated frame by frame and stored, so saves, reloads and speed changes never teleport a
 * bus and the sim doesn't need to have ticked for the renderer to ask "where is bus 3 right now".
 *
 * `(schedule, busIndex, busCount, totalMinutes)` in, a position out — same inputs always give
 * the same output. No allocation per call: this module writes into a caller-owned `BusPosition`
 * (see `createBusPositionScratch`) rather than returning a fresh object, so a renderer polling
 * every bus every frame never grows the heap.
 */

import { toCalendarTime } from '../clock/calendar';
import { DEFAULT_SERVICE_HOURS, MIN_HEADWAY_MINUTES } from '../constants';
import { distanceAtElapsed } from './kinematics';
import { bearingBetween, lerpInto, offsetRightInto } from './geo';
import type { LegSchedule, RouteSchedule } from './schedule';

const SECONDS_PER_MINUTE = 60;

/** How far right of the centreline a bus sits (manual §15: "keep to the right of the centreline
 * so opposing buses pass instead of colliding") — half a lane's width, roughly. Not a number the
 * manual states; picked to read clearly on the map without buses on opposite sides of a two-lane
 * street overlapping. # tune */
const KEEP_RIGHT_OFFSET_M = 2.5;

export type BusState = 'driving' | 'dwelling' | 'layover';

export interface BusPosition {
  /** Mutable in place — see the module comment. Treat as `LngLat` (`[lng, lat]`) when reading. */
  lngLat: [number, number];
  /** Degrees clockwise from north, `[0, 360)` — the bus's direction of travel; holds its
   * upcoming-departure heading while `dwelling` or in `layover`. */
  bearing: number;
  state: BusState;
}

/** One scratch `BusPosition` per bus (or per renderer slot) the caller reuses across every call
 * — never allocate a fresh one per frame. */
export function createBusPositionScratch(): BusPosition {
  return { lngLat: [0, 0], bearing: 0, state: 'layover' };
}

/** Scans `schedule.legs` (built once, small — a handful to a few dozen entries for any one line)
 * for the leg whose `[prevArriveS, arriveS)` window contains `t`. Linear, not binary, search:
 * simpler, and cheap enough at this size to not be worth the extra code. Read-only, no
 * allocation. */
function findLegAt(schedule: RouteSchedule, t: number): LegSchedule {
  const legs = schedule.legs;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg === undefined) continue; // unreachable — array is dense by construction
    if (t < leg.arriveS || i === legs.length - 1) return leg;
  }
  // Unreachable (schedule always has >= 1 leg, guaranteed by buildRouteSchedule), but keeps this
  // function's return type non-nullable rather than pushing an impossible null check onto every
  // caller.
  return legs[legs.length - 1]!;
}

/** Finds the polyline segment of `leg` containing `targetDistM` along its cumulative-distance
 * array and writes the interpolated point/bearing into `out`. No allocation. */
function placeOnLeg(leg: LegSchedule, targetDistM: number, out: BusPosition): void {
  const cum = leg.cumDistM;
  let segIndex = cum.length - 2;
  for (let i = 0; i < cum.length - 1; i++) {
    const next = cum[i + 1];
    if (next !== undefined && targetDistM <= next) {
      segIndex = i;
      break;
    }
  }

  const a = leg.polyline[segIndex];
  const b = leg.polyline[segIndex + 1];
  const segStart = cum[segIndex];
  const segEnd = cum[segIndex + 1];
  if (a === undefined || b === undefined || segStart === undefined || segEnd === undefined) {
    // Impossible given a well-formed schedule (polyline and cumDistM are always the same,
    // >= 2, length) — fail loud in dev rather than silently drawing a bus at (0, 0).
    throw new Error('busPositionAt: malformed schedule leg — polyline/cumDistM mismatch');
  }

  const segT = segEnd > segStart ? (targetDistM - segStart) / (segEnd - segStart) : 0;
  lerpInto(a, b, segT, out.lngLat);
  offsetRightInto(a, b, out.lngLat, KEEP_RIGHT_OFFSET_M, out.lngLat);
  out.bearing = bearingBetween(a, b);
}

/**
 * Where bus `busIndex` of `busCount` on `schedule` is at `totalMinutes` of game time.
 *
 * - Buses are staggered evenly across the route: headway = round trip ÷ `busCount`, floored at
 *   `MIN_HEADWAY_MINUTES` (manual §15 / `MIN_HEADWAY_MINUTES`).
 * - Returns `null` (leaving `out` untouched) outside `DEFAULT_SERVICE_HOURS` — nothing runs.
 * - Writes into and returns `out`; never allocates. Get one with `createBusPositionScratch` and
 *   reuse it.
 */
export function busPositionAt(
  schedule: RouteSchedule,
  busIndex: number,
  busCount: number,
  totalMinutes: number,
  out: BusPosition
): BusPosition | null {
  if (busCount <= 0 || busIndex < 0 || busIndex >= busCount || !Number.isFinite(busIndex)) {
    // A caller bug (asking for a bus that doesn't exist), not a player-reachable state — fail
    // loud in dev via console (survives into release builds) but never crash the player's run.
    console.error(`busPositionAt: busIndex ${busIndex} is out of range for busCount ${busCount}`);
    return null;
  }
  if (schedule.roundTripDurationS <= 0) {
    console.error(`busPositionAt: schedule for line ${schedule.lineId} has a non-positive round trip`);
    return null;
  }

  const { hour } = toCalendarTime(totalMinutes);
  if (hour < DEFAULT_SERVICE_HOURS.firstHour || hour >= DEFAULT_SERVICE_HOURS.lastHour) return null;

  const roundTripMinutes = schedule.roundTripDurationS / SECONDS_PER_MINUTE;
  const headwayMinutes = Math.max(MIN_HEADWAY_MINUTES, roundTripMinutes / busCount);
  const offsetS = busIndex * headwayMinutes * SECONDS_PER_MINUTE;

  const rawT = totalMinutes * SECONDS_PER_MINUTE - offsetS;
  const roundTripS = schedule.roundTripDurationS;
  const t = ((rawT % roundTripS) + roundTripS) % roundTripS;

  const leg = findLegAt(schedule, t);

  if (t < leg.departS) {
    // Stopped at fromStopId — dwelling at an intermediate stop or laying over at a terminus.
    // Face the way it's about to depart (the manual's "face their direction of travel" reads
    // most naturally for a stopped bus as "the way it's about to pull out"), and keep the same
    // right-of-centreline offset as while driving — a bus sits at the curb while stopped, not
    // straddling the centreline, and it keeps every sample (waiting or driving) on the same
    // offset curve so there's no artificial jump the instant it pulls away.
    const start = leg.polyline[0];
    const next = leg.polyline[1];
    if (start === undefined || next === undefined) {
      throw new Error('busPositionAt: malformed schedule leg — polyline shorter than 2 points');
    }
    offsetRightInto(start, next, start, KEEP_RIGHT_OFFSET_M, out.lngLat);
    out.bearing = bearingBetween(start, next);
    out.state = leg.waitKind;
    return out;
  }

  const elapsedS = t - leg.departS;
  const distM = distanceAtElapsed(leg.profile, elapsedS);
  const totalPolylineM = leg.cumDistM[leg.cumDistM.length - 1] ?? 0;
  const fraction = leg.lengthM > 0 ? distM / leg.lengthM : 0;
  const targetDistM = fraction * totalPolylineM;

  placeOnLeg(leg, targetDistM, out);
  out.state = 'driving';
  return out;
}
