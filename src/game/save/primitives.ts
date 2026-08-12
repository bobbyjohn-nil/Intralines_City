/**
 * Total, never-throw readers for one JSON field at a time — the building blocks `read.ts` and
 * `load.ts` share for "defaults-on-read is primary" (save-format.md §3). A field that is missing
 * *or* present with the wrong type both degrade to `fallback`; nothing here ever throws. Only
 * `read.ts`'s array readers throw, and only when a field meant to be a collection is present as
 * some other type — see that file's `readArrayField`.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStringField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function readNumberField(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readBooleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
