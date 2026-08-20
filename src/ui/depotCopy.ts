/**
 * Copy for the depot placement flow (depots-and-timetables.md §1 "Depot placement", §2 "Depot
 * economics") — one function per message so the exact wording lives in exactly one place and the
 * cursor chip, the depot panel, and whatever `Notice` the wiring layer shows on an arm refusal
 * all read the same sentence. Nothing here recomputes a rule `isDepotSitable`/`canArmDepotTool`
 * already decided — every function takes the discriminated result and only turns it into a
 * string, per GAME.md's "one shared predicate per rule".
 *
 * House voice (GAME.md, "the manual states thresholds rather than gesturing at them"): every
 * refusal names the rule, the measured value, and — where the check table gives one — the fix.
 * Rows 1-4's strings are quoted verbatim from the check table with the dynamic figure filled in;
 * row 0 the same. The "clear to build" and "next depot" lines have no spec wording to match
 * (the manual only says the ghost marker "turns --blue when clear") so their phrasing is chosen
 * here, in the same voice.
 */

import { formatUsd } from '../game/economy/format';
import { CENTS_PER_USD } from '../game/economy/types';
import type { DepotArmResult } from '../game/depots/economics';
import type { DepotSitingResult } from '../game/depots/siting';
import { DEPOT_MAX_COUNT } from '../game/depots/constants';

/** `economics.ts`/`siting.ts` work in plain USD (see their own doc comments); `formatUsd` wants
 * cents (`economy/format.ts`) — this is the one place in this module that crosses that boundary. */
function usd(amountUsd: number): string {
  return formatUsd(Math.round(amountUsd * CENTS_PER_USD));
}

/** `nearestRoadDistanceM` can be `Infinity` only for a zero-node road graph — siting.ts's own
 * doc comment calls that "an impossible-in-practice city". Guarded anyway: a real player must
 * never see the literal string "Infinity m". */
function meters(distanceM: number): string {
  if (!Number.isFinite(distanceM)) return 'unreachable';
  return `${Math.round(distanceM)} m`;
}

/**
 * Row 0 of the §1 check table — why "Place depot" refused to arm at all. This is evaluated once,
 * when the player reaches for the tool, not per cursor position: there is no site to measure
 * before the tool is even armed. Quoted verbatim from the check table.
 */
export function depotArmRefusalMessage(arm: Extract<DepotArmResult, { ok: false }>): string {
  if (arm.reason === 'depot_limit_reached') {
    return `Depot limit reached (${DEPOT_MAX_COUNT}).`;
  }
  return `Needs ${usd(arm.costUsd)} — you have ${usd(arm.cashUsd)}.`;
}

/**
 * Rows 1-4 of the §1 check table, plus the clear-to-build line the manual leaves as "the ghost
 * marker turns --blue". `nextCostUsd` is the price a click at this point would spend — only the
 * clear case ever reads it, since a failing row never reaches a price.
 */
export function depotSiteMessage(site: DepotSitingResult, nextCostUsd: number): string {
  if (site.ok) {
    return `Clear to build — ${usd(nextCostUsd)}.`;
  }
  switch (site.reason) {
    case 'outside_city':
      return 'Outside the mapped city.';
    case 'not_zoned':
      return 'Not industrial land — build on the green.';
    case 'no_road_access':
      return `No street access — nearest road is ${meters(site.nearestRoadDistanceM)}.`;
    case 'too_close_to_depot':
      return `Too close to ${site.depotName} (${meters(site.distanceM)}).`;
    default: {
      const exhaustive: never = site;
      return exhaustive;
    }
  }
}

/**
 * The depot panel's "next depot on the ladder" line — the same row-0 gate `depotArmRefusalMessage`
 * explains at the tool, restated for a panel that is open regardless of whether the tool is armed
 * (a player reviewing an existing depot hasn't necessarily reached for "Place depot" at all).
 * Affordable and capped both state the number, never just a greyed control: "needs $45,000 more",
 * not "can't afford".
 */
export function nextDepotStatusMessage(arm: DepotArmResult): string {
  if (arm.ok) {
    return `Next depot: ${usd(arm.costUsd)} — you can afford it.`;
  }
  if (arm.reason === 'depot_limit_reached') {
    return `Depot cap reached (${DEPOT_MAX_COUNT} of ${DEPOT_MAX_COUNT}) — no more depots can be built.`;
  }
  const shortfallUsd = arm.costUsd - arm.cashUsd;
  return `Next depot: ${usd(arm.costUsd)} — needs ${usd(shortfallUsd)} more (you have ${usd(arm.cashUsd)}).`;
}
