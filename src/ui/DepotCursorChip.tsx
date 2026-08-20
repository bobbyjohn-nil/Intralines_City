/**
 * The cursor chip for the "Place depot" tool (depots-and-timetables.md §1: "Checks 1-4 run on
 * pointer-move... so the chip updates as you drag"). Names which of the ordered checks failed,
 * and by how much — "Too close to Mill St Depot (85 m)", not "can't build here" — or, once the
 * spot is clear, the price the click would spend.
 *
 * Throttling seam (the "one thing to decide and justify" this component owns): this component
 * runs `isDepotSitable` zero times and owns no timer. `site` is a prop — the latest result the
 * caller already computed — so the ≤ 20 Hz budget the spec asks for (checks 1-4 run a
 * point-in-polygon test against zone geometry, "cheap with a grid index" per the doc comment on
 * `siting.ts`) is entirely the wiring layer's to enforce: gate the pointermove handler that calls
 * `isDepotSitable` (a `setTimeout`/`requestAnimationFrame` throttle, a trailing-edge debounce,
 * whatever fits the render loop that owns pointer events), then push the newest result in here.
 * The reasons this stays out of the component: (1) it doesn't know the city's grid index or the
 * render loop's own frame budget, so a timer here would be a second, uncoordinated clock racing
 * the one the map already runs; (2) a prop-driven component is trivially testable and trivially
 * re-timed later (20 Hz today, something else tomorrow) without touching this file at all — it
 * renders whatever it's handed, on every render, and nothing more.
 */

import type { DepotSitingResult } from '../game/depots/siting';
import { depotSiteMessage } from './depotCopy';
import './DepotCursorChip.css';

export interface DepotCursorChipProps {
  /** The latest `isDepotSitable(point, city, existingDepots)` result for the pointer's current
   * map position, or `null` when there's nothing to say yet — the pointer hasn't moved over the
   * map, or the tool isn't armed. Owned and throttled by the caller; see the module doc comment. */
  readonly site: DepotSitingResult | null;
  /** The price a click at this point would spend if `site.ok` — threaded in separately because
   * `isDepotSitable` itself never sees a treasury (siting.ts's own doc comment: that's row 0's
   * job, in `economics.ts`, not this predicate's). */
  readonly nextCostUsd: number;
  /** Chip position in CSS pixels, already tracking the pointer. This component places itself at
   * exactly the point it's told and reads no mouse event of its own — same division of labour as
   * `site`: positioning is a rendering-layer concern (`src/render/` owns the map/pointer), this
   * is presentation only. */
  readonly x: number;
  readonly y: number;
}

export function DepotCursorChip({ site, nextCostUsd, x, y }: DepotCursorChipProps) {
  if (site === null) return null;

  const message = depotSiteMessage(site, nextCostUsd);
  const legal = site.ok;

  return (
    <div
      className={`depot-cursor-chip${legal ? ' is-legal' : ' is-blocked'}`}
      style={{ left: x, top: y }}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}
