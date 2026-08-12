/**
 * The error bus. One entry point — `report(r: ErrorReport)` — plus sink registration.
 * See `studio/docs/design/errors.md` §1 (this file), §2 (severity tiers, lived in `types.ts`) and
 * the dedup rules quoted inline below.
 *
 * Build order (errors.md §9). This file is step 1: bus + severities + dedup + console sink +
 * constants, no UI. Everything else in the spec is deliberately **not** here yet:
 *   - The recovery card, and `clearCaches()` — §4, build step 2.
 *   - The boot-time net in `index.html` — §5, build step 2 (no imports allowed there anyway).
 *   - The worker bridge (`src/game/errors/worker.ts`) and the sim ping watchdog — §7, build step 5.
 *   - The toast surface, the ⚠ badge, and the session log panel — §1 "Sinks" / §9 steps 3–4. They
 *     are `registerSink()` consumers and belong to `ui-designer`; this file only computes, for each
 *     report, whether it has earned a toast (see `notify` below) and hands it to whatever sinks
 *     exist.
 */

import {
  ERROR_LOG_CAPACITY,
  ERROR_QUEUE_CAPACITY,
  ERROR_TOAST_DEDUPE_MS,
  ERROR_TOAST_MAX_PER_CODE,
} from '../constants';
import type { ErrorAction, ErrorReport, ErrorSeverity, ErrorSource } from './types';

/**
 * The bus's own view of a `source/code` key: the latest report's contents plus dedup bookkeeping.
 * One of these is created per key and mutated in place on every repeat — never a second entry for
 * the same key, and no allocation on the repeat path (see `report()` below).
 */
export interface ErrorLogEntry {
  readonly source: ErrorSource;
  readonly code: string;
  severity: ErrorSeverity;
  message: string;
  detail: string | undefined;
  action: ErrorAction | undefined;
  /** Total reports collapsed into this row, including the first. */
  count: number;
  readonly firstAtMs: number;
  lastAtMs: number;
}

/**
 * A registered sink sees every report (after dedup) as `(entry, notify)`:
 *   - `entry` is the live, mutated-in-place log row for that `source/code` — read what you need
 *     synchronously, since its fields change on the next repeat.
 *   - `notify` is true iff this occurrence passed the toast dedupe window and per-session cap
 *     (errors.md §1) and its severity is above `note` (§2) — i.e. it has earned a toast (`problem`)
 *     or the recovery card (`fatal`). `false` means badge/log only.
 * A sink that throws is dropped for the session (§8 "Error inside a sink") so a broken renderer
 * can't become a fatal loop.
 */
export type ErrorSink = (entry: ErrorLogEntry, notify: boolean) => void;

/** Internal-only bookkeeping alongside the public entry fields, kept on the same object so a
 * repeat never allocates anything beyond the one-time entry creation. */
interface InternalEntry extends ErrorLogEntry {
  toastCount: number;
  lastToastAtMs: number;
}

const SEVERITY_RANK: Record<ErrorSeverity, number> = { note: 0, problem: 1, fatal: 2 };

const log = new Map<string, InternalEntry>();
const sinks: ErrorSink[] = [];

interface QueuedEvent {
  readonly entry: InternalEntry;
  readonly notify: boolean;
}

/** Holds reports made while `sinks` is empty — boot code and the worker bridge calling `report()`
 * before React has mounted anything (§1 "Sinks"). Drained into the first sink to register. */
const queue: QueuedEvent[] = [];

/**
 * Always-on sink (§1: "Console (always, dev and prod)"). Not part of `sinks` / `registerSink` —
 * it doesn't need React mounted and must never be droppable, so it's called directly rather than
 * through the pluggable, throw-safe sink list.
 */
function consoleSink(entry: ErrorLogEntry, notify: boolean): void {
  const line = `[${entry.source}/${entry.code}] ${entry.message}` + (entry.count > 1 ? ` ×${entry.count}` : '');
  const method = entry.severity === 'fatal' ? 'error' : entry.severity === 'problem' ? 'warn' : 'info';
  // eslint-disable-next-line no-console -- this *is* the console sink.
  console[method](line, { detail: entry.detail, notify });
}

/** Evicts the lowest-severity, then oldest-`lastAtMs` entry once the ring buffer is full (§1). Runs
 * only when a brand-new key would exceed capacity — O(n) over at most `ERROR_LOG_CAPACITY` rows,
 * not a per-report cost. */
function evictOneIfAtCapacity(): void {
  if (log.size < ERROR_LOG_CAPACITY) return;
  let victimKey: string | undefined;
  let victim: InternalEntry | undefined;
  for (const [key, entry] of log) {
    if (
      victim === undefined ||
      SEVERITY_RANK[entry.severity] < SEVERITY_RANK[victim.severity] ||
      (SEVERITY_RANK[entry.severity] === SEVERITY_RANK[victim.severity] && entry.lastAtMs < victim.lastAtMs)
    ) {
      victimKey = key;
      victim = entry;
    }
  }
  if (victimKey !== undefined) log.delete(victimKey);
}

/**
 * Dedup + toast-throttle rules, straight from errors.md §1:
 * "A key toasts at most once per ERROR_TOAST_DEDUPE_MS (120 000) and at most
 * ERROR_TOAST_MAX_PER_CODE (3) times per session; after that it is badge-only."
 * `note` never toasts (§2: badge + log only) regardless of the above.
 */
function earnsNotify(entry: InternalEntry, nowMs: number): boolean {
  if (entry.severity === 'note') return false;
  if (entry.toastCount >= ERROR_TOAST_MAX_PER_CODE) return false;
  if (entry.toastCount > 0 && nowMs - entry.lastToastAtMs < ERROR_TOAST_DEDUPE_MS) return false;
  return true;
}

function safeCall(sink: ErrorSink, entry: InternalEntry, notify: boolean): void {
  try {
    sink(entry, notify);
  } catch (err) {
    const i = sinks.indexOf(sink);
    if (i !== -1) sinks.splice(i, 1);
    // A sink is only dropped, never rethrown to the caller of report() — a broken renderer must
    // not become the next fatal (§8).
    // eslint-disable-next-line no-console
    console.error('[errors] a sink threw and was dropped for the rest of the session', err);
  }
}

/**
 * Delivers to every currently-registered sink, indexing rather than `for...of`-ing `sinks`
 * directly: `safeCall` can splice a throwing sink out mid-loop, and a live iterator over a
 * shrinking array silently skips whatever shifted into the removed slot.
 */
function deliverToAllSinks(entry: InternalEntry, notify: boolean): void {
  for (let i = 0; i < sinks.length; i++) {
    const before = sinks.length;
    safeCall(sinks[i]!, entry, notify);
    if (sinks.length < before) i--; // this index now holds the sink that followed the dropped one
  }
}

function enqueue(entry: InternalEntry, notify: boolean): void {
  queue.push({ entry, notify });
  // Drop oldest, not newest — a player still wants to know about the thing happening *now*, not
  // the first of a burst that happened seconds ago. [call]
  if (queue.length > ERROR_QUEUE_CAPACITY) queue.shift();
}

/**
 * The one entry point (§1). Safe to call with zero sinks registered — see module doc.
 */
export function report(r: ErrorReport): void {
  const now = Date.now();
  const key = `${r.source}/${r.code}`;
  let entry = log.get(key);

  if (entry === undefined) {
    evictOneIfAtCapacity();
    entry = {
      source: r.source,
      code: r.code,
      severity: r.severity,
      message: r.message,
      detail: r.detail,
      action: r.action,
      count: 1,
      firstAtMs: now,
      lastAtMs: now,
      toastCount: 0,
      lastToastAtMs: -Infinity,
    };
    log.set(key, entry);
  } else {
    // Repeat of an existing key: mutate the one row in place. No allocation, no second entry —
    // this is what turns 214 storage-full autosave failures into one row reading "×214".
    entry.count += 1;
    entry.lastAtMs = now;
    entry.severity = r.severity;
    entry.message = r.message;
    entry.detail = r.detail;
    entry.action = r.action;
  }

  const notify = earnsNotify(entry, now);
  if (notify) {
    entry.toastCount += 1;
    entry.lastToastAtMs = now;
  }

  consoleSink(entry, notify);

  if (sinks.length === 0) {
    enqueue(entry, notify);
    return;
  }
  deliverToAllSinks(entry, notify);
}

/**
 * Registers a sink (session log panel, toast layer, recovery card — none of which exist yet, see
 * module doc). If reports queued up before any sink existed, this drains them into the sink being
 * registered, in the order they arrived, then clears the queue. Returns an unregister function.
 */
export function registerSink(sink: ErrorSink): () => void {
  sinks.push(sink);
  if (queue.length > 0) {
    const backlog = queue.splice(0, queue.length);
    for (const queued of backlog) safeCall(sink, queued.entry, queued.notify);
  }
  return () => {
    const i = sinks.indexOf(sink);
    if (i !== -1) sinks.splice(i, 1);
  };
}

/**
 * Test-only reset. The bus is a module-level singleton by design (§1 — it must be callable from
 * anywhere without threading an instance through), which means tests need an explicit way back to
 * a clean slate between cases.
 */
export function resetErrorBusForTests(): void {
  log.clear();
  sinks.length = 0;
  queue.length = 0;
}
