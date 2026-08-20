/**
 * Stop markers — screen-space billboards, pixel-sized regardless of camera distance, drawn unlit
 * with depth test off (renderer-3d.md §2: "Screen-space... stop markers... drawn in an unlit pass
 * with depth test off"). One `THREE.Points` draw call for every stop (fill + `--ink` ring, same
 * fill-plus-stroke idiom the Canvas renderer used), radius set per-vertex by `gl_PointSize` so the
 * whole layer updates from a single uniform on zoom change — never rebuilt per frame.
 */

import * as THREE from 'three';
import { STOP_OUTLINE_WIDTH_PX } from '../style';
import { hexToUnitRgb } from './colorSpace';

const VERTEX_SHADER = /* glsl */ `
  uniform float uRadiusPx;
  uniform float uDpr;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = uRadiusPx * 2.0 * uDpr;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uFillColor;
  uniform vec3 uOutlineColor;
  uniform float uOutlineFraction;
  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float dist = length(centered) * 2.0; // 0 at center, 1 at the circle's edge
    if (dist > 1.0) discard;
    vec3 color = dist > (1.0 - uOutlineFraction) ? uOutlineColor : uFillColor;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export interface StopMarkerLayer {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  setPositions(positions: Float32Array): void;
}

export function createStopMarkerLayer(panelHex: string, inkHex: string): StopMarkerLayer {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));

  const [fr, fg, fb] = hexToUnitRgb(panelHex);
  const [or_, og, ob] = hexToUnitRgb(inkHex);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uRadiusPx: { value: 6 },
      uDpr: { value: 1 },
      uFillColor: { value: new THREE.Vector3(fr, fg, fb) },
      uOutlineColor: { value: new THREE.Vector3(or_, og, ob) },
      uOutlineFraction: { value: 0.2 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
    transparent: false,
  });
  // STOP_OUTLINE_WIDTH_PX is a fixed ring width in the Canvas version; expressed here as a fraction
  // of the current radius so it stays visible at both the min and max marker radius. Recomputed
  // whenever `setRadiusPx` runs (see caller).
  material.userData.outlineWidthPx = STOP_OUTLINE_WIDTH_PX;

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;

  return {
    points,
    material,
    setPositions(positions: Float32Array) {
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.attributes.position!.needsUpdate = true;
      geometry.computeBoundingSphere();
    },
  };
}

export function setStopRadiusPx(layer: StopMarkerLayer, radiusPx: number, dpr: number): void {
  layer.material.uniforms.uRadiusPx!.value = radiusPx;
  layer.material.uniforms.uDpr!.value = dpr;
  const outlinePx: number = layer.material.userData.outlineWidthPx ?? STOP_OUTLINE_WIDTH_PX;
  layer.material.uniforms.uOutlineFraction!.value = radiusPx > 0 ? Math.min(0.6, outlinePx / radiusPx) : 0;
}
