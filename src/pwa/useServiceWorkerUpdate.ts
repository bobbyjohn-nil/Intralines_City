import { useSyncExternalStore } from "react";
import { applyUpdate, getUpdateState, subscribeToUpdateState } from "./register";
import type { ApplyUpdateOptions, UpdateState } from "./register";

export type { ApplyUpdateOptions, UpdateState };

export interface ServiceWorkerUpdateState extends UpdateState {
  applyUpdate: (options?: ApplyUpdateOptions) => Promise<void>;
}

/**
 * Reports whether a new release of the app is ready to take over, and applies it on request.
 *
 * Registration itself happens once, as a side effect of importing `src/pwa/register.ts` from
 * `src/main.tsx` at boot — not from this hook — so the app shell precaches and updates get
 * detected regardless of whether any component ever renders the banner. This hook only exposes
 * that state to React and is safe to use from any number of components at once.
 *
 * TODO(ui-designer): nothing calls this hook yet — App.tsx does not import it. Wire it into the
 * "New version available" banner from manual §2: `updateAvailable` drives visibility, its Reload
 * button calls `applyUpdate()` (manual/uncapped — the manual promises the company is saved before
 * reloading), "Not now" just dismisses the banner without calling anything (the worker stays
 * queued; `updateAvailable` remains true, so the banner can reappear, e.g. on the next screen
 * change). Separately, the manual says the home menu applies updates on its own — that path should
 * call `applyUpdate({ auto: true })`, which self-caps at two reloads per session (see
 * src/pwa/register.ts) and silently no-ops after that, deliberately leaving `updateAvailable` true
 * rather than looping.
 */
export function useServiceWorkerUpdate(): ServiceWorkerUpdateState {
  const state = useSyncExternalStore(subscribeToUpdateState, getUpdateState, getUpdateState);

  return {
    ...state,
    applyUpdate,
  };
}
