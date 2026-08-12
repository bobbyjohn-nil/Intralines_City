/**
 * Owns the `<canvas>` element for the offline basemap: device-pixel-ratio-correct sizing, window
 * resize, mouse drag to pan, wheel to zoom, click-to-place / hover-to-preview reporting for the
 * line-drawing flow, and a redraw-on-change rAF loop (never redraws a static map for free, except
 * while buses are actually moving — see the draw loop below).
 */

import { useEffect, useRef } from 'react';
import type { City, LngLat } from '../game/types';
import type { Draft, Line, Stop, StopId } from '../game/lines/types';
import { drawCity, drawMask } from './drawCity';
import { drawOverlays, pointerMovedPastClickThreshold, type LineBusSchedule } from './drawOverlays';
import { invalidatePaperPaletteCache, readPaperPalette } from './paperPalette';
import { lngLatToTuple, Viewport, type MutableLngLat } from './projection';

/** Wheel delta -> zoom factor. Negative deltaY (scroll up) zooms in. TUNE */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** Minute-of-day changes smaller than this are not worth a repaint. TUNE */
const MINUTE_OF_DAY_QUANTUM = 1;

/**
 * Pointer movement beyond this many screen pixels, straight-line, between down and up counts as
 * a drag rather than a click — so panning the map never drops a stop at the end of the gesture.
 * TUNE
 */
const CLICK_DRAG_THRESHOLD_PX = 6;

function quantizeMinuteOfDay(minuteOfDay: number | undefined): number | undefined {
  if (minuteOfDay === undefined) return undefined;
  return Math.floor(minuteOfDay / MINUTE_OF_DAY_QUANTUM) * MINUTE_OF_DAY_QUANTUM;
}

export interface MapCanvasProps {
  readonly city: City;
  /**
   * Game clock minute-of-day (0–1439), driving the map's time-of-day tint. Absent = neutral day,
   * no tint — so the map renders correctly before the clock is wired in. Quantised to the minute;
   * see `quantizeMinuteOfDay`.
   */
  readonly minuteOfDay?: number;
  /** Confirmed lines to draw as routes + stops. Absent = none drawn. */
  readonly lines?: readonly Line[];
  /** The top-level stop collection `lines[].stopIds` resolves against (save-format.md §5).
   * Absent = no line stops drawn, even if `lines` is present — see `drawOverlays`'s `EMPTY_STOPS_MAP`. */
  readonly stops?: ReadonlyMap<StopId, Stop>;
  /** Bus schedules to animate, one entry per line that has buses running. Absent, or absent
   * `totalMinutes`, = no buses drawn and no per-frame redraw forced (see the draw loop below). */
  readonly schedules?: readonly LineBusSchedule[];
  /** The line currently being drawn, if any — its confirmed legs/stops plus a rubber-band
   * preview to `hoverLngLat`. */
  readonly draft?: Draft;
  /** Where the pointer currently is, in map coordinates — fed back in by the caller (typically
   * from this component's own `onHover`) so the draft's rubber band can track the cursor. */
  readonly hoverLngLat?: LngLat;
  /** Game clock total minutes, driving bus animation. See `schedules`. */
  readonly totalMinutes?: number;
  /** Fires on a genuine click — not at the end of a drag/pan. See `CLICK_DRAG_THRESHOLD_PX`. */
  readonly onMapClick?: (lngLat: LngLat) => void;
  /** Fires with the pointer's current map position, or `null` when it leaves the canvas.
   * Throttled to at most once per animation frame. */
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
  const viewportRef = useRef<Viewport | null>(null);
  const dirtyRef = useRef(true);
  const cityRef = useRef(city);
  cityRef.current = city;
  const minuteOfDayRef = useRef(quantizeMinuteOfDay(minuteOfDay));

  // Overlay data is read fresh every draw via refs (not effect dependencies) so the draw loop —
  // registered once, below — always sees the latest props without resubscribing.
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

  // Buses are a pure function of the clock (see `busPositionAt`'s doc comment) — as long as any
  // line actually has buses and a clock is supplied, they're moving on every frame regardless of
  // whether anything else changed, so the draw loop below must redraw continuously rather than
  // wait on `dirtyRef`. `movingRef` is that flag; it's the *only* thing allowed to bypass the
  // dirty gate — see the draw loop.
  const hasMovingBuses = totalMinutes !== undefined && !!schedules && schedules.some((s) => s.busCount > 0);
  const movingRef = useRef(hasMovingBuses);
  movingRef.current = hasMovingBuses;

  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  // Whether the player has ever panned or zoomed this city's viewport by hand (set by the drag
  // and wheel handlers below). While false, every observed size change performs a *full*
  // `fitToBounds` (recomputing zoom, not just width/height) — see the sizing effect below for why:
  // this is what stops a layout race (the boot hand-off revealing the map, a panel opening, a
  // font-load reflow settling the container after mount) from stranding the camera at whatever
  // undersized rect happened to exist the instant this component first mounted. Once true, a
  // resize only patches width/height and preserves the player's chosen zoom/pan, same as always.
  const hasUserAdjustedViewportRef = useRef(false);

  // Redraw when the tint-relevant minute actually changes — quantised so sub-minute clock ticks
  // (the sim runs faster than real time) don't each trigger a repaint.
  useEffect(() => {
    const next = quantizeMinuteOfDay(minuteOfDay);
    if (next !== minuteOfDayRef.current) {
      minuteOfDayRef.current = next;
      dirtyRef.current = true;
    }
  }, [minuteOfDay]);

  // Redraw whenever overlay-relevant data actually changes — a new stop, a completed line, the
  // draft's rubber band following the cursor. Reference equality, same convention as `city`
  // below: a caller that memoizes its data gets a properly gated static map; one that doesn't
  // gets some extra redraws, never a stale one. (Continuous bus motion is handled separately by
  // `movingRef`, not this effect — `totalMinutes` deliberately isn't a dependency here.)
  useEffect(() => {
    dirtyRef.current = true;
  }, [lines, stops, schedules, draft, hoverLngLat]);

  // Fit the viewport to the city whenever the city itself changes, and let a brand-new city start
  // at a correct, full fit rather than inheriting the previous city's manual pan/zoom state.
  useEffect(() => {
    hasUserAdjustedViewportRef.current = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    viewportRef.current = Viewport.fitToBounds(
      city.bounds,
      Math.max(1, rect.width),
      Math.max(1, rect.height),
    );
    dirtyRef.current = true;
  }, [city]);

  // Sizing: device-pixel-ratio-correct canvas, refit (not just resized) whenever the canvas's own
  // box actually changes size. Watched with a `ResizeObserver` on the canvas itself rather than
  // (only) `window`'s `resize` event, because the canvas can change size for reasons that never
  // fire a window resize — the boot hand-off revealing the map, a side panel opening/closing, an
  // orientation change, a font-load reflow settling a flex container's height after first paint.
  // Any one of those, landing between this component's mount and the layout actually settling,
  // used to strand `fitToBounds`'s zoom against a too-small transitional rect forever (only
  // `viewport.width`/`height` ever got corrected afterwards, never the zoom that was fit to them —
  // see `projection.ts`'s `fitToBounds` doc and the render task's "initial scale" fix): the DOM
  // element itself would report its final, correct size to any inspector, while the map was drawn
  // small and centered in a void, because everything (road widths, bus markers, park fills) scales
  // off the same stuck `viewport.scale()`. Falls back to the `window` resize event if
  // `ResizeObserver` is unavailable (SPEC: degrade, don't fail) — strictly worse coverage, but
  // still functional. TUNE: none of this changes drawing, only when a refit is triggered.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = Math.max(1, rect.width);
      const cssHeight = Math.max(1, rect.height);
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);

      const viewport = viewportRef.current;
      if (viewport && hasUserAdjustedViewportRef.current) {
        // The player has already taken manual control of pan/zoom for this city — a resize must
        // preserve it, only the frame around it changes.
        viewport.width = cssWidth;
        viewport.height = cssHeight;
        // A resize can change the viewport's own aspect ratio out from under a manually-panned
        // position (e.g. a side panel opening narrows the map) — re-clamp so that never stands up
        // a previously-valid pan into one that now shows nothing but void.
        viewport.clampToBounds(cityRef.current.bounds);
      } else {
        // No manual pan/zoom yet: always (re)compute a full fit against the size actually
        // observed now, so the very first thing the player sees is correct no matter when layout
        // settles.
        viewportRef.current = Viewport.fitToBounds(cityRef.current.bounds, cssWidth, cssHeight);
      }
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

  // Palette-change watcher: a theme flip (the `data-theme` attribute on <html> — see styles.css —
  // or, if that's ever wired to the OS preference, a `prefers-color-scheme` change) doesn't touch
  // anything else this component watches. `readPaperPalette` already re-derives correctly from
  // live CSS on every call; the missing piece was nobody telling the draw loop a redraw was owed,
  // which used to mean a theme change required a manual page reload.
  useEffect(() => {
    const onPaletteChange = () => {
      invalidatePaperPaletteCache();
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

  // Input: drag to pan, wheel to zoom about the cursor, click to place (suppressed at the end of
  // a drag), hover to preview (throttled to one `onHover` call per animation frame).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;

    // Hover throttling: only the most recent position is kept between animation frames, and at
    // most one `onHover` call is scheduled at a time.
    let hoverScheduled = false;
    let pendingHover: LngLat | null = null;
    const hoverScratch: MutableLngLat = { lng: 0, lat: 0 };

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
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = canvas.getBoundingClientRect();
      viewport.unproject(clientX - rect.left, clientY - rect.top, hoverScratch);
      scheduleHover(lngLatToTuple(hoverScratch));
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
        // Dragging the map right should slide the world right under the cursor, i.e. pan the
        // viewport center left — panBy takes a screen-space delta of that opposite sign.
        viewportRef.current.panBy(-dx, -dy);
        // Cover-fit (see `fitToBounds`) means the city routinely overflows the viewport by
        // design — clamp keeps that overflow recoverable instead of letting a drag pan the city
        // away into void forever. See `clampToBounds`'s doc for the margin and the zoomed-out
        // escape it deliberately doesn't fight.
        viewportRef.current.clampToBounds(cityRef.current.bounds);
        hasUserAdjustedViewportRef.current = true;
        dirtyRef.current = true;
      }
      reportHoverAt(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);

      const viewport = viewportRef.current;
      if (!viewport) return;
      const draggedPastThreshold = pointerMovedPastClickThreshold(
        downX,
        downY,
        event.clientX,
        event.clientY,
        CLICK_DRAG_THRESHOLD_PX,
      );
      if (draggedPastThreshold) return; // end of a pan, not a click — never drop a stop here
      const rect = canvas.getBoundingClientRect();
      viewport.unproject(event.clientX - rect.left, event.clientY - rect.top, hoverScratch);
      onMapClickRef.current?.(lngLatToTuple(hoverScratch));
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
      // See the pan handler above: keeps a zoom-out-then-zoom-back-in gesture from stranding the
      // camera somewhere the earlier pan clamp would have prevented outright.
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

  // Redraw loop: draws when `dirtyRef` is set (resize, pan, zoom, city/overlay-data change, a
  // theme flip) OR while `movingRef` is set (buses are actually running against the clock) — a
  // static map with nothing moving still only repaints on change, never every frame for free.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    const tick = () => {
      const viewport = viewportRef.current;
      if (viewport && (dirtyRef.current || movingRef.current)) {
        dirtyRef.current = false;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCity(ctx, cityRef.current, viewport, minuteOfDayRef.current);
        drawOverlays(ctx, cityRef.current, viewport, {
          lines: linesRef.current,
          stops: stopsRef.current,
          schedules: schedulesRef.current,
          draft: draftRef.current,
          hoverLngLat: hoverLngLatRef.current,
          totalMinutes: totalMinutesRef.current,
        });
        drawMask(ctx, viewport, cityRef.current.bounds, readPaperPalette());
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
