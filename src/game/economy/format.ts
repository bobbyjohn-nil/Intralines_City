/**
 * Money formatting for display only. Every other function in this module works in integer
 * cents; this is the one place that turns cents into something a player reads, and nothing
 * upstream should ever do that conversion itself (studio/GAME.md: "the map shows shapes, panels
 * show numbers" — this is where the numbers get made).
 */

import { CENTS_PER_USD } from './types';

/** Above this many dollars, amounts abbreviate to the nearest thousand ("$260k") instead of
 * spelling out every digit — the Finance panel is a glance, not a spreadsheet. # tune */
const ABBREVIATE_ABOVE_USD = 10_000;

const USD_PER_THOUSAND = 1_000;

/** Non-breaking-free comma grouping, e.g. 1240 -> "1,240". No locale APIs — deterministic
 * regardless of the runtime's available ICU data. */
function withThousandsCommas(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Formats cents as a dollar amount for display: "$1,240", "$260k", "-$40". A non-finite cash
 * value (the sandbox's unlimited treasury) renders as "∞" with no sign or currency symbol.
 */
export function formatUsd(cents: number): string {
  if (!Number.isFinite(cents)) {
    return '∞';
  }

  const dollars = Math.round(cents / CENTS_PER_USD);
  const sign = dollars < 0 ? '-' : '';
  const magnitude = Math.abs(dollars);

  if (magnitude >= ABBREVIATE_ABOVE_USD) {
    const thousands = Math.round(magnitude / USD_PER_THOUSAND);
    return `${sign}$${thousands}k`;
  }

  return `${sign}$${withThousandsCommas(magnitude)}`;
}
