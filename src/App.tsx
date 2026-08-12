import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateRiverton, RIVERTON_SEED } from './game/city/generateRiverton';
import { useGameClock } from './game/clock/useGameClock';
import { useClockKeys } from './game/clock/useClockKeys';
import { toCalendarTime } from './game/clock/calendar';
import { accrue, createTreasury, spend } from './game/economy/ledger';
import { CENTS_PER_USD, type Treasury } from './game/economy/types';
import { addStop, canCreate, startDraft, summarizeDraft, undoLastStop } from './game/lines/draft';
import type { DraftState } from './game/lines/draft';
import type { Line } from './game/lines/types';
import { buildRouteSchedule } from './game/buses/schedule';
import type { LngLat } from './game/types';
import { MapCanvas } from './render/MapCanvas';
import type { LineBusSchedule } from './render/drawOverlays';
import { TopBar } from './ui/TopBar';
import { Dock, type Tool } from './ui/Dock';
import { DraftBar } from './ui/DraftBar';
import { Notice } from './ui/Notice';
import { BUS_MODELS, STARTING_BUS_MODEL, STOP_PLACEMENT_COST_USD } from './game/constants';
import './App.css';

const STARTING_MODEL = BUS_MODELS[STARTING_BUS_MODEL]!;

/** Buses put on a line the moment it is created. Milestone 1 has no fleet screen yet, so a new
 * line gets a token service rather than sitting inert. # tune — replaced by the Fleet panel. */
const BUSES_PER_NEW_LINE = 2;

export function App() {
  // Generated once from a fixed seed and never regenerated — it is large, immutable, and every
  // downstream cache (render buckets, pathfind buffers) is keyed on this object's identity.
  const city = useMemo(() => generateRiverton(RIVERTON_SEED), []);

  const { clock, togglePause, setSpeedIndex } = useGameClock();

  // Picking a speed means "run at this speed" — while paused, the raw setter changed the rate but
  // left the clock stopped, so ▶ looked broken. Resuming is part of choosing a speed.
  const selectSpeed = useCallback(
    (index: number) => {
      setSpeedIndex(index);
      if (clock.paused) togglePause();
    },
    [clock.paused, setSpeedIndex, togglePause]
  );

  useClockKeys(togglePause, selectSpeed);
  const calendar = toCalendarTime(clock.totalMinutes);

  const [treasury, setTreasury] = useState<Treasury>(() => createTreasury());
  const [tool, setTool] = useState<Tool>('select');
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [hoverLngLat, setHoverLngLat] = useState<LngLat | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  // ── Money ──────────────────────────────────────────────────────────────────
  // A ref, not state: it must track the exact clock position each accrual consumed, so a stale
  // render can never re-bill a stretch of time that was already banked.
  const lastAccruedMinutes = useRef(clock.totalMinutes);

  const busesInService = lines.length * BUSES_PER_NEW_LINE;

  useEffect(() => {
    const deltaMinutes = clock.totalMinutes - lastAccruedMinutes.current;
    if (deltaMinutes <= 0) return;
    const minuteOfDayAtStart = toCalendarTime(lastAccruedMinutes.current).minuteOfDay;
    lastAccruedMinutes.current = clock.totalMinutes;

    setTreasury(
      (current) =>
        accrue(current, deltaMinutes, {
          minuteOfDayAtStart,
          // TODO(milestone 2): real distance driven, from the fleet's actual positions.
          kmDriven: 0,
          busesInService,
          busModel: STARTING_MODEL,
        }).treasury
    );
  }, [clock.totalMinutes, busesInService]);

  // ── Schedules ──────────────────────────────────────────────────────────────
  // Built once per line, never per frame — see buildRouteSchedule's contract.
  const schedules = useMemo<readonly LineBusSchedule[]>(
    () =>
      lines.map((line) => ({
        lineId: line.id,
        schedule: buildRouteSchedule(line, city.graph, STARTING_MODEL.cruiseSpeedKmh),
        busCount: BUSES_PER_NEW_LINE,
      })),
    [lines, city.graph]
  );

  // ── Line drawing ───────────────────────────────────────────────────────────

  const beginDraft = useCallback(
    (next: Tool) => {
      setTool(next);
      setDraft(next === 'draw-line' ? startDraft(city.graph) : null);
    },
    [city.graph]
  );

  const handleMapClick = useCallback(
    (lngLat: LngLat) => {
      if (tool !== 'draw-line' || draft === null) return;

      // Charge for the stop before placing it. A refused payment must not place the stop, and a
      // refused placement must not charge — so the two decisions are made together, here.
      const payment = spend(treasury, STOP_PLACEMENT_COST_USD, 'stop placement');
      if (!payment.ok) {
        setNotice(payment.reason);
        return;
      }
      const result = addStop(draft, lngLat);
      if (!result.ok) {
        setNotice(result.reason);
        return;
      }
      setTreasury(payment.treasury);
      setDraft(result.state);
    },
    [tool, draft, treasury]
  );

  const handleUndo = useCallback(() => {
    if (draft === null || draft.stops.length === 0) return;
    // Refund what the removed stop cost. Tracked against what was invested, per manual §9.
    setTreasury((current) => current && refund(current, STOP_PLACEMENT_COST_USD));
    setDraft(undoLastStop(draft));
  }, [draft]);

  const handleCancel = useCallback(() => {
    if (draft !== null) {
      setTreasury((current) => refund(current, STOP_PLACEMENT_COST_USD * draft.stops.length));
    }
    setDraft(null);
    setTool('select');
  }, [draft]);

  const handleCreate = useCallback(() => {
    if (draft === null || !canCreate(draft)) return;
    const summary = summarizeDraft(draft);
    setLines((current) => [
      ...current,
      {
        id: current.length,
        name: `Line ${current.length + 1}`,
        stops: summary.stops,
        legs: summary.legs,
        totalLengthM: summary.totalLengthM,
      },
    ]);
    setDraft(null);
    setTool('select');
  }, [draft]);

  // Esc unwinds one level at a time, in the manual's stated order: cancel the draft first, then
  // drop the tool. Panels and selection join this chain as they arrive.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (draft !== null) {
        handleCancel();
        return;
      }
      if (tool !== 'select') setTool('select');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [draft, tool, handleCancel]);

  const draftSummary = draft === null ? null : summarizeDraft(draft);

  return (
    <div className="app">
      <TopBar
        clock={clock}
        cashUsd={treasury.cashCents / CENTS_PER_USD}
        onTogglePause={togglePause}
        onSetSpeed={selectSpeed}
        companyName={city.name}
      />
      <main className="app-map">
        <MapCanvas
          city={city}
          minuteOfDay={calendar.minuteOfDay}
          totalMinutes={clock.totalMinutes}
          lines={lines}
          schedules={schedules}
          {...(draftSummary !== null ? { draft: draftSummary } : {})}
          {...(hoverLngLat !== undefined ? { hoverLngLat } : {})}
          onMapClick={handleMapClick}
          onHover={(lngLat) => setHoverLngLat(lngLat ?? undefined)}
        />
      </main>
      {draftSummary !== null && (
        <DraftBar
          draft={draftSummary}
          canCreate={draft !== null && canCreate(draft)}
          onUndo={handleUndo}
          onCancel={handleCancel}
          onCreate={handleCreate}
        />
      )}
      <Notice message={notice} onDismiss={() => setNotice(null)} />
      <Dock tool={tool} onSelectTool={beginDraft} />
    </div>
  );
}

/** Returning money to the treasury. `spend` guards overdraft; a refund has nothing to refuse. */
function refund(treasury: Treasury, amountUsd: number): Treasury {
  return { ...treasury, cashCents: treasury.cashCents + Math.round(amountUsd * CENTS_PER_USD) };
}

export default App;
