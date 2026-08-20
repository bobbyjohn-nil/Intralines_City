/**
 * The dock (bottom bar, manual §5, "The dock"). The manual lists seven entries — Select, New
 * line, Place depot, Map ▾, Lines, Fleet, Staff, Company ▾ — but Milestone 1 only has systems
 * behind the first three. The rest slot into `<Dock>` once the map menu, the line list, the
 * fleet and staff exist; nothing here invents a button for a system that isn't built.
 */

import './Dock.css';
import { Depot as DepotIcon } from './icons';

/** The tools with a real system behind them today. Grows toward the manual's seven as later
 * milestones land — `'map' | 'lines' | 'fleet' | 'staff' | 'company'`. */
export type Tool = 'select' | 'draw-line' | 'place-depot';

export interface DockProps {
  readonly tool: Tool;
  readonly onSelectTool: (tool: Tool) => void;
  /**
   * Whether the company has sited its first depot yet. "Place depot" (manual §5: "Only visible
   * until your first depot exists, pulses to draw the eye") renders only while this is `false` —
   * the first depot is mandatory and gates every other system (buses need one to park in), so the
   * dock spends a pulse drawing the eye to it once and never again once it's done its job. Once a
   * company owns a depot the entry disappears rather than sitting there inert; a later depot is
   * bought from the depot panel's own ladder (`DepotPanel`), not the dock.
   *
   * Optional, defaulting to `true` (entry hidden) purely so an existing `<Dock tool=.../>` call
   * site — one that hasn't been wired to real depot state yet — keeps compiling and never shows a
   * pulsing call-to-action for a system it isn't tracking. Pass the real value once depot state
   * exists in the caller; this default is a build-safety net, not a design choice about when the
   * button should show.
   */
  readonly hasDepot?: boolean;
}

/** An arrow cursor — the Select tool (manual: "Pan/click mode"). */
function SelectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3 1.5 L3 13.5 L6.2 10.6 L8.3 14.8 L10.1 13.9 L8 9.7 L12.3 9.3 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A drawn route between two stops — the New line tool (manual: "Draw a bus line"). */
function DrawLineIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 12.5 C 5 6, 11 6, 13.5 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="2.5" cy="12.5" r="1.6" fill="currentColor" />
      <circle cx="13.5" cy="3" r="1.6" fill="currentColor" />
    </svg>
  );
}

const TOOLS: ReadonlyArray<{
  readonly tool: Tool;
  readonly label: string;
  readonly ariaLabel: string;
  readonly Icon: () => JSX.Element;
}> = [
  { tool: 'select', label: 'Select', ariaLabel: 'Select tool — pan and click', Icon: SelectIcon },
  { tool: 'draw-line', label: 'New line', ariaLabel: 'New line tool — draw a bus line', Icon: DrawLineIcon },
];

export function Dock({ tool, onSelectTool, hasDepot = true }: DockProps) {
  return (
    <footer className="dock" aria-label="Dock">
      <div className="dock__group" role="group" aria-label="Tools">
        {TOOLS.map(({ tool: entryTool, label, ariaLabel, Icon }) => {
          const isActive = tool === entryTool;
          return (
            <button
              key={entryTool}
              type="button"
              className={`dock__btn${isActive ? ' is-active' : ''}`}
              onClick={() => onSelectTool(entryTool)}
              aria-pressed={isActive}
              aria-label={ariaLabel}
            >
              <Icon />
              <span className="dock__btn-label">{label}</span>
            </button>
          );
        })}

        {/* Manual §5: "Only visible until your first depot exists, pulses to draw the eye" — the
            first depot is mandatory (buses need one to park in) and everything else in the dock
            waits on it, so this entry gets a pulse no other dock button has, and then retires for
            good the moment `hasDepot` flips true. `disabled` is not the reason this hides; it's
            gone entirely, so the pulse is never fighting a greyed-out control for attention. */}
        {!hasDepot && (
          <button
            type="button"
            className={`dock__btn${tool === 'place-depot' ? ' is-active' : ''} dock__btn--pulse`}
            onClick={() => onSelectTool('place-depot')}
            aria-pressed={tool === 'place-depot'}
            aria-label="Place depot tool — site your first depot"
          >
            <DepotIcon />
            <span className="dock__btn-label">Place depot</span>
          </button>
        )}
      </div>

      {/*
        Milestone 2+: a second `dock__group` holds the Map ▾, Lines, Fleet, Staff and Company ▾
        menu buttons (manual §5) once those systems exist. Those open portaled menus outside this
        clipped container, not top-level buttons — do not add them until there's something to menu.
      */}
    </footer>
  );
}
