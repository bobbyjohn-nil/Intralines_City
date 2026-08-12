/**
 * The envelope writer (save-format.md §1, §6). Pure construction + serialization, plus the one
 * function that actually calls `storage.setItem` on the write side.
 */

import { saveKey } from './keys';
import { SAVE_COMPANY_NAME_MAX_LENGTH, SAVE_FORMAT } from './constants';
import type { SaveStorage } from './storage';
import type { SaveData, SaveEnvelope } from './types';

export interface CreateSaveEnvelopeInput {
  readonly gameVersion: string;
  readonly cityId: string;
  readonly companyName: string;
  readonly sandbox: boolean;
  /** Caller-supplied — nothing in this module calls `Date.now()` itself. */
  readonly savedAtMs: number;
  readonly data: SaveData;
}

/** Builds the envelope at this module's current `SAVE_FORMAT`. Pure. */
export function createSaveEnvelope(input: CreateSaveEnvelopeInput): SaveEnvelope {
  return {
    format: SAVE_FORMAT,
    gameVersion: input.gameVersion,
    cityId: input.cityId,
    companyName: input.companyName.slice(0, SAVE_COMPANY_NAME_MAX_LENGTH),
    sandbox: input.sandbox,
    savedAtMs: input.savedAtMs,
    data: input.data,
  };
}

/** The live save is compact JSON. `JSON.stringify(env, null, 2)` (pretty-printed) is reserved for
 * export (§6) — not built by this Milestone 2 cut. */
export function serializeSaveEnvelope(envelope: SaveEnvelope): string {
  return JSON.stringify(envelope);
}

/** Serialize-then-write — never a partial write (§6: "serialize to a string first, then a single
 * `setItem`"). The only function in this module that writes to `storage` on the write side; every
 * write path (autosave, leave-to-menu, `pagehide`, ...) funnels through here once wired. */
export function writeSave(storage: SaveStorage, envelope: SaveEnvelope): void {
  storage.setItem(saveKey(envelope.cityId), serializeSaveEnvelope(envelope));
}
