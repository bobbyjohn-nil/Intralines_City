/**
 * Data contracts for the demand model's first shippable slice (demand-model.md, build order §6
 * step 1: "a line carries riders" — Riverton zones + A1–A5 + B1 + direct-only path (round 1, no
 * clusters) + B6 logit + captive + B7 flat all-day assignment). Everything below B6/B7 in the
 * doc's stage list (hourly profiles, waits keyed to a real timetable, transfers, crowding, stop
 * tiers, fare/express perceived minutes, visitors, congestion, satisfaction) is out of scope —
 * see each field's doc comment for exactly which simplification stands in for it.
 *
 * Per `studio/GAME.md`'s WASM-portability constraint: `DemandBuffers` is a flat-typed-array record,
 * sized once by `createDemandBuffers` and mutated in place by `computeCityStatics`/`computeDemand`
 * rather than reallocated — the "pure function, buffer as argument" pattern `src/game/lines/
 * pathfind.ts`'s `PathfindContext` already establishes in this codebase. `DemandResult` is the one
 * object worth returning fresh each call — a small scalar-and-view header, never a per-zone or
 * per-stop object graph.
 */

/**
 * Every array here is sized once, at `createDemandBuffers` time, to a *capacity* — `zoneCapacity`
 * must equal the city's actual zone count (zones never change size mid-session); `stopCapacity`/
 * `lineCapacity` are upper bounds the player's network is allowed to grow into without forcing a
 * reallocation. `computeDemand` throws if the network it's given exceeds either — see its doc
 * comment. Nothing here is ever resized; a bigger city means a new `DemandBuffers`.
 */
export interface DemandBuffers {
  readonly zoneCapacity: number;
  readonly stopCapacity: number;
  readonly lineCapacity: number;

  // ── Stage A — city statics (A1–A5), written once by `computeCityStatics`, read-only to
  // `computeDemand`. O(Z²); depends on nothing the player can change, so it must not be redone
  // inside the debounce (demand-model.md §1). ─────────────────────────────────────────────────

  /** Zone centroid, projected metres on the city's fixed tangent plane (`geo.ts`). Length Z. */
  readonly zoneXM: Float64Array;
  readonly zoneYM: Float64Array;
  /** A4: `zonePop[i] * WORKFORCE_RATE`. Length Z. */
  readonly zoneProd: Float64Array;
  /** A2, symmetric, `zoneDistM[i*Z+j]`. Length Z². */
  readonly zoneDistM: Float32Array;
  /** A3: car time at the city's car speed ×1.3 + 10 min parking, `carMinutes[i*Z+j]`. Length Z². */
  readonly carMinutes: Float32Array;
  /** A5, gravity O–D, one-way *commuter* flow/day (home→job), singly constrained on
   * `zoneProd[i]` — `Σ_j odCommute[i*Z+j] == zoneProd[i]`. Deliberately not doubled for the
   * return trip here; `TRIPS_PER_COMMUTER_PER_DAY` is applied once, downstream, at the one place
   * this buffer is actually spent as trips/day (`demand.ts`'s B7 assignment) — see that
   * constant's doc comment for why doubling it in this buffer would be the wrong layer. Length
   * Z². */
  readonly odCommute: Float64Array;

  // ── Stage B — network recompute, rebuilt every call from the current `lines`/`stops`. ───────

  /** B1: zone→stop walk access, CSR. Row `i` spans
   * `[zoneAccessOffset[i], zoneAccessOffset[i+1])` into `zoneAccessStopIndex`/`zoneAccessWalkMin`.
   * Length Z+1. */
  readonly zoneAccessOffset: Int32Array;
  /** Stop index (into the `stops` array passed to `computeDemand`, not `StopId`) for each CSR
   * entry. Capacity `zoneCapacity * stopCapacity` (every zone could in principle reach every
   * stop); only the prefix up to `zoneAccessOffset[zoneCapacity]` is meaningful after a call. */
  readonly zoneAccessStopIndex: Int32Array;
  /** Perceived walk minutes for each CSR entry — no stop-tier bonus this slice (§9's tiers are
   * out of scope; every stop reaches exactly `WALK_RADIUS_M` at a flat `WALK_MINUTES_PER_KM`). */
  readonly zoneAccessWalkMin: Float32Array;

  /** Scratch: stop positions projected onto the city's tangent plane, refreshed at the top of
   * every `computeDemand` call from the caller's `stops` array. Length `stopCapacity`, only the
   * first `stops.length` entries are live after a call. */
  readonly stopXM: Float32Array;
  readonly stopYM: Float32Array;

  /** B2 (congestion-free this slice — §15's feedback loop is out of scope): per-line cumulative
   * ride minutes at each stop position, CSR. Row `li` spans
   * `[lineOffset[li], lineOffset[li+1])` into `lineStop`/`lineCumMin`, in the line's stop order.
   * Length L+1. */
  readonly lineOffset: Int32Array;
  /** Stop index (into `stops`) at each line/position, or -1 if a line references a `StopId` not
   * found in `stops` (an orphaned line — carries nobody, never crashes). Capacity
   * `lineCapacity * stopCapacity`. */
  readonly lineStop: Int32Array;
  /** Cumulative free-flow minutes from the line's first stop to this position — reused for both
   * directions of travel, since a line runs its stops both ways over a round trip
   * (`onboardMin(a, b) = |lineCumMin[b] - lineCumMin[a]|`). Same length as `lineStop`. */
  readonly lineCumMin: Float32Array;

  /** Scratch for the per-origin-zone relaxation (B5): walk-seeded arrival at each stop, read-only
   * once seeded — never fed back as a boarding source, which is what keeps this round-1-only
   * (no line ever boards from a stop it was *ridden* to). Reset per origin zone. Length
   * `stopCapacity`. */
  readonly walkSeedArrival: Float32Array;
  /** Scratch: best arrival-at-stop reached by riding one line from a walk-seeded stop. Reset per
   * origin zone. Length `stopCapacity`. */
  readonly bestArrivalAtStop: Float32Array;
  /** Scratch: which line produced `bestArrivalAtStop`'s current value, or -1. Length
   * `stopCapacity`. */
  readonly bestLineAtStop: Int32Array;

  /** B5: best direct-only (round-1, no transfers) bus minutes for each O–D pair, walk-to-wait-to
   * -onboard-to-walk. `Infinity` where no line connects the pair's access stops — those riders are
   * stranded, not captive (demand-model.md §3). Length Z². */
  readonly busMin: Float32Array;
  /** Which line index produced `busMin[i*Z+j]`, or -1 where `busMin` is `Infinity`. This is what
   * lets B9 attribute a boarding to the right line. Length Z². */
  readonly bestLineForOD: Int32Array;

  /** B9: boardings/day per line — what fare revenue counts. Length L. */
  readonly boardingsPerLine: Float64Array;
  /** B9: linked trips/day per line — what service and rider-count unlocks should count
   * (demand-model.md §3.2's "same bug class" warning). Numerically identical to
   * `boardingsPerLine` in this slice, since round-1-only means every trip is exactly one
   * boarding — kept as a separate array anyway so nothing downstream has to guess which one it
   * wants, and so the two diverge for free the day transfers land. Length L. */
  readonly linkedTripsPerLine: Float64Array;
}

/**
 * Stage A's non-buffer output — small enough to not need a flat-array encoding, and never
 * touched inside a hot loop (`edgeTimeMinById` is read once per (line, edge) pair while building
 * B2, not per zone pair). Cached by the caller alongside `DemandBuffers` and threaded into every
 * `computeDemand` call for the life of the city.
 */
export interface CityDemandStatics {
  readonly zoneCount: number;
  readonly cityCarSpeedKmh: number;
  /** The tangent plane every zone and stop position in this city is measured against — must be
   * reused for every `computeDemand` call so stop and zone distances stay commensurable. */
  readonly projection: import('./geo').Projection;
  /** Road edge id → free-flow minutes to cross it, at `ROAD_SPEED_KMH`. Static per city (the
   * street graph never changes once loaded), built once here so B2 never allocates a lookup. */
  readonly edgeTimeMinById: ReadonlyMap<number, number>;
}

/**
 * One recompute's output. Deliberately flat — a scalar header plus two per-line views into
 * `DemandBuffers` (subarrays, not copies) — per demand-model.md §2's worker-boundary note: "one
 * `DemandResult` … a ~12-field scalar header. No object graph either way."
 */
export interface DemandResult {
  readonly lineCount: number;
  readonly zoneCount: number;
  /** Boardings/day per line, length `lineCount`. Money's number — see `linkedTripsPerLine`. */
  readonly boardingsPerLine: Float64Array;
  /** Linked trips/day per line, length `lineCount`. Service's and rider-unlock's number —
   * conflating this with `boardingsPerLine` is exactly the bug demand-model.md §3.2 flags. */
  readonly linkedTripsPerLine: Float64Array;
  readonly totalBoardingsPerDay: number;
  readonly totalLinkedTripsPerDay: number;
  /** Every O–D trip the city generates, bus or not — the denominator of `busSharePerDay`. */
  readonly totalTripsPerDay: number;
  /** `totalBoardingsPerDay / totalTripsPerDay`, 0 if the city generates no trips at all. Not the
   * same as mode-choice `busShare` per O–D pair — this is the citywide aggregate for the top bar. */
  readonly busSharePerDay: number;
}
