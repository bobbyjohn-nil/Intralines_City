/**
 * Owns the `<canvas>` element for the offline basemap: device-pixel-ratio-correct sizing, window
 * resize, mouse drag to pan, wheel to zoom, and a redraw-on-change rAF loop (never redraws a
 * static map for free).
 */

import { useEffect, useRef } from 'react';
import type { City } from '../game/types';
import { drawCity } from './drawCity';
import { Viewport } from './projection';

/** Wheel delta -> zoom factor. Negative deltaY (scroll up) zooms in. TUNE */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

export interface MapCanvasProps {
  readonly city: City;
}

export function MapCanvas({ city }: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const dirtyRef = useRef(true);
  const cityRef = useRef(city);
  cityRef.current = city;

  // Fit the viewport to the city whenever the city itself changes.
  useEffect(() => {
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

  // Sizing: device-pixel-ratio-correct canvas, redrawn (not just resized) on window resize.
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
      if (viewport) {
        viewport.width = cssWidth;
        viewport.height = cssHeight;
      } else {
        viewportRef.current = Viewport.fitToBounds(cityRef.current.bounds, cssWidth, cssHeight);
      }
      dirtyRef.current = true;
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Input: drag to pan, wheel to zoom about the cursor.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || !viewportRef.current) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      // Dragging the map right should slide the world right under the cursor, i.e. pan the
      // viewport center left — panBy takes a screen-space delta of that opposite sign.
      viewportRef.current.panBy(-dx, -dy);
      dirtyRef.current = true;
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      if (!viewportRef.current) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      viewportRef.current.zoomAt(factor, screenX, screenY);
      dirtyRef.current = true;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Redraw loop: only draws when `dirtyRef` is set (resize, pan, zoom, or city change), so a
  // static map does not repaint every frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    const tick = () => {
      const viewport = viewportRef.current;
      if (dirtyRef.current && viewport) {
        dirtyRef.current = false;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCity(ctx, cityRef.current, viewport);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
