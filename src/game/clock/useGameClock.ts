/**
 * Drives the `GameClock` from `requestAnimationFrame`. Real elapsed time (clamped) is what
 * advances game-minutes, never frame count — see `MAX_FRAME_DELTA_MS` below.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameClock } from '../types';
import { CLOCK_DEFAULT_SPEED_INDEX, CLOCK_SPEEDS, START_PAUSED } from '../constants';

/**
 * Largest slice of real time a single frame may advance the clock by, in ms. Guards against an
 * alt-tab or a debugger breakpoint dumping a huge `dt` into the sim and fast-forwarding days. TUNE
 */
const MAX_FRAME_DELTA_MS = 250;

const MS_PER_SECOND = 1000;

export interface UseGameClockResult {
  readonly clock: GameClock;
  readonly togglePause: () => void;
  readonly setSpeedIndex: (index: number) => void;
}

/** Looks up a `CLOCK_SPEEDS` entry, degrading to the default speed on an out-of-range index. */
function speedForIndex(index: number): number {
  const speed = CLOCK_SPEEDS[index];
  if (speed !== undefined) return speed;

  // Impossible via setSpeedIndex (it validates), so this only fires from a corrupt/loaded state.
  // Fail loud (console.error survives into release builds), degrade to the default speed so a
  // bad index never stalls or crashes the clock.
  console.error(`useGameClock: speedIndex ${index} is out of range for CLOCK_SPEEDS`);
  return CLOCK_SPEEDS[CLOCK_DEFAULT_SPEED_INDEX] ?? CLOCK_SPEEDS[0];
}

export function useGameClock(): UseGameClockResult {
  const [clock, setClock] = useState<GameClock>({
    totalMinutes: 0,
    paused: START_PAUSED,
    speedIndex: CLOCK_DEFAULT_SPEED_INDEX,
  });

  // Mirrors `clock` so the rAF loop always reads the latest state without depending on it
  // (which would mean tearing the loop down and rebuilding it every tick).
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const lastFrameTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef(0);

  useEffect(() => {
    // Created once per mount, not per frame — the rAF loop below just keeps calling itself.
    const tick = (now: number) => {
      rafIdRef.current = requestAnimationFrame(tick);

      const lastFrameTime = lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;
      if (lastFrameTime === null) return; // first frame: nothing to measure yet

      const current = clockRef.current;
      if (current.paused) return;

      const deltaMs = Math.min(now - lastFrameTime, MAX_FRAME_DELTA_MS);
      const deltaSeconds = deltaMs / MS_PER_SECOND;
      const gameMinutes = deltaSeconds * speedForIndex(current.speedIndex);
      if (gameMinutes === 0) return;

      setClock({
        totalMinutes: current.totalMinutes + gameMinutes,
        paused: current.paused,
        speedIndex: current.speedIndex,
      });
    };

    rafIdRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafIdRef.current);
  }, []);

  const togglePause = useCallback(() => {
    setClock((prev) => ({ ...prev, paused: !prev.paused }));
  }, []);

  const setSpeedIndex = useCallback((index: number) => {
    if (CLOCK_SPEEDS[index] === undefined) {
      console.error(`useGameClock.setSpeedIndex: ${index} is out of range for CLOCK_SPEEDS`);
      return;
    }
    setClock((prev) => (prev.speedIndex === index ? prev : { ...prev, speedIndex: index }));
  }, []);

  return { clock, togglePause, setSpeedIndex };
}
