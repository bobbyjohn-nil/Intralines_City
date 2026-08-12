/**
 * Save-facing shapes for line drawing (manual §9). Flat and serializable on purpose — these
 * are the ones that end up in the save file, so no class instances, no `Map`/`Set`, nothing a
 * `JSON.stringify` round-trip would lose.
 *
 * `Draft` is the only one of these that never gets saved — it's the live state of a line still
 * being drawn, discarded on Create/Cancel — but it's kept flat for the same reason: it feeds
 * the draft bar UI directly, no adaptation layer. Because it's never saved, `Draft.stops` still
 * carries full `Stop` objects (the draft bar wants the whole thing, not an id to chase); `Line`
 * does not — see below.
 *
 * Shape per `studio/docs/design/save-format.md` §5:
 *  - Stops are hoisted out of `Line` into a top-level collection the caller owns alongside
 *    `lines` (`App.tsx` keeps a `stops` array plus a `Map<StopId, Stop>` built from it); a `Line`
 *    carries `stopIds: readonly StopId[]` (order = travel order) instead of nesting `Stop`
 *    objects, so a stop served by two lines is stored once.
 *  - `Stop`/`Line` ids are monotonic and branded (`StopId`/`LineId`), never array indices and
 *    never reused — see `draft.ts`'s `DraftState.nextStopId` for where they're minted, and
 *    save-format.md §5's `nextIds` for where the persisted counter eventually lives.
 *  - `Stop.roadClass` records the class of the edge the player actually clicked, alongside the
 *    derived `orphaned`/`movedM` fields the §5.2 re-anchor pass will populate on load. That pass
 *    itself is not implemented here — only the fields it needs, so it doesn't force a fourth
 *    reshape of `Stop` later.
 */

import type { LngLat, RoadClass } from '../types';

/**
 * Branded so a raw `number` — an array index, a loop counter — can never be passed where a stop
 * id is expected. That mistake (`id: state.stops.length`, a per-draft counter that collided
 * across lines) is the exact bug this refactor exists to make impossible; the brand turns it
 * back into a compile error if anyone reintroduces it.
 */
export type StopId = number & { readonly __brand: 'StopId' };
/** Same reasoning as `StopId`, for lines. */
export type LineId = number & { readonly __brand: 'LineId' };

/** Increments a branded id. Generic over `StopId`/`LineId` so one helper serves both counters —
 * the brand still stops either counter's value from being assigned to the other's field. */
export function nextId<T extends number>(id: T): T {
  return ((id as number) + 1) as T;
}

/** A stop placed on the road network (manual §9). */
export interface Stop {
  readonly id: StopId;
  readonly name: string;
  readonly position: LngLat;
  /** The road class of the edge this stop was placed on — half of the save-format §5.1 anchor
   * `(lng, lat, roadClass)`. Recorded once, at placement, from the edge the player actually
   * clicked; never recomputed from `edgeId` later, since that's exactly what makes it survive a
   * pack rebake that an edge-based anchor wouldn't. */
  readonly roadClass: RoadClass;
  /** The road edge it's snapped to. Derived-and-rebuilt on every load by the (not yet
   * implemented) §5.2 re-anchor pass — a city-pack rebake resplits and renumbers edges, so this
   * is never part of the anchor itself, only its current best-known snap. */
  readonly edgeId: number;
  /** Fraction along that edge, 0 = `edge.from`, 1 = `edge.to`. */
  readonly edgeT: number;
  /** Set by the §5.2 pass when no candidate edge is found within range on load. Always `false` at
   * placement — a freshly placed stop always sits on the edge it just snapped to. */
  readonly orphaned: boolean;
  /** How far the §5.2 pass moved this stop from its saved position, metres — `null` until that
   * pass has actually run once (including every stop at the moment it's placed). */
  readonly movedM: number | null;
}

/** The street route driven between two consecutive stops on a line. */
export interface RouteLeg {
  readonly fromStopId: StopId;
  readonly toStopId: StopId;
  /** Road edges from `fromStopId` to `toStopId`, in travel order. */
  readonly edgeIds: readonly number[];
  readonly lengthM: number;
}

export interface Line {
  readonly id: LineId;
  readonly name: string;
  /** Order = travel order. Resolve against the top-level stop collection the caller owns
   * alongside `lines` (save-format.md §5) — a `Line` no longer carries `Stop` objects itself. */
  readonly stopIds: readonly StopId[];
  /** One leg per consecutive stop pair — `legs.length === stopIds.length - 1`. */
  readonly legs: readonly RouteLeg[];
  readonly totalLengthM: number;
}

/** A line being drawn, before `canCreate()` promotes it to a `Line`. Mirrors the draft bar
 * (manual §9): live stop count, length, and a round-trip time preview. */
export interface Draft {
  readonly stops: readonly Stop[];
  readonly legs: readonly RouteLeg[];
  readonly totalLengthM: number;
  readonly stopCount: number;
  readonly estimatedRoundTripMinutes: number;
  readonly placementCostUsd: number;
}
