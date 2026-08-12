/**
 * Data contracts for the money floor (manual §17). Cash is tracked in integer cents throughout —
 * see `ledger.ts` for why — and converted to dollars only at the display boundary in `format.ts`.
 *
 * Milestone 1 has no riders yet, so nothing here computes fare or subsidy income. Both fields are
 * declared anyway so Milestone 2 slots real numbers into them without a type change downstream.
 */

/** Cents per US dollar. The only place cents and dollars are related by a literal. */
export const CENTS_PER_USD = 100;

/**
 * The company's cash position, plus the sub-cent remainder of every accrual line that hasn't
 * banked a whole cent yet. Carrying the remainder — rather than rounding each tick to the nearest
 * cent and discarding what's left over — is what keeps `accrue` exact across thousands of small
 * ticks. See `ledger.test.ts` for the drift check.
 */
export interface Treasury {
  /** Integer cents. May go negative — nothing here stops the company running out of cash, that's
   * a later system's problem (credit score, lenders, §17). Only `spend` refuses to overdraw. */
  readonly cashCents: number;
  readonly carry: LedgerCarry;
}

/**
 * The not-yet-banked remainder of every accrual line. Produced and consumed entirely within
 * `ledger.ts` — nothing outside the economy module should need to read one of these.
 *
 * Two different techniques live here, because they need different guarantees:
 *  - `fuelCents`/`maintenanceCents` are a sub-cent remainder in `[0, 1)`, added to and drained
 *    tick by tick. Fuel and maintenance rates come from whatever `BusModelSpec` the caller
 *    passes in, which can legitimately change tick to tick (a different bus model), so nothing
 *    here may assume a single fixed rate applied over the line's whole history.
 *  - `cumulativeBusServiceMinutes`/`cumulativeMinutes` are running totals of *time*, not cents.
 *    Driver wages ($26/h) and office overhead ($250/day) are true constants that never change
 *    over a company's life, so `accrue` banks them by computing the cumulative cents owed from
 *    scratch on both sides of the tick and taking the difference — see `ledger.ts`. That keeps a
 *    day's total exact no matter how it is sliced into ticks, which the additive remainder alone
 *    cannot guarantee once a rate is a repeating binary fraction (250/1440, 26/60, ...).
 */
export interface LedgerCarry {
  readonly fuelCents: number;
  readonly maintenanceCents: number;
  /** Σ busesInService × minutes actually inside service hours, since founding. */
  readonly cumulativeBusServiceMinutes: number;
  /** Minutes elapsed since founding. */
  readonly cumulativeMinutes: number;
}

/**
 * Income and expense lines for a period, itemised the way the manual's §17 table groups them.
 * Doubles as both the increment `accrue` produces for a single tick and the sum of many ticks —
 * a day's ledger (for the Finance panel) is just every tick's ledger added line by line.
 *
 * Milestone 1 only ever produces nonzero `expense` — no rider exists yet to pay a fare or draw a
 * subsidy — but both income fields are here so the shape doesn't change when riders arrive.
 */
export interface LedgerDay {
  readonly income: {
    /** Fare × boardings. Always 0 until Milestone 2 wires up riders. */
    readonly fareCents: number;
    /** City subsidy per boarding — $1.60/boarding, $2.40 on express (§17). Always 0 until
     * Milestone 2. */
    readonly citySubsidyCents: number;
  };
  readonly expense: {
    readonly fuelCents: number;
    readonly maintenanceCents: number;
    readonly driverWagesCents: number;
    readonly officeOverheadCents: number;
  };
}

/**
 * A single discrete, player- or system-initiated cash movement — a stop placed, a bus bought.
 * Distinct from `accrue`'s continuous per-tick lines, which flow straight into the treasury and
 * are never individually logged as a `Transaction`.
 */
export interface Transaction {
  /** Always positive; direction is implied by context (only `spend` produces these today, so it
   * is always an expense). */
  readonly amountCents: number;
  /** Free-form label for the Finance log/UI, e.g. "Stop placement". */
  readonly reason: string;
}
