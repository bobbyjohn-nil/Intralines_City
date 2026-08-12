import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateRiverton, RIVERTON_SEED } from './game/city/generateRiverton';
import { useGameClock } from './game/clock/useGameClock';
import { useClockKeys } from './game/clock/useClockKeys';
import { toCalendarTime } from './game/clock/calendar';
import { accrue, createTreasury, refund, spend } from './game/economy/ledger';
import { CENTS_PER_USD, type Treasury } from './game/economy/types';
import { addStop, canCreate, startDraft, summarizeDraft, undoLastStop } from './game/lines/draft';
import type { DraftState } from './game/lines/draft';
import { nextId, type Line, type LineId, type Stop, type StopId } from './game/lines/types';
import { buildRouteSchedule } from './game/buses/schedule';
import type { LngLat } from './game/types';
import { MapCanvas } from './render/MapCanvas';
import type { LineBusSchedule } from './render/drawOverlays';
import { TopBar } from './ui/TopBar';
import { Dock, type Tool } from './ui/Dock';
import { DraftBar } from './ui/DraftBar';
import { Notice } from './ui/Notice';
import { UpdateBanner } from './ui/UpdateBanner';
import { useServiceWorkerUpdate } from './pwa/useServiceWorkerUpdate';
import { BUS_MODELS, STARTING_BUS_MODEL, STOP_PLACEMENT_COST_USD } from './game/constants';
import './App.css';

const STARTING_MODEL = BUS_MODELS[STARTING_BUS_MODEL]!;

/** Buses put on a line the moment it is created. Milestone 1 has no fleet screen yet, so a new
 * line gets a token service rather than sitting inert. # tune — replaced by the Fleet panel. */
const BUSES_PER_NEW_LINE = 2;

/** Ids a fresh company mints from. Stands in for the persisted `nextIds.stop`/`nextIds.line`
 * (save-format.md §5) until saving exists — App owns the live counters below the same way a
 * loaded save eventually will, so nothing about the threading changes when persistence lands. */
const FIRST_STOP_ID = 0 as StopId;
const FIRST_LINE_ID = 0 as LineId;

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
  // Top-level stop collection (save-format.md §5) — lives here, alongside `lines`, rather than
  // nested inside each `Line`, so a stop shared by two lines is stored once. `nextStopId`/
  // `nextLineId` are the live counters a draft/line is minted from; see `FIRST_STOP_ID` above.
  const [stops, setStops] = useState<readonly Stop[]>([]);
  const [nextStopId, setNextStopId] = useState<StopId>(FIRST_STOP_ID);
  const [nextLineId, setNextLineId] = useState<LineId>(FIRST_LINE_ID);
  const [hoverLngLat, setHoverLngLat] = useState<LngLat | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  // Built fresh only when `stops` actually changes — read by schedule-building and the renderer,
  // never rebuilt inside either's per-frame path.
  const stopsById = useMemo<ReadonlyMap<StopId, Stop>>(() => new Map(stops.map((s) => [s.id, s] as const)), [stops]);

  // ── Updates ────────────────────────────────────────────────────────────────
  // In-play path only (manual §2): a player-initiated Reload, never capped, never automatic. The
  // menu's own path — "on the menu it updates itself automatically" — would call
  // `applyUpdate({ auto: true })` from wherever the menu mounts, but there is no home menu yet
  // (see App.tsx's return below for where that path attaches once one exists).
  const { updateAvailable, applyUpdate } = useServiceWorkerUpdate();
  const handleReloadForUpdate = useCallback(() => {
    void applyUpdate();
  }, [applyUpdate]);

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
        schedule: buildRouteSchedule(line, stopsById, city.graph, STARTING_MODEL.cruiseSpeedKmh),
        busCount: BUSES_PER_NEW_LINE,
      })),
    [lines, stopsById, city.graph]
  );

  // ── Line drawing ───────────────────────────────────────────────────────────

  const beginDraft = useCallback(
    (next: Tool) => {
      setTool(next);
      setDraft(next === 'draw-line' ? startDraft(city.graph, nextStopId) : null);
    },
    [city.graph, nextStopId]
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
    setTreasury((current) => current && refund(current, STOP_PLACEMENT_COST_USD, 'stop undo').treasury);
    setDraft(undoLastStop(draft));
  }, [draft]);

  const handleCancel = useCallback(() => {
    if (draft !== null) {
      setTreasury((current) => refund(current, STOP_PLACEMENT_COST_USD * draft.stops.length, 'draft cancelled').treasury);
    }
    setDraft(null);
    setTool('select');
  }, [draft]);

  const handleCreate = useCallback(() => {
    if (draft === null || !canCreate(draft)) return;
    const summary = summarizeDraft(draft);
    const lineId = nextLineId;
    setLines((current) => [
      ...current,
      {
        id: lineId,
        name: `Line ${current.length + 1}`,
        stopIds: summary.stops.map((stop) => stop.id),
        legs: summary.legs,
        totalLengthM: summary.totalLengthM,
      },
    ]);
    // Commit the draft's stops (and the id ground it staked out) to the shared collection —
    // until now they only existed inside this one draft. See lines/draft.ts's `DraftState`
    // comment for why undo/cancel never reach this point.
    setStops((current) => [...current, ...summary.stops]);
    setNextStopId(draft.nextStopId);
    setNextLineId(nextId(lineId));
    setDraft(null);
    setTool('select');
  }, [draft, nextLineId]);

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
          stops={stopsById}
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
      {/* In-play update banner (manual §2). The whole app is "in play" until a home menu exists —
          once one does, its mount point should call applyUpdate({ auto: true }) itself instead of
          rendering this banner, per the comment above. */}
      <UpdateBanner
        updateAvailable={updateAvailable}
        onReload={handleReloadForUpdate}
        onDismiss={() => {}}
      />
      <Dock tool={tool} onSelectTool={beginDraft} />
    </div>
  );
}

export default App;
