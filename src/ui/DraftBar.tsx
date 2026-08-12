/**
 * The draft bar (manual §9, "Drawing a line"): "shows live: stop count, length, a round-trip
 * time preview using the baseline bus... Undo, Cancel, and Create line (needs ≥ 2 stops)."
 * Mounted only while a line is being drawn — the caller owns the draft state machine
 * (`src/game/lines/draft.ts`); this component only ever renders a `summarizeDraft()` result and
 * the `canCreate()` verdict computed against it, never its own numbers.
 */

import type { Draft } from '../game/lines/types';
import { formatUsd } from '../game/economy/format';
import { CENTS_PER_USD } from '../game/economy/types';
import './DraftBar.css';

export interface DraftBarProps {
  readonly draft: Draft;
  /** The real `canCreate()` verdict (`src/game/lines/draft.ts`) — the one predicate every
   * consumer shares, per GAME.md's "one shared predicate per rule". */
  readonly canCreate: boolean;
  readonly onUndo: () => void;
  readonly onCancel: () => void;
  readonly onCreate: () => void;
}

/** Manual §9's threshold, restated in the house voice rather than gestured at with a greyed
 * button. Mirrors `canCreate()`'s `stops.length >= 2` — update both together if that ever changes. */
const CREATE_DISABLED_REASON = 'Needs at least 2 stops.';

const METERS_PER_KM = 1000;
const MINUTES_PER_HOUR = 60;

/** "1,240 m" below a kilometre, "1.2 km" above — display only, never fed back into the sim. */
function formatLength(lengthM: number): string {
  if (lengthM < METERS_PER_KM) {
    return `${Math.round(lengthM)} m`;
  }
  return `${(lengthM / METERS_PER_KM).toFixed(1)} km`;
}

/** "42 min" under an hour, "1 h 12 min" above. */
function formatDuration(minutes: number): string {
  const totalMinutes = Math.round(minutes);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const mins = totalMinutes % MINUTES_PER_HOUR;
  return hours > 0 ? `${hours} h ${mins} min` : `${mins} min`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="draft-bar__stat">
      <span className="draft-bar__stat-label">{label}</span>
      <span className="draft-bar__stat-value">{value}</span>
    </div>
  );
}

export function DraftBar({ draft, canCreate, onUndo, onCancel, onCreate }: DraftBarProps) {
  // Draft.placementCostUsd is plain dollars (src/game/constants.ts's STOP_PLACEMENT_COST_USD is
  // $4,000, not cents) — formatUsd takes cents, so convert at this display boundary only.
  const costText = formatUsd(draft.placementCostUsd * CENTS_PER_USD);

  return (
    <div className="draft-bar" role="group" aria-label="Drawing a line">
      <div className="draft-bar__stats">
        <Stat label="Stops" value={String(draft.stopCount)} />
        <Stat label="Length" value={formatLength(draft.totalLengthM)} />
        <Stat label="Round trip" value={formatDuration(draft.estimatedRoundTripMinutes)} />
        <Stat label="Cost" value={costText} />
      </div>

      <div className="draft-bar__actions">
        <button
          type="button"
          className="draft-bar__btn"
          onClick={onUndo}
          disabled={draft.stopCount === 0}
        >
          Undo
        </button>
        <button type="button" className="draft-bar__btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="draft-bar__btn draft-bar__btn--primary"
          onClick={onCreate}
          disabled={!canCreate}
        >
          Create line
        </button>
      </div>

      {/* Fixed-height reason line — always in the layout so Create's disabled state never
          reflows the bar when it toggles. */}
      <p className="draft-bar__hint" aria-live="polite">
        {canCreate ? '' : CREATE_DISABLED_REASON}
      </p>
    </div>
  );
}
