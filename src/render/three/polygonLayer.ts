/**
 * Water and park polygon layers — unlit, flat-filled, one merged `BufferGeometry` per layer (one
 * draw call), matching the Canvas renderer's "one `fill()` call per layer" discipline (GAME.md:
 * "one draw call per class"). Triangulated via `THREE.ShapeGeometry` (ear clipping); city scenery
 * polygons are simple closed rings (never self-intersecting, per `game/types.ts`'s `Polygon` doc),
 * which is exactly what that triangulator expects.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Polygon } from '../../game/types';
import type { LocalOrigin } from './localProjection';
import { toLocalXZ } from './localProjection';

/** Builds one merged, unlit mesh for a set of polygons (water or parks) at a fixed elevation. */
export function buildPolygonLayerMesh(
  polygons: readonly Polygon[],
  origin: LocalOrigin,
  elevationY: number,
  color: string,
  opacity: number,
): THREE.Mesh | null {
  const geometries: THREE.BufferGeometry[] = [];
  const scratch: [number, number] = [0, 0];

  for (const polygon of polygons) {
    if (polygon.length < 3) continue;
    const shape = new THREE.Shape();
    const [x0, z0] = toLocalXZ(origin, polygon[0]!, scratch);
    // THREE.Shape lives in an XY plane; Z (our "north/south") maps to the shape's Y so the
    // triangulation happens in the same orientation we project into, then the geometry is rotated
    // flat (rotateX(-90deg)) below.
    shape.moveTo(x0, z0);
    for (let i = 1; i < polygon.length; i++) {
      const [x, z] = toLocalXZ(origin, polygon[i]!, scratch);
      shape.lineTo(x, z);
    }
    shape.closePath();

    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2);
    // ShapeGeometry triangulates in the XY plane winding CCW for a positively-oriented polygon; the
    // 90deg rotateX above flips the effective winding as seen from +Y (looking down), which would
    // otherwise backface-cull every polygon under a camera looking straight down. Flip explicitly.
    geometry.scale(1, 1, -1);
    geometry.translate(0, elevationY, 0);
    geometries.push(geometry);
  }

  if (geometries.length === 0) return null;

  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) return null;

  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(merged, material);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
