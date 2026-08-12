/**
 * The dock (bottom bar, manual §5, "The dock"). The manual lists seven entries — Select, New
 * line, Place depot, Map ▾, Lines, Fleet, Staff, Company ▾ — but Milestone 1 only has systems
 * behind the first two. The rest slot into `<Dock>` once depots, the map menu, the line list,
 * the fleet and staff exist; nothing here invents a button for a system that isn't built.
 */

import './Dock.css';

/** The tools with a real system behind them today. Grows toward the manual's seven as later
 * milestones land — `'place-depot' | 'map' | 'lines' | 'fleet' | 'staff' | 'company'`. */
export type Tool = 'select' | 'draw-line';

export interface DockProps {
  readonly tool: Tool;
  readonly onSelectTool: (tool: Tool) => void;
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

export function Dock({ tool, onSelectTool }: DockProps) {
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
        {/*
          Milestone 2+: Place depot slots in here once depots exist (manual §5 — "Only visible
          until your first depot exists, pulses to draw the eye").
        */}
      </div>

      {/*
        Milestone 2+: a second `dock__group` holds the Map ▾, Lines, Fleet, Staff and Company ▾
        menu buttons (manual §5) once those systems exist. Those open portaled menus outside this
        clipped container, not top-level buttons — do not add them until there's something to menu.
      */}
    </footer>
  );
}
