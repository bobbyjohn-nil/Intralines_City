/**
 * The depot glyph — a yard building, gabled roof over a bay door. Same hand as `Bus.tsx`: thin
 * `currentColor` stroke on a 16×16 grid, cut plain enough to survive at dock-icon size (no
 * corrugation lines, no window, just roof / walls / bay). Shared by the dock's "Place depot"
 * entry and the depot panel's header — the two places a depot needs a glyph rather than a name.
 */

export interface DepotIconProps {
  readonly size?: number;
  readonly title?: string;
}

export function Depot({ size = 16, title }: DepotIconProps) {
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
        d="M1.6 6.8 L8 2 L14.4 6.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.4 6.6 L2.4 13.3 L13.6 13.3 L13.6 6.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 13.3 L6 9.6 L10 9.6 L10 13.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
