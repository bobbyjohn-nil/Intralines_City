/**
 * Trapezoidal (or, on a short block, triangular) speed profile for one straight run between two
 * stops. Manual §15: "Buses move with real kinematics — accelerate at 1.1 m/s², brake at 1.3,
 * cruise between." Pure functions only, per `studio/GAME.md`'s WASM-portability constraint: a
 * leg length and the three speeds go in, a profile comes out, and every read of that profile
 * (`distanceAtElapsed`) is plain arithmetic — no allocation, no lookup, safe to call every
 * frame for every bus on the road.
 *
 * `buildSpeedProfile` is meant to be called once per leg when a `RouteSchedule` is built (see
 * `schedule.ts`), not per tick — the profile it returns is what gets read per tick instead.
 */

/**
 * One leg's speed-vs-time shape. If the bus reaches cruise speed before it must start braking,
 * this is a trapezoid (`cruiseTimeS > 0`); on a short-enough leg it never reaches cruise and this
 * is a triangle (`cruiseTimeS === 0`, `peakSpeedMs < cruiseSpeedMs`).
 */
export interface SpeedProfile {
  readonly lengthM: number;
  readonly cruiseSpeedMs: number;
  readonly accelMs2: number;
  readonly brakeMs2: number;
  /** The fastest the bus actually gets on this leg — `cruiseSpeedMs` on a trapezoid, less on a
   * triangle. */
  readonly peakSpeedMs: number;
  readonly accelTimeS: number;
  /** 0 on a triangular (short-leg) profile. */
  readonly cruiseTimeS: number;
  readonly brakeTimeS: number;
  readonly accelDistM: number;
  /** 0 on a triangular (short-leg) profile. */
  readonly cruiseDistM: number;
  readonly brakeDistM: number;
  /** Total time to cover `lengthM`, seconds. */
  readonly totalTimeS: number;
}

const ZERO_LENGTH_PROFILE_LENGTH_M = 0;

/**
 * Builds the speed profile for a straight run of `lengthM` metres. `lengthM` must be >= 0 (a
 * leg can legitimately be 0 m only in the degenerate case of two stops snapped to the same
 * point); negative lengths are an impossible upstream state, so this fails loud rather than
 * returning nonsense.
 */
export function buildSpeedProfile(
  lengthM: number,
  cruiseSpeedMs: number,
  accelMs2: number,
  brakeMs2: number
): SpeedProfile {
  if (lengthM < 0) {
    throw new Error(`buildSpeedProfile: lengthM ${lengthM} is negative — a leg cannot have negative length`);
  }
  if (cruiseSpeedMs <= 0 || accelMs2 <= 0 || brakeMs2 <= 0) {
    throw new Error(
      `buildSpeedProfile: cruiseSpeedMs (${cruiseSpeedMs}), accelMs2 (${accelMs2}) and brakeMs2 (${brakeMs2}) must all be positive`
    );
  }

  if (lengthM === ZERO_LENGTH_PROFILE_LENGTH_M) {
    return {
      lengthM,
      cruiseSpeedMs,
      accelMs2,
      brakeMs2,
      peakSpeedMs: 0,
      accelTimeS: 0,
      cruiseTimeS: 0,
      brakeTimeS: 0,
      accelDistM: 0,
      cruiseDistM: 0,
      brakeDistM: 0,
      totalTimeS: 0,
    };
  }

  // Distance needed to reach cruise speed from a stop, and to shed it back down to a stop.
  const accelDistToCruise = (cruiseSpeedMs * cruiseSpeedMs) / (2 * accelMs2);
  const brakeDistFromCruise = (cruiseSpeedMs * cruiseSpeedMs) / (2 * brakeMs2);

  if (accelDistToCruise + brakeDistFromCruise <= lengthM) {
    // Trapezoidal: there's room to hold cruise speed for a while.
    const cruiseDistM = lengthM - accelDistToCruise - brakeDistFromCruise;
    const accelTimeS = cruiseSpeedMs / accelMs2;
    const brakeTimeS = cruiseSpeedMs / brakeMs2;
    const cruiseTimeS = cruiseDistM / cruiseSpeedMs;
    return {
      lengthM,
      cruiseSpeedMs,
      accelMs2,
      brakeMs2,
      peakSpeedMs: cruiseSpeedMs,
      accelTimeS,
      cruiseTimeS,
      brakeTimeS,
      accelDistM: accelDistToCruise,
      cruiseDistM,
      brakeDistM: brakeDistFromCruise,
      totalTimeS: accelTimeS + cruiseTimeS + brakeTimeS,
    };
  }

  // Triangular: the block is too short to reach cruise speed at all — solve for the peak speed
  // at which "distance to accelerate up" + "distance to brake down" exactly equals lengthM.
  // v_peak^2/(2a) + v_peak^2/(2b) = lengthM  =>  v_peak = sqrt(2 * lengthM * a * b / (a + b))
  const peakSpeedMs = Math.sqrt((2 * lengthM * accelMs2 * brakeMs2) / (accelMs2 + brakeMs2));
  const accelTimeS = peakSpeedMs / accelMs2;
  const brakeTimeS = peakSpeedMs / brakeMs2;
  const accelDistM = (peakSpeedMs * peakSpeedMs) / (2 * accelMs2);
  // Brake distance is "whatever's left", not recomputed from peakSpeedMs, so accel + brake sums
  // to exactly lengthM despite floating-point rounding in the sqrt above.
  const brakeDistM = lengthM - accelDistM;

  return {
    lengthM,
    cruiseSpeedMs,
    accelMs2,
    brakeMs2,
    peakSpeedMs,
    accelTimeS,
    cruiseTimeS: 0,
    brakeTimeS,
    accelDistM,
    cruiseDistM: 0,
    brakeDistM,
    totalTimeS: accelTimeS + brakeTimeS,
  };
}

/**
 * Distance covered `elapsedS` seconds into `profile`, clamped to `[0, profile.lengthM]` — callers
 * never need to clamp `elapsedS` themselves (a leg that's already finished just returns
 * `lengthM`, one that hasn't started yet returns 0). Pure arithmetic, no allocation.
 */
export function distanceAtElapsed(profile: SpeedProfile, elapsedS: number): number {
  const t = Math.max(0, Math.min(elapsedS, profile.totalTimeS));

  if (t <= profile.accelTimeS) {
    return 0.5 * profile.accelMs2 * t * t;
  }

  const tAfterAccel = t - profile.accelTimeS;
  if (tAfterAccel <= profile.cruiseTimeS) {
    return profile.accelDistM + profile.peakSpeedMs * tAfterAccel;
  }

  const tBraking = tAfterAccel - profile.cruiseTimeS;
  const brakeDist = profile.peakSpeedMs * tBraking - 0.5 * profile.brakeMs2 * tBraking * tBraking;
  return profile.accelDistM + profile.cruiseDistM + brakeDist;
}
