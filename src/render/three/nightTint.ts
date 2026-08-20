/**
 * The day/night tint — a translucent plane sitting between the road layer (`Y_ROAD`) and the route
 * layer (`Y_ROUTE`) so it composites over the basemap (ground/water/parks/roads) but never over
 * routes, stops or buses, exactly matching the Canvas renderer's draw order ("the tint is
 * composited after the basemap... gameplay overlays... are drawn after this" — `drawCity.ts`'s old
 * module comment) without needing a second render pass: ordinary depth testing against the opaque
 * basemap beneath it does the compositing, and routes/stops/buses simply sit at a higher elevation
 * than the tint plane so they depth-test in front of it, untinted.
 *
 * Sized the same generous multiple of the city bounds diagonal as the out-of-bounds mask quad —
 * see `maskLayer.ts`'s doc comment for the same step-1-only caveat.
 */

import * as THREE from 'three';
import type { Bounds } from '../../game/types';
import type { LocalOrigin } from './localProjection';
import { toLocalXZ } from './localProjection';
import { MASK_QUAD_MARGIN_MULTIPLIER } from './maskLayer';
import { Y_NIGHT_TINT } from './constants';

export interface NightTintLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
}

export function buildNightTintLayer(bounds: Bounds, origin: LocalOrigin): NightTintLayer {
  const [minX, minZ] = toLocalXZ(origin, [bounds.west, bounds.north]);
  const [maxX, maxZ] = toLocalXZ(origin, [bounds.east, bounds.south]);
  const diagonal = Math.hypot(maxX - minX, maxZ - minZ);
  const half = Math.max(diagonal * MASK_QUAD_MARGIN_MULTIPLIER, 1000);

  const geometry = new THREE.PlaneGeometry(half * 2, half * 2);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, Y_NIGHT_TINT, 0);
  mesh.visible = false;
  return { mesh, material };
}

/** Applies `getTimeOfDayTint`'s result — a no-op (invisible mesh) at alpha 0, so noon pays nothing
 * beyond a single boolean check. */
export function setNightTint(layer: NightTintLayer, colorRgb: readonly [number, number, number], alpha: number): void {
  if (alpha <= 0) {
    layer.mesh.visible = false;
    return;
  }
  layer.mesh.visible = true;
  layer.material.color.setRGB(colorRgb[0], colorRgb[1], colorRgb[2], THREE.SRGBColorSpace);
  layer.material.opacity = alpha;
}
