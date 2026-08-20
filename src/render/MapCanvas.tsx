/**
 * Owns the WebGL canvas — the three.js scene (`three/scene.ts`), device-pixel-ratio-correct
 * sizing, window resize, mouse drag to pan, wheel to zoom, click-to-place / hover-to-preview
 * reporting for the line-drawing flow, and a redraw-on-change rAF loop. Step 1 (renderer-3d.md
 * §8): camera pitch locked at 0°, no yaw — "looks like today's map, in WebGL." `Viewport`
 * (`projection.ts`) is unchanged and still owns every pan/zoom/clamp number; this component's job
 * is turning that 2D camera-state object into an actual `THREE.PerspectiveCamera` every redraw
 * (`three/cameraRig.ts`) instead of a 2D canvas transform.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { City, LngLat } from '../game/types';
import type { Draft, Line, Stop, StopId } from '../game/lines/types';
import type { LineBusSchedule } from './schedules';
import { pointerMovedPastClickThreshold } from './pointerGestures';
import { invalidatePaperPaletteCache, readPaperPalette } from './paperPalette';
import { lngLatToTuple, Viewport, type MutableLngLat } from './projection';
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

const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const MINUTE_OF_DAY_QUANTUM = 1;
const CLICK_DRAG_THRESHOLD_PX = 6;

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

  // City change: fresh viewport fit, fresh (or cached) scene.
  useEffect(() => {
    hasUserAdjustedViewportRef.current = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    viewportRef.current = Viewport.fitToBounds(city.bounds, Math.max(1, rect.width), Math.max(1, rect.height));
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
        viewport.clampToBounds(cityRef.current.bounds);
      } else {
        viewportRef.current = Viewport.fitToBounds(cityRef.current.bounds, cssWidth, cssHeight);
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
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      downX = event.clientX;
      downY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragging && viewportRef.current) {
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
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);

      if (!viewportRef.current) return;
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
    const onWheel = (event: WheelEvent) => {
      if (!viewportRef.current) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      viewportRef.current.zoomAt(factor, screenX, screenY);
      viewportRef.current.clampToBounds(cityRef.current.bounds);
      hasUserAdjustedViewportRef.current = true;
      dirtyRef.current = true;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Redraw loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId = 0;
    const tick = () => {
      const renderer = rendererRef.current;
      const viewport = viewportRef.current;
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
        updateViewportDependent(scene, viewport, dpr);
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
          updateBuses(scene, schedulesRef.current, totalMinutesRef.current, viewport.height, palette);
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
