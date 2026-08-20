/**
 * Click-vs-drag discrimination, shared by every pointer-driven surface this game has ever had
 * (Canvas 2D, now the WebGL canvas) — kept pure and tested in isolation because getting it wrong
 * makes the map unusable (every pan would drop a stop).
 */

/** True if the pointer moved farther than `thresholdPx` (straight-line) between down and up. */
export function pointerMovedPastClickThreshold(
  downX: number,
  downY: number,
  upX: number,
  upY: number,
  thresholdPx: number,
): boolean {
  const dx = upX - downX;
  const dy = upY - downY;
  return dx * dx + dy * dy > thresholdPx * thresholdPx;
}
