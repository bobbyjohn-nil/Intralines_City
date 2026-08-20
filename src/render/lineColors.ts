/**
 * Line and bus color cycling — pure palette arithmetic, unchanged by the move to WebGL (renderer-
 *3d.md §3: "the palette itself... keep working unchanged"). A route ribbon and a bus stripe are
 * unlit data layers (DECISIONS #66), so whatever `getLineColor`/`getBusStripeColor` compute here
 * *is* the rendered pixel color, exactly like it was under Canvas 2D.
 */

import { mixHex, type PaperPalette } from './paperPalette';
import { BUS_BODY_COLOR_MIX, BUS_STRIPE_CONTRAST_MIX_T, LINE_COLOR_MIX_STOPS } from './style';

// ── Line color cycle ─────────────────────────────────────────────────────────

const lineColorCache = new WeakMap<PaperPalette, readonly string[]>();

function getLineColorPalette(palette: PaperPalette): readonly string[] {
  let colors = lineColorCache.get(palette);
  if (!colors) {
    colors = LINE_COLOR_MIX_STOPS.map(([from, to, t]) => mixHex(palette[from], palette[to], t));
    lineColorCache.set(palette, colors);
  }
  return colors;
}

/** The stroke color for line `lineId`, cycling through `LINE_COLOR_MIX_STOPS` so consecutive
 * lines stay visually distinct. */
export function getLineColor(palette: PaperPalette, lineId: number): string {
  const colors = getLineColorPalette(palette);
  const index = ((lineId % colors.length) + colors.length) % colors.length;
  return colors[index]!;
}

// ── Bus stripe color (contrast-tinted, never identical to the route it rides on) ────────────────
// See `BUS_STRIPE_CONTRAST_MIX_T`'s doc comment in `style.ts` for the full playtest-fix rationale:
// the stripe must never render in the exact color of the route beneath the bus, or the vehicle's
// own centerline optically fuses with its route (DECISIONS #62, cause 4 — "survives, harder" under
// lighting per renderer-3d.md §7).

const RGB_PATTERN = /^rgb\((\d+), (\d+), (\d+)\)$/;

function parseRgb(color: string): readonly [number, number, number] {
  const match = RGB_PATTERN.exec(color);
  if (!match) throw new Error(`not an rgb(...) string produced by mixHex: ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function mixRgb(from: string, to: string, t: number): string {
  const [r0, g0, b0] = parseRgb(from);
  const [r1, g1, b1] = parseRgb(to);
  const r = Math.round(r0 + (r1 - r0) * t);
  const g = Math.round(g0 + (g1 - g0) * t);
  const b = Math.round(b0 + (b1 - b0) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

const busStripeColorCache = new WeakMap<PaperPalette, readonly string[]>();

function getBusStripeColorPalette(palette: PaperPalette): readonly string[] {
  let colors = busStripeColorCache.get(palette);
  if (!colors) {
    const panel = mixHex(palette.panel, palette.panel, 0); // palette.panel as an rgb(...) string
    colors = getLineColorPalette(palette).map((routeColor) =>
      mixRgb(routeColor, panel, BUS_STRIPE_CONTRAST_MIX_T),
    );
    busStripeColorCache.set(palette, colors);
  }
  return colors;
}

/** The bus centerline stripe color for line `lineId` — a `--panel`-tinted variant of
 * `getLineColor(palette, lineId)`, deliberately *not* identical to the route color it rides on. */
export function getBusStripeColor(palette: PaperPalette, lineId: number): string {
  const colors = getBusStripeColorPalette(palette);
  const index = ((lineId % colors.length) + colors.length) % colors.length;
  return colors[index]!;
}

// ── Bus body color ────────────────────────────────────────────────────────────

const busBodyColorCache = new WeakMap<PaperPalette, string>();

/** The bus "company brand" placeholder color (`studio/GAME.md`: "Buses wear the company brand
 * color..."). Until the fleet/livery system exists, every bus shares this one palette-derived
 * color — see `BUS_BODY_COLOR_MIX`'s doc comment in `style.ts`. */
export function getBusBodyColor(palette: PaperPalette): string {
  let color = busBodyColorCache.get(palette);
  if (!color) {
    color = mixHex(palette.muted, palette.amber, BUS_BODY_COLOR_MIX);
    busBodyColorCache.set(palette, color);
  }
  return color;
}

/** Parses any `rgb(r, g, b)` / `rgba(r, g, b, a)` string this module or `mixHex` can produce back
 * into plain components — shared by every rendered-pixel and intended-color consumer so nobody
 * hand-rolls a second regex. */
export function parseRgbString(css: string): readonly [number, number, number] {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!match) throw new Error(`not an rgb()/rgba() string: ${css}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
