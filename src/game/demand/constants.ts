/**
 * Demand-model tunables that aren't yet in `src/game/constants.ts` (studio/docs/design/demand-model.md).
 * Kept here rather than there per this agent's file-ownership boundary — this agent owns only
 * `src/game/demand/`, and the shared constants file is being edited concurrently by other agents.
 * Same convention `src/game/city/zones.ts` already uses for its own SPEC numbers ("They live here
 * rather than in `src/game/constants.ts` per this agent's file-ownership boundary — flag for
 * promotion into that shared file once [another] module needs them too"). Flag these for promotion
 * the same way once a second consumer (the worker wiring, the UI) needs them.
 *
 * `SPEC` = a number the manual, `studio/GAME.md`, or demand-model.md states outright. `# tune` =
 * chosen here because the doc left it unstated.
 */

// ── Stage A — gravity O–D (demand-model.md §3, §5) ────────────────────────────

/** Share of a zone's residents in the workforce: `prod[i] = zonePop[i] * WORKFORCE_RATE`.
 * SPEC range 0.46–0.52; this is Riverton's own value (demand-model.md §5). */
export const WORKFORCE_RATE = 0.49;

/** Gravity decay constant, metres: `w[i][j] = zoneJobs[j] * exp(-zoneDistM[i][j] / BETA_M)`.
 * SPEC range 3.2–5 km; this is Riverton's own value (demand-model.md §5). */
export const BETA_M = 4000;

/** Riverton's free-flow car speed, km/h (demand-model.md §5, `# tune`). The `City` type carries
 * no per-city car-speed field yet (flagged in `demand.test.ts`'s fixture comment) — every caller
 * of `computeCityStatics` passes a car speed explicitly; this is the one Riverton uses. */
export const RIVERTON_CAR_SPEED_KMH = 34;

// ── Car time and mode choice (demand-model.md §3; also quoted in studio/GAME.md "Key numbers") ──

/** `carMin = zoneDistM/1000 / cityCarSpeedKmh * 60 * 1.3 + 10` — both SPEC. */
export const CAR_TRAFFIC_MULTIPLIER = 1.3;
export const CAR_PARKING_PENALTY_MIN = 10;

/** `final = 0.13 + 0.87 * 0.92 / (1 + exp((busMin - carMin) / 9))` — all three SPEC. */
export const CAPTIVE_SHARE = 0.13;
export const LOGIT_SCALE_FACTOR = 0.92;
export const LOGIT_SENSITIVITY_MIN = 9;

// ── Waiting (demand-model.md §3) ───────────────────────────────────────────────

/** `wait_b = min(15, ...)` — SPEC. */
export const WAIT_CAP_MIN = 15;

/**
 * This slice omits hourly profiles and timetable-aware waits (demand-model.md's stated first-slice
 * scope, and B3 — headway per line per period — isn't built yet: `Line` carries no timetable or
 * fleet data for a real headway to come from). The full formula's 30 %-of-riders term
 * (`0.30 * 0.5 * headwayMin`, timetable-unaware) survives untouched; the 70 %-timetable-aware term
 * is the one explicitly out of scope, so every rider is modelled as timetable-unaware this slice:
 * `wait = min(WAIT_CAP_MIN, 0.5 * ASSUMED_HEADWAY_MIN)`.
 *
 * `ASSUMED_HEADWAY_MIN` stands in for the real per-line headway B3 will eventually compute from
 * fleet size and round-trip time. Replace every read of this constant the day B3 ships — see
 * demand-model.md §6's build order. `# tune`.
 */
export const ASSUMED_HEADWAY_MIN = 12;
