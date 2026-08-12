/**
 * The ordered migration chain (save-format.md §3). Empty at `SAVE_FORMAT = 1` per §8's Milestone 2
 * cut — there is nothing yet to migrate from.
 *
 * > **Contributor rule.** Adding a field to `SaveData`: make it optional-with-a-default in
 * > `read.ts` — do NOT touch this file or bump `SAVE_FORMAT`. Only append a migration, and only
 * > then bump `SAVE_FORMAT`, when an *existing* field changes name, type, or meaning (a restructure
 * > `read.ts`'s `??` defaulting can't express). A migration is pure — `(prev: unknown) => unknown`,
 * > never reads `src/game/constants.ts` — and once merged is never edited again: it has to keep
 * > reading a format-n file the same way forever, even after the constant it once referenced moves.
 */
export type Migration = (prev: unknown) => unknown;

/** `MIGRATIONS[n]` migrates a file at `format === n + 1` to `format === n + 2`. Sparse in general —
 * empty here. */
export const MIGRATIONS: readonly Migration[] = [];

/** Applies `MIGRATIONS` ascending from `fromFormat`, stopping once there's no next migration to
 * run (§1 step 6). A throw from a migration propagates to the caller, which treats it exactly like
 * any other step 6-8 failure — UNREADABLE (see `load.ts`). */
export function runMigrations(fromFormat: number, data: unknown): unknown {
  let current = data;
  let format = fromFormat;
  while (format - 1 < MIGRATIONS.length) {
    const migration = MIGRATIONS[format - 1];
    if (migration === undefined) break; // unreachable given the loop guard; defensive only
    current = migration(current);
    format += 1;
  }
  return current;
}
