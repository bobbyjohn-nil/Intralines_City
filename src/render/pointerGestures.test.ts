import { describe, expect, it } from 'vitest';
import { pointerMovedPastClickThreshold } from './pointerGestures';

describe('pointerMovedPastClickThreshold', () => {
  const THRESHOLD_PX = 6;

  it('is false when the pointer never moved', () => {
    expect(pointerMovedPastClickThreshold(100, 100, 100, 100, THRESHOLD_PX)).toBe(false);
  });

  it('is false for movement at or under the threshold (a click, not a drag)', () => {
    expect(pointerMovedPastClickThreshold(0, 0, THRESHOLD_PX, 0, THRESHOLD_PX)).toBe(false);
    expect(pointerMovedPastClickThreshold(0, 0, THRESHOLD_PX - 1, 0, THRESHOLD_PX)).toBe(false);
  });

  it('is true once straight-line movement exceeds the threshold', () => {
    expect(pointerMovedPastClickThreshold(0, 0, THRESHOLD_PX + 1, 0, THRESHOLD_PX)).toBe(true);
  });

  it('measures straight-line (Pythagorean) distance, not per-axis distance', () => {
    expect(pointerMovedPastClickThreshold(0, 0, 3, 4, 4.5)).toBe(true);
    expect(pointerMovedPastClickThreshold(0, 0, 3, 0, 4.5)).toBe(false);
    expect(pointerMovedPastClickThreshold(0, 0, 0, 4, 4.5)).toBe(false);
  });

  it('is symmetric under negative deltas (drag direction does not matter)', () => {
    expect(pointerMovedPastClickThreshold(50, 50, 40, 45, 6)).toBe(
      pointerMovedPastClickThreshold(50, 50, 60, 55, 6),
    );
  });

  it('a real click never fires onMapClick-suppressing logic for sub-pixel jitter', () => {
    expect(pointerMovedPastClickThreshold(200, 300, 201, 300, 6)).toBe(false);
  });
});
