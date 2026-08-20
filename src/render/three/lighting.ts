/**
 * The lighting envelope — renderer-3d.md §3: "Hemisphere: sky `--paper` @ 0.55, ground `--muted`
 * @ 0.25. One directional key `#fff8e8` @ 0.45, azimuth follows the clock, elevation clamped
 * >= 25°... No shadow maps." Applies to lit geometry only (buildings, vehicles, depots, stop-tier
 * furniture — DECISIONS #66); every data layer stays `MeshBasicMaterial`-flat and is never lit by
 * this rig.
 */

import * as THREE from 'three';
import {
  HEMI_GROUND_INTENSITY,
  HEMI_SKY_INTENSITY,
  KEY_LIGHT_INTENSITY,
  KEY_LIGHT_MIN_ELEVATION_DEG,
  PHYSICAL_LIGHT_UNIT_SCALE,
} from './constants';
import { MINUTES_PER_DAY } from '../../game/constants';

const DEG_TO_RAD = Math.PI / 180;

export interface LightingRig {
  readonly hemisphere: THREE.HemisphereLight;
  readonly key: THREE.DirectionalLight;
}

/** Builds the two lights once, using live palette hex values (never invented colors — same
 * "palette arithmetic" discipline as every other renderer module). */
export function createLightingRig(paperHex: string, mutedHex: string): LightingRig {
  // `PHYSICAL_LIGHT_UNIT_SCALE` — see its own doc comment in `constants.ts`. The spec's 0.55/0.25/
  // 0.45 are the *documented* multipliers (kept as-is, quoted directly from renderer-3d.md §3);
  // three.js's light intensities since it moved to physically-based units are not a simple "output
  // = base x intensity" multiplier (a Lambertian surface's diffuse response divides irradiance by
  // Ï€), so the numbers actually handed to `THREE.Light` need this compensation for the *documented*
  // multiplier semantics to hold at the framebuffer — verified against the rendered lighting-
  // envelope test, not assumed.
  const hemisphere = new THREE.HemisphereLight(paperHex, mutedHex, HEMI_SKY_INTENSITY * PHYSICAL_LIGHT_UNIT_SCALE);
  // three's HemisphereLight has one intensity, applied to the sky color; the ground contribution
  // is implicit in `groundColor`. To honor two independent intensities (sky 0.55, ground 0.25) the
  // ground color is pre-scaled by the ratio so the *effective* ground contribution matches SPEC
  // exactly, since three has no separate "groundIntensity" uniform.
  const groundColor = new THREE.Color(mutedHex).multiplyScalar(HEMI_GROUND_INTENSITY / HEMI_SKY_INTENSITY);
  hemisphere.groundColor.copy(groundColor);

  const key = new THREE.DirectionalLight(0xfff8e8, KEY_LIGHT_INTENSITY * PHYSICAL_LIGHT_UNIT_SCALE);
  return { hemisphere, key };
}

/**
 * Points the key light's azimuth at the game clock (renderer-3d.md §3: "azimuth follows the
 * clock"), elevation clamped to never drop below `KEY_LIGHT_MIN_ELEVATION_DEG` — "so no raking
 * near-black faces." Pure function of `minuteOfDay` and the light's target distance; called once
 * per redraw, never integrated.
 */
export function updateKeyLightForClock(
  key: THREE.DirectionalLight,
  minuteOfDay: number,
  focus: THREE.Vector3,
  distance = 500,
): void {
  const dayFraction = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY / MINUTES_PER_DAY;
  // Sun-like azimuth sweep: east at sunrise (~0.25 = 06:00), west at sunset (~0.79 = 19:00) — a
  // simple continuous sweep is enough for step 1's flat-parity scene (no shadow maps to sell it
  // further); elevation is a smooth sine bump clamped to the SPEC floor, never literal solar
  // geometry.
  const azimuthRad = dayFraction * Math.PI * 2;
  // Amplitude 45 + offset 45 spans [0, 90] — 90 (straight overhead) at solar noon, 0 at the
  // day/night boundary, then floored to `KEY_LIGHT_MIN_ELEVATION_DEG` below. A first draft used
  // 55/55 (spans [0, 110]), which let the elevation exceed 90 near noon — past-vertical, where
  // `Math.cos(elevationRad)` goes negative and the light silently swings to the opposite azimuth
  // side. Caught by the rendered lighting-envelope test going dark at noon specifically.
  const rawElevationDeg = 45 * Math.sin(dayFraction * Math.PI * 2 - Math.PI / 2) + 45;
  const elevationDeg = Math.max(KEY_LIGHT_MIN_ELEVATION_DEG, rawElevationDeg);
  const elevationRad = elevationDeg * DEG_TO_RAD;

  const horizontal = distance * Math.cos(elevationRad);
  const height = distance * Math.sin(elevationRad);
  key.position.set(
    focus.x + horizontal * Math.sin(azimuthRad),
    focus.y + height,
    focus.z - horizontal * Math.cos(azimuthRad),
  );
  key.target.position.copy(focus);
  key.target.updateMatrixWorld();
}
