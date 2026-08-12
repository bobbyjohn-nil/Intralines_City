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

function hexToRgb(hex: string): readonly [number, number, number] {
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
