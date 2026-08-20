/**
 * Owns the WebGL canvas — the three.js scene (`three/scene.ts`), device-pixel-ratio-correct
 * sizing, window resize, mouse drag to pan, wheel to zoom, click-to-place / hover-to-preview
 * reporting for the line-drawing flow, and a redraw-on-change rAF loop. `Viewport` (`projection.ts`)
 * is unchanged and still owns every pan/zoom/clamp number; this component's job is turning that 2D
 * camera-state object into an actual `THREE.PerspectiveCamera` every redraw (`three/cameraRig.ts`)
 * instead of a 2D canvas transform.
 *
 * Step 2 (renderer-3d.md §8/§1) unlocks the camera on top of that: pitch 0°-60° (right-button drag
 * or Up/Down arrow keys), free yaw (right-button drag or Left/Right arrow keys), `Home` (one key,
 * eases to default framing) and `N` (one key, eases yaw to north) — `pitchDegRef`/`yawDegRef` below
 * are the live orbit state this adds, threaded into `updateViewportDependent` alongside the
 * `Viewport` it already owned. Every control has a keyboard route (GAME.md: "every camera control
 * needs a keyboard route, not only a mouse one").
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { City, LngLat } from '../game/types';
import type { Draft, Line, Stop, StopId } from '../game/lines/types';
import type { LineBusSchedule } from './schedules';
import { pointerMovedPastClickThreshold } from './pointerGestures';
import { invalidatePaperPaletteCache, readPaperPalette } from './paperPalette';
import { lngLatToTuple, Viewport, zoomFloor, type MutableLngLat } from './projection';
import {
  buildCityScene,
  updateBuses,
  updateKeyLightClock,
  updateLineResolutionsForResize,
  updateLinesAndStops,
  updateNightTint,
  updateViewportDependent,
  type CityScene,
} from './three/scene';
import { fromLocalXZ } from './three/localProjection';
import {
  CAMERA_DRAG_PITCH_DEG_PER_PX,
  CAMERA_DRAG_YAW_DEG_PER_PX,
  CAMERA_HOME_EASE_MS,
  CAMERA_KEY_PITCH_RATE_DEG_PER_S,
  CAMERA_KEY_YAW_RATE_DEG_PER_S,
  CAMERA_KEY_ZOOM_RATE_PER_S,
  CAMERA_MAX_ZOOM,
  CAMERA_NORTH_SNAP_EASE_MS,
  CAMERA_PITCH_DEG,
  CAMERA_PITCH_MAX_DEG,
  CAMERA_PITCH_MIN_DEG,
  CAMERA_YAW_DEG,
} from './three/constants';

const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const MINUTE_OF_DAY_QUANTUM = 1;
const CLICK_DRAG_THRESHOLD_PX = 6;
/** Longest single `tick()` delta ever applied to a held-key/ease update — guards against a huge
 * jump after the tab regains focus (rAF simply doesn't fire while hidden, so the next `dt` would
 * otherwise be however long the tab was backgrounded). TUNE */
const MAX_CAMERA_DT_SECONDS = 0.25;

// ── Camera-unlock math (renderer-3d.md §1/§8 step 2) — pure, no DOM/THREE dependency ────────────

function clampDeg(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function normalizeYawDeg(yawDeg: number): number {
  const wrapped = yawDeg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Shortest signed angular delta from `from` to `to` — an eased yaw transition (`N`, `Home`) always
 * takes the short way round rather than potentially spinning the long way past 180°. */
function shortestYawDeltaDeg(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function easeOutCubic(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - Math.pow(1 - clamped, 3);
}

/** The camera's own zoom range (renderer-3d.md §1: "zoom | fit | `zoomFloor(city)` … 20") — tighter
 * than `Viewport`'s own generic `[MIN_ZOOM, MAX_ZOOM]`, applied on top of it by every zoom-changing
 * gesture below. */
function clampCameraZoom(viewport: Viewport, city: City): void {
  const floor = zoomFloor(city.bounds, viewport.width, viewport.height);
  viewport.zoom = clampDeg(viewport.zoom, floor, CAMERA_MAX_ZOOM);
}

interface CameraEaseTarget {
  pitchDeg: number;
  yawDeg: number;
  zoom: number;
  centerLng: number;
  centerLat: number;
}

interface CameraEase {
  readonly startMs: number;
  readonly durationMs: number;
  readonly from: CameraEaseTarget;
  readonly to: CameraEaseTarget;
}

/** Held-continuously keys: pitch (Up/Down), yaw (Left/Right), zoom (`+`/`-`, both the shifted and
 * unshifted glyphs, plus the numpad `+`/`-` which `event.key` reports the same way). `Home`/`N`
 * are one-shot and handled separately, not in this set. */
const CAMERA_HELD_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', '_']);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Ctrl/Alt/Meta are left alone (browser/OS shortcuts — e.g. Ctrl/Cmd+`=` is browser zoom); Shift
 * is not blocking, since it's how a US keyboard types `+` for the zoom-in key. */
function hasBlockingModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey;
}

function quantizeMinuteOfDay(minuteOfDay: number | undefined): number | undefined {
  if (minuteOfDay === undefined) return undefined;
  return Math.floor(minuteOfDay / MINUTE_OF_DAY_QUANTUM) * MINUTE_OF_DAY_QUANTUM;
}

export interface MapCanvasProps {
  readonly city: City;
  readonly minuteOfDay?: number;
  readonly lines?: readonly Line[];
  readonly stops?: ReadonlyMap<StopId, Stop>;
  readonly schedules?: readonly LineBusSchedule[];
  readonly draft?: Draft;
  readonly hoverLngLat?: LngLat;
  readonly totalMinutes?: number;
  readonly onMapClick?: (lngLat: LngLat) => void;
  readonly onHover?: (lngLat: LngLat | null) => void;
}

export function MapCanvas({
  city,
  minuteOfDay,
  lines,
  stops,
  schedules,
  draft,
  hoverLngLat,
  totalMinutes,
  onMapClick,
  onHover,
}: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cityScenesRef = useRef<WeakMap<City, CityScene>>(new WeakMap());
  const activeSceneRef = useRef<CityScene | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const dirtyRef = useRef(true);
  const cityRef = useRef(city);
  cityRef.current = city;
  const minuteOfDayRef = useRef(quantizeMinuteOfDay(minuteOfDay));

  const linesRef = useRef(lines);
  linesRef.current = lines;
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const schedulesRef = useRef(schedules);
  schedulesRef.current = schedules;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const hoverLngLatRef = useRef(hoverLngLat);
  hoverLngLatRef.current = hoverLngLat;
  const totalMinutesRef = useRef(totalMinutes);
  totalMinutesRef.current = totalMinutes;

  const hasMovingBuses = totalMinutes !== undefined && !!schedules && schedules.some((s) => s.busCount > 0);
  const movingRef = useRef(hasMovingBuses);
  movingRef.current = hasMovingBuses;

  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  const hasUserAdjustedViewportRef = useRef(false);

  // ── Camera unlock (renderer-3d.md §1/§8 step 2) ─────────────────────────────────────────────
  // `pitchDegRef`/`yawDegRef` are the camera's *live* orbit state — separate from `Viewport`
  // (which still owns only center/zoom, exactly as it did pre-3D). Every gesture below writes
  // absolute state (never accumulates a per-event delta onto itself across frames), matching
  // renderer-3d.md §8's "spammed camera input is idempotent" edge case.
  const pitchDegRef = useRef(CAMERA_PITCH_DEG);
  const yawDegRef = useRef(CAMERA_YAW_DEG);
  /** Keys currently held for continuous pitch/yaw/zoom — `MapCanvas`'s own keyboard route for
   * every camera control (GAME.md: "every camera control needs a keyboard route, not only a mouse
   * one"), applied per rendered frame in the redraw loop below, not per keydown, so a held key
   * reads exactly like a drag regardless of OS key-repeat timing. */
  const heldCameraKeysRef = useRef<Set<string>>(new Set());
  /** The one in-flight eased transition (`Home` or `N`) — `null` when idle. Allocated once per
   * trigger, mutated in place by nothing (a fresh object per ease start, matching every other
   * "no per-frame allocation" path: the allocation happens on the rare keypress, not every tick). */
  const cameraEaseRef = useRef<CameraEase | null>(null);
  const lastFrameTimeMsRef = useRef<number | null>(null);
  const prefersReducedMotionRef = useRef(
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {
      prefersReducedMotionRef.current = media.matches;
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  /** `Home` — renderer-3d.md §1: "eases the camera to default framing over 400 ms (ease-out
   * cubic)"; §8 step 2: "a way home... reachable by one key." Default framing is exactly what the
   * city-change effect below already computes for a fresh `Viewport` (`fitToBounds`), at the
   * default pitch/yaw. */
  const goHome = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const fitted = Viewport.fitToBounds(cityRef.current.bounds, viewport.width, viewport.height);
    clampCameraZoom(fitted, cityRef.current);
    const from: CameraEaseTarget = {
      pitchDeg: pitchDegRef.current,
      yawDeg: yawDegRef.current,
      zoom: viewport.zoom,
      centerLng: viewport.centerLng,
      centerLat: viewport.centerLat,
    };
    const to: CameraEaseTarget = {
      pitchDeg: CAMERA_PITCH_DEG,
      yawDeg: from.yawDeg + shortestYawDeltaDeg(from.yawDeg, CAMERA_YAW_DEG),
      zoom: fitted.zoom,
      centerLng: fitted.centerLng,
      centerLat: fitted.centerLat,
    };
    // Home returns the camera to exactly the state a fresh mount/resize would compute — so a
    // resize right after should keep re-fitting, same as before the player ever touched the map.
    hasUserAdjustedViewportRef.current = false;
    if (prefersReducedMotionRef.current) {
      pitchDegRef.current = to.pitchDeg;
      yawDegRef.current = normalizeYawDeg(to.yawDeg);
      viewport.zoom = to.zoom;
      viewport.centerLng = to.centerLng;
      viewport.centerLat = to.centerLat;
      cameraEaseRef.current = null;
    } else {
      cameraEaseRef.current = { startMs: performance.now(), durationMs: CAMERA_HOME_EASE_MS, from, to };
    }
    dirtyRef.current = true;
  };

  /** `N` — renderer-3d.md §1: "`N` snaps to north over 300 ms." Pitch, zoom and pan are untouched;
   * only yaw eases to 0 by the shortest rotational path. */
  const snapNorth = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const from: CameraEaseTarget = {
      pitchDeg: pitchDegRef.current,
      yawDeg: yawDegRef.current,
      zoom: viewport.zoom,
      centerLng: viewport.centerLng,
      centerLat: viewport.centerLat,
    };
    const to: CameraEaseTarget = { ...from, yawDeg: from.yawDeg + shortestYawDeltaDeg(from.yawDeg, CAMERA_YAW_DEG) };
    if (prefersReducedMotionRef.current) {
      yawDegRef.current = normalizeYawDeg(to.yawDeg);
      cameraEaseRef.current = null;
    } else {
      cameraEaseRef.current = { startMs: performance.now(), durationMs: CAMERA_NORTH_SNAP_EASE_MS, from, to };
    }
    dirtyRef.current = true;
  };

  useEffect(() => {
    const next = quantizeMinuteOfDay(minuteOfDay);
    if (next !== minuteOfDayRef.current) {
      minuteOfDayRef.current = next;
      dirtyRef.current = true;
    }
  }, [minuteOfDay]);

  useEffect(() => {
    dirtyRef.current = true;
  }, [lines, stops, schedules, draft, hoverLngLat]);

  // City change: fresh viewport fit, fresh (or cached) scene, camera back to its default orbit.
  useEffect(() => {
    hasUserAdjustedViewportRef.current = false;
    cameraEaseRef.current = null;
    pitchDegRef.current = CAMERA_PITCH_DEG;
    yawDegRef.current = CAMERA_YAW_DEG;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const viewport = Viewport.fitToBounds(city.bounds, Math.max(1, rect.width), Math.max(1, rect.height));
    clampCameraZoom(viewport, city);
    viewportRef.current = viewport;
    dirtyRef.current = true;
  }, [city]);

  // Renderer lifecycle: created once, disposed on unmount. Rebuilds the active scene from current
  // props on WebGL context loss (renderer-3d.md §8 failure/edge cases: "Context loss → rebuild the
  // scene from state on `webglcontextrestored`... the save is never touched" — nothing here reads
  // or writes a save; the scene is rebuilt purely from the props this component already holds).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    rendererRef.current = renderer;

    const onContextLost = (event: Event) => {
      event.preventDefault();
    };
    const onContextRestored = () => {
      cityScenesRef.current = new WeakMap();
      activeSceneRef.current = null;
      dirtyRef.current = true;
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    return () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Sizing: DPR-correct renderer size, refit (not just resized) whenever the canvas's own box
  // changes — see the Canvas-era comment this preserves verbatim (renderer-3d.md §7 cause 3: "the
  // mount-time rect race... survives unchanged, plus a new sibling (`devicePixelRatio`)").
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, rect.width);
      const cssHeight = Math.max(1, rect.height);
      if (cssWidth < 16 || cssHeight < 16) return; // a transitional/unmeasured rect — refuse it

      const dpr = window.devicePixelRatio || 1;
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.setPixelRatio(dpr);
        renderer.setSize(cssWidth, cssHeight, false);
      }

      const viewport = viewportRef.current;
      if (viewport && hasUserAdjustedViewportRef.current) {
        viewport.width = cssWidth;
        viewport.height = cssHeight;
        clampCameraZoom(viewport, cityRef.current);
        viewport.clampToBounds(cityRef.current.bounds);
      } else {
        const fitted = Viewport.fitToBounds(cityRef.current.bounds, cssWidth, cssHeight);
        clampCameraZoom(fitted, cityRef.current);
        viewportRef.current = fitted;
      }

      const scene = activeSceneRef.current;
      if (scene) updateLineResolutionsForResize(scene, cssWidth * dpr, cssHeight * dpr);

      dirtyRef.current = true;
    };

    resize();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const onPaletteChange = () => {
      invalidatePaperPaletteCache();
      cityScenesRef.current = new WeakMap();
      activeSceneRef.current = null;
      dirtyRef.current = true;
    };
    const observer = new MutationObserver(onPaletteChange);
    observer.observe(document.documentElement, { attributes: true });
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    media?.addEventListener('change', onPaletteChange);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', onPaletteChange);
    };
  }, []);

  // Input: drag to pan, wheel to zoom about the cursor, click to place, hover to preview. Pan/zoom
  // bookkeeping stays on `Viewport` exactly as it was under Canvas (renderer-3d.md §1: "every
  // number tuned against the Canvas renderer transfers unchanged"); the ground-plane ray/plane
  // intersection below is only for turning a *screen pixel* into an *lng/lat* for click/hover
  // callbacks, matching §1's "ray/plane intersection" pick semantics.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging = false;
    // Orbit (renderer-3d.md §1's "Feel": "Tilt/yaw drag is 1:1... No screenshake, ever") — a
    // separate gesture from pan, driven by the secondary (right) pointer button so the two never
    // conflict and a right-drag never also fires a left-click's place/select on release.
    let orbiting = false;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;

    let hoverScheduled = false;
    let pendingHover: LngLat | null = null;

    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ndc = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();

    const pickLngLat = (clientX: number, clientY: number): LngLat | null => {
      const scene = activeSceneRef.current;
      if (!scene) return null;
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, scene.camera);
      if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return null;
      return fromLocalXZ(scene.origin, hitPoint.x, hitPoint.z);
    };

    const flushHover = () => {
      hoverScheduled = false;
      onHoverRef.current?.(pendingHover);
    };
    const scheduleHover = (next: LngLat | null) => {
      pendingHover = next;
      if (hoverScheduled) return;
      hoverScheduled = true;
      requestAnimationFrame(flushHover);
    };
    const reportHoverAt = (clientX: number, clientY: number) => {
      scheduleHover(pickLngLat(clientX, clientY));
    };

    const onPointerDown = (event: PointerEvent) => {
      orbiting = event.button === 2;
      dragging = !orbiting;
      lastX = event.clientX;
      lastY = event.clientY;
      downX = event.clientX;
      downY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (orbiting) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        pitchDegRef.current = clampDeg(
          pitchDegRef.current + dy * CAMERA_DRAG_PITCH_DEG_PER_PX,
          CAMERA_PITCH_MIN_DEG,
          CAMERA_PITCH_MAX_DEG,
        );
        yawDegRef.current = normalizeYawDeg(yawDegRef.current + dx * CAMERA_DRAG_YAW_DEG_PER_PX);
        cameraEaseRef.current = null; // a grabbed camera wins outright over any in-flight ease
        dirtyRef.current = true;
      } else if (dragging && viewportRef.current) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        viewportRef.current.panBy(-dx, -dy);
        viewportRef.current.clampToBounds(cityRef.current.bounds);
        hasUserAdjustedViewportRef.current = true;
        dirtyRef.current = true;
      }
      reportHoverAt(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      const wasOrbiting = orbiting;
      dragging = false;
      orbiting = false;
      canvas.releasePointerCapture(event.pointerId);

      if (wasOrbiting || !viewportRef.current) return;
      const draggedPastThreshold = pointerMovedPastClickThreshold(
        downX,
        downY,
        event.clientX,
        event.clientY,
        CLICK_DRAG_THRESHOLD_PX,
      );
      if (draggedPastThreshold) return;
      const lngLat = pickLngLat(event.clientX, event.clientY);
      if (lngLat) onMapClickRef.current?.(lngLat);
    };
    const onPointerLeave = () => {
      scheduleHover(null);
    };
    const onContextMenu = (event: MouseEvent) => {
      // The right button drives orbit, not the browser context menu — see `onPointerDown`.
      event.preventDefault();
    };
    const onWheel = (event: WheelEvent) => {
      if (!viewportRef.current) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      viewportRef.current.zoomAt(factor, screenX, screenY);
      clampCameraZoom(viewportRef.current, cityRef.current);
      viewportRef.current.clampToBounds(cityRef.current.bounds);
      hasUserAdjustedViewportRef.current = true;
      dirtyRef.current = true;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Keyboard: pitch/yaw/zoom (held, continuous — applied in the redraw loop below) plus Home/N
  // (one-shot, eased). GAME.md: "every camera control needs a keyboard route, not only a mouse
  // one" — this is that route for every control §1's camera table exposes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasBlockingModifier(event) || isTypingTarget(event.target)) return;

      if (event.key === 'Home') {
        event.preventDefault();
        goHome();
        return;
      }
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        snapNorth();
        return;
      }
      if (CAMERA_HELD_KEYS.has(event.key)) {
        event.preventDefault();
        heldCameraKeysRef.current.add(event.key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      heldCameraKeysRef.current.delete(event.key);
    };
    // Held keys must not get stuck down if focus leaves the window mid-hold (alt-tab, a dialog
    // opening) — nothing would ever fire `keyup` for them otherwise.
    const onBlur = () => {
      heldCameraKeysRef.current.clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- goHome/snapNorth close over refs only
  }, []);

  // Redraw loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId = 0;
    const tick = () => {
      const renderer = rendererRef.current;
      const viewport = viewportRef.current;

      // Camera-unlock update — held keys and any in-flight `Home`/`N` ease, both applied here
      // (once per rendered frame, dt-scaled) rather than per DOM event, so their rate is frame-rate
      // independent and a held key reads exactly like a drag. Runs before the dirty-gate below so
      // either path can *set* dirty for this frame.
      const nowMs = performance.now();
      const lastMs = lastFrameTimeMsRef.current;
      lastFrameTimeMsRef.current = nowMs;
      const dtSeconds = lastMs === null ? 0 : Math.min(MAX_CAMERA_DT_SECONDS, (nowMs - lastMs) / 1000);

      if (viewport) {
        const ease = cameraEaseRef.current;
        if (ease) {
          const t = easeOutCubic((nowMs - ease.startMs) / ease.durationMs);
          pitchDegRef.current = ease.from.pitchDeg + (ease.to.pitchDeg - ease.from.pitchDeg) * t;
          yawDegRef.current = normalizeYawDeg(ease.from.yawDeg + (ease.to.yawDeg - ease.from.yawDeg) * t);
          viewport.zoom = ease.from.zoom + (ease.to.zoom - ease.from.zoom) * t;
          viewport.centerLng = ease.from.centerLng + (ease.to.centerLng - ease.from.centerLng) * t;
          viewport.centerLat = ease.from.centerLat + (ease.to.centerLat - ease.from.centerLat) * t;
          if (t >= 1) cameraEaseRef.current = null;
          dirtyRef.current = true;
        } else if (dtSeconds > 0 && heldCameraKeysRef.current.size > 0) {
          const keys = heldCameraKeysRef.current;
          let pitchDelta = 0;
          let yawDelta = 0;
          let zoomDelta = 0;
          if (keys.has('ArrowUp')) pitchDelta += CAMERA_KEY_PITCH_RATE_DEG_PER_S * dtSeconds;
          if (keys.has('ArrowDown')) pitchDelta -= CAMERA_KEY_PITCH_RATE_DEG_PER_S * dtSeconds;
          if (keys.has('ArrowRight')) yawDelta += CAMERA_KEY_YAW_RATE_DEG_PER_S * dtSeconds;
          if (keys.has('ArrowLeft')) yawDelta -= CAMERA_KEY_YAW_RATE_DEG_PER_S * dtSeconds;
          if (keys.has('+') || keys.has('=')) zoomDelta += CAMERA_KEY_ZOOM_RATE_PER_S * dtSeconds;
          if (keys.has('-') || keys.has('_')) zoomDelta -= CAMERA_KEY_ZOOM_RATE_PER_S * dtSeconds;

          if (pitchDelta !== 0 || yawDelta !== 0) {
            pitchDegRef.current = clampDeg(pitchDegRef.current + pitchDelta, CAMERA_PITCH_MIN_DEG, CAMERA_PITCH_MAX_DEG);
            yawDegRef.current = normalizeYawDeg(yawDegRef.current + yawDelta);
            dirtyRef.current = true;
          }
          if (zoomDelta !== 0) {
            viewport.zoom += zoomDelta;
            clampCameraZoom(viewport, cityRef.current);
            viewport.clampToBounds(cityRef.current.bounds);
            hasUserAdjustedViewportRef.current = true;
            dirtyRef.current = true;
          }
        }
      }

      if (renderer && viewport && (dirtyRef.current || movingRef.current)) {
        dirtyRef.current = false;

        let scene = cityScenesRef.current.get(cityRef.current);
        if (!scene) {
          const palette = readPaperPalette();
          scene = buildCityScene(cityRef.current, palette, viewport.width / viewport.height);
          cityScenesRef.current.set(cityRef.current, scene);
          const dpr = window.devicePixelRatio || 1;
          updateLineResolutionsForResize(scene, viewport.width * dpr, viewport.height * dpr);
        }
        activeSceneRef.current = scene;

        const palette = readPaperPalette();
        const dpr = window.devicePixelRatio || 1;
        updateViewportDependent(scene, viewport, dpr, pitchDegRef.current, yawDegRef.current);
        updateNightTint(scene, minuteOfDayRef.current ?? 12 * 60, palette);
        updateKeyLightClock(scene, minuteOfDayRef.current ?? 12 * 60);
        updateLinesAndStops(
          scene,
          linesRef.current,
          stopsRef.current,
          draftRef.current,
          hoverLngLatRef.current,
          palette,
          viewport.scale(),
        );
        if (schedulesRef.current && totalMinutesRef.current !== undefined) {
          updateBuses(scene, schedulesRef.current, totalMinutesRef.current, viewport.width, viewport.height, palette);
        }

        renderer.render(scene.scene, scene.camera);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
