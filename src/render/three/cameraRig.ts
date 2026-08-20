/**
 * Camera math — renderer-3d.md §1. "Camera distance is derived, never stored:
 * `d = (viewportHeightPx / 2) / (pxPerM · tan(FOV/2))`. So 'zoom' keeps meaning metres-per-pixel
 * *at the focus point*, and every number tuned against the Canvas renderer transfers unchanged."
 *
 * Step 1 (renderer-3d.md §8): pitch locked at 0°, yaw locked at 0° (north up, camera looks
 * straight down). Step 2 unlocks both — this module already takes pitch/yaw parameters so that
 * unlock is a camera-rig change only, not a rebuild of this math.
 */

import * as THREE from 'three';
import { CAMERA_FOV_DEG, CAMERA_PITCH_DEG, CAMERA_YAW_DEG } from './constants';
import type { LocalOrigin } from './localProjection';
import { toLocalXZ } from './localProjection';
import type { Viewport } from '../projection';

const DEG_TO_RAD = Math.PI / 180;
const HALF_FOV_RAD = (CAMERA_FOV_DEG / 2) * DEG_TO_RAD;

/** Camera distance from the ground-plane focus point, for a viewport `heightPx` tall at `pxPerM`
 * metres-per-pixel — the exact formula in renderer-3d.md §1. */
export function cameraDistanceM(viewportHeightPx: number, pxPerM: number): number {
  return viewportHeightPx / 2 / (pxPerM * Math.tan(HALF_FOV_RAD));
}

/** Builds the camera once. `updateCameraRig` positions/aims it every frame after — see below. */
export function createCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.1, 1_000_000);
  return camera;
}

const focusScratch: [number, number] = [0, 0];

/**
 * Positions/aims `camera` from `viewport`'s current center/zoom — pure function of `viewport` and
 * `origin`, called once per redraw (not integrated), same "ask, never integrate" discipline as
 * `busPositionAt`. `pitchDeg`/`yawDeg` default to the step-1 locked values; step 2 passes live
 * values from the orbit controls instead.
 */
export function updateCameraRig(
  camera: THREE.PerspectiveCamera,
  viewport: Viewport,
  origin: LocalOrigin,
  pitchDeg: number = CAMERA_PITCH_DEG,
  yawDeg: number = CAMERA_YAW_DEG,
): void {
  const pxPerM = viewport.scale();
  const distance = cameraDistanceM(viewport.height, pxPerM);
  const [focusX, focusZ] = toLocalXZ(origin, [viewport.centerLng, viewport.centerLat], focusScratch);

  const pitchRad = pitchDeg * DEG_TO_RAD;
  const yawRad = yawDeg * DEG_TO_RAD;

  // Spherical offset from the focus point: pitch measured from nadir (0 = straight down), yaw
  // measured clockwise from north (matches `BusPosition.bearing`'s convention).
  const horizontalDistance = distance * Math.sin(pitchRad);
  const height = distance * Math.cos(pitchRad);
  const offsetX = horizontalDistance * Math.sin(yawRad);
  const offsetZ = -horizontalDistance * Math.cos(yawRad);

  camera.position.set(focusX + offsetX, height, focusZ + offsetZ);
  camera.up.set(Math.sin(yawRad) * Math.sin(pitchRad), Math.cos(pitchRad), -Math.cos(yawRad) * Math.sin(pitchRad));
  // At pitch 0 the up vector above degenerates toward (0,1,0), which is parallel to the (0,-1,0)
  // view direction — fall back to the north-up convention `localProjection.ts` documents.
  if (pitchDeg === 0) camera.up.set(0, 0, -1);
  camera.lookAt(focusX, 0, focusZ);

  const aspect = viewport.width / viewport.height;
  if (camera.aspect !== aspect) {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}
