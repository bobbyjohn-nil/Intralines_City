/**
 * Color-space handling for the WebGL scene — read this before adding any new material.
 *
 * three.js's `THREE.Color` (and any built-in material's `color` property) converts a hex/CSS
 * string from sRGB into three's internal *linear* working color space, then a built-in material's
 * fragment shader converts back to `renderer.outputColorSpace` (SRGB, per renderer-3d.md §3) via
 * the `colorspace_fragment` chunk. That round trip is what built-in materials (`MeshBasicMaterial`
 * for water/park fills, `LineMaterial` for roads/routes, `MeshLambertMaterial` for lit buses) get
 * for free, and it is what keeps DECISIONS #66 true for them: hex in, (approximately) the same
 * pixel out.
 *
 * This game's own raw `THREE.ShaderMaterial`s (stop markers, the night tint, the out-of-bounds
 * mask) do **not** go through that chunk — they write `gl_FragColor` directly. If their uniforms
 * were built via `new THREE.Color(hex)` (linear-converted) but the fragment shader never converts
 * back, the rendered pixel would be measurably darker than the palette color the test asserts
 * against, silently breaking the "rendered pixel equals intended color" contract. So every raw
 * shader in this scene is fed **unconverted 0–1 sRGB fractions** via this helper, and writes them
 * to `gl_FragColor` with no further transform — output identically matches the built-in-material
 * path (both end up sRGB-encoded going into the same output framebuffer) without the linear
 * round trip in between.
 */

import * as THREE from 'three';
import { hexToRgb } from '../paperPalette';

export function hexToUnitRgb(hex: string): readonly [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/** Same as `hexToUnitRgb` but for the `rgb(r, g, b)` strings `mixHex`/`getLineColor`/
 * `getBusStripeColor` produce. */
export function rgbStringToUnitRgb(rgbString: string): readonly [number, number, number] {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgbString);
  if (!match) throw new Error(`not an rgb()/rgba() string: ${rgbString}`);
  return [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255];
}

/**
 * The id-buffer palette (`three/constants.ts`'s `ID_COLOR_*`) is built as `THREE.Color` instances
 * so it can be handed straight to `material.color.copy(...)` for built-in-material tags
 * (`idPass.ts`'s `colorSwapTag`) — that path is correct as-is (see this module's doc comment: a
 * built-in material's own shader does the linear->sRGB round trip). But `THREE.Color` always
 * stores its *internal* `.r/.g/.b` in the linear working color space, never the original sRGB
 * bytes — reading them back directly (as either a raw-shader uniform, per this module's rule, or
 * as the "what byte value should the id pass have produced" target a test compares
 * `readPixels()` output against) silently uses the wrong, gamma-shifted numbers. This recovers the
 * *original* sRGB bytes losslessly via `getHex(SRGBColorSpace)` (the exact inverse of the default
 * `setHex`/constructor conversion) rather than reading `.r/.g/.b` directly — use it anywhere an id
 * color needs to become "the byte value a pixel should equal," on either side of that comparison.
 */
export function idColorToUnitRgb(idColor: THREE.Color): readonly [number, number, number] {
  const hex = idColor.getHex(THREE.SRGBColorSpace);
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}
