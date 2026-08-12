import { describe, expect, it } from 'vitest';
import { BUS_ACCEL_MS2, BUS_BRAKE_MS2, BUS_MODELS, STARTING_BUS_MODEL } from '../constants';
import { buildSpeedProfile, distanceAtElapsed } from './kinematics';

const KMH_TO_MS = 1000 / 3600;
const CRUISE_SPEED_MS = BUS_MODELS[STARTING_BUS_MODEL]!.cruiseSpeedKmh * KMH_TO_MS;

// Distance needed to accelerate up to cruise speed and brake back down from it — any leg
// shorter than this can never reach cruise (triangular profile); any leg longer than it can
// (trapezoidal profile). Used to pick unambiguous fixtures below.
const ACCEL_BRAKE_DIST_M =
  (CRUISE_SPEED_MS * CRUISE_SPEED_MS) / (2 * BUS_ACCEL_MS2) + (CRUISE_SPEED_MS * CRUISE_SPEED_MS) / (2 * BUS_BRAKE_MS2);

describe('buildSpeedProfile', () => {
  it('gives a long leg a trapezoidal profile: total time = accelerate + cruise + brake', () => {
    const lengthM = ACCEL_BRAKE_DIST_M * 5; // comfortably long enough to reach cruise speed
    const profile = buildSpeedProfile(lengthM, CRUISE_SPEED_MS, BUS_ACCEL_MS2, BUS_BRAKE_MS2);

    expect(profile.cruiseTimeS).toBeGreaterThan(0);
    expect(profile.peakSpeedMs).toBeCloseTo(CRUISE_SPEED_MS, 9);
    expect(profile.totalTimeS).toBeCloseTo(profile.accelTimeS + profile.cruiseTimeS + profile.brakeTimeS, 9);
  });

  it("a long leg's traversal time is strictly greater than length ÷ cruise speed", () => {
    const lengthM = ACCEL_BRAKE_DIST_M * 5;
    const profile = buildSpeedProfile(lengthM, CRUISE_SPEED_MS, BUS_ACCEL_MS2, BUS_BRAKE_MS2);

    const timeAtConstantCruiseS = lengthM / CRUISE_SPEED_MS;
    expect(profile.totalTimeS).toBeGreaterThan(timeAtConstantCruiseS);
  });

  it('gives a short leg a triangular profile that never reaches cruise speed', () => {
    const lengthM = ACCEL_BRAKE_DIST_M * 0.4; // well under the accelerate+brake distance
    const profile = buildSpeedProfile(lengthM, CRUISE_SPEED_MS, BUS_ACCEL_MS2, BUS_BRAKE_MS2);

    expect(profile.cruiseTimeS).toBe(0);
    expect(profile.cruiseDistM).toBe(0);
    expect(profile.peakSpeedMs).toBeLessThan(CRUISE_SPEED_MS);
    // Accelerate + brake distance must still sum to the full leg length.
    expect(profile.accelDistM + profile.brakeDistM).toBeCloseTo(lengthM, 9);
  });

  it('a short (triangular) leg never exceeds cruise speed at any sampled instant', () => {
    const lengthM = ACCEL_BRAKE_DIST_M * 0.4;
    const profile = buildSpeedProfile(lengthM, CRUISE_SPEED_MS, BUS_ACCEL_MS2, BUS_BRAKE_MS2);

    const sampleCount = 200;
    const dt = 1e-3;
    for (let i = 0; i <= sampleCount; i++) {
      const t = (profile.totalTimeS * i) / sampleCount;
      // Numerically differentiate distanceAtElapsed to get instantaneous speed.
      const speed = (distanceAtElapsed(profile, t + dt) - distanceAtElapsed(profile, t)) / dt;
      expect(speed).toBeLessThanOrEqual(CRUISE_SPEED_MS + 1e-6);
      expect(profile.peakSpeedMs).toBeLessThanOrEqual(CRUISE_SPEED_MS);
    }
  });
});

describe('distanceAtElapsed', () => {
  it('covers exactly the leg length by the time the profile says it should', () => {
    const lengthM = ACCEL_BRAKE_DIST_M * 5;
    const profile = buildSpeedProfile(lengthM, CRUISE_SPEED_MS, BUS_ACCEL_MS2, BUS_BRAKE_MS2);

    expect(distanceAtElapsed(profile, profile.totalTimeS)).toBeCloseTo(lengthM, 6);
  });

  it('is 0 at the start and clamps at both ends instead of going negative or past the leg length', () => {
    const lengthM = ACCEL_BRAKE_DIST_M * 5;
    const profile = buildSpeedProfile(lengthM, CRUISE_SPEED_MS, BUS_ACCEL_MS2, BUS_BRAKE_MS2);

    expect(distanceAtElapsed(profile, 0)).toBe(0);
    expect(distanceAtElapsed(profile, -10)).toBe(0);
    expect(distanceAtElapsed(profile, profile.totalTimeS + 1000)).toBeCloseTo(lengthM, 6);
  });

  it('is monotonically non-decreasing across the whole profile', () => {
    const lengthM = ACCEL_BRAKE_DIST_M * 0.6;
    const profile = buildSpeedProfile(lengthM, CRUISE_SPEED_MS, BUS_ACCEL_MS2, BUS_BRAKE_MS2);

    let previous = -1;
    const steps = 500;
    for (let i = 0; i <= steps; i++) {
      const d = distanceAtElapsed(profile, (profile.totalTimeS * i) / steps);
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
  });
});
