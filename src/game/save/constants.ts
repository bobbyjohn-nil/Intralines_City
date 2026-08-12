/**
 * Save-module-only tunables (studio/docs/design/save-format.md). Deliberately kept out of the
 * shared `src/game/constants.ts` — these describe the save *schema* (a version integer, storage
 * key shapes), not a gameplay number that a formula or a UI label could quote. `SAVE_FORMAT` is
 * bumped by this module alone, by adding a `MIGRATIONS` entry (see `migrations.ts`), never by
 * editing a number in the shared tunables file.
 */

/** Bumped only for a breaking change to `SaveData`'s shape — an additive field is a default in
 * `read.ts`, not a bump (save-format.md §3's contributor rule: "adding a field ... do not bump
 * SAVE_FORMAT"). Starts at 1 per §8's Milestone 2 cut. */
export const SAVE_FORMAT = 1;

/** `intralines.save.<cityId>` — no version in the key, so an old tab can still *find* a newer
 * save in order to refuse it (§6). */
export const SAVE_KEY_PREFIX = 'intralines.save.';
/** `intralines.backup.<cityId>.unreadable` / `.newer` (§6) — same prefix, different suffix. */
export const BACKUP_KEY_PREFIX = 'intralines.backup.';
export const BACKUP_UNREADABLE_KEY_SUFFIX = '.unreadable';
export const BACKUP_NEWER_KEY_SUFFIX = '.newer';

/** `companyName` is clamped to this on read (§1) — a hand-edited or imported file gets a soft
 * truncation rather than a rejected load; the 32-char limit itself is enforced at input time by
 * whatever UI collects the name, not here. TUNE (spec states the limit, not the enforcement point) */
export const SAVE_COMPANY_NAME_MAX_LENGTH = 32;
