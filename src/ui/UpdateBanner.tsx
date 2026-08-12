/**
 * The "New version available" banner (manual §2: "A tab left open across a release shows a dark
 * 'New version available' banner in play — Reload / Not now — your company is saved before
 * reloading"). Consumes `useServiceWorkerUpdate()`; see that hook's TODO for the full contract.
 *
 * This is the in-play path only — a player-initiated Reload, never automatic. The menu's own
 * auto-update path (manual §2: "on the menu it updates itself automatically") calls
 * `applyUpdate({ auto: true })` directly and does not render this banner at all; there is no home
 * menu yet, so that path has nowhere to attach (see the mount comment in App.tsx).
 *
 * "Not now" hides the banner for the rest of the session without touching the waiting worker —
 * `updateAvailable` stays true (the hook never learns the player dismissed it), so this component
 * tracks its own dismissal locally, the same way Notice.tsx owns its own display state.
 */

import { useEffect, useState } from 'react';
import './UpdateBanner.css';

export interface UpdateBannerProps {
  /** Mirrors the hook's `updateAvailable`. Renders nothing while false. */
  readonly updateAvailable: boolean;
  /** Player pressed Reload — the caller is expected to call the hook's `applyUpdate()` with no
   * options, i.e. never `{ auto: true }`, since this click is the one deliberate action the cap
   * does not apply to. */
  readonly onReload: () => void;
  /** Player pressed Not now. The banner hides itself; this is for the caller to observe only, it
   * does not need to change any state for the hiding to take effect. */
  readonly onDismiss: () => void;
}

export function UpdateBanner({ updateAvailable, onReload, onDismiss }: UpdateBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  // A fresh update (updateAvailable flipping false → true again) should be able to show even if a
  // previous one was dismissed this session — dismissal is scoped to "this update", not forever.
  useEffect(() => {
    if (!updateAvailable) setDismissed(false);
  }, [updateAvailable]);

  if (!updateAvailable || dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    onDismiss();
  }

  return (
    <div className="update-banner-region">
      <div className="update-banner" role="status" aria-live="polite">
        <p className="update-banner__text">
          A new version of Intralines is ready. Your company is saved before reloading.
        </p>
        <div className="update-banner__actions">
          <button
            type="button"
            className="update-banner__btn update-banner__btn--primary"
            onClick={onReload}
          >
            Reload
          </button>
          <button type="button" className="update-banner__btn" onClick={handleDismiss}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
