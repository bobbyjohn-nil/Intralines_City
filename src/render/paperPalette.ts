/**
 * Reads the paper palette from CSS custom properties on `:root` (see `styles.css`), so the
 * offline renderer never hardcodes a hex value and automatically follows light/dark theming.
 *
 * Reads are cached and only redone when the underlying CSS variable strings actually change
 * (theme flip), so a running draw loop does not call `getComputedStyle` or reparse hex strings
 * every frame.
 */

export interface PaperPalette {
  readonly paper: string;
  readonly panel: string;
  readonly ink: string;
  readonly muted: string;
  readonly blue: string;
  readonly amber: string;
  readonly red: string;
}

const CSS_VAR_NAMES = ['paper', 'panel', 'ink', 'muted', 'blue', 'amber', 'red'] as const;

let cachedRaw: string | null = null;
let cachedPalette: PaperPalette | null = null;

/** Fallback palette used only if CSS variables cannot be read at all (e.g. in a headless test). */
const FALLBACK: PaperPalette = {
  paper: '#f6f1e1',
  panel: '#fffdf6',
  ink: '#2c2a24',
  muted: '#7a7259',
  blue: '#1d3f7a',
  amber: '#ffe9a8',
  red: '#c94f35',
};

/** Reads (and caches) the live paper palette. Safe to call every draw — cheap when unchanged. */
export function readPaperPalette(root: HTMLElement = document.documentElement): PaperPalette {
  const computed = getComputedStyle(root);
  let raw = '';
  for (const name of CSS_VAR_NAMES) {
    raw += computed.getPropertyValue(`--${name}`).trim() + '|';
  }
  if (raw === cachedRaw && cachedPalette) {
    return cachedPalette;
  }
  const values = raw.split('|');
  const next: Record<string, string> = {};
  for (let i = 0; i < CSS_VAR_NAMES.length; i++) {
    const name = CSS_VAR_NAMES[i]!;
    const value = values[i];
    next[name] = value && value.length > 0 ? value : FALLBACK[name];
  }
  cachedRaw = raw;
  cachedPalette = next as unknown as PaperPalette;
  return cachedPalette;
}

// ── Color mixing ─────────────────────────────────────────────────────────────

const hexRgbCache = new Map<string, readonly [number, number, number]>();

/** Exported for the WebGL scene's raw shaders (`three/*.ts`): they deliberately bypass
 * `THREE.Color`'s automatic sRGB->linear working-space conversion (see `three/colorSpace.ts`'s
 * module comment) and need this exact 0-255 parse to feed a uniform. */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const cached = hexRgbCache.get(hex);
  if (cached) return cached;
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) {
    h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  }
  const num = Number.parseInt(h, 16);
  const rgb: readonly [number, number, number] = [
    (num >> 16) & 0xff,
    (num >> 8) & 0xff,
    num & 0xff,
  ];
  hexRgbCache.set(hex, rgb);
  return rgb;
}

/** Linearly blends two palette hex colors; `t=0` is `fromHex`, `t=1` is `toHex`. */
export function mixHex(fromHex: string, toHex: string, t: number): string {
  const [r0, g0, b0] = hexToRgb(fromHex);
  const [r1, g1, b1] = hexToRgb(toHex);
  const r = Math.round(r0 + (r1 - r0) * t);
  const g = Math.round(g0 + (g1 - g0) * t);
  const b = Math.round(b0 + (b1 - b0) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** A palette hex color at reduced opacity, for fills that must not compete with linework. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Linearly blends two palette hex colors (`t=0` is `fromHex`, `t=1` is `toHex`, same as `mixHex`)
 * and applies alpha in the same step, returning a ready-to-use `rgba(...)` string. Exists because
 * `mixHex` returns `rgb(...)` (not a hex string), which `withAlpha` cannot parse — chaining
 * `withAlpha(mixHex(...), alpha)` silently breaks on the `rgb(...)` prefix. Both inputs stay plain
 * hex palette colors, so this composes with the same "never an invented hex" rule as `mixHex` and
 * `withAlpha`.
 */
export function mixHexAlpha(fromHex: string, toHex: string, t: number, alpha: number): string {
  const [r0, g0, b0] = hexToRgb(fromHex);
  const [r1, g1, b1] = hexToRgb(toHex);
  const r = Math.round(r0 + (r1 - r0) * t);
  const g = Math.round(g0 + (g1 - g0) * t);
  const b = Math.round(b0 + (b1 - b0) * t);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Forces the next `readPaperPalette()` call to fully re-derive from live CSS, discarding the
 * cached raw-string comparison — call this whenever something *outside* a normal render call
 * might have changed the palette (a theme flip), so the next read can't short-circuit on a stale
 * comparison. `readPaperPalette` itself already re-derives correctly from `getComputedStyle` on
 * every call it's given; what a theme flip is actually missing is someone telling the canvas a
 * redraw is owed at all — see `MapCanvas`'s palette-change watcher, which pairs this with marking
 * the canvas dirty.
 */
export function invalidatePaperPaletteCache(): void {
  cachedRaw = null;
  cachedPalette = null;
}
