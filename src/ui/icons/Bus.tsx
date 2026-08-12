/**
 * The canonical bus (manual §22, "one bus drawing reused from favicon to fleet list to loading
 * screen"). This is that drawing. Every place the game needs a bus glyph in its chrome — the
 * favicon, the fleet list, the boot splash (manual §2) — renders this same component (or, for the
 * favicon, the same path data copied into a standalone document; see `favicon.svg` in this
 * folder) rather than a fresh interpretation.
 *
 * Side profile, flat front (no hood — that's what keeps it reading as a transit bus rather than a
 * school bus), raked windshield, flat roof, flat undercarriage. Two filled wheel dots reuse the
 * same "thin stroke path + filled circle" hand established by `DrawLineIcon` in Dock.tsx, just
 * applied to wheels instead of stop markers.
 *
 * Deliberately cut so the silhouette survives at 16 px (manual §2's favicon size): no window
 * mullions, no wheel spokes, no door seam, no destination-sign box. At 16 px those become a smear
 * of sub-pixel strokes that cost legibility for zero silhouette gain — the long low box with a
 * raked front and two wheels is what reads as "bus" at a glance, and that's all this drawing is.
 */

export interface BusIconProps {
  /** Rendered width and height in px. The drawing is authored on a 16×16 grid — the same grid
   * Dock.tsx's icons use — and scales cleanly up for the fleet list or a loading-screen splash. */
  readonly size?: number;
  /** Accessible name. Omit for a purely decorative placement (the icon is `aria-hidden` in that
   * case); pass one wherever the bus is the only content conveying meaning. */
  readonly title?: string;
}

export function Bus({ size = 16, title }: BusIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M2.3 9.5 L2.3 4.7 L11.1 4.7 L13.5 7.2 L13.5 9.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="4.8" cy="10.8" r="1.3" fill="currentColor" />
      <circle cx="11.3" cy="10.8" r="1.3" fill="currentColor" />
    </svg>
  );
}
