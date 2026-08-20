import { describe, expect, it } from 'vitest';
import { busWorldScaleMultiplier, projectedLengthPx } from './busLayer';
import { BUS_MAX_EXAGGERATION, BUS_TARGET_FOOTPRINT_PX } from './constants';

// Pure math only — no THREE.* instantiation, so this runs under the `node` project (jsdom) rather
// than needing the `render` project's real WebGL context. Regression coverage for renderer-3d.md
// §7 cause 1's fix: "per-frame world-scale multiplier max(1, minPx / projectedPx)... capped at 8x
// exaggeration" — replacing the Canvas renderer's fixed screen-pixel marker clamp, which is the
// *worse* version of the same bug ("a true-scale bus shrinks with distance and has no floor at
// all").

describe('busWorldScaleMultiplier', () => {
  it('is 1 (no exaggeration) once the true-scale footprint already meets the target', () => {
    expect(busWorldScaleMultiplier(BUS_TARGET_FOOTPRINT_PX)).toBeCloseTo(1, 6);
    expect(busWorldScaleMultiplier(BUS_TARGET_FOOTPRINT_PX * 2)).toBeCloseTo(1, 6);
  });

  it('exaggerates a small true-scale footprint up toward the target', () => {
    const projectedPx = BUS_TARGET_FOOTPRINT_PX / 4;
    expect(busWorldScaleMultiplier(projectedPx)).toBeCloseTo(4, 6);
  });

  it('never exceeds BUS_MAX_EXAGGERATION, however small the true-scale footprint gets', () => {
    expect(busWorldScaleMultiplier(0.001)).toBeLessThanOrEqual(BUS_MAX_EXAGGERATION);
    expect(busWorldScaleMultiplier(0)).toBeLessThanOrEqual(BUS_MAX_EXAGGERATION);
  });

  it('never shrinks a bus below true scale (multiplier is always >= 1)', () => {
    for (const projectedPx of [1, 10, 30, 60, 200, 1000]) {
      expect(busWorldScaleMultiplier(projectedPx)).toBeGreaterThanOrEqual(1);
    }
  });

  it('is monotonically non-increasing as the true-scale footprint grows', () => {
    let previous = busWorldScaleMultiplier(0.1);
    for (const projectedPx of [1, 5, 10, 20, 30, 50, 100]) {
      const multiplier = busWorldScaleMultiplier(projectedPx);
      expect(multiplier).toBeLessThanOrEqual(previous + 1e-9);
      previous = multiplier;
    }
  });
});

describe('projectedLengthPx', () => {
  it('grows as the object gets closer to the camera', () => {
    const far = projectedLengthPx(12, 1000, 30, 720);
    const near = projectedLengthPx(12, 100, 30, 720);
    expect(near).toBeGreaterThan(far);
  });

  it('is proportional to the object\'s length', () => {
    const short = projectedLengthPx(6, 500, 30, 720);
    const long = projectedLengthPx(12, 500, 30, 720);
    expect(long).toBeCloseTo(short * 2, 6);
  });
});
