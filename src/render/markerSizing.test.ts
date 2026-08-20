import { describe, expect, it } from 'vitest';
import { stopRadiusPx } from './markerSizing';
import { MAX_ZOOM, MIN_ZOOM } from './projection';

describe('stopRadiusPx', () => {
  it('is the minimum radius at MIN_ZOOM', () => {
    expect(stopRadiusPx(MIN_ZOOM)).toBeCloseTo(3, 6);
  });

  it('is the maximum radius at MAX_ZOOM', () => {
    expect(stopRadiusPx(MAX_ZOOM)).toBeCloseTo(6, 6);
  });

  it('is monotonically non-decreasing across the zoom range', () => {
    let previous = stopRadiusPx(MIN_ZOOM);
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.5) {
      const radius = stopRadiusPx(zoom);
      expect(radius).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = radius;
    }
  });

  it('grows faster than linear near MIN_ZOOM (square-root curve, not a straight ramp)', () => {
    const mid = MIN_ZOOM + (MAX_ZOOM - MIN_ZOOM) / 2;
    const linearMid = 3 + (6 - 3) * 0.5;
    expect(stopRadiusPx(mid)).toBeGreaterThan(linearMid);
  });

  it('clamps below MIN_ZOOM and above MAX_ZOOM instead of extrapolating', () => {
    expect(stopRadiusPx(MIN_ZOOM - 10)).toBeCloseTo(3, 6);
    expect(stopRadiusPx(MAX_ZOOM + 10)).toBeCloseTo(6, 6);
  });
});
