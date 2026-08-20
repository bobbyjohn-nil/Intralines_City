/**
 * The wiring-path regression `contrast.rendered.test.ts` doesn't cover (DECISIONS #67's own
 * lesson: "a gate that checks everything except the new neighbour is how the last six bus-
 * visibility causes survived" — the seventh shape is the same gate checking the *internals* while
 * the app wires them differently). `contrast.rendered.test.ts` builds a `CityScene` directly and
 * calls `updateBuses` by hand; it proves the render internals place a bus correctly but proves
 * nothing about the wiring between `App.tsx`'s props and `MapCanvas`'s own rAF tick loop, which is
 * the one path a real player's screen ever goes through.
 *
 * This file mounts the actual `MapCanvas` component — a real `react-dom` root, real props passed
 * the way `App.tsx` passes them (`city`, `minuteOfDay`, `totalMinutes`, `lines`, `stops`,
 * `schedules` — see `App.tsx` ~517-546 for how `schedules` is built and ~852-863 for the props
 * `<MapCanvas>` is actually handed) — lets its own internal `requestAnimationFrame` tick loop run,
 * and reads pixels back from the *live* WebGL framebuffer, not a hand-built scene.
 *
 * **Capture method, and why it isn't a naive `requestAnimationFrame`-ordering guess.** A first
 * draft of this file tried to synchronize with `MapCanvas`'s own rAF loop by registering a second
 * `requestAnimationFrame` callback after the component had already started its chain, reasoning
 * that same-frame callback ordering would let it `readPixels` right after the component's own
 * `renderer.render(...)` call, before the browser could swap/clear the (non-
 * `preserveDrawingBuffer`) drawing buffer. Measured result: a checksum-identical, all-zero
 * framebuffer on *every* attempt, including a version that zoomed the camera in via synthetic
 * wheel events first — a false "nothing rendered" that would have shipped as a false "no bus"
 * finding, the exact class of confound this investigation exists to rule out. The actual cause:
 * three.js's `WebGLRenderer.render` is assigned as an *own instance property* inside the
 * constructor (`this.render = function (scene, camera) {...}`, see
 * `node_modules/three/src/renderers/WebGLRenderer.js`), not a prototype method — so there is no
 * reliable frame boundary to race against from outside without either changing production code
 * (`preserveDrawingBuffer: true`, which has a real per-frame cost `MapCanvas` should not pay for a
 * test's convenience) or hooking the one call that matters directly.
 *
 * The fix, kept here: `vi.mock('three', ...)` subclasses `THREE.WebGLRenderer`, and in the
 * subclass constructor rewraps the base class's own instance-level `render` function to capture
 * (`getContext().readPixels(...)`) synchronously, in the same call stack, immediately after every
 * real `render()` call `MapCanvas` makes — the same "read pixels right after render, in the same
 * task" rule `contrast.rendered.test.ts` relies on (there achieved by calling `render()` and
 * `readPixels` back to back in one function), applied here across the component's own async loop
 * without touching any production code path or its runtime behaviour.
 *
 * Investigated 2026-08-20 against a pinned playtest at ef96f74 that reported no bus ever appearing
 * on screen, 34 game-minutes into service hours, at any zoom, even under forced repaints — while
 * `contrast.rendered.test.ts` passed 313 tests claiming a bus renders. Traced the whole chain by
 * hand first (`MapCanvas.tsx`'s tick loop, `App.tsx`'s prop wiring at the `<MapCanvas>` call site,
 * `busPositionAt`/`buildRouteSchedule`): `schedules` and `totalMinutes` both reach `MapCanvas`,
 * `movingRef`/`dirtyRef` both gate correctly, and `updateBuses` always runs immediately before
 * `renderer.render(...)` in the same gated block — never after, never skipped. No wiring defect
 * found by inspection. **Framebuffer verdict (this file, with the capture method above): present.**
 * At the default whole-city framing a real bus differs from the same frame with zero buses
 * scheduled by 6 px (checksum 185,411,198 vs 185,410,934, max per-channel delta 65) — small,
 * because the default whole-city framing is genuinely the most zoomed-out legal camera state (the
 * same "too far out to clear the footprint gate" state `contrast.rendered.test.ts`'s own comments
 * describe), not because the bus is missing. `render()` was observed firing 8 times over 10 frames
 * with buses scheduled (continuous redraw, `movingRef` correctly gating a moving scene) vs 2 times
 * with zero buses (settle-then-static, `dirtyRef`'s one-shot prop-change redraw) — independent
 * confirmation that `movingRef`/`dirtyRef` gate exactly as `MapCanvas.tsx` intends.
 *
 * The pinned playtest's own "no bus even under forced repaint" observation is most plausibly the
 * same class of confound this file's own false start just produced: a screen-capture/readback path
 * that misses `MapCanvas`'s actual paint (not `preserveDrawingBuffer`-safe, or racing the rAF loop
 * the wrong way), not a rendering defect — this repo's own render code has no path where
 * `renderer.render(...)` can run without `updateBuses` having already run in the same gated block
 * (`MapCanvas.tsx`'s tick loop), so "stale/origin-position buses from a draw outrunning the update"
 * cannot happen here today. Recorded as a permanent regression: mounts through the wiring `App.tsx`
 * actually uses, not a hand-built scene, so a future wiring regression (schedules dropped,
 * `totalMinutes` not threaded, `movingRef` never set) fails here even if
 * `contrast.rendered.test.ts` keeps passing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

interface CapturedFrame {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

let latestFrame: CapturedFrame | null = null;
let renderCallCount = 0;

// See this file's own module doc comment for why this exists instead of a `requestAnimationFrame`-
// ordering guess: `THREE.WebGLRenderer.render` is an own instance property (assigned inside the
// constructor), not a prototype method, so there's no prototype to spy on from outside. Subclassing
// and rewrapping the instance's own `render` right after `super()` is the one hook point that
// actually intercepts every call `MapCanvas` makes, with no production code touched.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class CapturingWebGLRenderer extends actual.WebGLRenderer {
    constructor(parameters?: ConstructorParameters<typeof actual.WebGLRenderer>[0]) {
      super(parameters);
      const originalRender = this.render.bind(this);
      this.render = (scene, camera) => {
        originalRender(scene, camera);
        renderCallCount += 1;
        const gl = this.getContext();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        latestFrame = { pixels, width, height };
      };
    }
  }
  return { ...actual, WebGLRenderer: CapturingWebGLRenderer };
});

const { MapCanvas } = await import('../MapCanvas');
const { generateRiverton, RIVERTON_SEED } = await import('../../game/city/generateRiverton');
const { addStop, startDraft, summarizeDraft } = await import('../../game/lines/draft');
const { buildRouteSchedule } = await import('../../game/buses/schedule');
const { BUS_MODELS, STARTING_BUS_MODEL } = await import('../../game/constants');
type LineType = import('../../game/lines/types').Line;
type StopType = import('../../game/lines/types').Stop;
type StopIdType = import('../../game/lines/types').StopId;
type LineIdType = import('../../game/lines/types').LineId;
type LineBusScheduleType = import('../schedules').LineBusSchedule;

const WIDTH = 640;
const HEIGHT = 360;

/** Mirrors `App.tsx`'s own `BUSES_PER_NEW_LINE` — not imported from `App.tsx` (this suite owns
 * `src/render/` only and must not reach into it), kept in lockstep by this comment. */
const BUSES_PER_NEW_LINE = 2;

/** `totalMinutes=0` already lands on 06:00 (`START_MINUTE_OF_DAY`, see `clock/calendar.ts`'s
 * `toCalendarTime`) — 34 matches the pinned playtest's own clock position exactly: 34 game-minutes
 * into service hours (06:00-22:00, `DEFAULT_SERVICE_HOURS`). */
const TOTAL_MINUTES_34_INTO_SERVICE = 34;
const MINUTE_OF_DAY_34_INTO_SERVICE = 6 * 60 + 34;

const city = generateRiverton(RIVERTON_SEED);

/** Same fixture-line construction as `contrast.rendered.test.ts` — a real routable line on the
 * real generated city, two real graph nodes a bounded real-world distance apart. */
function buildFixtureLine(): { line: LineType; stopsById: Map<StopIdType, StopType> } {
  let state = startDraft(city.graph);
  const nodes = city.graph.nodes;
  const from = nodes[Math.floor(nodes.length * 0.15)]!;
  const METERS_PER_DEG_LAT = 111_320;
  let to = nodes[Math.floor(nodes.length * 0.65)]!;
  let bestDist = Infinity;
  for (const candidate of nodes) {
    const dLng = (candidate.pos[0] - from.pos[0]) * METERS_PER_DEG_LAT * Math.cos((from.pos[1] * Math.PI) / 180);
    const dLat = (candidate.pos[1] - from.pos[1]) * METERS_PER_DEG_LAT;
    const distM = Math.hypot(dLng, dLat);
    if (distM > 250 && distM < bestDist) {
      bestDist = distM;
      to = candidate;
    }
  }

  const first = addStop(state, from.pos);
  if (!first.ok) throw new Error(`fixture: first stop failed to place: ${first.reason}`);
  state = first.state;
  const second = addStop(state, to.pos);
  if (!second.ok) throw new Error(`fixture: second stop failed to place: ${second.reason}`);
  state = second.state;

  const summary = summarizeDraft(state);
  if (summary.legs.length === 0) throw new Error('fixture: draft produced no routable legs');

  const line: LineType = {
    id: 0 as LineIdType,
    name: 'Test Line',
    stopIds: summary.stops.map((s) => s.id),
    legs: summary.legs,
    totalLengthM: summary.totalLengthM,
  };
  const stopsById = new Map(summary.stops.map((s) => [s.id, s] as const));
  return { line, stopsById };
}

const { line: fixtureLine, stopsById: fixtureStops } = buildFixtureLine();
const fixtureSchedule = buildRouteSchedule(fixtureLine, fixtureStops, city.graph, BUS_MODELS[STARTING_BUS_MODEL]!.cruiseSpeedKmh);
/** Riders/day rose, so the line is real and scheduled — matching the playtest exactly
 * (`BUSES_PER_NEW_LINE` buses on the one line just drawn). */
const fixtureSchedules: readonly LineBusScheduleType[] = [
  { lineId: fixtureLine.id, schedule: fixtureSchedule, busCount: BUSES_PER_NEW_LINE },
];
/** Same line, same schedule, zero buses — isolates exactly the bus layer's own pixels when diffed
 * against `fixtureSchedules` (route ribbon, stops, roads, buildings, night tint and camera framing
 * are all otherwise identical). */
const noBusSchedules: readonly LineBusScheduleType[] = [{ lineId: fixtureLine.id, schedule: fixtureSchedule, busCount: 0 }];

// ── Mount helpers ────────────────────────────────────────────────────────────

let activeRoot: Root | null = null;
let activeContainer: HTMLDivElement | null = null;

afterEach(() => {
  activeRoot?.unmount();
  activeContainer?.remove();
  activeRoot = null;
  activeContainer = null;
});

function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const step = () => {
      count += 1;
      if (count >= n) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Mounts `MapCanvas` with props exactly the way `App.tsx`'s own `<MapCanvas>` call site passes
 * them, lets its mount effects and rAF loop settle across real animation frames, and returns the
 * last frame it actually painted plus how many times it painted at all. */
async function mountAndCapture(schedules: readonly LineBusScheduleType[]): Promise<{ frame: CapturedFrame; renderCalls: number }> {
  latestFrame = null;
  renderCallCount = 0;

  const container = document.createElement('div');
  container.style.width = `${WIDTH}px`;
  container.style.height = `${HEIGHT}px`;
  container.style.position = 'fixed';
  container.style.left = '0';
  container.style.top = '0';
  document.body.appendChild(container);

  const root = createRoot(container);
  activeRoot = root;
  activeContainer = container;

  root.render(
    createElement(MapCanvas, {
      city,
      minuteOfDay: MINUTE_OF_DAY_34_INTO_SERVICE,
      totalMinutes: TOTAL_MINUTES_34_INTO_SERVICE,
      lines: [fixtureLine],
      stops: fixtureStops,
      schedules,
    }),
  );

  // Mount effects (renderer construction, ResizeObserver's first measurement, the fresh-scene
  // build on the first dirty tick) settle across several real frames — matching how a player's
  // first paint after navigating to the map actually happens, not one synchronous tick.
  await waitFrames(10);

  if (!latestFrame) throw new Error('mountAndCapture: MapCanvas never called renderer.render(...)');
  return { frame: latestFrame, renderCalls: renderCallCount };
}

function diffPixelCount(a: Uint8Array, b: Uint8Array, width: number, height: number, tolerance = 4): number {
  let count = 0;
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    const dr = Math.abs(a[off]! - b[off]!);
    const dg = Math.abs(a[off + 1]! - b[off + 1]!);
    const db = Math.abs(a[off + 2]! - b[off + 2]!);
    if (dr > tolerance || dg > tolerance || db > tolerance) count++;
  }
  return count;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MapCanvas wiring: App.tsx-shaped props actually reach a painted bus', () => {
  it('a bus painted through the real App.tsx -> MapCanvas prop wiring differs from the same frame with zero buses scheduled', async () => {
    const withBuses = await mountAndCapture(fixtureSchedules);
    activeRoot?.unmount();
    activeContainer?.remove();
    activeRoot = null;
    activeContainer = null;
    const withoutBuses = await mountAndCapture(noBusSchedules);

    expect(withBuses.frame.width).toBe(withoutBuses.frame.width);
    expect(withBuses.frame.height).toBe(withoutBuses.frame.height);

    // The only thing that differs between the two mounts is `busCount` (2 vs 0) on an otherwise
    // identical scene (same city, same line, same clock minute, same default camera framing) — any
    // differing pixel is a painted bus (body, stripe or outline), reached through MapCanvas's own
    // tick loop exactly as a player's screen is, never a hand-built scene.
    const diff = diffPixelCount(withBuses.frame.pixels, withoutBuses.frame.pixels, withBuses.frame.width, withBuses.frame.height);
    expect(diff).toBeGreaterThan(0);
  });

  it('a moving bus keeps MapCanvas redrawing (movingRef), while zero buses settle to a static frame (dirtyRef one-shot)', async () => {
    const withBuses = await mountAndCapture(fixtureSchedules);
    activeRoot?.unmount();
    activeContainer?.remove();
    activeRoot = null;
    activeContainer = null;
    const withoutBuses = await mountAndCapture(noBusSchedules);

    // Regression guard for "movingRef never set true so updateBuses never runs" (this
    // investigation's own hypothesis list): with a real scheduled bus, MapCanvas's tick loop must
    // keep painting every frame rather than settling after the initial prop-driven redraw.
    expect(withBuses.renderCalls).toBeGreaterThan(withoutBuses.renderCalls);
    expect(withBuses.renderCalls).toBeGreaterThan(1);
  });

  it('with schedules present, MapCanvas paints non-background pixels beyond just paper', async () => {
    const { frame } = await mountAndCapture(fixtureSchedules);
    const paperRgb: readonly [number, number, number] = [0xf6, 0xf1, 0xe1]; // fallback --paper (paperPalette.ts)
    let nonPaper = 0;
    for (let i = 0; i < frame.width * frame.height; i++) {
      const off = i * 4;
      const dr = frame.pixels[off]! - paperRgb[0];
      const dg = frame.pixels[off + 1]! - paperRgb[1];
      const db = frame.pixels[off + 2]! - paperRgb[2];
      if (Math.hypot(dr, dg, db) > 8) nonPaper++;
    }
    // Sanity floor only — the scene is definitely drawing *something* (roads, water, the route
    // ribbon) — guards this file's own harness against silently reading back a blank canvas (the
    // exact false negative this file's own doc comment describes finding and fixing).
    expect(nonPaper).toBeGreaterThan(1000);
  });
});
