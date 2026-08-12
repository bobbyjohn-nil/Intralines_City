import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateRiverton, RIVERTON_SEED } from './game/city/generateRiverton';
import { useGameClock } from './game/clock/useGameClock';
import { useClockKeys } from './game/clock/useClockKeys';
import { toCalendarTime } from './game/clock/calendar';
import { accrue, createTreasury, refund, spend } from './game/economy/ledger';
import { CENTS_PER_USD, type Treasury } from './game/economy/types';
import { addStop, canCreate, routeLeg, startDraft, summarizeDraft, undoLastStop } from './game/lines/draft';
import type { DraftState } from './game/lines/draft';
import { createPathfindContext, type PathfindContext } from './game/lines/pathfind';
import { snapToRoad } from './game/lines/snapToRoad';
import { nextId, type Line, type LineId, type RouteLeg, type Stop, type StopId } from './game/lines/types';
import { buildRouteSchedule } from './game/buses/schedule';
import type { City, LngLat, StreetGraph } from './game/types';
import { createDemandBuffers, computeCityStatics, computeDemand } from './game/demand/demand';
import { RIVERTON_CAR_SPEED_KMH } from './game/demand/constants';
import {
  createLocalStorageAdapter,
  createSaveEnvelope,
  loadSave,
  writeSave,
  type BusId,
  type DepotId,
  type LoadResult,
  type SaveCompany,
  type SaveData,
  type SavedLine,
  type SavedStop,
  type SaveEnvelope,
  type SaveStorage,
} from './game/save';
import { MapCanvas } from './render/MapCanvas';
import type { LineBusSchedule } from './render/drawOverlays';
import { TopBar } from './ui/TopBar';
import { Dock, type Tool } from './ui/Dock';
import { DraftBar } from './ui/DraftBar';
import { Notice } from './ui/Notice';
import { UpdateBanner } from './ui/UpdateBanner';
import { useServiceWorkerUpdate } from './pwa/useServiceWorkerUpdate';
import {
  BUS_MODELS,
  DEFAULT_FARE_USD,
  MIN_STOPS_TO_CREATE_LINE,
  STARTING_BUS_MODEL,
  STOP_PLACEMENT_COST_USD,
} from './game/constants';
import './App.css';

const STARTING_MODEL = BUS_MODELS[STARTING_BUS_MODEL]!;

/** Buses put on a line the moment it is created. Milestone 1 has no fleet screen yet, so a new
 * line gets a token service rather than sitting inert. # tune — replaced by the Fleet panel. */
const BUSES_PER_NEW_LINE = 2;

/** Ids a fresh company mints from. Stands in for the persisted `nextIds.stop`/`nextIds.line`
 * (save-format.md §5) for a company that has no save to load — see the boot-load block below for
 * where a loaded company's live counters come from instead. */
const FIRST_STOP_ID = 0 as StopId;
const FIRST_LINE_ID = 0 as LineId;
const FIRST_BUS_ID = 0 as BusId;
const FIRST_DEPOT_ID = 0 as DepotId;

// ── Demand (studio/docs/design/demand-model.md) ─────────────────────────────────────────────

/** Upper bound the session's network is allowed to grow into without a `DemandBuffers`
 * reallocation (`game/demand/demand.ts`'s `createDemandBuffers` doc comment: "generous headroom").
 * Generous relative to what one Riverton session draws today. # tune */
const DEMAND_STOP_CAPACITY = 200;
const DEMAND_LINE_CAPACITY = 40;

/** Stage B's network recompute waits this long after the last line/stop edit before running —
 * never on every edit, never on a clock tick (demand-model.md §1: "~250 ms debounced"). SPEC */
const DEMAND_RECOMPUTE_DEBOUNCE_MS = 250;

// ── Saving (studio/docs/design/save-format.md) ──────────────────────────────────────────────

/** Debounce after the last cash/clock change, and the longest a dirty session is ever left
 * unwritten — save-format.md §6: "Debounce 3 s after the last meaningful action, floor 10 s
 * between writes." SPEC */
const AUTOSAVE_DEBOUNCE_MS = 3000;
const AUTOSAVE_FLOOR_MS = 10000;

/** Display-only (save-format.md §1: "never branched on") — no release pipeline sets this yet. # tune */
const GAME_VERSION = '0.1.0-dev';

/** GAME.md palette `--blue`. `SaveCompany.brandColor` has no picker UI yet, so every fresh
 * company starts on the same placeholder — matches `game/save/read.ts`'s own default so a hand
 * edited or pre-UI save reads the same color either way. # tune */
const DEFAULT_BRAND_COLOR = '#1d3f7a';
/** `lines/types.ts`'s `Line` carries no `color` field yet, so every saved line gets the same
 * placeholder until that lands. # tune */
const DEFAULT_SAVED_LINE_COLOR = '#1d3f7a';
/** No timetable system exists yet to persist a real headway; matches `game/save/read.ts`'s own
 * default so nothing changes the moment a save round-trips. # tune */
const DEFAULT_SAVED_HEADWAY_MINUTES = 10;

/** Everything `rebuildDerived` produces from a loaded save (save-format.md §1 step 8): re-anchored
 * stops, re-routed lines, and the names of anything that came back damaged, for one summary
 * notice rather than a crash. */
interface RebuiltFromSave {
  readonly stops: readonly Stop[];
  readonly lines: readonly Line[];
  readonly orphanedStopNames: readonly string[];
  readonly droppedLineNames: readonly string[];
}

/**
 * Re-anchors one saved stop against the *current* road graph (save-format.md §5.2). This is the
 * simple nearest-eligible-edge snap only — reusing line-drawing's own `snapToRoad` predicate, per
 * GAME.md's "one shared predicate per rule" — not the full tier pass (Exact/Near/Ambiguous,
 * class-penalty cost, `movedM` logging threshold). Upgrade to that pass here when it lands; until
 * then a stop with nothing eligible nearby is marked `orphaned` rather than dropped (§5.3: "never
 * delete").
 */
function reanchorStop(saved: SavedStop, graph: StreetGraph): Stop {
  const snap = snapToRoad(saved.position, graph);
  if (snap === null) {
    return {
      id: saved.id,
      name: saved.name,
      position: saved.position,
      roadClass: saved.roadClass,
      edgeId: -1,
      edgeT: 0,
      orphaned: true,
      movedM: null,
    };
  }
  return {
    id: saved.id,
    name: saved.name,
    position: snap.position,
    roadClass: snap.roadClass,
    edgeId: snap.edgeId,
    edgeT: snap.t,
    orphaned: false,
    movedM: snap.distanceM,
  };
}

/** Rebuilds one saved line's `legs`/`totalLengthM` against the current graph, dropping any
 * orphaned stop from its route (save-format.md §5.3: "the line keeps running past the orphan").
 * Returns `null` — never throws — if too few routable stops survive, or a leg can't be routed at
 * all; the caller drops the line and reports it rather than crashing the load. */
function rebuildLine(saved: SavedLine, stopsById: ReadonlyMap<StopId, Stop>, graph: StreetGraph, ctx: PathfindContext): Line | null {
  const routable = saved.stopIds
    .map((id) => stopsById.get(id))
    .filter((stop): stop is Stop => stop !== undefined && !stop.orphaned);
  if (routable.length < MIN_STOPS_TO_CREATE_LINE) return null;

  const legs: RouteLeg[] = [];
  let totalLengthM = 0;
  for (let i = 1; i < routable.length; i++) {
    const leg = routeLeg(graph, ctx, routable[i - 1]!, routable[i]!);
    if (leg === null) return null;
    legs.push(leg);
    totalLengthM += leg.lengthM;
  }

  return { id: saved.id, name: saved.name, stopIds: routable.map((s) => s.id), legs, totalLengthM };
}

/** `LoadSaveInput.rebuildDerived` (save-format.md §1 step 8): re-anchor every stop, re-route every
 * line, and never throw for a damaged-but-recoverable network — an orphan or a dropped line is
 * reported, not a load failure (§5.3). */
function makeRebuildDerived(city: City): (data: SaveData, envelope: SaveEnvelope) => RebuiltFromSave {
  return (data) => {
    const stops = data.stops.map((s) => reanchorStop(s, city.graph));
    const stopsById = new Map(stops.map((s) => [s.id, s] as const));
    const orphanedStopNames = stops.filter((s) => s.orphaned).map((s) => s.name);

    const ctx = createPathfindContext(city.graph);
    const lines: Line[] = [];
    const droppedLineNames: string[] = [];
    for (const savedLine of data.lines) {
      const rebuilt = rebuildLine(savedLine, stopsById, city.graph, ctx);
      if (rebuilt === null) {
        console.error(`load: line "${savedLine.name}" could not be re-routed on the current graph and was dropped`);
        droppedLineNames.push(savedLine.name);
        continue;
      }
      lines.push(rebuilt);
    }

    return { stops, lines, orphanedStopNames, droppedLineNames };
  };
}

/** Module-scoped so React 18 StrictMode's deliberate double-invoke of a lazy `useState`
 * initializer (dev only) can't run `loadSave` — which has real side effects (backing up an
 * unreadable file, clearing the live key) — twice. A real page reload always gets a fresh module,
 * so this never survives past the session it was computed for. */
let cachedBootLoad: LoadResult<RebuiltFromSave> | undefined;
function loadBootSave(city: City, storage: SaveStorage): LoadResult<RebuiltFromSave> {
  if (cachedBootLoad === undefined) {
    cachedBootLoad = loadSave<RebuiltFromSave>({
      storage,
      cityId: city.id,
      // Riverton is the only playable city this slice — every save this build can ever write is
      // its own, so this is trivially true rather than a real catalogue lookup.
      isKnownCityId: (id) => id === city.id,
      rebuildDerived: makeRebuildDerived(city),
    });
  }
  return cachedBootLoad;
}

function toSavedStop(stop: Stop): SavedStop {
  return {
    id: stop.id,
    name: stop.name,
    position: stop.position,
    roadClass: stop.roadClass,
    // No orphan-acknowledgement UI exists yet (§5.3's dialog) — nothing ever sets this true.
    orphanAcknowledged: false,
  };
}

function toSavedLine(line: Line): SavedLine {
  return {
    id: line.id,
    name: line.name,
    color: DEFAULT_SAVED_LINE_COLOR,
    stopIds: line.stopIds,
    fareCents: Math.round(DEFAULT_FARE_USD * CENTS_PER_USD),
    timetable: { mode: 'headway', headwayMinutes: DEFAULT_SAVED_HEADWAY_MINUTES },
    assignedBusIds: [],
  };
}

/** One session's worth of state a save needs, refreshed every render (cheap — a handful of
 * primitives and the array references React state already owns) and read only from inside the
 * debounced/floored autosave timers below, never from a per-frame path. */
interface AutosaveSnapshot {
  readonly treasury: Treasury;
  readonly effectiveTotalMinutes: number;
  readonly speedIndex: number;
  readonly lines: readonly Line[];
  readonly stops: readonly Stop[];
  readonly nextStopId: StopId;
  readonly nextLineId: LineId;
  readonly companyName: string;
}

function buildSaveData(snapshot: AutosaveSnapshot, company: SaveCompany, citySeed: number): SaveData {
  return {
    clock: { totalMinutes: snapshot.effectiveTotalMinutes, speedIndex: snapshot.speedIndex },
    company,
    // Riverton has no baked pack — its "identity" is just the seed it regenerates from.
    city: { seed: citySeed, packFormat: 0, packBuild: '', packHash: '' },
    stops: snapshot.stops.map(toSavedStop),
    lines: snapshot.lines.map(toSavedLine),
    depots: [],
    buses: [],
    treasury: snapshot.treasury,
    nextIds: { stop: snapshot.nextStopId, line: snapshot.nextLineId, bus: FIRST_BUS_ID, depot: FIRST_DEPOT_ID },
  };
}

export function App() {
  // Generated once from a fixed seed and never regenerated — it is large, immutable, and every
  // downstream cache (render buckets, pathfind buffers) is keyed on this object's identity.
  const city = useMemo(() => generateRiverton(RIVERTON_SEED), []);

  // One adapter for the process's lifetime — `createLocalStorageAdapter` just wraps `window
  // .localStorage`, so a fresh one every render would be wasted allocation for no benefit.
  const storage = useMemo(() => createLocalStorageAdapter(), []);

  // Runs the full save-format.md §1 sequence exactly once, synchronously, before first paint —
  // see `loadBootSave`'s module-level cache for why. Every other piece of loaded state below
  // (treasury, lines, stops, ids, clock) reads from this same result.
  const [bootLoad] = useState(() => loadBootSave(city, storage));
  const bootData = bootLoad.outcome === 'ok' ? bootLoad.envelope.data : null;

  // "NEWER" refusal (save-format.md §2): autosave is blocked for the rest of this session — never
  // persisted, never overridable, clears only on reload. A storage-quota failure at write time
  // (below) sets the same flag for the same reason.
  const autosaveBlockedRef = useRef(bootLoad.outcome === 'newer');

  const { clock, togglePause, setSpeedIndex } = useGameClock();

  // `useGameClock` owns its own `totalMinutes`, always starting at 0 — there is no setter for an
  // arbitrary starting value, and that hook is outside this file's ownership. A loaded save's
  // elapsed minutes are carried as a constant offset instead: every reader of "the clock" below
  // uses `effectiveTotalMinutes`, so a resumed company picks up exactly where it left off without
  // this file reaching into `game/clock/`.
  const clockOffsetMinutesRef = useRef(bootData?.clock.totalMinutes ?? 0);
  const effectiveTotalMinutes = clock.totalMinutes + clockOffsetMinutesRef.current;

  // Restores the loaded speed index once, on mount — `setSpeedIndex` is the one piece of clock
  // state this file *can* reach through its existing public API.
  const didRestoreSpeedRef = useRef(false);
  useEffect(() => {
    if (didRestoreSpeedRef.current) return;
    didRestoreSpeedRef.current = true;
    if (bootData !== null) setSpeedIndex(bootData.clock.speedIndex);
    // bootData/setSpeedIndex are both stable for this component's lifetime; this is a run-once effect.
  }, [bootData, setSpeedIndex]);

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
  const calendar = toCalendarTime(effectiveTotalMinutes);

  const [treasury, setTreasury] = useState<Treasury>(() => bootData?.treasury ?? createTreasury());
  const [tool, setTool] = useState<Tool>('select');
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [lines, setLines] = useState<readonly Line[]>(() => bootLoad.outcome === 'ok' ? bootLoad.derived.lines : []);
  // Top-level stop collection (save-format.md §5) — lives here, alongside `lines`, rather than
  // nested inside each `Line`, so a stop shared by two lines is stored once. `nextStopId`/
  // `nextLineId` are the live counters a draft/line is minted from; see `FIRST_STOP_ID` above.
  const [stops, setStops] = useState<readonly Stop[]>(() => bootLoad.outcome === 'ok' ? bootLoad.derived.stops : []);
  const [nextStopId, setNextStopId] = useState<StopId>(() => bootData?.nextIds.stop ?? FIRST_STOP_ID);
  const [nextLineId, setNextLineId] = useState<LineId>(() => bootData?.nextIds.line ?? FIRST_LINE_ID);
  const [hoverLngLat, setHoverLngLat] = useState<LngLat | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  // Company identity a founding flow would normally collect; nothing here changes it once loaded
  // (or minted fresh) — a ref rather than state since it never drives a re-render.
  const companyRef = useRef<SaveCompany>(
    bootData?.company ?? { brandColor: DEFAULT_BRAND_COLOR, foundedAtMs: Date.now(), howToPlaySeen: false }
  );
  const companyNameRef = useRef<string>(
    bootLoad.outcome === 'ok' && bootLoad.envelope.companyName.length > 0 ? bootLoad.envelope.companyName : city.name
  );
  const sandboxRef = useRef<boolean>(bootLoad.outcome === 'ok' ? bootLoad.envelope.sandbox : false);

  // Boot refusal/repair notices (save-format.md §2, §5.3) — one summary toast through the existing
  // `Notice` component; runs once, since `bootLoad`/`city` never change after mount.
  useEffect(() => {
    if (bootLoad.outcome === 'newer') {
      setNotice(
        `This company was saved by a newer version of Intralines. Reload to update — your save is safe and untouched.`
      );
    } else if (bootLoad.outcome === 'unreadable') {
      setNotice('That save could not be read. A backup was kept.');
    } else if (bootLoad.outcome === 'wrong_city') {
      setNotice(`This save belongs to "${bootLoad.fileCityId}", not ${city.name} — it was left untouched.`);
    } else if (bootLoad.outcome === 'ok') {
      const { orphanedStopNames, droppedLineNames } = bootLoad.derived;
      const parts: string[] = [];
      if (orphanedStopNames.length > 0) {
        parts.push(`${orphanedStopNames.length} stop(s) could not be placed on the road network: ${orphanedStopNames.join(', ')}`);
      }
      if (droppedLineNames.length > 0) {
        parts.push(`${droppedLineNames.length} line(s) could not be re-routed and were dropped: ${droppedLineNames.join(', ')}`);
      }
      if (parts.length > 0) setNotice(parts.join('. '));
    }
  }, [bootLoad, city.name]);

  // Built fresh only when `stops` actually changes — read by schedule-building and the renderer,
  // never rebuilt inside either's per-frame path.
  const stopsById = useMemo<ReadonlyMap<StopId, Stop>>(() => new Map(stops.map((s) => [s.id, s] as const)), [stops]);

  // ── Demand (studio/docs/design/demand-model.md) ─────────────────────────────
  // Stage A — city statics plus the O(Z²) gravity table — depends on nothing the player can
  // change, so it is computed exactly once per city, memoised on `city`'s own identity. It must
  // never rerun inside the debounce below; that's what keeps the 250 ms budget honest.
  const demand = useMemo(() => {
    const buffers = createDemandBuffers(city.zones.length, DEMAND_STOP_CAPACITY, DEMAND_LINE_CAPACITY);
    const statics = computeCityStatics(buffers, city, RIVERTON_CAR_SPEED_KMH);
    return { buffers, statics };
  }, [city]);

  // `undefined` until Stage B's first recompute lands — distinct from `0`, which means "computed,
  // and this network truly carries no riders" (a city with no lines yet). TopBar's `ridersPerDay`
  // prop makes the same distinction: omit the chip for `undefined`, show "0" for a real zero.
  const [ridersPerDay, setRidersPerDay] = useState<number | undefined>(undefined);

  // Stage B — everything that reads `lines`/`stops` — reruns ~250 ms after the last network edit,
  // never on every render and never on a clock tick (`lines`/`stops` only change via a draft
  // commit, never per frame).
  useEffect(() => {
    if (lines.length === 0) {
      // No lines drawn yet: there is nothing to count, and that's a different state from "hasn't
      // computed yet" or "computed to zero" — Stage B never runs, so `computeDemand` never gets a
      // chance to turn "no answer" into a misleadingly real-looking 0. Also covers the player
      // deleting every line after having some: back to no figure at all, not a stale one.
      setRidersPerDay(undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      if (stops.length > demand.buffers.stopCapacity || lines.length > demand.buffers.lineCapacity) {
        // The session's network outgrew the buffers Riverton started with — `computeDemand`'s
        // documented fix is a fresh, bigger `DemandBuffers`, not a resize this module performs.
        // Fails loud in the console, soft for the player: demand just stops updating.
        console.error(
          `demand: network (${stops.length} stops, ${lines.length} lines) exceeds DemandBuffers capacity ` +
            `(${demand.buffers.stopCapacity} stops, ${demand.buffers.lineCapacity} lines) — recompute skipped`
        );
        return;
      }
      const result = computeDemand(demand.buffers, demand.statics, lines, stops);
      setRidersPerDay(Math.round(result.totalBoardingsPerDay));
    }, DEMAND_RECOMPUTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [demand, lines, stops]);
  // `ridersPerDay` (demand-model.md §6 build order 1: "Riders/day in the top bar") is passed
  // straight through to `TopBar`'s own optional prop below — see the `<TopBar>` element in the
  // return for why it's left undefined rather than 0 before the first recompute lands.

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
  // render can never re-bill a stretch of time that was already banked. Starts at whatever a
  // loaded save's clock resumed from, so nothing is billed twice across a reload.
  const lastAccruedMinutes = useRef(effectiveTotalMinutes);

  const busesInService = lines.length * BUSES_PER_NEW_LINE;

  useEffect(() => {
    const deltaMinutes = effectiveTotalMinutes - lastAccruedMinutes.current;
    if (deltaMinutes <= 0) return;
    const minuteOfDayAtStart = toCalendarTime(lastAccruedMinutes.current).minuteOfDay;
    lastAccruedMinutes.current = effectiveTotalMinutes;

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
  }, [effectiveTotalMinutes, busesInService]);

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

  // ── Saving (studio/docs/design/save-format.md) ──────────────────────────────
  // Kept current every render (cheap — see AutosaveSnapshot's comment) and read only from inside
  // the timers below, never a per-frame path itself.
  const latestSnapshotRef = useRef<AutosaveSnapshot>({
    treasury,
    effectiveTotalMinutes,
    speedIndex: clock.speedIndex,
    lines,
    stops,
    nextStopId,
    nextLineId,
    companyName: companyNameRef.current,
  });
  latestSnapshotRef.current = {
    treasury,
    effectiveTotalMinutes,
    speedIndex: clock.speedIndex,
    lines,
    stops,
    nextStopId,
    nextLineId,
    companyName: companyNameRef.current,
  };

  const debounceTimerRef = useRef<number | undefined>(undefined);
  const floorTimerRef = useRef<number | undefined>(undefined);

  const performAutosave = useCallback(() => {
    if (debounceTimerRef.current !== undefined) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = undefined;
    }
    if (floorTimerRef.current !== undefined) {
      window.clearTimeout(floorTimerRef.current);
      floorTimerRef.current = undefined;
    }
    if (autosaveBlockedRef.current) return;

    const envelope = createSaveEnvelope({
      gameVersion: GAME_VERSION,
      cityId: city.id,
      companyName: latestSnapshotRef.current.companyName,
      sandbox: sandboxRef.current,
      savedAtMs: Date.now(),
      data: buildSaveData(latestSnapshotRef.current, companyRef.current, city.seed),
    });
    try {
      writeSave(storage, envelope);
    } catch {
      // Quota or similar (save-format.md §2/§6's second autosave-blocking cause) — block for the
      // rest of the session, same refusal as a NEWER load, and say so once.
      autosaveBlockedRef.current = true;
      setNotice('Storage is full — your company could not be saved.');
    }
  }, [city.id, city.seed, storage]);

  // Debounce 3 s after the last change; force a write every 10 s regardless if changes keep
  // coming (save-format.md §6) — so continuous unpaused play still saves periodically instead of
  // never, while a single click never fires an immediate write.
  const scheduleAutosave = useCallback(() => {
    if (autosaveBlockedRef.current) return;
    if (debounceTimerRef.current !== undefined) window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = window.setTimeout(performAutosave, AUTOSAVE_DEBOUNCE_MS);
    if (floorTimerRef.current === undefined) {
      floorTimerRef.current = window.setTimeout(performAutosave, AUTOSAVE_FLOOR_MS);
    }
  }, [performAutosave]);

  useEffect(() => {
    scheduleAutosave();
  }, [treasury, effectiveTotalMinutes, scheduleAutosave]);

  // Creating a line is a meaningful action (manual §19) — save right away rather than waiting out
  // the debounce. Guarded so the very first render (which may already hold a loaded network)
  // doesn't immediately rewrite the save it just read.
  const skipNextLinesAutosaveRef = useRef(true);
  useEffect(() => {
    if (skipNextLinesAutosaveRef.current) {
      skipNextLinesAutosaveRef.current = false;
      return;
    }
    performAutosave();
  }, [lines, performAutosave]);

  // Best-effort immediate write on the way out — the debounce/floor above cover continuous play,
  // this covers the tab closing before either fires.
  useEffect(() => {
    const handlePageHide = () => performAutosave();
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [performAutosave]);

  useEffect(
    () => () => {
      if (debounceTimerRef.current !== undefined) window.clearTimeout(debounceTimerRef.current);
      if (floorTimerRef.current !== undefined) window.clearTimeout(floorTimerRef.current);
    },
    []
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
        companyName={companyNameRef.current}
        {...(ridersPerDay !== undefined ? { ridersPerDay } : {})}
      />
      <main className="app-map">
        <MapCanvas
          city={city}
          minuteOfDay={calendar.minuteOfDay}
          totalMinutes={effectiveTotalMinutes}
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
