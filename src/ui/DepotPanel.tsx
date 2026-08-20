/**
 * The depot panel (depots-and-timetables.md §2, "Depot economics") — what a selected depot is
 * worth today: its level, how full it is, what it costs to keep running, and what the *next*
 * depot on the ladder would cost were the player to buy one. One purpose, one depot at a time —
 * this is not the multi-depot fleet view (that's a Fleet panel's job, manual §5, not built here)
 * and it never invents an upgrade button: `economics.ts`'s own doc comment says upgrade purchases
 * aren't wired yet, so this panel states the level, it does not offer to change it.
 *
 * Fixed-positioned and out of document flow, same reasoning as `DraftBar`/`Notice`: opening this
 * panel must never resize or reflow the dock, the top bar, or the map underneath it.
 */

import { depotCapacity, depotUpkeepUsdPerDay, canArmDepotTool } from '../game/depots/economics';
import type { Depot } from '../game/depots/types';
import { formatUsd } from '../game/economy/format';
import { CENTS_PER_USD } from '../game/economy/types';
import { nextDepotStatusMessage } from './depotCopy';
import { Depot as DepotIcon } from './icons';
import './DepotPanel.css';

export interface DepotPanelProps {
  /** The depot this panel is open on. */
  readonly depot: Depot;
  /** How many depots the company owns in total — needed (with `cashUsd`) to price and gate the
   * *next* depot on the ladder (§2), which is a company-wide fact, not a property of `depot`
   * itself. Same `canArmDepotTool` the dock's "Place depot" tool arms against — one predicate,
   * never a second copy of the cash/cap gate. */
  readonly depotsOwnedCount: number;
  readonly cashUsd: number;
  readonly onClose: () => void;
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="depot-panel__stat">
      <span className="depot-panel__stat-label">{label}</span>
      <span className="depot-panel__stat-value">{value}</span>
    </div>
  );
}

export function DepotPanel({ depot, depotsOwnedCount, cashUsd, onClose }: DepotPanelProps) {
  const capacity = depotCapacity(depot.level);
  const upkeepUsd = depotUpkeepUsdPerDay(depot.level);
  const arm = canArmDepotTool(depotsOwnedCount, cashUsd);
  const nextDepotText = nextDepotStatusMessage(arm);
  const nextDepotClass = arm.ok ? 'is-ok' : arm.reason === 'depot_limit_reached' ? 'is-capped' : 'is-blocked';

  return (
    <section className="depot-panel" role="region" aria-label={`Depot: ${depot.name}`}>
      <header className="depot-panel__header">
        <span className="depot-panel__icon" aria-hidden="true">
          <DepotIcon size={20} />
        </span>
        <div className="depot-panel__title">
          <span className="depot-panel__name">{depot.name}</span>
          <span className="depot-panel__level">Level {depot.level}</span>
        </div>
        <button type="button" className="depot-panel__close" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="depot-panel__stats">
        <Stat label="Capacity" value={`${depot.busesParked} / ${capacity} parked`} />
        <Stat label="Upkeep" value={`${formatUsd(upkeepUsd * CENTS_PER_USD)}/day`} />
      </div>

      <p className={`depot-panel__next depot-panel__next--${nextDepotClass}`}>{nextDepotText}</p>
    </section>
  );
}
