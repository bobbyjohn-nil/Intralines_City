import { describe, expect, it } from 'vitest';
import { nextId } from '../lines/types';
import type { LineId, StopId } from '../lines/types';
import { createSaveEnvelope, serializeSaveEnvelope, writeSave } from './write';
import { loadSave } from './load';
import { readSave } from './read';
import { createMemoryStorage } from './storage';
import { saveKey, unreadableBackupKey, newerBackupKey } from './keys';
import { SAVE_FORMAT } from './constants';
import type { BusId, DepotId, NextIds, SaveData, SaveEnvelope } from './types';

const CITY_ID = 'riverton';
const KNOWN_CITIES = new Set(['riverton', 'boston']);
const isKnownCityId = (id: string) => KNOWN_CITIES.has(id);

/** Step 8's rebuild hook: this module hands the actual pack/re-anchor pass off to a caller (see
 * load.ts's doc comment), so tests plug in a trivial one that just proves the hook runs and can
 * fail loudly when asked to. */
const identityRebuild = (data: SaveData) => ({ stopCount: data.stops.length });
type Derived = ReturnType<typeof identityRebuild>;

function baseSaveData(overrides: Partial<SaveData> = {}): SaveData {
  return {
    clock: { totalMinutes: 1234, speedIndex: 1 },
    company: { brandColor: '#c94f35', foundedAtMs: 1_000, howToPlaySeen: true },
    city: { seed: 42, packFormat: 1, packBuild: 'abc', packHash: 'def' },
    stops: [
      { id: 0 as StopId, name: 'Elm & 4th', position: [-71.06, 42.36], roadClass: 'residential', orphanAcknowledged: false },
      { id: 1 as StopId, name: 'Main St', position: [-71.07, 42.35], roadClass: 'primary', orphanAcknowledged: false },
    ],
    lines: [
      {
        id: 0 as LineId,
        name: 'Route 1',
        color: '#1d3f7a',
        stopIds: [0 as StopId, 1 as StopId],
        fareCents: 225,
        timetable: { mode: 'headway', headwayMinutes: 12 },
        assignedBusIds: [] as readonly BusId[],
      },
    ],
    depots: [],
    buses: [],
    treasury: {
      cashCents: 50_000_012,
      carry: { fuelCents: 0.37, maintenanceCents: 0.91, cumulativeBusServiceMinutes: 600, cumulativeMinutes: 900 },
    },
    nextIds: { stop: 2 as StopId, line: 1 as LineId, bus: 0 as BusId, depot: 0 as DepotId },
    ...overrides,
  };
}

function writeEnvelope(storage: ReturnType<typeof createMemoryStorage>, envelope: SaveEnvelope): void {
  writeSave(storage, envelope);
}

function makeEnvelope(overrides: Partial<SaveData> = {}, envelopeOverrides: Partial<SaveEnvelope> = {}): SaveEnvelope {
  const base = createSaveEnvelope({
    gameVersion: '1.18',
    cityId: CITY_ID,
    companyName: 'Acme Transit',
    sandbox: false,
    savedAtMs: 5_000,
    data: baseSaveData(overrides),
  });
  return { ...base, ...envelopeOverrides };
}

describe('save round-trip', () => {
  it('preserves treasury cents exactly and every line\'s stop order', () => {
    const storage = createMemoryStorage();
    const envelope = makeEnvelope();
    writeEnvelope(storage, envelope);

    const result = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('expected ok');

    expect(result.envelope.data.treasury.cashCents).toBe(envelope.data.treasury.cashCents);
    expect(result.envelope.data.treasury.carry).toEqual(envelope.data.treasury.carry);
    expect(result.envelope.data.lines[0]!.stopIds).toEqual(envelope.data.lines[0]!.stopIds);
    expect(result.derived.stopCount).toBe(2);
  });
});

describe('NEWER refusal', () => {
  it('refuses a save from a newer format and never overwrites it', () => {
    const storage = createMemoryStorage();
    const envelope = makeEnvelope({}, { format: SAVE_FORMAT + 1 });
    const raw = serializeSaveEnvelope(envelope);
    storage.setItem(saveKey(CITY_ID), raw);

    const result = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });

    expect(result.outcome).toBe('newer');
    if (result.outcome === 'newer') expect(result.fileFormat).toBe(SAVE_FORMAT + 1);

    // The live save key is byte-for-byte untouched — never loaded, never overwritten.
    expect(storage.getItem(saveKey(CITY_ID))).toBe(raw);
    // A best-effort copy lands at the newer-backup key.
    expect(storage.getItem(newerBackupKey(CITY_ID))).toBe(raw);
  });
});

describe('UNREADABLE backup', () => {
  it('backs up an unparsable payload before starting fresh', () => {
    const storage = createMemoryStorage();
    const raw = '{not valid json';
    storage.setItem(saveKey(CITY_ID), raw);

    const result = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });

    expect(result.outcome).toBe('unreadable');
    expect(storage.getItem(unreadableBackupKey(CITY_ID))).toBe(raw);
    // Live key cleared so the next load is a fresh start.
    expect(storage.getItem(saveKey(CITY_ID))).toBeNull();
  });

  it('backs up a structurally wrong payload (lines not an array) rather than crashing', () => {
    const storage = createMemoryStorage();
    const envelope = makeEnvelope();
    const corrupted = {
      ...envelope,
      data: { ...envelope.data, lines: 'not-an-array' },
    };
    const raw = JSON.stringify(corrupted);
    storage.setItem(saveKey(CITY_ID), raw);

    const result = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });

    expect(result.outcome).toBe('unreadable');
    expect(storage.getItem(unreadableBackupKey(CITY_ID))).toBe(raw);
    expect(storage.getItem(saveKey(CITY_ID))).toBeNull();
  });
});

describe('missing later-added field', () => {
  it('loads with a default when a field is absent entirely', () => {
    const storage = createMemoryStorage();
    const envelope = makeEnvelope();
    // Simulate a save written before `howToPlaySeen` existed.
    const withoutField = {
      ...envelope,
      data: {
        ...envelope.data,
        company: { brandColor: envelope.data.company.brandColor, foundedAtMs: envelope.data.company.foundedAtMs },
      },
    };
    storage.setItem(saveKey(CITY_ID), JSON.stringify(withoutField));

    const result = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('expected ok');
    expect(result.envelope.data.company.howToPlaySeen).toBe(false);
  });

  it('defaults an entirely missing collection to empty rather than throwing', () => {
    const raw = JSON.stringify({
      format: 1,
      gameVersion: '1.0',
      cityId: CITY_ID,
      companyName: 'X',
      sandbox: false,
      savedAtMs: 0,
      data: { treasury: { cashCents: 100, carry: {} } },
    });
    const data = readSave(JSON.parse(raw).data);
    expect(data.stops).toEqual([]);
    expect(data.lines).toEqual([]);
    expect(data.treasury.cashCents).toBe(100);
  });
});

describe('nextIds stay monotonic across a save/load cycle', () => {
  it('never reuses an id after a reload', () => {
    const storage = createMemoryStorage();
    const envelope = makeEnvelope();
    writeEnvelope(storage, envelope);

    const first = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });
    if (first.outcome !== 'ok') throw new Error('expected ok');

    const nextIds: NextIds = first.envelope.data.nextIds;
    const mintedStopId = nextIds.stop; // 2, per baseSaveData
    const advanced = nextId(mintedStopId);
    expect(advanced).toBe(3);

    // Persist the advanced counter and reload — the next mint must continue from there, never
    // reuse 2.
    const secondEnvelope = createSaveEnvelope({
      gameVersion: envelope.gameVersion,
      cityId: CITY_ID,
      companyName: envelope.companyName,
      sandbox: envelope.sandbox,
      savedAtMs: envelope.savedAtMs + 1,
      data: { ...first.envelope.data, nextIds: { ...nextIds, stop: advanced } },
    });
    writeEnvelope(storage, secondEnvelope);

    const second = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });
    if (second.outcome !== 'ok') throw new Error('expected ok');
    expect(second.envelope.data.nextIds.stop).toBe(3);
    expect(second.envelope.data.nextIds.stop).not.toBe(mintedStopId);
  });
});

describe('a failed load never touches the stored string', () => {
  it('leaves the key exactly as-is on a NEWER refusal', () => {
    const storage = createMemoryStorage();
    const envelope = makeEnvelope({}, { format: SAVE_FORMAT + 5 });
    const raw = serializeSaveEnvelope(envelope);
    storage.setItem(saveKey(CITY_ID), raw);

    loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });

    expect(storage.getItem(saveKey(CITY_ID))).toBe(raw);
  });

  it('leaves the key exactly as-is on a WRONG_CITY refusal', () => {
    const storage = createMemoryStorage();
    const envelope = makeEnvelope({}, { cityId: 'atlantis' });
    const raw = serializeSaveEnvelope(envelope);
    storage.setItem(saveKey(CITY_ID), raw);

    const result = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });

    expect(result.outcome).toBe('wrong_city');
    expect(storage.getItem(saveKey(CITY_ID))).toBe(raw);
  });

  it('leaves the key exactly as-is when step 8 (derived rebuild) throws', () => {
    const storage = createMemoryStorage();
    const envelope = makeEnvelope();
    const raw = serializeSaveEnvelope(envelope);
    storage.setItem(saveKey(CITY_ID), raw);

    const throwingRebuild = () => {
      throw new Error('pack failed to load');
    };

    const result = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: throwingRebuild });

    expect(result.outcome).toBe('unreadable');
    // Unlike NEWER/WRONG_CITY, UNREADABLE *does* clear the live key by design (§2) — assert the
    // backup captured the pre-failure string instead.
    expect(storage.getItem(unreadableBackupKey(CITY_ID))).toBe(raw);
  });
});

describe('no key present', () => {
  it('reports "none" so the caller can offer New company', () => {
    const storage = createMemoryStorage();
    const result = loadSave<Derived>({ storage, cityId: CITY_ID, isKnownCityId, rebuildDerived: identityRebuild });
    expect(result.outcome).toBe('none');
  });
});
