/**
 * Binds the clock's keyboard shortcuts (manual §5): Space pauses/resumes, 1/2/3 pick a speed.
 * Stays out of the way of typing — inputs, textareas, contenteditable — and of any shortcut a
 * modifier key is meant for (browser tab-switching, etc).
 */

import { useEffect } from 'react';

/** `event.key` → index into `CLOCK_SPEEDS`. SPEC (manual §5: "1 / 2 / 3 — speed"). */
const SPEED_KEYS: Readonly<Record<string, number>> = { '1': 0, '2': 1, '3': 2 };

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}

export function useClockKeys(togglePause: () => void, setSpeedIndex: (index: number) => void): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (hasModifier(event)) return; // let the browser/OS shortcut through untouched
      if (isTypingTarget(event.target)) return; // don't hijack typing in a field

      if (event.code === 'Space') {
        event.preventDefault();
        togglePause();
        return;
      }

      const speedIndex = SPEED_KEYS[event.key];
      if (speedIndex !== undefined) {
        event.preventDefault();
        setSpeedIndex(speedIndex);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePause, setSpeedIndex]);
}
