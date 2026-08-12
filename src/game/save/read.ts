/**
 * `readSave` — total against everything except a structurally wrong collection (save-format.md §1
 * step 7: "defaults fill gaps; a throw means a field is structurally wrong, e.g. `lines` is not an
 * array"). Every scalar field goes through `primitives.ts`'s `??`-style readers so a missing or
 * mistyped field degrades to a default instead of throwing; only `readArrayField` throws, and only
 * when the field is *present* as something other than an array — a missing array field is just an
 * empty save-format-additive default (§3's "defaults-on-read is primary").
 *
 * Runs on already-migrated data (post `runMigrations`, §1 step 6) — never on the raw envelope.
 */

import type { LngLat, RoadClass } from '../types';
import { ROAD_SPEED_KMH, CLOCK_DEFAULT_SPEED_INDEX, DEFAULT_FARE_USD, STARTING_BUS_MODEL, STARTING_CASH_USD } from '../constants';
import type { LineId, StopId } from '../lines/types';
import type { LedgerCarry, Treasury } from '../economy/types';
import { CENTS_PER_USD } from '../economy/types';
import { isRecord, readBooleanField, readNumberField, readStringField } from './primitives';
import type {
  BusId,
  DepotId,
  NextIds,
  SaveCityIdentity,
  SaveClock,
  SaveCompany,
  SaveData,
  SavedBus,
  SavedDepot,
  SavedLine,
  SavedStop,
  SavedTimetable,
} from './types';

const DEFAULT_ROAD_CLASS: RoadClass = 'residential';
const DEFAULT_POSITION: LngLat = [0, 0];
const ROAD_CLASSES = new Set<string>(Object.keys(ROAD_SPEED_KMH));
/** TUNE — the manual doesn't state a default headway; a save missing one gets a middling number
 * rather than 0 (which would read as "no service"). */
const DEFAULT_HEADWAY_MINUTES = 10;
const DEFAULT_LINE_COLOR = '#1d3f7a'; // GAME.md palette --blue
const DEFAULT_BRAND_COLOR = '#1d3f7a';

function readPosition(value: unknown): LngLat {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return [value[0], value[1]];
  }
  return DEFAULT_POSITION;
}

function readRoadClass(value: unknown): RoadClass {
  return typeof value === 'string' && ROAD_CLASSES.has(value) ? (value as RoadClass) : DEFAULT_ROAD_CLASS;
}

/** A missing array field defaults to `[]` (additive-field-friendly); a *present* non-array value
 * throws — that's the one structurally-wrong case §1 step 7 names explicitly. */
function readArrayField<T>(value: unknown, field: string, readItem: (item: unknown) => T): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`readSave: "${field}" is present but not an array`);
  }
  return value.map((item) => readItem(item));
}

function readIdArrayField<T extends number>(value: unknown, field: string): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`readSave: "${field}" is present but not an array`);
  }
  return value.filter((item): item is number => typeof item === 'number') as unknown as readonly T[];
}

function readClock(value: unknown): SaveClock {
  const rec = isRecord(value) ? value : {};
  return {
    totalMinutes: readNumberField(rec.totalMinutes, 0),
    speedIndex: readNumberField(rec.speedIndex, CLOCK_DEFAULT_SPEED_INDEX),
  };
}

function readCompany(value: unknown): SaveCompany {
  const rec = isRecord(value) ? value : {};
  return {
    brandColor: readStringField(rec.brandColor, DEFAULT_BRAND_COLOR),
    foundedAtMs: readNumberField(rec.foundedAtMs, 0),
    howToPlaySeen: readBooleanField(rec.howToPlaySeen, false),
  };
}

function readCityIdentity(value: unknown): SaveCityIdentity {
  const rec = isRecord(value) ? value : {};
  return {
    seed: readNumberField(rec.seed, 0),
    packFormat: readNumberField(rec.packFormat, 0),
    packBuild: readStringField(rec.packBuild, ''),
    packHash: readStringField(rec.packHash, ''),
  };
}

function readStop(item: unknown): SavedStop {
  if (!isRecord(item)) throw new Error('readSave: a "stops" entry is not an object');
  const id = readNumberField(item.id, Number.NaN);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('readSave: a "stops" entry has no valid integer "id"');
  }
  return {
    id: id as StopId,
    name: readStringField(item.name, ''),
    position: readPosition(item.position),
    roadClass: readRoadClass(item.roadClass),
    orphanAcknowledged: readBooleanField(item.orphanAcknowledged, false),
  };
}

function readTimetable(value: unknown): SavedTimetable {
  const rec = isRecord(value) ? value : {};
  return {
    mode: readStringField(rec.mode, 'headway'),
    headwayMinutes: readNumberField(rec.headwayMinutes, DEFAULT_HEADWAY_MINUTES),
  };
}

function readLine(item: unknown): SavedLine {
  if (!isRecord(item)) throw new Error('readSave: a "lines" entry is not an object');
  const id = readNumberField(item.id, Number.NaN);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('readSave: a "lines" entry has no valid integer "id"');
  }
  return {
    id: id as LineId,
    name: readStringField(item.name, ''),
    color: readStringField(item.color, DEFAULT_LINE_COLOR),
    stopIds: readIdArrayField<StopId>(item.stopIds, 'lines[].stopIds'),
    fareCents: readNumberField(item.fareCents, Math.round(DEFAULT_FARE_USD * CENTS_PER_USD)),
    timetable: readTimetable(item.timetable),
    assignedBusIds: readIdArrayField<BusId>(item.assignedBusIds, 'lines[].assignedBusIds'),
  };
}

function readDepot(item: unknown): SavedDepot {
  if (!isRecord(item)) throw new Error('readSave: a "depots" entry is not an object');
  const id = readNumberField(item.id, Number.NaN);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('readSave: a "depots" entry has no valid integer "id"');
  }
  const addons = Array.isArray(item.addons) ? item.addons.filter((a): a is string => typeof a === 'string') : [];
  return {
    id: id as DepotId,
    position: readPosition(item.position),
    level: readNumberField(item.level, 1),
    addons,
  };
}

function readBus(item: unknown): SavedBus {
  if (!isRecord(item)) throw new Error('readSave: a "buses" entry is not an object');
  const id = readNumberField(item.id, Number.NaN);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('readSave: a "buses" entry has no valid integer "id"');
  }
  const lineId = typeof item.lineId === 'number' ? (item.lineId as LineId) : null;
  return {
    id: id as BusId,
    model: readStringField(item.model, STARTING_BUS_MODEL),
    mk: readNumberField(item.mk, 1),
    depotId: readNumberField(item.depotId, Number.NaN) as DepotId,
    lineId,
    odometerKm: readNumberField(item.odometerKm, 0),
    wearPoints: readNumberField(item.wearPoints, 0),
    purchasedAtMinutes: readNumberField(item.purchasedAtMinutes, 0),
  };
}

function readTreasury(value: unknown): Treasury {
  const rec = isRecord(value) ? value : {};
  const carryRec = isRecord(rec.carry) ? rec.carry : {};
  const carry: LedgerCarry = {
    fuelCents: readNumberField(carryRec.fuelCents, 0),
    maintenanceCents: readNumberField(carryRec.maintenanceCents, 0),
    cumulativeBusServiceMinutes: readNumberField(carryRec.cumulativeBusServiceMinutes, 0),
    cumulativeMinutes: readNumberField(carryRec.cumulativeMinutes, 0),
  };
  return {
    cashCents: readNumberField(rec.cashCents, Math.round(STARTING_CASH_USD * CENTS_PER_USD)),
    carry,
  };
}

function readNextIds(value: unknown): NextIds {
  const rec = isRecord(value) ? value : {};
  return {
    stop: readNumberField(rec.stop, 0) as StopId,
    line: readNumberField(rec.line, 0) as LineId,
    bus: readNumberField(rec.bus, 0) as BusId,
    depot: readNumberField(rec.depot, 0) as DepotId,
  };
}

/** Reads the envelope's `data` field into a complete `SaveData`. Throws only when a field meant to
 * be a collection is present as something else — every other gap is filled from a default (§1
 * step 7). `data` itself being something other than an object is the same category of failure. */
export function readSave(data: unknown): SaveData {
  if (!isRecord(data)) {
    throw new Error('readSave: "data" is not an object');
  }
  return {
    clock: readClock(data.clock),
    company: readCompany(data.company),
    city: readCityIdentity(data.city),
    stops: readArrayField(data.stops, 'stops', readStop),
    lines: readArrayField(data.lines, 'lines', readLine),
    depots: readArrayField(data.depots, 'depots', readDepot),
    buses: readArrayField(data.buses, 'buses', readBus),
    treasury: readTreasury(data.treasury),
    nextIds: readNextIds(data.nextIds),
  };
}
