/**
 * The ordered check sequence on open (save-format.md §1). First failure decides the outcome and
 * stops. Steps 6-8 run on a throwaway copy — `key` is never written to during a load; the stored
 * string is untouched until the caller's first successful autosave *after* a clean load. The one
 * exception is UNREADABLE, which per §2 moves the raw string to a backup key and deletes the live
 * one as *part of* declaring the outcome, not as a side effect of a later step.
 */

import { SAVE_COMPANY_NAME_MAX_LENGTH, SAVE_FORMAT } from './constants';
import { newerBackupKey, saveKey, unreadableBackupKey } from './keys';
import { runMigrations } from './migrations';
import { isRecord, readBooleanField, readNumberField, readStringField } from './primitives';
import { readSave } from './read';
import type { SaveStorage } from './storage';
import type { SaveData, SaveEnvelope } from './types';

export type LoadResult<TDerived> =
  | { readonly outcome: 'none' }
  | { readonly outcome: 'ok'; readonly migrated: boolean; readonly envelope: SaveEnvelope; readonly derived: TDerived }
  | { readonly outcome: 'newer'; readonly fileFormat: number }
  | { readonly outcome: 'unreadable' }
  | { readonly outcome: 'wrong_city'; readonly fileCityId: string };

export interface LoadSaveInput<TDerived> {
  readonly storage: SaveStorage;
  readonly cityId: string;
  /** Step 5 — whether `fileCityId` names a city this build ships. Injected rather than owned here:
   * this module doesn't hold the city catalogue. */
  readonly isKnownCityId: (cityId: string) => boolean;
  /**
   * Step 8 — "derived rebuild succeeds: pack loads, stops re-anchor (§5.2)". The pack loader and
   * the §5.2 re-anchor pass are a later piece of work owned by whichever module ends up loading
   * city packs and routing lines; this is deliberately just the hook that runs them, so this
   * module stays decoupled from both. A throw here is treated exactly like a step 6/7 failure —
   * UNREADABLE, backed up, fresh start (an orphaned stop, per §5.3, is *not* a failure and must
   * not throw from here).
   */
  readonly rebuildDerived: (data: SaveData, envelope: SaveEnvelope) => TDerived;
}

/** §2's UNREADABLE behaviour: move the raw string to the single-slot backup key, then delete the
 * live one. Best-effort on the backup write — losing it to a quota error must never block the
 * fresh start it's protecting against. */
function backupAndClearUnreadable(storage: SaveStorage, cityId: string, raw: string): void {
  try {
    storage.setItem(unreadableBackupKey(cityId), raw);
  } catch {
    // Quota or similar — the fresh start below still has to happen.
  }
  storage.removeItem(saveKey(cityId));
}

export function loadSave<TDerived>(input: LoadSaveInput<TDerived>): LoadResult<TDerived> {
  const { storage, cityId, isKnownCityId, rebuildDerived } = input;
  const key = saveKey(cityId);

  // Step 1 — key present.
  const raw = storage.getItem(key);
  if (raw === null) return { outcome: 'none' };

  // Step 2 — JSON.parse succeeds.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    backupAndClearUnreadable(storage, cityId, raw);
    return { outcome: 'unreadable' };
  }

  // Step 3 — shape sanity: non-null object; format an integer >= 1; cityId a string.
  if (!isRecord(parsed)) {
    backupAndClearUnreadable(storage, cityId, raw);
    return { outcome: 'unreadable' };
  }
  const format = parsed.format;
  const fileCityId = parsed.cityId;
  const formatIsValid = typeof format === 'number' && Number.isInteger(format) && format >= 1;
  if (!formatIsValid || typeof fileCityId !== 'string') {
    backupAndClearUnreadable(storage, cityId, raw);
    return { outcome: 'unreadable' };
  }

  // Step 4 — format <= SAVE_FORMAT. A newer save is never loaded and never overwritten (§2) — the
  // live key is left exactly as it was; only a best-effort copy goes to the newer-backup key.
  if (format > SAVE_FORMAT) {
    try {
      storage.setItem(newerBackupKey(cityId), raw);
    } catch {
      // "best effort, skipped on quota" (§2).
    }
    return { outcome: 'newer', fileFormat: format };
  }

  // Step 5 — cityId is a known city. Refuse and write nothing — this is the import-only path
  // (§1: "refuse, keep file"); the live key (which can only ever hold this city's own save) is
  // left untouched either way.
  if (!isKnownCityId(fileCityId)) {
    return { outcome: 'wrong_city', fileCityId };
  }

  // Steps 6-8 run on a throwaway copy of `parsed` — nothing below writes back to `key`.
  try {
    // Step 6 — migration chain, format -> SAVE_FORMAT.
    const migratedData = runMigrations(format, parsed.data);

    // Step 7 — readSave: defaults fill gaps, a throw means a field is structurally wrong.
    const data = readSave(migratedData);

    const envelope: SaveEnvelope = {
      format: SAVE_FORMAT,
      gameVersion: readStringField(parsed.gameVersion, 'unknown'),
      cityId: fileCityId,
      companyName: readStringField(parsed.companyName, '').slice(0, SAVE_COMPANY_NAME_MAX_LENGTH),
      sandbox: readBooleanField(parsed.sandbox, false),
      savedAtMs: readNumberField(parsed.savedAtMs, 0),
      data,
    };

    // Step 8 — derived rebuild (pack load + §5.2 re-anchor, owned by the caller's hook).
    const derived = rebuildDerived(data, envelope);

    return { outcome: 'ok', migrated: format < SAVE_FORMAT, envelope, derived };
  } catch {
    backupAndClearUnreadable(storage, cityId, raw);
    return { outcome: 'unreadable' };
  }
}
