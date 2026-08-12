/**
 * The top bar (manual §5, "Top bar (left to right)"). Milestone 1 only wires up the chips that
 * have real systems behind them — clock, speed control, cash. The manual also lists Drivers,
 * Riders/day, Satisfaction and Coverage chips; those slot into `<TopBarChips>` below once staff,
 * demand and the report card exist. Nothing here invents a value for a system that isn't built.
 */

import type { ReactNode } from 'react';
import type { GameClock } from '../game/types';
import { toCalendarTime, formatCalendarTime } from '../game/clock/calendar';
import { CLOCK_SPEEDS } from '../game/constants';
import './TopBar.css';

export interface TopBarProps {
  readonly clock: GameClock;
  readonly cashUsd: number;
  readonly onTogglePause: () => void;
  readonly onSetSpeed: (index: number) => void;
  /** Company/city name shown in the left slot. SPEC (manual §5: "● Company"). */
  readonly companyName?: string;
}

const DEFAULT_COMPANY_NAME = 'Riverton';

const cashFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** Two vertical bars — the pause glyph. Hand-drawn stroke style, no emoji (see GAME.md). */
function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <rect x="2" y="1" width="3.5" height="12" rx="0.5" fill="currentColor" />
      <rect x="8.5" y="1" width="3.5" height="12" rx="0.5" fill="currentColor" />
    </svg>
  );
}

const TRIANGLE_POINTS = '1,1 1,13 11,7';
const TRIANGLE_SPACING = 6;

/** One, two or three right-pointing triangles — ▶ / ▶▶ / ▶▶▶ drawn in `currentColor`. */
function SpeedIcon({ triangleCount }: { triangleCount: number }) {
  const width = 12 + (triangleCount - 1) * TRIANGLE_SPACING;
  return (
    <svg width={width} height="14" viewBox={`0 0 ${width} 14`} aria-hidden="true" focusable="false">
      {Array.from({ length: triangleCount }, (_, i) => (
        <polygon
          key={i}
          points={TRIANGLE_POINTS}
          transform={`translate(${i * TRIANGLE_SPACING}, 0)`}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

/**
 * A label/value pair, the shared shape every top-bar chip uses. Cash uses it today; Drivers,
 * Riders/day, Satisfaction and Coverage will reuse it unchanged when those systems land.
 */
function Chip({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  const chipClassName = className ? `top-bar__chip ${className}` : 'top-bar__chip';
  return (
    <div className={chipClassName}>
      <span className="top-bar__chip-label">{label}</span>
      <span className="top-bar__chip-value">{value}</span>
    </div>
  );
}

/** Pause + the three `CLOCK_SPEEDS` buttons, exactly one of which is ever "current". */
function SpeedControl({
  clock,
  onTogglePause,
  onSetSpeed,
}: Pick<TopBarProps, 'clock' | 'onTogglePause' | 'onSetSpeed'>) {
  return (
    <div className="top-bar__speed-group" role="group" aria-label="Playback speed">
      <button
        type="button"
        className={`top-bar__speed-btn${clock.paused ? ' is-active' : ''}`}
        onClick={onTogglePause}
        aria-pressed={clock.paused}
        aria-label="Pause"
      >
        <PauseIcon />
      </button>
      {CLOCK_SPEEDS.map((speed, index) => {
        const isActive = !clock.paused && clock.speedIndex === index;
        return (
          <button
            key={speed}
            type="button"
            className={`top-bar__speed-btn${isActive ? ' is-active' : ''}`}
            onClick={() => onSetSpeed(index)}
            aria-pressed={isActive}
            aria-label={`Speed: ${speed} game minutes per second`}
          >
            <SpeedIcon triangleCount={index + 1} />
          </button>
        );
      })}
    </div>
  );
}

export function TopBar({
  clock,
  cashUsd,
  onTogglePause,
  onSetSpeed,
  companyName = DEFAULT_COMPANY_NAME,
}: TopBarProps) {
  const calendarTime = toCalendarTime(clock.totalMinutes);
  const clockText = formatCalendarTime(calendarTime);
  const cashText = cashFormatter.format(cashUsd);

  return (
    <header className="top-bar" aria-label="Top bar">
      <div className="top-bar__brand">
        <span className="top-bar__brand-name">{companyName}</span>
      </div>

      <div className="top-bar__chips">
        <span className="top-bar__clock" aria-label={`Game time: ${clockText}`}>
          {clockText}
        </span>

        <SpeedControl clock={clock} onTogglePause={onTogglePause} onSetSpeed={onSetSpeed} />

        <Chip label="Cash" value={cashText} className="top-bar__chip--cash" />

        {/*
          Milestone 2+: Drivers, Riders/day, Satisfaction and Coverage chips (manual §5) slot in
          here as more `<Chip label=... value=... />` entries once staff, demand and the report
          card exist. Omitted for now rather than shown with an invented value.
        */}
      </div>
    </header>
  );
}
