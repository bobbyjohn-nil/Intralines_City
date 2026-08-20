import { describe, expect, it } from 'vitest';
import type { PaperPalette } from './paperPalette';
import { getBusStripeColor, getLineColor } from './lineColors';
import { LINE_COLOR_MIX_STOPS } from './style';

// Same fallback palette `paperPalette.ts` uses when CSS custom properties aren't available — lets
// these tests call palette-consuming helpers directly, no DOM required.
const PALETTE: PaperPalette = {
  paper: '#f6f1e1',
  panel: '#fffdf6',
  ink: '#2c2a24',
  muted: '#7a7259',
  blue: '#1d3f7a',
  amber: '#ffe9a8',
  red: '#c94f35',
};

// Contrast/legibility claims about these colors (bus-vs-paper, bus-vs-road, bus-vs-route, stripe-
// vs-route RGB distance) moved to `three/contrast.rendered.test.ts` — renderer-3d.md §3: those
// assertions compared *intended* fill colors, which stopped being trustworthy the moment lighting
// entered the picture. What's left here is pure logic: determinism, cycling, and output format —
// still exactly true regardless of renderer.

describe('getLineColor', () => {
  it('is deterministic for a given palette and line id', () => {
    expect(getLineColor(PALETTE, 3)).toBe(getLineColor(PALETTE, 3));
  });

  it('cycles rather than repeating the same color for every line', () => {
    const colors = new Set(Array.from({ length: 8 }, (_, id) => getLineColor(PALETTE, id)));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('wraps around for ids beyond the cycle length the same as their modulo', () => {
    for (let id = 0; id < 8; id++) {
      expect(getLineColor(PALETTE, id)).toBe(getLineColor(PALETTE, id + 800));
    }
  });

  it('never invents a color outside the palette-mix format (always an rgb(...) string)', () => {
    for (let id = 0; id < 8; id++) {
      expect(getLineColor(PALETTE, id)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    }
  });
});

describe('getBusStripeColor', () => {
  it('is deterministic and cycles the same way getLineColor does', () => {
    expect(getBusStripeColor(PALETTE, 3)).toBe(getBusStripeColor(PALETTE, 3));
    for (let id = 0; id < LINE_COLOR_MIX_STOPS.length; id++) {
      expect(getBusStripeColor(PALETTE, id)).toBe(getBusStripeColor(PALETTE, id + LINE_COLOR_MIX_STOPS.length * 100));
    }
  });

  it('never invents a color outside the palette-mix format (always an rgb(...) string)', () => {
    for (let id = 0; id < LINE_COLOR_MIX_STOPS.length; id++) {
      expect(getBusStripeColor(PALETTE, id)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    }
  });

  it('differs from getLineColor for the same id (never literally the route color — the structural ' +
    'half of the camouflage fix; the measured-distance half is asserted on rendered pixels now)', () => {
    for (let id = 0; id < LINE_COLOR_MIX_STOPS.length; id++) {
      expect(getBusStripeColor(PALETTE, id)).not.toBe(getLineColor(PALETTE, id));
    }
  });
});
