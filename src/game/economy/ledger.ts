/**
 * The money floor. Pure functions only — a `Treasury` goes in, a new one comes out, per the
 * sim's hard constraint (studio/GAME.md "The simulation must stay portable to WebAssembly").
 *
 * Cash flows continuously per tick (manual §17), not in daily lumps, so `accrue` is designed to
 * be called every sim tick with however many game-minutes just elapsed. Milestone 1 has no
 * riders, so only the cost lines that can actually accrue today are computed here: fuel and
 * maintenance per km driven, driver wages (service hours only), and office overhead.
 */

import type { BusModelSpec } from '../constants';
import {
  DEFAULT_SERVICE_HOURS,
  DRIVER_WAGE_PER_HOUR_USD,
  MINUTES_PER_DAY,
  OFFICE_OVERHEAD_PER_DAY_USD,
  STARTING_CASH_USD,
} from '../constants';
import { CENTS_PER_USD } from './types';
import type { LedgerCarry, LedgerDay, Transaction, Treasury } from './types';

const ZERO_CARRY: LedgerCarry = {
  fuelCents: 0,
  maintenanceCents: 0,
  cumulativeBusServiceMinutes: 0,
  cumulativeMinutes: 0,
};

export const ZERO_LEDGER_DAY: LedgerDay = {
  income: { fareCents: 0, citySubsidyCents: 0 },
  expense: { fuelCents: 0, maintenanceCents: 0, driverWagesCents: 0, officeOverheadCents: 0 },
};

/** The treasury a freshly founded company starts with. */
export function createTreasury(startingCashUsd: number = STARTING_CASH_USD): Treasury {
  return { cashCents: usdToCents(startingCashUsd), carry: ZERO_CARRY };
}

/** Adds two `LedgerDay`s line by line. Used to fold many ticks' `accrue` output into a running
 * day (or any other period) without the economy module needing to know what a "day" is to a UI. */
export function addLedgerDay(a: LedgerDay, b: LedgerDay): LedgerDay {
  return {
    income: {
      fareCents: a.income.fareCents + b.income.fareCents,
      citySubsidyCents: a.income.citySubsidyCents + b.income.citySubsidyCents,
    },
    expense: {
      fuelCents: a.expense.fuelCents + b.expense.fuelCents,
      maintenanceCents: a.expense.maintenanceCents + b.expense.maintenanceCents,
      driverWagesCents: a.expense.driverWagesCents + b.expense.driverWagesCents,
      officeOverheadCents: a.expense.officeOverheadCents + b.expense.officeOverheadCents,
    },
  };
}

/** Income minus expense for a `LedgerDay`. */
export function netCents(day: LedgerDay): number {
  return (
    day.income.fareCents +
    day.income.citySubsidyCents -
    (day.expense.fuelCents +
      day.expense.maintenanceCents +
      day.expense.driverWagesCents +
      day.expense.officeOverheadCents)
  );
}

// ── accrue ───────────────────────────────────────────────────────────────────

export interface AccrualContext {
  /** Minute-of-day at the moment this tick starts, in `[0, 1440)`, fractional — e.g.
   * `toCalendarTime(clock.totalMinutes).minuteOfDay`. The caller owns the calendar epoch; this
   * module only needs where in the 24h service cycle the tick begins. */
  readonly minuteOfDayAtStart: number;
  /** Kilometres actually driven by the fleet during this tick. Supplied by the caller — the
   * ledger never looks up bus positions itself. */
  readonly kmDriven: number;
  /** The bus model whose per-km costs apply to `kmDriven`. Milestone 1 only ever passes
   * `BUS_MODELS[STARTING_BUS_MODEL]`, but nothing here assumes that. */
  readonly busModel: BusModelSpec;
  /** Number of buses currently in service; each earns a driver wage for the portion of this
   * tick that falls inside service hours. */
  readonly busesInService: number;
}

export interface AccrualResult {
  readonly treasury: Treasury;
  /** Cents accrued during this tick only, shaped like `LedgerDay` so callers can fold it
   * straight into a running total with `addLedgerDay`. */
  readonly accrued: LedgerDay;
}

const SERVICE_START_MINUTE = DEFAULT_SERVICE_HOURS.firstHour * 60;
const SERVICE_END_MINUTE = DEFAULT_SERVICE_HOURS.lastHour * 60;
const SERVICE_MINUTES_PER_DAY = SERVICE_END_MINUTE - SERVICE_START_MINUTE;

/**
 * Minutes of service-hours coverage from the start of time up to `minuteOfDay` (which may be
 * larger than 1440 — it is a position on an infinite line where the 24h cycle repeats, not a
 * value already wrapped into a single day). Strictly increasing, so the overlap of any window
 * with service hours is just the difference of this function at its two ends — see
 * `serviceMinutesInWindow`. That is what makes the result independent of how a day gets sliced
 * into ticks.
 */
function cumulativeServiceMinutes(minuteOfDay: number): number {
  const fullDays = Math.floor(minuteOfDay / MINUTES_PER_DAY);
  const remainder = minuteOfDay - fullDays * MINUTES_PER_DAY;
  const partial = Math.min(Math.max(remainder, SERVICE_START_MINUTE), SERVICE_END_MINUTE) - SERVICE_START_MINUTE;
  return fullDays * SERVICE_MINUTES_PER_DAY + partial;
}

/** How many of the `deltaMinutes` starting at `minuteOfDayAtStart` fall inside service hours. */
function serviceMinutesInWindow(minuteOfDayAtStart: number, deltaMinutes: number): number {
  return (
    cumulativeServiceMinutes(minuteOfDayAtStart + deltaMinutes) -
    cumulativeServiceMinutes(minuteOfDayAtStart)
  );
}

/**
 * Banks whatever whole cents `carryBefore + exactCents` now contains, keeping the leftover
 * fraction as the new carry. Summing `wholeCents` across any run of calls, plus the final carry,
 * always equals the exact sum of every `exactCents` passed in — that's what keeps continuous
 * accrual from silently rounding a fraction of a cent away every single tick.
 *
 * Used for fuel and maintenance, whose rate can change tick to tick (a different bus model) —
 * see the `LedgerCarry` doc comment for why that rules out `bankFromCumulativeTotal` below.
 */
function bankCents(carryBefore: number, exactCents: number): { wholeCents: number; carryAfter: number } {
  const total = carryBefore + exactCents;
  const wholeCents = Math.floor(total);
  return { wholeCents, carryAfter: total - wholeCents };
}

/**
 * Banks whole cents for a line whose dollar rate is a true constant (driver wages, office
 * overhead) by computing the total owed from scratch at both ends of the tick and taking the
 * difference, rather than accumulating a fractional-cents remainder tick by tick.
 *
 * This matters because `rateNumeratorCents / rateDenominatorUnits` (26/60, 250/1440, ...) is
 * usually a repeating binary fraction — reusing that already-rounded rate as an addend hundreds
 * of times can leave a whole cent stranded in the remainder and never quite bank it (verified by
 * `ledger.test.ts`'s tick-size-independence check). Recomputing the *cumulative* total fresh
 * every time sidesteps that: `before` and `after` are each rounded independently rather than
 * being built by repeatedly adding an already-rounded value to itself, and integer inputs
 * (whole minutes, whole bus counts) keep the numerator exact right up to the one division.
 */
function bankFromCumulativeTotal(
  rateNumeratorCents: number,
  rateDenominatorUnits: number,
  before: number,
  after: number,
): number {
  const bankedBefore = Math.floor((rateNumeratorCents * before) / rateDenominatorUnits);
  const bankedAfter = Math.floor((rateNumeratorCents * after) / rateDenominatorUnits);
  return bankedAfter - bankedBefore;
}

function usdToCents(usd: number): number {
  return Math.round(usd * CENTS_PER_USD);
}

/**
 * Advances the treasury by `deltaMinutes` of game time. Never call this with a negative
 * `deltaMinutes` or `kmDriven` — those are impossible states for a forward-only clock and a
 * caller bug, not a player action, so they're logged loudly and clamped to zero rather than
 * corrupting the treasury.
 */
export function accrue(treasury: Treasury, deltaMinutes: number, context: AccrualContext): AccrualResult {
  const safeDeltaMinutes = clampNonNegative(deltaMinutes, 'accrue: deltaMinutes');
  const safeKmDriven = clampNonNegative(context.kmDriven, 'accrue: context.kmDriven');
  const safeBusesInService = clampNonNegative(context.busesInService, 'accrue: context.busesInService');

  // Fuel & maintenance: additive sub-cent carry — see `bankCents` and the `LedgerCarry` doc.
  const fuelExactCents = safeKmDriven * context.busModel.fuelPerKmUsd * CENTS_PER_USD;
  const maintenanceRatePerKmUsd = context.busModel.costPerKmUsd - context.busModel.fuelPerKmUsd;
  const maintenanceExactCents = safeKmDriven * maintenanceRatePerKmUsd * CENTS_PER_USD;
  const fuel = bankCents(treasury.carry.fuelCents, fuelExactCents);
  const maintenance = bankCents(treasury.carry.maintenanceCents, maintenanceExactCents);

  // Driver wages: fixed $26/h rate, banked from a fresh cumulative total — see
  // `bankFromCumulativeTotal`. Only the minutes actually inside service hours count.
  const serviceMinutes = serviceMinutesInWindow(context.minuteOfDayAtStart, safeDeltaMinutes);
  const busServiceMinutesBefore = treasury.carry.cumulativeBusServiceMinutes;
  const busServiceMinutesAfter = busServiceMinutesBefore + safeBusesInService * serviceMinutes;
  const driverWagesWholeCents = bankFromCumulativeTotal(
    DRIVER_WAGE_PER_HOUR_USD * CENTS_PER_USD,
    60,
    busServiceMinutesBefore,
    busServiceMinutesAfter,
  );

  // Office overhead: fixed $250/day rate, same fresh-cumulative-total trick.
  const minutesBefore = treasury.carry.cumulativeMinutes;
  const minutesAfter = minutesBefore + safeDeltaMinutes;
  const officeOverheadWholeCents = bankFromCumulativeTotal(
    OFFICE_OVERHEAD_PER_DAY_USD * CENTS_PER_USD,
    MINUTES_PER_DAY,
    minutesBefore,
    minutesAfter,
  );

  const totalSpentCents =
    fuel.wholeCents + maintenance.wholeCents + driverWagesWholeCents + officeOverheadWholeCents;

  return {
    treasury: {
      cashCents: treasury.cashCents - totalSpentCents,
      carry: {
        fuelCents: fuel.carryAfter,
        maintenanceCents: maintenance.carryAfter,
        cumulativeBusServiceMinutes: busServiceMinutesAfter,
        cumulativeMinutes: minutesAfter,
      },
    },
    accrued: {
      income: { fareCents: 0, citySubsidyCents: 0 },
      expense: {
        fuelCents: fuel.wholeCents,
        maintenanceCents: maintenance.wholeCents,
        driverWagesCents: driverWagesWholeCents,
        officeOverheadCents: officeOverheadWholeCents,
      },
    },
  };
}

function clampNonNegative(value: number, label: string): number {
  if (value < 0) {
    // Fail loud (console.error survives into release builds), degrade to zero so a caller bug
    // never pushes the treasury backwards or makes time run in reverse.
    console.error(`${label}: ${value} is negative — clamped to 0`);
    return 0;
  }
  return value;
}

// ── spend ────────────────────────────────────────────────────────────────────

export type SpendResult =
  | { readonly ok: true; readonly treasury: Treasury; readonly transaction: Transaction }
  | { readonly ok: false; readonly reason: 'insufficient_funds' };

/**
 * A discrete, player-initiated spend (stop placement, a bus purchase, ...). Unlike `accrue`,
 * this can be refused outright — cash never goes negative through `spend`, silently or
 * otherwise.
 */
export function spend(treasury: Treasury, amountUsd: number, reason: string): SpendResult {
  if (amountUsd < 0) {
    console.error(`spend: amountUsd ${amountUsd} is negative for reason "${reason}" — refusing`);
    return { ok: false, reason: 'insufficient_funds' };
  }

  const amountCents = usdToCents(amountUsd);
  if (amountCents > treasury.cashCents) {
    return { ok: false, reason: 'insufficient_funds' };
  }

  return {
    ok: true,
    treasury: { ...treasury, cashCents: treasury.cashCents - amountCents },
    transaction: { amountCents, reason },
  };
}
