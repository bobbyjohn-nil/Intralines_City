/**
 * The out-of-bounds mask and dashed playable-area boundary — screen-space (world position, unlit,
 * depth test off), drawn last, above everything (renderer-3d.md §2 and §7's "also carried over":
 * "the strict draw-order contract (mask last, above everything)").
 *
 * Implemented as one large flat quad, high above the rest of the scene (`Y_MASK`), whose fragment
 * shader tests each pixel's own world XZ against the city bounds rectangle: inside bounds it
 * discards (the mask is invisible over the playable area, letting every layer beneath show
 * through untouched); outside it shades `--muted` at `MASK_ALPHA`. Depth test is off so it always
 * wins regardless of what else is drawn at that pixel, matching the Canvas renderer's "always
 * paint the mask last" contract exactly. The quad is sized generously beyond the city's own bounds
 * (`MASK_QUAD_MARGIN_MULTIPLIER`) so it still covers the visible ground at every camera state this
 * step 1 scene's locked top-down camera and clamped pan can reach; a step 2 camera unlock (free
 * pan/zoom range) should re-check this margin against the wider range it introduces.
 *
 * The dashed boundary itself is a separate `Line2` loop at the same elevation, `worldUnits: true`,
 * with `dashed: true` — real geometry, not a Canvas-style stroke, but the same visual contract.
 */

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Bounds } from '../../game/types';
import type { LocalOrigin } from './localProjection';
import { toLocalXZ } from './localProjection';
import { MASK_ALPHA, MASK_DASH_PATTERN, MASK_DASH_WIDTH_PX } from '../style';
import { Y_MASK } from './constants';
import { hexToUnitRgb } from './colorSpace';

/** How far beyond the city's own bounding box the mask quad extends, as a multiple of the bounds
 * diagonal — generous headroom for step 1's clamped pan/zoom range (see this module's doc
 * comment). TUNE */
export const MASK_QUAD_MARGIN_MULTIPLIER = 25;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vLocalXZ;
  void main() {
    vLocalXZ = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vLocalXZ;
  uniform vec2 uBoundsMinXZ;
  uniform vec2 uBoundsMaxXZ;
  uniform vec3 uMaskColor;
  uniform float uMaskAlpha;
  void main() {
    bool insideBounds =
      vLocalXZ.x >= uBoundsMinXZ.x && vLocalXZ.x <= uBoundsMaxXZ.x &&
      vLocalXZ.y >= uBoundsMinXZ.y && vLocalXZ.y <= uBoundsMaxXZ.y;
    if (insideBounds) discard;
    gl_FragColor = vec4(uMaskColor, uMaskAlpha);
  }
`;

export interface MaskLayer {
  readonly group: THREE.Group;
  readonly boundaryMaterial: LineMaterial;
  /** The void-fill quad's own raw shader material — exposed so `three/scene.ts` can register an
   * id-pass tag for it (the void-share gate segments *this* fill, not the thin dashed boundary). */
  readonly quadMaterial: THREE.ShaderMaterial;
}

export function buildMaskLayer(bounds: Bounds, origin: LocalOrigin, mutedHex: string, inkHex: string): MaskLayer {
  const group = new THREE.Group();

  const [minX, minZ] = toLocalXZ(origin, [bounds.west, bounds.north]);
  const [maxX, maxZ] = toLocalXZ(origin, [bounds.east, bounds.south]);
  const boundsMinX = Math.min(minX, maxX);
  const boundsMaxX = Math.max(minX, maxX);
  const boundsMinZ = Math.min(minZ, maxZ);
  const boundsMaxZ = Math.max(minZ, maxZ);
  const diagonal = Math.hypot(boundsMaxX - boundsMinX, boundsMaxZ - boundsMinZ);
  const half = Math.max(diagonal * MASK_QUAD_MARGIN_MULTIPLIER, 1000);

  const [muR, muG, muB] = hexToUnitRgb(mutedHex);
  const quadGeometry = new THREE.PlaneGeometry(half * 2, half * 2);
  quadGeometry.rotateX(-Math.PI / 2);
  const quadMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uBoundsMinXZ: { value: new THREE.Vector2(boundsMinX, boundsMinZ) },
      uBoundsMaxXZ: { value: new THREE.Vector2(boundsMaxX, boundsMaxZ) },
      uMaskColor: { value: new THREE.Vector3(muR, muG, muB) },
      uMaskAlpha: { value: MASK_ALPHA },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(quadGeometry, quadMaterial);
  quad.position.set(0, Y_MASK, 0);
  quad.renderOrder = 1000;
  group.add(quad);

  const corners = [
    [boundsMinX, Y_MASK, boundsMinZ],
    [boundsMaxX, Y_MASK, boundsMinZ],
    [boundsMaxX, Y_MASK, boundsMaxZ],
    [boundsMinX, Y_MASK, boundsMaxZ],
    [boundsMinX, Y_MASK, boundsMinZ],
  ];
  const positions = corners.flat();
  const boundaryGeometry = new LineGeometry();
  boundaryGeometry.setPositions(positions);
  const boundaryMaterial = new LineMaterial({
    color: inkHex,
    worldUnits: true,
    linewidth: MASK_DASH_WIDTH_PX,
    dashed: true,
    dashSize: MASK_DASH_PATTERN[0] ?? 8,
    gapSize: MASK_DASH_PATTERN[1] ?? 6,
    resolution: new THREE.Vector2(1, 1),
  });
  const boundary = new Line2(boundaryGeometry, boundaryMaterial);
  boundary.computeLineDistances();
  boundary.renderOrder = 1001;
  group.add(boundary);

  return { group, boundaryMaterial, quadMaterial };
}

/** Recomputes the dashed boundary's world-space dash/gap/width from the current `pxPerM` — on
 * zoom change only, same discipline as `lineLayers.ts`'s road/route widths. */
export function updateMaskBoundaryScale(layer: MaskLayer, pxPerM: number): void {
  layer.boundaryMaterial.linewidth = MASK_DASH_WIDTH_PX / pxPerM;
  layer.boundaryMaterial.dashSize = (MASK_DASH_PATTERN[0] ?? 8) / pxPerM;
  layer.boundaryMaterial.gapSize = (MASK_DASH_PATTERN[1] ?? 6) / pxPerM;
}
