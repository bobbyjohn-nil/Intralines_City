/**
 * Every tunable number in the game. Single source of truth.
 *
 * Values marked `SPEC` are stated in studio/docs/design/manual-v1.18.md and must not be changed
 * without changing the spec. Values marked `TUNE` were not in the manual and were chosen to fit —
 * they are expected to move.
 *
 * Never inline a gameplay number anywhere else, and never quote one from memory.
 */

// ── Clock ────────────────────────────────────────────────────────────────────

/** Game-minutes advanced per real second, per speed setting. SPEC */
export const CLOCK_SPEEDS = [0.25, 2, 10] as const;
/** Speed index the game starts on (paused, so this is what ▶ resumes to). TUNE */
export const CLOCK_DEFAULT_SPEED_INDEX = 1;
/** Days in a quarter. SPEC */
export const DAYS_PER_QUARTER = 10;
/** Quarters in a year. SPEC */
export const QUARTERS_PER_YEAR = 4;
/** Minute of day the game starts at — 06:00. SPEC */
export const START_MINUTE_OF_DAY = 6 * 60;
/** Entering a city always starts paused so nothing burns while you plan. SPEC */
export const START_PAUSED = true;

export const MINUTES_PER_DAY = 24 * 60;

// ── Road network ─────────────────────────────────────────────────────────────

/** Free-flow speed by road class, km/h. Motorway and living street are SPEC; the rest are TUNE. */
export const ROAD_SPEED_KMH = {
  motorway: 88,
  trunk: 70,
  primary: 55,
  secondary: 45,
  tertiary: 38,
  residential: 30,
  service: 20,
  living_street: 15,
} as const;

/** How much each class congests relative to the city-wide curve. SPEC (four stated classes). */
export const ROAD_CONGESTION_WEIGHT = {
  motorway: 1.35,
  trunk: 1.35,
  primary: 1.15,
  secondary: 1.15,
  tertiary: 0.55,
  residential: 0.18,
  service: 0.18,
  living_street: 0.18,
} as const;

/** Stops may not be placed on roads faster than this. SPEC */
export const STOP_MAX_ROAD_SPEED_KMH = 55;

// ── Lines ────────────────────────────────────────────────────────────────────

/** A drafted line can't be created with fewer stops than this (manual §9: "Create line (needs
 * ≥ 2 stops)"). Read by both `canCreate()` and the draft bar's disabled-reason copy so the rule
 * and its prose can never drift apart. SPEC */
export const MIN_STOPS_TO_CREATE_LINE = 2;

// ── Buses ────────────────────────────────────────────────────────────────────

/** Acceleration, m/s². SPEC */
export const BUS_ACCEL_MS2 = 1.1;
/** Braking, m/s². SPEC */
export const BUS_BRAKE_MS2 = 1.3;
/** Time held at a stop, seconds. SPEC */
export const BUS_DWELL_SECONDS = 20;
/** Layover at each end of a round trip, minutes. SPEC */
export const BUS_LAYOVER_MINUTES = 4;
/** Buses cannot physically follow closer than this, minutes. SPEC */
export const MIN_HEADWAY_MINUTES = 2;
/** Time to refuel, minutes. SPEC */
export const BUS_REFUEL_MINUTES = 7;

export interface BusModelSpec {
  readonly id: string;
  readonly name: string;
  readonly capacity: number;
  readonly priceUsd: number;
  readonly costPerKmUsd: number;
  readonly fuelPerKmUsd: number;
  readonly rangeKm: number;
  readonly cruiseSpeedKmh: number;
  /** Total riders the company must have served, all-time, before this model can be bought.
   * `0` means available from the start. Manual §12's "Unlocks at" column — data only, no
   * unlocking logic lives here or reads this field yet. */
  readonly unlockRidersServed: number;
  /** Whether buying this model also requires a depot with chargers (manual §12, Volt-E only).
   * Data only, same as `unlockRidersServed` — nothing enforces this yet. */
  readonly requiresDepotChargers: boolean;
}

/** The fleet. All values SPEC. Milestone 1 only uses `metro40`. */
export const BUS_MODELS: Record<string, BusModelSpec> = {
  sparrow: {
    id: 'sparrow',
    name: 'Sparrow Minibus',
    capacity: 28,
    priceUsd: 95_000,
    costPerKmUsd: 0.9,
    fuelPerKmUsd: 0.38,
    rangeKm: 260,
    cruiseSpeedKmh: 26,
    unlockRidersServed: 0,
    requiresDepotChargers: false,
  },
  metro40: {
    id: 'metro40',
    name: 'Metro 40 City Bus',
    capacity: 70,
    priceUsd: 260_000,
    costPerKmUsd: 1.5,
    fuelPerKmUsd: 0.62,
    rangeKm: 420,
    cruiseSpeedKmh: 25,
    unlockRidersServed: 0,
    requiresDepotChargers: false,
  },
  goliath: {
    id: 'goliath',
    name: 'Goliath Articulated',
    capacity: 115,
    priceUsd: 440_000,
    costPerKmUsd: 2.2,
    fuelPerKmUsd: 0.95,
    rangeKm: 480,
    cruiseSpeedKmh: 23,
    unlockRidersServed: 25_000,
    requiresDepotChargers: false,
  },
  skyline: {
    id: 'skyline',
    name: 'Skyline Double-Decker',
    capacity: 130,
    priceUsd: 520_000,
    costPerKmUsd: 1.9,
    fuelPerKmUsd: 0.8,
    rangeKm: 400,
    cruiseSpeedKmh: 22,
    unlockRidersServed: 40_000,
    requiresDepotChargers: false,
  },
  volte: {
    id: 'volte',
    name: 'Volt-E Electric',
    capacity: 75,
    priceUsd: 380_000,
    costPerKmUsd: 0.7,
    fuelPerKmUsd: 0.16,
    rangeKm: 300,
    cruiseSpeedKmh: 26,
    unlockRidersServed: 60_000,
    requiresDepotChargers: true,
  },
};

/** The model available from the start of Milestone 1. */
export const STARTING_BUS_MODEL = 'metro40';

// ── Money ────────────────────────────────────────────────────────────────────

/** Treasury at founding. Not stated in the manual. TUNE */
export const STARTING_CASH_USD = 500_000;
/** Cost to place one stop. SPEC */
export const STOP_PLACEMENT_COST_USD = 4_000;
/** Driver wage per hour, paid only while their bus is in service. SPEC */
export const DRIVER_WAGE_PER_HOUR_USD = 26;
/** Flat daily company overhead. SPEC */
export const OFFICE_OVERHEAD_PER_DAY_USD = 250;
/** Default fare. The neutral point — at exactly this, fare changes no rider's mind. SPEC */
export const DEFAULT_FARE_USD = 2.25;
/** City subsidy per boarding on a normal line. SPEC */
export const SUBSIDY_PER_BOARDING_USD = 1.6;

// ── Riders (declared now, first used in Milestone 2) ─────────────────────────

/** A trip considers the bus only if both ends have a stop within this walk, metres. SPEC */
export const WALK_RADIUS_M = 650;
/** Walking pace, minutes per kilometre. SPEC */
export const WALK_MINUTES_PER_KM = 12;

// ── Presentation ─────────────────────────────────────────────────────────────

/** Service hours — outside these nothing runs and no driver wages accrue. SPEC */
export const DEFAULT_SERVICE_HOURS = { firstHour: 6, lastHour: 22 } as const;

// ── Errors (src/game/errors/, errors.md §1) ───────────────────────────────────

/** A `source/code` key toasts at most once per this many ms. SPEC (errors.md §1) */
export const ERROR_TOAST_DEDUPE_MS = 120_000;
/** A `source/code` key toasts at most this many times per session; after that it is badge-only.
 * SPEC (errors.md §1) */
export const ERROR_TOAST_MAX_PER_CODE = 3;
/** Toasts visible at once — older ones collapse into the badge. Owned by the toast layer (not yet
 * built); the bus does not enforce this. SPEC (errors.md §1) */
export const ERROR_TOAST_MAX_ONSCREEN = 3;
/** Session log ring buffer size, in distinct `source/code` keys. Evicts lowest severity, then
 * oldest `lastAtMs`, once full. SPEC (errors.md §1) */
export const ERROR_LOG_CAPACITY = 200;
/** Reports made before any sink is registered (pre-mount boot code, the worker bridge) queue up to
 * this many and flush to the first sink that registers. SPEC (errors.md §1, "cap 50") */
export const ERROR_QUEUE_CAPACITY = 50;
