/**
 * Shared data contracts. Owned by the orchestrator — agents read these and build against them,
 * so independent systems can be written in parallel without agreeing with each other by accident.
 */

import type { ROAD_SPEED_KMH } from './constants';

export type RoadClass = keyof typeof ROAD_SPEED_KMH;

/** Longitude/latitude, in that order — matches GeoJSON and MapLibre. */
export type LngLat = readonly [number, number];

export interface Bounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

// ── Street graph ─────────────────────────────────────────────────────────────

export interface RoadNode {
  readonly id: number;
  readonly pos: LngLat;
}

/**
 * An undirected street segment between two nodes. Buses travel it in either direction;
 * `keepRight` handling is the renderer's problem, not the graph's.
 */
export interface RoadEdge {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly roadClass: RoadClass;
  /** Great-circle length in metres, precomputed at generation time. */
  readonly lengthM: number;
}

export interface StreetGraph {
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
  /** Node id → ids of edges incident to it. Built once at generation; never recomputed per frame. */
  readonly adjacency: ReadonlyMap<number, readonly number[]>;
}

// ── Scenery ──────────────────────────────────────────────────────────────────

/** A closed ring. First and last points are NOT required to be equal. */
export type Polygon = readonly LngLat[];

export interface Scenery {
  readonly water: readonly Polygon[];
  readonly parks: readonly Polygon[];
}

// ── Zones ────────────────────────────────────────────────────────────────────

/**
 * A census-block-group equivalent — the demand model's unit of demand (demand-model.md §1: "the
 * unit is the census block group; Riverton: a synthetic equivalent") and, per
 * depots-and-timetables.md §1's Zoning B fallback, the only thing a depot-eligibility check has to
 * test against when a city pack carries no OSM land-use layer. `residents`/`jobs`/`areaHa` are the
 * minimum both consumers read; `tourismJobs` is demand-model Stage A's extra field.
 */
export interface Zone {
  readonly id: number;
  /** Closed ring, same convention as `Polygon` elsewhere. Never overlaps a sibling zone or
   * extends outside the city's `bounds`. */
  readonly polygon: Polygon;
  readonly centroid: LngLat;
  readonly areaHa: number;
  readonly residents: number;
  readonly jobs: number;
  readonly tourismJobs: number;
}

// ── City ─────────────────────────────────────────────────────────────────────

export interface City {
  readonly id: string;
  readonly name: string;
  /** The playable area. Everything outside is masked grey with a dashed boundary. */
  readonly bounds: Bounds;
  readonly graph: StreetGraph;
  readonly scenery: Scenery;
  /** Census-block-group-equivalent zones — demand model input, depot-zoning fallback surface. */
  readonly zones: readonly Zone[];
  /** Seed the city was generated from. Same seed must always give the same city. */
  readonly seed: number;
}

// ── Clock ────────────────────────────────────────────────────────────────────

export interface GameClock {
  /** Total game-minutes elapsed since the company was founded. The single source of game time. */
  readonly totalMinutes: number;
  readonly paused: boolean;
  /** Index into CLOCK_SPEEDS. */
  readonly speedIndex: number;
}

/** Derived calendar view of the clock. Never stored — always computed from `totalMinutes`. */
export interface CalendarTime {
  readonly year: number;
  readonly quarter: number;
  readonly dayOfQuarter: number;
  readonly hour: number;
  readonly minute: number;
  readonly minuteOfDay: number;
}
