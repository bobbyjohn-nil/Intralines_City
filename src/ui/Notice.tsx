/**
 * A transient notice strip for refusals (manual §9: "unroutable clicks are refused with a
 * notice"). `addStop` (`src/game/lines/draft.ts`) returns a reason string instead of silently
 * dropping a click — a road too fast for a stop, an unroutable leg — and this is how the player
 * sees it. Positioned off the document flow so it never shifts anything around it when it shows
 * up or goes away.
 */

import { useEffect, useState } from 'react';
import './Notice.css';

export interface NoticeProps {
  /** The current refusal reason, or `null` when there is nothing to show. Owned by the caller —
   * this component never invents its own message, it only times one out. */
  readonly message: string | null;
  /** Called once the notice should clear, whether from the auto-dismiss timer or a click. The
   * caller is expected to set `message` back to `null` in response. */
  readonly onDismiss: () => void;
}

/** How long a refusal stays up before it clears itself. # tune — the manual states that a notice
 * appears, not how long it lingers. */
const AUTO_DISMISS_MS = 4000;

export function Notice({ message, onDismiss }: NoticeProps) {
  // Keeps rendering the last message through its fade-out, after the caller has already moved
  // `message` back to null — otherwise the exit transition never has anything to animate.
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (message !== null) setShown(message);
  }, [message]);

  useEffect(() => {
    if (message === null) return undefined;
    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  const visible = message !== null;

  return (
    <div className="notice-region">
      {shown !== null && (
        <button
          type="button"
          className={`notice${visible ? ' is-visible' : ''}`}
          role="status"
          aria-live="polite"
          onClick={onDismiss}
          onTransitionEnd={() => {
            if (!visible) setShown(null);
          }}
          aria-label={`Dismiss notice: ${shown}`}
        >
          {shown}
        </button>
      )}
    </div>
  );
}
