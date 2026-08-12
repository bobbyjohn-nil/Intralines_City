import { describe, expect, it } from 'vitest';
import { accrue, addLedgerDay, createTreasury, refund, spend, ZERO_LEDGER_DAY } from './ledger';
import type { AccrualContext } from './ledger';
import { BUS_MODELS, DEFAULT_SERVICE_HOURS, DRIVER_WAGE_PER_HOUR_USD, MINUTES_PER_DAY, OFFICE_OVERHEAD_PER_DAY_USD } from '../constants';
import { CENTS_PER_USD } from './types';
import type { BusModelSpec } from '../constants';
import type { LedgerDay, Treasury } from './types';

function requireBusModel(id: string): BusModelSpec {
  const model = BUS_MODELS[id];
  if (!model) throw new Error(`test setup: BUS_MODELS.${id} is missing`);
  return model;
}

const BUS = requireBusModel('metro40');

const SERVICE_START_MINUTE = DEFAULT_SERVICE_HOURS.firstHour * 60; // 360 (06:00)
const SERVICE_END_MINUTE = DEFAULT_SERVICE_HOURS.lastHour * 60; // 1320 (22:00)

function baseContext(overrides: Partial<AccrualContext> = {}): AccrualContext {
  return {
    minuteOfDayAtStart: 0,
    kmDriven: 0,
    busModel: BUS,
    busesInService: 0,
    ...overrides,
  };
}

describe('accrue — driver wages and service hours', () => {
  it('accrues wages for a tick fully inside service hours', () => {
    const treasury = createTreasury();
    const { accrued } = accrue(treasury, 60, baseContext({ minuteOfDayAtStart: 600, busesInService: 1 }));
    // Exactly one bus-hour inside service: $26 flat, no rounding ambiguity.
    expect(accrued.expense.driverWagesCents).toBe(DRIVER_WAGE_PER_HOUR_USD * CENTS_PER_USD);
  });

  it('accrues exactly zero wages for a tick fully outside service hours', () => {
    const treasury = createTreasury();
    // 22:00–23:00 — service ends at 22:00 (exclusive), so this whole hour is outside.
    const { accrued } = accrue(
      treasury,
      60,
      baseContext({ minuteOfDayAtStart: SERVICE_END_MINUTE, busesInService: 3 }),
    );
    expect(accrued.expense.driverWagesCents).toBe(0);
  });

  it('accrues exactly zero wages before service hours start', () => {
    const treasury = createTreasury();
    // 00:00–06:00 (up to but not including service start).
    const { accrued } = accrue(
      treasury,
      SERVICE_START_MINUTE,
      baseContext({ minuteOfDayAtStart: 0, busesInService: 5 }),
    );
    expect(accrued.expense.driverWagesCents).toBe(0);
  });

  it('accrues wages only for the portion of a tick that overlaps service hours', () => {
    const treasury = createTreasury();
    // 05:50–06:10 straddles the 06:00 open — only the last 10 minutes count.
    const { accrued } = accrue(
      treasury,
      20,
      baseContext({ minuteOfDayAtStart: SERVICE_START_MINUTE - 10, busesInService: 1 }),
    );
    const wageCentsPerMinute = (DRIVER_WAGE_PER_HOUR_USD * CENTS_PER_USD) / 60;
    expect(accrued.expense.driverWagesCents).toBe(Math.floor(wageCentsPerMinute * 10));
  });

  it('no wages accrue with no bus in service, even during service hours', () => {
    const treasury = createTreasury();
    const { accrued } = accrue(treasury, 120, baseContext({ minuteOfDayAtStart: 600, busesInService: 0 }));
    expect(accrued.expense.driverWagesCents).toBe(0);
  });
});

describe('accrue — office overhead is tick-size independent', () => {
  const OFFICE_OVERHEAD_PER_DAY_CENTS = OFFICE_OVERHEAD_PER_DAY_USD * CENTS_PER_USD;

  /** Simulates exactly one full day of overhead accrual, sliced into `tickMinutes`-sized ticks. */
  function simulateFullDay(tickMinutes: number): number {
    let treasury = createTreasury();
    let day: LedgerDay = ZERO_LEDGER_DAY;
    let elapsed = 0;
    while (elapsed < MINUTES_PER_DAY) {
      const result = accrue(treasury, tickMinutes, baseContext({ minuteOfDayAtStart: elapsed }));
      treasury = result.treasury;
      day = addLedgerDay(day, result.accrued);
      elapsed += tickMinutes;
    }
    return day.expense.officeOverheadCents;
  }

  const tickSizes = [1, 5, 30, 60, 90, 1440];

  it.each(tickSizes)('a day sliced into %i-minute ticks accrues exactly one day of overhead', (tickMinutes) => {
    expect(simulateFullDay(tickMinutes)).toBe(OFFICE_OVERHEAD_PER_DAY_CENTS);
  });

  it('every tick size agrees on the total', () => {
    const totals = tickSizes.map(simulateFullDay);
    for (const total of totals) {
      expect(total).toBe(OFFICE_OVERHEAD_PER_DAY_CENTS);
    }
  });
});

describe('accrue — driver wages are also tick-size independent', () => {
  const DRIVER_WAGE_PER_DAY_CENTS =
    DRIVER_WAGE_PER_HOUR_USD * CENTS_PER_USD * ((SERVICE_END_MINUTE - SERVICE_START_MINUTE) / 60);

  /** Simulates one full calendar day of a single bus in continuous service, sliced into
   * `tickMinutes`-sized ticks, and returns the total driver wages banked. */
  function simulateFullDayOfWages(tickMinutes: number): number {
    let treasury = createTreasury();
    let totalWagesCents = 0;
    let elapsed = 0;
    while (elapsed < MINUTES_PER_DAY) {
      const result = accrue(treasury, tickMinutes, baseContext({ minuteOfDayAtStart: elapsed, busesInService: 1 }));
      treasury = result.treasury;
      totalWagesCents += result.accrued.expense.driverWagesCents;
      elapsed += tickMinutes;
    }
    return totalWagesCents;
  }

  it.each([1, 5, 30, 60, 90, 1440])('a day sliced into %i-minute ticks banks exactly one day of wages', (tickMinutes) => {
    expect(simulateFullDayOfWages(tickMinutes)).toBe(DRIVER_WAGE_PER_DAY_CENTS);
  });
});

describe('spend', () => {
  it('refuses to overdraw and leaves cash unchanged', () => {
    const treasury: Treasury = {
      cashCents: 1_000,
      carry: { fuelCents: 0, maintenanceCents: 0, cumulativeBusServiceMinutes: 0, cumulativeMinutes: 0 },
    };
    const result = spend(treasury, 20, 'Stop placement'); // $20 > $10 on hand
    expect(result.ok).toBe(false);
    // The input treasury is never mutated.
    expect(treasury.cashCents).toBe(1_000);
  });

  it('succeeds and deducts exactly the spent amount when funds are sufficient', () => {
    const treasury = createTreasury(500); // $500
    const result = spend(treasury, 120, 'Stop placement'); // $120
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.treasury.cashCents).toBe((500 - 120) * CENTS_PER_USD);
      expect(result.transaction).toEqual({ amountCents: 120 * CENTS_PER_USD, reason: 'Stop placement' });
    }
  });

  it('refuses spending exactly one cent more than is on hand', () => {
    const treasury: Treasury = {
      cashCents: 100,
      carry: { fuelCents: 0, maintenanceCents: 0, cumulativeBusServiceMinutes: 0, cumulativeMinutes: 0 },
    };
    const result = spend(treasury, 1.01, 'x');
    expect(result.ok).toBe(false);
  });
});

describe('spend/refund — the shared-predicate property', () => {
  // `spend` and `refund` share the same private `usdToCents`, so a round trip through both must
  // land the treasury back on its exact starting cents — including for fractional-dollar amounts,
  // which is the case a whole-dollar-only cost (like today's STOP_PLACEMENT_COST_USD) never
  // exercises. This is the invariant a divergent App.tsx-local `refund` could silently violate.
  it.each([1, 20, 120, 4000.005, 0.01, 1234.567, 0.005])(
    'spending then refunding $%s returns the treasury to its starting cents',
    (amountUsd) => {
      const start = createTreasury(1_000_000); // plenty of headroom for every amount above
      const spent = spend(start, amountUsd, 'test spend');
      expect(spent.ok).toBe(true);
      if (!spent.ok) return;

      const refunded = refund(spent.treasury, amountUsd, 'test refund');

      expect(refunded.treasury.cashCents).toBe(start.cashCents);
    },
  );
});

describe('accrue — cent-level arithmetic does not drift', () => {
  it('splitting a run into 10,000 small ticks matches a single equivalent tick exactly', () => {
    const TICK_COUNT = 10_000;
    // Both dt and km-per-tick are exact binary fractions so floating-point summation of either
    // is itself bit-exact — isolating the assertion to whether the *cents* bookkeeping drifts,
    // which is the thing this module is responsible for.
    const DT_MINUTES = 0.25;
    const KM_PER_TICK = 0.0625;

    const start = createTreasury();

    // Path A: 10,000 small ticks.
    let smallTicked = start;
    let smallTickedLedger: LedgerDay = ZERO_LEDGER_DAY;
    let minuteOfDay = 0;
    for (let i = 0; i < TICK_COUNT; i++) {
      const result = accrue(
        smallTicked,
        DT_MINUTES,
        baseContext({ minuteOfDayAtStart: minuteOfDay, kmDriven: KM_PER_TICK, busesInService: 2 }),
      );
      smallTicked = result.treasury;
      smallTickedLedger = addLedgerDay(smallTickedLedger, result.accrued);
      minuteOfDay += DT_MINUTES;
    }

    // Path B: one tick covering the same total time and distance.
    const totalMinutes = TICK_COUNT * DT_MINUTES;
    const totalKm = TICK_COUNT * KM_PER_TICK;
    const oneBigTick = accrue(start, totalMinutes, baseContext({ minuteOfDayAtStart: 0, kmDriven: totalKm, busesInService: 2 }));

    const drift = smallTicked.cashCents - oneBigTick.treasury.cashCents;

    expect(smallTicked.cashCents).toBe(oneBigTick.treasury.cashCents);
    expect(smallTickedLedger).toEqual(oneBigTick.accrued);
    expect(drift).toBe(0);
  });
});
