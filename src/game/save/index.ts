/**
 * Public API of `src/game/save/` (studio/docs/design/save-format.md). This is the only module
 * boundary another part of the game should import across — nothing outside this directory should
 * need a deeper import than `game/save`.
 *
 * Minting a `StopId`/`LineId`/`DepotId`/`BusId` from a loaded `NextIds` uses `nextId` from
 * `lines/types.ts` directly (it's generic over any branded number) — re-exported here so a caller
 * wiring this module doesn't need a second import just for that.
 */

export type {
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
  SaveEnvelope,
} from './types';

export { SAVE_FORMAT, SAVE_COMPANY_NAME_MAX_LENGTH } from './constants';
export { saveKey, unreadableBackupKey, newerBackupKey } from './keys';

export type { SaveStorage } from './storage';
export { createLocalStorageAdapter, createMemoryStorage } from './storage';

export { readSave } from './read';

export type { Migration } from './migrations';
export { MIGRATIONS, runMigrations } from './migrations';

export type { CreateSaveEnvelopeInput } from './write';
export { createSaveEnvelope, serializeSaveEnvelope, writeSave } from './write';

export type { LoadResult, LoadSaveInput } from './load';
export { loadSave } from './load';

export { nextId } from '../lines/types';
