/**
 * The one shape every failure in the game takes.
 *
 * `report(r: ErrorReport)` in `./bus.ts` is the single entry point (spec `errors.md` §1) — nothing
 * else renders its own failure UI, and nothing catches and stays quiet (§6).
 */

/** §2 decides which tier a failure lands in. The line is cost to the player, not technical severity. */
export type ErrorSeverity = 'note' | 'problem' | 'fatal';

/**
 * Closed union, extended by PR only — a free string would let dedup keys drift, since
 * `${source}/${code}` is the dedup identity (§1). **[call]**
 */
export type ErrorSource = 'save' | 'pack' | 'sim' | 'map' | 'render' | 'pwa' | 'ui' | 'boot';

/** Present on an `ErrorReport` ⇒ actionable; renders as one button on the toast (§1). */
export interface ErrorAction {
  readonly label: string;
  readonly run: () => void;
}

export interface ErrorReport {
  readonly severity: ErrorSeverity;
  readonly source: ErrorSource;
  /** Stable slug, e.g. `quota`, `worker-dead`. `${source}/${code}` is the dedup identity. */
  readonly code: string;
  /** Player language (§3). Required even for `note` — a log a dev must decode is a log nobody reads. */
  readonly message: string;
  /** Dev-facing: `error.name`, `error.message`, first 5 stack frames, versions. Never a save body,
   * never a company name. */
  readonly detail?: string;
  readonly action?: ErrorAction;
}
