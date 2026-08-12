/** Storage key builders (save-format.md §6). The only place a save/backup key is assembled —
 * everything else in this module calls these rather than string-templating a key itself. */

import {
  BACKUP_KEY_PREFIX,
  BACKUP_NEWER_KEY_SUFFIX,
  BACKUP_UNREADABLE_KEY_SUFFIX,
  SAVE_KEY_PREFIX,
} from './constants';

/** `intralines.save.<cityId>` — one per city, no version number (§6). */
export function saveKey(cityId: string): string {
  return `${SAVE_KEY_PREFIX}${cityId}`;
}

/** `intralines.backup.<cityId>.unreadable` — single slot, overwritten each time (§2). */
export function unreadableBackupKey(cityId: string): string {
  return `${BACKUP_KEY_PREFIX}${cityId}${BACKUP_UNREADABLE_KEY_SUFFIX}`;
}

/** `intralines.backup.<cityId>.newer` — best-effort copy of a save from a future version (§2). */
export function newerBackupKey(cityId: string): string {
  return `${BACKUP_KEY_PREFIX}${cityId}${BACKUP_NEWER_KEY_SUFFIX}`;
}
