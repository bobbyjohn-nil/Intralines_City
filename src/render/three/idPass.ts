/**
 * The id-buffer pass — renderer-3d.md §3: "every gameplay element is drawn with a flat unique id
 * colour into an offscreen target... Segmentation from the id buffer, colour from the beauty
 * buffer." This is what lets the rendered-pixel contrast tests find "the bus's pixels" without
 * knowing what a bus looks like, and is also the footprint-area gate's data source (DECISIONS #67:
 * "a colour-correct three-pixel bus is the original five-cause bug wearing a green test").
 *
 * Every taggable object registers an `apply`/`restore` pair rather than this module reaching into
 * material internals itself — a lit bus (MeshLambertMaterial, shaded) can't just have its `.color`
 * read back after rendering (lighting would corrupt the id color), so it swaps in a flat unlit
 * proxy instead; an already-unlit data layer (roads, routes, the mask boundary, stop points) just
 * swaps its own `.color`/uniform. Both look identical to this module — it only ever calls the two
 * functions it's handed.
 */

import * as THREE from 'three';
import { idColorToUnitRgb } from './colorSpace';

export interface IdTag {
  readonly idColor: THREE.Color;
  apply(): void;
  restore(): void;
}

/**
 * The id target's texture color space must be set explicitly to `SRGBColorSpace` — a plain
 * `new THREE.WebGLRenderTarget(...)` defaults its texture to `NoColorSpace`, and every built-in
 * material's fragment shader picks its linear->output encode step from the *target's own*
 * `texture.colorSpace` when rendering to an offscreen target (only the default framebuffer uses
 * `renderer.outputColorSpace` directly). Skip this and a material's color is written to the id
 * buffer still in three's internal *linear* representation — every id color reads back far darker
 * than intended (a first-draft version of this file did exactly that: route id `0x400000`, r=64,
 * read back as r=13, the linear value with no sRGB re-encode — caught by `segmentByIdColor` never
 * matching anything). Always build id-pass render targets through this helper, not a bare
 * constructor, so that mistake can't recur silently.
 */
export function createIdRenderTarget(width: number, height: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  return target;
}

export class IdPassRegistry {
  private readonly tags: IdTag[] = [];

  register(tag: IdTag): void {
    this.tags.push(tag);
  }

  /** Renders `scene`/`camera` into `target` with every registered tag's flat id color, restoring
   * beauty-pass state afterward. Allocates nothing per call beyond what `WebGLRenderTarget`
   * readback itself requires — the tag list and every color object are built once at scene-build
   * time (see `three/scene.ts`). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget): void {
    const previousBackground = scene.background;
    scene.background = new THREE.Color(0, 0, 0);
    for (const tag of this.tags) tag.apply();

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);

    for (const tag of this.tags) tag.restore();
    scene.background = previousBackground;
  }
}

/** A tag for any object whose material already exposes a plain `.color: THREE.Color` (unlit data
 * layers: `MeshBasicMaterial`, `LineMaterial`). */
export function colorSwapTag(material: { color: THREE.Color; needsUpdate?: boolean }, idColor: THREE.Color): IdTag {
  const previous = new THREE.Color();
  return {
    idColor,
    apply() {
      previous.copy(material.color);
      material.color.copy(idColor);
      material.needsUpdate = true;
    },
    restore() {
      material.color.copy(previous);
      material.needsUpdate = true;
    },
  };
}

/** Same as `colorSwapTag`, but also forces `opacity` to 1 for the duration of the pass — for
 * translucent unlit fills (water/park polygons), so the id buffer holds the pure id color instead
 * of that color blended against whatever's underneath at the fill's normal beauty-pass alpha,
 * which `segmentByIdColor`'s exact-match tolerance would otherwise miss entirely. */
export function opaqueColorSwapTag(material: { color: THREE.Color; opacity: number }, idColor: THREE.Color): IdTag {
  const previous = new THREE.Color();
  let previousOpacity = 1;
  return {
    idColor,
    apply() {
      previous.copy(material.color);
      previousOpacity = material.opacity;
      material.color.copy(idColor);
      material.opacity = 1;
    },
    restore() {
      material.color.copy(previous);
      material.opacity = previousOpacity;
    },
  };
}

/**
 * Hides an object with no id color of its own for the duration of the pass — the night tint plane
 * is the one user of this today: it isn't a gameplay element the id pass ever needs to segment,
 * but left visible it would composite its translucent color over every *tagged* data layer
 * beneath it (ground/water/parks/roads), corrupting their id-buffer reads at any hour with an
 * active tint. Restores whatever visibility the object actually had (so a mesh already hidden for
 * an unrelated reason — e.g. the night tint at noon, alpha 0 — comes back correctly hidden too).
 */
export function hideDuringPassTag(object: THREE.Object3D): IdTag {
  let previousVisible = object.visible;
  return {
    idColor: new THREE.Color(0, 0, 0),
    apply() {
      previousVisible = object.visible;
      object.visible = false;
    },
    restore() {
      object.visible = previousVisible;
    },
  };
}

/** A tag for a lit object: hides the beauty mesh(es) and shows a flat unlit proxy for the
 * duration of the id pass. */
export function proxyTag(beauty: THREE.Object3D[], proxy: THREE.Object3D, idColor: THREE.Color): IdTag {
  return {
    idColor,
    apply() {
      for (const mesh of beauty) mesh.visible = false;
      proxy.visible = true;
    },
    restore() {
      for (const mesh of beauty) mesh.visible = true;
      proxy.visible = false;
    },
  };
}

/** Reads back an `id * pixelCount` count and the mean beauty-buffer RGB of every pixel matching
 * one id color — the segmentation step every rendered contrast assertion in
 * `contrast.rendered.test.ts` starts from. */
export interface IdSegmentation {
  readonly pixelCount: number;
  readonly meanRgb: readonly [number, number, number];
}

export function segmentByIdColor(
  idBuffer: Uint8Array,
  beautyBuffer: Uint8Array,
  width: number,
  height: number,
  idColor: THREE.Color,
  tolerance = 4,
): IdSegmentation {
  // `idColor` is a `THREE.Color`, whose `.r/.g/.b` are always the *linear* working-space values —
  // never the original sRGB byte a rendered pixel actually holds (see `colorSpace.ts`'s module
  // comment). `idColorToUnitRgb` recovers those original bytes losslessly.
  const [rUnit, gUnit, bUnit] = idColorToUnitRgb(idColor);
  const targetR = Math.round(rUnit * 255);
  const targetG = Math.round(gUnit * 255);
  const targetB = Math.round(bUnit * 255);

  let count = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const pixelCountTotal = width * height;
  for (let i = 0; i < pixelCountTotal; i++) {
    const offset = i * 4;
    const r = idBuffer[offset]!;
    const g = idBuffer[offset + 1]!;
    const b = idBuffer[offset + 2]!;
    if (Math.abs(r - targetR) <= tolerance && Math.abs(g - targetG) <= tolerance && Math.abs(b - targetB) <= tolerance) {
      count++;
      sumR += beautyBuffer[offset]!;
      sumG += beautyBuffer[offset + 1]!;
      sumB += beautyBuffer[offset + 2]!;
    }
  }

  if (count === 0) return { pixelCount: 0, meanRgb: [0, 0, 0] };
  return { pixelCount: count, meanRgb: [sumR / count, sumG / count, sumB / count] };
}
