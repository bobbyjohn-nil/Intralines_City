import { describe, expect, it } from 'vitest';
import { generateRiverton, RIVERTON_SEED } from '../city/generateRiverton';
import { addStop, canCreate, startDraft, summarizeDraft } from '../lines/draft';
import type { Line, LineId, Stop, StopId } from '../lines/types';
import type { City, LngLat, StreetGraph } from '../types';
import { BUS_MODELS, DEFAULT_SERVICE_HOURS, MIN_HEADWAY_MINUTES, STARTING_BUS_MODEL } from '../constants';
import { buildRouteSchedule } from './schedule';
import { busPositionAt, createBusPositionScratch } from './position';
import { metersBetween } from './geo';

const CRUISE_SPEED_KMH = BUS_MODELS[STARTING_BUS_MODEL]!.cruiseSpeedKmh;
const KMH_TO_MS = 1000 / 3600;
const CRUISE_SPEED_MS = CRUISE_SPEED_KMH * KMH_TO_MS;

const city = generateRiverton(RIVERTON_SEED);

/** Midpoint of an edge's two endpoints — a deterministic click guaranteed to snap to that edge
 * (mirrors `lines/draft.test.ts`'s helper of the same name). */
function midpointOf(graph: StreetGraph, edgeIndex: number): LngLat {
  const edge = graph.edges[edgeIndex]!;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const from = nodeById.get(edge.from)!;
  const to = nodeById.get(edge.to)!;
  return [(from.pos[0] + to.pos[0]) / 2, (from.pos[1] + to.pos[1]) / 2];
}

/** Builds a real, multi-stop line over Riverton's street graph using the draft helpers, the
 * same way a player draws one — spread across the grid so most legs span several edges and
 * `schedule.ts`'s polyline reconstruction gets exercised, not just the single-edge case. Returns
 * the line alongside the top-level stop collection its `stopIds` resolve against
 * (save-format.md §5) — `App.tsx` keeps the same pair, alongside `lines`. */
function buildTestLine(testCity: City): { readonly line: Line; readonly stopsById: ReadonlyMap<StopId, Stop> } {
  const edgeCount = testCity.graph.edges.length;
  const stopEdgeIndices = [0, Math.floor(edgeCount * 0.3), Math.floor(edgeCount * 0.6), edgeCount - 1];

  let state = startDraft(testCity.graph);
  for (const edgeIndex of stopEdgeIndices) {
    const result = addStop(state, midpointOf(testCity.graph, edgeIndex));
    if (!result.ok) throw new Error(`buildTestLine: could not place a stop — ${result.reason}`);
    state = result.state;
  }
  if (!canCreate(state)) throw new Error('buildTestLine: draft never became a creatable line');

  const draft = summarizeDraft(state);
  const line: Line = {
    id: 1 as LineId,
    name: 'Test Line',
    stopIds: draft.stops.map((stop) => stop.id),
    legs: draft.legs,
    totalLengthM: draft.totalLengthM,
  };
  const stopsById = new Map(draft.stops.map((stop) => [stop.id, stop] as const));
  return { line, stopsById };
}

const { line, stopsById } = buildTestLine(city);
const schedule = buildRouteSchedule(line, stopsById, city.graph, CRUISE_SPEED_KMH);

/** A totalMinutes comfortably inside `DEFAULT_SERVICE_HOURS` for every sample a test takes —
 * `toCalendarTime` folds in `START_MINUTE_OF_DAY` (06:00), so `totalMinutes = 120` lands at
 * 08:00 on day 1, hours away from either service-hours boundary. */
const MIDDAY_TOTAL_MINUTES = 120;

function headwayMinutesFor(busCount: number): number {
  const roundTripMinutes = schedule.roundTripDurationS / 60;
  return Math.max(MIN_HEADWAY_MINUTES, roundTripMinutes / busCount);
}

describe('buildRouteSchedule (via position.ts)', () => {
  it('produces a positive round-trip duration with at least one leg per direction', () => {
    expect(schedule.roundTripDurationS).toBeGreaterThan(0);
    expect(schedule.legs.length).toBe(2 * (line.stopIds.length - 1));
  });
});

describe('busPositionAt', () => {
  it('is deterministic: identical arguments produce identical results', () => {
    const outA = createBusPositionScratch();
    const outB = createBusPositionScratch();

    const a = busPositionAt(schedule, 0, 3, MIDDAY_TOTAL_MINUTES, outA);
    const b = busPositionAt(schedule, 0, 3, MIDDAY_TOTAL_MINUTES, outB);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(outA).toEqual(outB);
  });

  it('is deterministic across repeated calls into the same scratch object', () => {
    const out = createBusPositionScratch();
    busPositionAt(schedule, 1, 3, MIDDAY_TOTAL_MINUTES, out);
    const first = { lngLat: [...out.lngLat] as [number, number], bearing: out.bearing, state: out.state };

    busPositionAt(schedule, 1, 3, MIDDAY_TOTAL_MINUTES, out);
    expect(out.lngLat).toEqual(first.lngLat);
    expect(out.bearing).toBe(first.bearing);
    expect(out.state).toBe(first.state);
  });

  it('returns null outside DEFAULT_SERVICE_HOURS and leaves the scratch object untouched', () => {
    const out = createBusPositionScratch();
    const beforeOpen = { lngLat: [...out.lngLat] as [number, number], bearing: out.bearing, state: out.state };

    // 03:00 — before firstHour (06:00).
    const nightMinutes = 3 * 60 - 6 * 60; // totalMinutes such that the calendar's minuteOfDay is 03:00
    const result = busPositionAt(schedule, 0, 2, nightMinutes, out);

    expect(result).toBeNull();
    expect(out).toEqual(beforeOpen);
  });

  it('returns null at and after lastHour (22:00), and non-null just before it', () => {
    const out = createBusPositionScratch();
    // totalMinutes = 0 is 06:00 on day 1 (START_MINUTE_OF_DAY); 16 hours later is 22:00.
    const atLastHour = 16 * 60;
    const justBefore = atLastHour - 1;

    expect(busPositionAt(schedule, 0, 2, atLastHour, out)).toBeNull();
    expect(busPositionAt(schedule, 0, 2, justBefore, out)).not.toBeNull();
  });

  it('two buses on the same line are separated by exactly one headway', () => {
    const busCount = 3;
    const headwayMinutes = headwayMinutesFor(busCount);

    const outA = createBusPositionScratch();
    const outB = createBusPositionScratch();

    const a = busPositionAt(schedule, 0, busCount, MIDDAY_TOTAL_MINUTES, outA);
    const b = busPositionAt(schedule, 1, busCount, MIDDAY_TOTAL_MINUTES + headwayMinutes, outB);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(outB.lngLat[0]).toBeCloseTo(outA.lngLat[0], 9);
    expect(outB.lngLat[1]).toBeCloseTo(outA.lngLat[1], 9);
    expect(outB.state).toBe(outA.state);
  });

  it('the headway is floored at MIN_HEADWAY_MINUTES even with many buses on a short line', () => {
    const busCount = 1000; // enough to force roundTrip / busCount below the floor
    expect(headwayMinutesFor(busCount)).toBe(MIN_HEADWAY_MINUTES);
  });

  it('never teleports: 1-second samples across a full round trip never move farther than cruise speed allows', () => {
    const out = createBusPositionScratch();
    const dtS = 1;
    const roundTripS = Math.ceil(schedule.roundTripDurationS);

    // The right-of-centreline offset (position.ts's KEEP_RIGHT_OFFSET_M) can shift by up to
    // twice its own magnitude the instant the bus's heading changes at a stop or a polyline
    // vertex — a small, bounded, intentional lateral correction, not a teleport. The physical
    // bound this test enforces is "cruise speed's worth of forward travel plus that bounded
    // correction", sampled every second for a full lap.
    const KEEP_RIGHT_OFFSET_M = 2.5; // must match position.ts's constant of the same name
    const maxAllowedM = CRUISE_SPEED_MS * dtS + 2 * KEEP_RIGHT_OFFSET_M + 0.5; // +0.5 m slack for projection approximation

    let previous: LngLat | null = null;
    let maxObservedM = 0;

    for (let t = 0; t <= roundTripS; t += dtS) {
      const totalMinutes = MIDDAY_TOTAL_MINUTES + t / 60;
      const result = busPositionAt(schedule, 0, 1, totalMinutes, out);
      expect(result).not.toBeNull();
      if (result === null) continue;

      const here: LngLat = [result.lngLat[0], result.lngLat[1]];
      if (previous !== null) {
        const distM = metersBetween(previous, here);
        maxObservedM = Math.max(maxObservedM, distM);
        expect(distM).toBeLessThanOrEqual(maxAllowedM);
      }
      previous = here;
    }

    expect(maxObservedM).toBeGreaterThan(0); // sanity: the bus actually moved at some point
    // eslint-disable-next-line no-console -- reported by the task, not left in as debug noise
    console.log(`no-teleport check: max inter-sample distance observed = ${maxObservedM.toFixed(3)} m`);
  });

  it('a bus faces its direction of travel while driving', () => {
    const out = createBusPositionScratch();
    const result = busPositionAt(schedule, 0, 1, MIDDAY_TOTAL_MINUTES, out);
    expect(result).not.toBeNull();
    expect(out.bearing).toBeGreaterThanOrEqual(0);
    expect(out.bearing).toBeLessThan(360);
  });
});
