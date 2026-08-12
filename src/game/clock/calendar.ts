/**
 * Pure conversions between `totalMinutes` (the clock's single source of truth, see
 * `GameClock` in ../types.ts) and the human-readable `CalendarTime` the top bar displays.
 *
 * `CalendarTime` is never stored — it is always derived from `totalMinutes` on demand, so these
 * are the only two functions that know how the calendar is laid out.
 */

import type { CalendarTime } from '../types';
import {
  DAYS_PER_QUARTER,
  MINUTES_PER_DAY,
  QUARTERS_PER_YEAR,
  START_MINUTE_OF_DAY,
} from '../constants';

const DAYS_PER_YEAR = DAYS_PER_QUARTER * QUARTERS_PER_YEAR;

/**
 * `totalMinutes` counts elapsed game-minutes since founding; the clock itself starts at
 * `START_MINUTE_OF_DAY` (06:00) on Year 1 · Quarter 1 · Day 1, so that offset is folded in
 * before any day/quarter/year math runs. Day, quarter and year are all 1-indexed on the way out.
 */
export function toCalendarTime(totalMinutes: number): CalendarTime {
  const minutesSinceEpoch = START_MINUTE_OF_DAY + totalMinutes;

  const dayIndex = Math.floor(minutesSinceEpoch / MINUTES_PER_DAY);
  const minuteOfDay = minutesSinceEpoch - dayIndex * MINUTES_PER_DAY;

  const yearIndex = Math.floor(dayIndex / DAYS_PER_YEAR);
  const dayIndexInYear = dayIndex - yearIndex * DAYS_PER_YEAR;
  const quarterIndex = Math.floor(dayIndexInYear / DAYS_PER_QUARTER);
  const dayIndexInQuarter = dayIndexInYear - quarterIndex * DAYS_PER_QUARTER;

  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay - hour * 60;

  return {
    year: yearIndex + 1,
    quarter: quarterIndex + 1,
    dayOfQuarter: dayIndexInQuarter + 1,
    hour,
    minute,
    minuteOfDay,
  };
}

/**
 * Inverse of `toCalendarTime` — reconstructs `totalMinutes` exactly. Round-tripping through
 * `toCalendarTime` and back must be lossless (see calendar.test.ts).
 */
export function toTotalMinutes(calendar: CalendarTime): number {
  const dayIndex =
    (calendar.year - 1) * DAYS_PER_YEAR +
    (calendar.quarter - 1) * DAYS_PER_QUARTER +
    (calendar.dayOfQuarter - 1);

  const minutesSinceEpoch = dayIndex * MINUTES_PER_DAY + calendar.minuteOfDay;

  return minutesSinceEpoch - START_MINUTE_OF_DAY;
}

const CLOCK_DIGITS = 2;

function pad2(value: number): string {
  return String(Math.floor(value)).padStart(CLOCK_DIGITS, '0');
}

/**
 * Renders exactly the manual's top-bar format (§5): "Year 1 · Quarter 1 Day 1 06:00".
 * Sub-minute precision is dropped for display only — `CalendarTime` itself stays exact.
 */
export function formatCalendarTime(calendar: CalendarTime): string {
  return (
    `Year ${calendar.year} · Quarter ${calendar.quarter} ` +
    `Day ${calendar.dayOfQuarter} ${pad2(calendar.hour)}:${pad2(calendar.minute)}`
  );
}
