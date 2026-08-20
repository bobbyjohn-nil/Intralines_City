/**
 * Bus placeholders — lit 3D geometry (renderer-3d.md §2: vehicles are lit, never a data layer),
 * one box per bus, positioned every frame from `busPositionAt` (a pure function of the game clock
 * — the renderer asks, never integrates). Per renderer-3d.md §6: "A bus before its model loads is
 * a 12.0 x 2.6 x 3.2 m rounded box in the company brand colour with the line stripe down its
 * centreline" — step 1 has no model pipeline yet (that's build-order step 4), so every bus in this
 * scene is permanently the placeholder box.
 *
 * Sizing implements renderer-3d.md §7 cause 1's fix exactly: a per-frame *world-scale* multiplier
 * (`max(1, targetPx / projectedPx)`, capped at `BUS_MAX_EXAGGERATION`) grows the true-scale mesh
 * rather than clamping a screen-space marker, so a bus shrinks realistically with true perspective
 * distance up to the point where it would read as a "sub-1%-speck" and only then gets exaggerated
 * back up to a legible footprint — never the reverse (never *shrunk* below true scale).
 *
 * The outline (cause 2's fix, "a screen-space outline... 1.5 px at a 30 px footprint, in --ink")
 * is a classic inverted-hull: a second, slightly larger, back-face-only copy of the same box in
 * flat `--ink`, rendered behind the real (lit) faces — cheap, per-object, and its scale inherits
 * the same world-scale multiplier so the ratio in the spec holds at every zoom.
 *
 * §7 cause 1, reopened by the step-2 camera unlock: `projectedLengthPx` measures true-world length
 * at a distance as if the bus were always broadside to the camera — true by construction at
 * step 1's locked pitch-0 (looking straight down, the bus's length axis is always perpendicular to
 * the view direction, at any yaw), false the moment pitch is unlocked: a bus heading toward or away
 * from a tilted camera foreshortens in screen space even though its distance is unchanged, and a
 * scalar "length at this distance" estimate has no way to know that. `projectedFootprintPx` below
 * replaces it for the actual scale decision — it projects the bus's real oriented bounding box (at
 * true scale, before any exaggeration) through the camera itself and measures the on-screen extent
 * that results, so foreshortening is measured, not assumed away. `projectedLengthPx` stays exported
 * (still correct at its own stated job, still covered by its own regression test) but is no longer
 * what sizes a bus.
 */

import * as THREE from 'three';
import { BUS_LENGTH_M, BUS_WIDTH_M } from '../style';
import { BUS_MAX_EXAGGERATION, BUS_TARGET_FOOTPRINT_PX, OUTLINE_PX_AT_TARGET_FOOTPRINT, Y_BUS_BASE } from './constants';

const BUS_HEIGHT_M = 3.2;
/** BUS_STRIPE_WIDTH_PX was a Canvas screen-pixel value; see this constant's use below for why the
 * WebGL stripe is sized as a fraction of the bus's own width instead. TUNE */
const STRIPE_WIDTH_FRACTION_OF_BUS_WIDTH = 0.16;

export interface BusInstance {
  readonly group: THREE.Group;
  readonly body: THREE.Mesh;
  readonly stripe: THREE.Mesh;
  readonly outline: THREE.Mesh;
}

export function createBusInstance(bodyColorHex: string, stripeColorHex: string, inkHex: string): BusInstance {
  const group = new THREE.Group();

  const bodyGeometry = new THREE.BoxGeometry(BUS_WIDTH_M, BUS_HEIGHT_M, BUS_LENGTH_M);
  const bodyMaterial = new THREE.MeshLambertMaterial({ color: bodyColorHex });
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.position.y = BUS_HEIGHT_M / 2;

  // Full-length centerline stripe: a thin box sitting proud of the roof, per
  // `studio/GAME.md`: "Buses wear the company brand color with a full-length stripe in the line's
  // color." `BUS_STRIPE_WIDTH_PX` was a Canvas screen-pixel stroke width; here the stripe is real
  // geometry, so it is instead a fixed fraction of the bus's true width — legible at the bus's own
  // scale regardless of camera distance, which a pixel width never was.
  const stripeWidthM = Math.max(0.15, BUS_WIDTH_M * STRIPE_WIDTH_FRACTION_OF_BUS_WIDTH);
  const stripeGeometry = new THREE.BoxGeometry(stripeWidthM, 0.05, BUS_LENGTH_M * 0.98);
  const stripeMaterial = new THREE.MeshLambertMaterial({ color: stripeColorHex });
  const stripe = new THREE.Mesh(stripeGeometry, stripeMaterial);
  stripe.position.y = BUS_HEIGHT_M + 0.03;

  // Inverted-hull outline: same box, scaled up slightly, back faces only, flat unlit ink.
  const outlineGeometry = new THREE.BoxGeometry(BUS_WIDTH_M, BUS_HEIGHT_M, BUS_LENGTH_M);
  const outlineMaterial = new THREE.MeshBasicMaterial({ color: inkHex, side: THREE.BackSide });
  const outline = new THREE.Mesh(outlineGeometry, outlineMaterial);
  outline.position.y = BUS_HEIGHT_M / 2;

  group.add(outline, body, stripe);
  return { group, body, stripe, outline };
}

/**
 * `max(1, targetPx / projectedPx)`, capped at `BUS_MAX_EXAGGERATION` — renderer-3d.md §7 cause 1.
 * `projectedPx` is the bus's true-scale on-screen major-axis footprint at its current distance
 * from the camera, computed by the caller (it needs the camera + viewport, which this pure
 * function deliberately does not take a dependency on).
 */
export function busWorldScaleMultiplier(projectedPx: number): number {
  if (projectedPx <= 0) return BUS_MAX_EXAGGERATION;
  return Math.min(BUS_MAX_EXAGGERATION, Math.max(1, BUS_TARGET_FOOTPRINT_PX / projectedPx));
}

/** True-scale on-screen footprint (px) of a `lengthM`-long object at `distanceM` from the camera,
 * for a camera with vertical FOV `fovDeg` and viewport height `viewportHeightPx`. Pure trig, no
 * three.js dependency, so it's cheap to call once per bus per frame. */
export function projectedLengthPx(lengthM: number, distanceM: number, fovDeg: number, viewportHeightPx: number): number {
  if (distanceM <= 0) return Number.POSITIVE_INFINITY;
  const fovRad = (fovDeg * Math.PI) / 180;
  const pxPerMAtDistance = viewportHeightPx / (2 * distanceM * Math.tan(fovRad / 2));
  return lengthM * pxPerMAtDistance;
}

/** Applies a uniform world-scale multiplier to a bus group, and the matching outline-vs-body
 * ratio from `OUTLINE_PX_AT_TARGET_FOOTPRINT` (renderer-3d.md §7 cause 2). */
export function applyBusScale(instance: BusInstance, multiplier: number): void {
  instance.group.scale.setScalar(multiplier);
  const outlineGrowth = 1 + OUTLINE_PX_AT_TARGET_FOOTPRINT_RATIO;
  instance.outline.scale.setScalar(outlineGrowth);
}

const OUTLINE_PX_AT_TARGET_FOOTPRINT_RATIO = OUTLINE_PX_AT_TARGET_FOOTPRINT / BUS_TARGET_FOOTPRINT_PX;

/** Places and orients a bus group at a local-space `(x, z)`, facing `bearingDeg` (degrees
 * clockwise from north, matching `BusPosition.bearing`). */
export function placeBus(instance: BusInstance, x: number, z: number, bearingDeg: number): void {
  instance.group.position.set(x, Y_BUS_BASE, z);
  instance.group.rotation.y = -(bearingDeg * Math.PI) / 180;
}

// Scratch objects reused across every `projectedFootprintPx` call (renderer-3d.md/GAME.md: no
// per-frame allocation) — this file's one THREE.js-dependent per-frame path.
const footprintScratchMatrix = new THREE.Matrix4();
const footprintScratchVector = new THREE.Vector3();
const FOOTPRINT_CORNER_SIGNS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 0, -1],
  [1, 0, -1],
  [-1, 0, 1],
  [1, 0, 1],
  [-1, 1, -1],
  [1, 1, -1],
  [-1, 1, 1],
  [1, 1, 1],
];

/**
 * The true-scale (unexaggerated) bus's actual on-screen bounding-box major axis, in CSS pixels, as
 * `camera` really sees it — the projection-aware replacement for `projectedLengthPx` (see this
 * module's own doc comment for why a scalar "length at distance" estimate stops being enough once
 * pitch is unlocked). Projects all 8 corners of the true-size box at its real world position and
 * heading through `camera`'s own projection matrix; the larger of the resulting screen-space width/
 * height spans is the number `busWorldScaleMultiplier` should exaggerate against.
 */
export function projectedFootprintPx(
  camera: THREE.Camera,
  worldX: number,
  worldZ: number,
  bearingDeg: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
): number {
  footprintScratchMatrix.makeRotationY(-(bearingDeg * Math.PI) / 180); // matches `placeBus`
  footprintScratchMatrix.setPosition(worldX, Y_BUS_BASE, worldZ);

  const halfLength = BUS_LENGTH_M / 2;
  const halfWidth = BUS_WIDTH_M / 2;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [signX, signY, signZ] of FOOTPRINT_CORNER_SIGNS) {
    footprintScratchVector.set(signX * halfWidth, signY * BUS_HEIGHT_M, signZ * halfLength);
    footprintScratchVector.applyMatrix4(footprintScratchMatrix);
    footprintScratchVector.project(camera);
    const screenX = (footprintScratchVector.x * 0.5 + 0.5) * viewportWidthPx;
    const screenY = (1 - (footprintScratchVector.y * 0.5 + 0.5)) * viewportHeightPx;
    if (screenX < minX) minX = screenX;
    if (screenX > maxX) maxX = screenX;
    if (screenY < minY) minY = screenY;
    if (screenY > maxY) maxY = screenY;
  }
  return Math.max(maxX - minX, maxY - minY);
}
