import { describe, expect, it } from 'vitest';
import { mixHex, mixHexAlpha, withAlpha } from './paperPalette';

const AMBER = '#ffe9a8';
const MUTED = '#7a7259';

function parseRgba(color: string): { r: number; g: number; b: number; a: number } {
  const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
  if (!match) throw new Error(`unparseable color: ${color}`);
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: Number(match[4]),
  };
}

describe('mixHexAlpha', () => {
  it('matches mixHex at the same t, with alpha appended', () => {
    const mixed = parseRgba(mixHex(AMBER, MUTED, 0.55).replace('rgb(', 'rgba(').replace(')', ', 0.5)'));
    const direct = parseRgba(mixHexAlpha(AMBER, MUTED, 0.55, 0.5));
    expect(direct.r).toBe(mixed.r);
    expect(direct.g).toBe(mixed.g);
    expect(direct.b).toBe(mixed.b);
    expect(direct.a).toBe(0.5);
  });

  it('t=0 equals fromHex, t=1 equals toHex, with the requested alpha', () => {
    const from = parseRgba(mixHexAlpha(AMBER, MUTED, 0, 0.3));
    expect(from).toEqual({ r: 255, g: 233, b: 168, a: 0.3 });

    const to = parseRgba(mixHexAlpha(AMBER, MUTED, 1, 0.3));
    expect(to).toEqual({ r: 122, g: 114, b: 89, a: 0.3 });
  });

  it('does not suffer the rgb()-into-hex-parser bug that withAlpha(mixHex(...), a) would hit', () => {
    // withAlpha expects a hex string; feeding it mixHex's `rgb(r, g, b)` output parses garbage
    // (Number.parseInt on a non-hex string) rather than throwing, which is exactly why
    // mixHexAlpha exists as a single-step alternative. This test pins the correct output so a
    // future refactor can't reintroduce the two-step chain silently.
    const broken = withAlpha(mixHex(AMBER, MUTED, 0.55), 0.5);
    const correct = mixHexAlpha(AMBER, MUTED, 0.55, 0.5);
    expect(broken).not.toBe(correct);
  });
});
