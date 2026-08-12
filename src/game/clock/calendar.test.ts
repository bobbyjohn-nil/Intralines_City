import { describe, expect, it } from 'vitest';
import { formatCalendarTime, toCalendarTime, toTotalMinutes } from './calendar';
import {
  DAYS_PER_QUARTER,
  MINUTES_PER_DAY,
  QUARTERS_PER_YEAR,
  START_MINUTE_OF_DAY,
} from '../constants';

const DAYS_PER_YEAR = DAYS_PER_QUARTER * QUARTERS_PER_YEAR;

describe('toCalendarTime', () => {
  it('minute 0 is Year 1, Quarter 1, Day 1, 06:00', () => {
    const calendar = toCalendarTime(0);
    expect(calendar).toEqual({
      year: 1,
      quarter: 1,
      dayOfQuarter: 1,
      hour: 6,
      minute: 0,
      minuteOfDay: 360,
    });
  });

  it('formats minute 0 exactly as the manual\'s top-bar string', () => {
    expect(formatCalendarTime(toCalendarTime(0))).toBe('Year 1 · Quarter 1 Day 1 06:00');
  });

  describe('day rollover', () => {
    // Day 1 runs from totalMinutes 0 (06:00) to totalMinutes 1079 (23:59). The next minute
    // (1080) is 00:00 on Day 2.
    it('sits at Day 1 23:59 the minute before the boundary', () => {
      expect(toCalendarTime(1079)).toMatchObject({ dayOfQuarter: 1, hour: 23, minute: 59 });
    });

    it('sits at Day 2 00:00 the minute of the boundary', () => {
      expect(toCalendarTime(1080)).toMatchObject({ dayOfQuarter: 2, hour: 0, minute: 0 });
    });
  });

  describe('quarter rollover', () => {
    // Quarter 1 has 10 days. Day 10 of Quarter 1 ends at totalMinutes 14039 (23:59); the next
    // minute (14040) opens Quarter 2, Day 1, 00:00.
    const lastMinuteOfQuarter = DAYS_PER_QUARTER * MINUTES_PER_DAY - 1 - START_MINUTE_OF_DAY;

    it('sits at Quarter 1 Day 10 23:59 the minute before the boundary', () => {
      expect(toCalendarTime(lastMinuteOfQuarter)).toMatchObject({
        quarter: 1,
        dayOfQuarter: DAYS_PER_QUARTER,
        hour: 23,
        minute: 59,
      });
    });

    it('sits at Quarter 2 Day 1 00:00 the minute of the boundary', () => {
      expect(toCalendarTime(lastMinuteOfQuarter + 1)).toMatchObject({
        quarter: 2,
        dayOfQuarter: 1,
        hour: 0,
        minute: 0,
      });
    });
  });

  describe('year rollover', () => {
    // A year is DAYS_PER_YEAR days. The last minute of Year 1 is Quarter 4, Day 10, 23:59; the
    // next minute opens Year 2, Quarter 1, Day 1, 00:00.
    const lastMinuteOfYear = DAYS_PER_YEAR * MINUTES_PER_DAY - START_MINUTE_OF_DAY - 1;

    it('sits at Year 1 Quarter 4 Day 10 23:59 the minute before the boundary', () => {
      expect(toCalendarTime(lastMinuteOfYear)).toMatchObject({
        year: 1,
        quarter: QUARTERS_PER_YEAR,
        dayOfQuarter: DAYS_PER_QUARTER,
        hour: 23,
        minute: 59,
      });
    });

    it('sits at Year 2 Quarter 1 Day 1 00:00 the minute of the boundary', () => {
      expect(toCalendarTime(lastMinuteOfYear + 1)).toMatchObject({
        year: 2,
        quarter: 1,
        dayOfQuarter: 1,
        hour: 0,
        minute: 0,
      });
    });
  });
});

describe('round-trip: totalMinutes -> CalendarTime -> totalMinutes', () => {
  it('is lossless for minute 0', () => {
    expect(toTotalMinutes(toCalendarTime(0))).toBe(0);
  });

  it('is lossless across a wide range of integer values, including boundaries', () => {
    const samples = [
      0, 1, 59, 60, 1079, 1080, 1439, 1440, 14039, 14040, 57239, 57240, 100_000, 999_999,
      12_345_678,
    ];
    for (const totalMinutes of samples) {
      expect(toTotalMinutes(toCalendarTime(totalMinutes))).toBe(totalMinutes);
    }
  });

  it('is lossless across a dense sweep of consecutive minutes spanning a day boundary', () => {
    for (let totalMinutes = 1070; totalMinutes <= 1090; totalMinutes++) {
      expect(toTotalMinutes(toCalendarTime(totalMinutes))).toBe(totalMinutes);
    }
  });

  it('is lossless for fractional totalMinutes (the clock advances continuously, not by whole minutes)', () => {
    const samples = [0.25, 12.5, 1079.75, 1080.1, 57239.99];
    for (const totalMinutes of samples) {
      expect(toTotalMinutes(toCalendarTime(totalMinutes))).toBeCloseTo(totalMinutes, 9);
    }
  });
});
