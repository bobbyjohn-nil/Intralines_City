/**
 * Save-facing shapes for line drawing (manual §9). Flat and serializable on purpose — these
 * are the ones that end up in the save file, so no class instances, no `Map`/`Set`, nothing a
 * `JSON.stringify` round-trip would lose.
 *
 * `Draft` is the only one of these that never gets saved — it's the live state of a line still
 * being drawn, discarded on Create/Cancel — but it's kept flat for the same reason: it feeds
 * the draft bar UI directly, no adaptation layer.
 */

import type { LngLat } from '../types';

/** A stop placed on the road network (manual §9). */
export interface Stop {
  readonly id: number;
  readonly name: string;
  readonly position: LngLat;
  /** The road edge it's snapped to. */
  readonly edgeId: number;
  /** Fraction along that edge, 0 = `edge.from`, 1 = `edge.to`. */
  readonly edgeT: number;
}

/** The street route driven between two consecutive stops on a line. */
export interface RouteLeg {
  readonly fromStopId: number;
  readonly toStopId: number;
  /** Road edges from `fromStopId` to `toStopId`, in travel order. */
  readonly edgeIds: readonly number[];
  readonly lengthM: number;
}

export interface Line {
  readonly id: number;
  readonly name: string;
  readonly stops: readonly Stop[];
  /** One leg per consecutive stop pair — `legs.length === stops.length - 1`. */
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
