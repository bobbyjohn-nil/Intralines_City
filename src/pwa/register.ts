/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import { registerSW } from "virtual:pwa-register";

// SPEC — manual §2 ("Starting up" / "Updates"): "capped at two automatic reloads per session so a
// half-propagated deploy can't loop you."
const MAX_AUTOMATIC_RELOADS_PER_SESSION = 2;

// sessionStorage only — scoped to one tab, cleared on close, and never shared with localStorage
// (the save envelope) or IndexedDB (city packs). This key is a reload counter, not game state, and
// requirement 6 ("never touch saved games") does not apply to it, but it's kept in a separate
// storage area from saves regardless, on principle.
const AUTO_RELOAD_SESSION_KEY = "intralines:pwa:autoReloadCount";

function readAutoReloadCount(): number {
  try {
    const raw = window.sessionStorage.getItem(AUTO_RELOAD_SESSION_KEY);
    const parsed = raw === null ? 0 : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    // Private/locked-down contexts can throw on storage access. Fail open rather than permanently
    // refuse updates because sessionStorage is unavailable.
    return 0;
  }
}

function writeAutoReloadCount(count: number): void {
  try {
    window.sessionStorage.setItem(AUTO_RELOAD_SESSION_KEY, String(count));
  } catch {
    // Best-effort only.
  }
}

export interface ApplyUpdateOptions {
  /**
   * Set true for updates the game triggers on its own (manual §2: "on the menu it updates itself
   * automatically"). Automatic calls are capped at MAX_AUTOMATIC_RELOADS_PER_SESSION and silently
   * no-op once the cap is hit — `updateAvailable` stays true so a manual reload (the in-play
   * banner's "Reload" button, called with no options / `auto: false`) remains possible and is
   * never capped, since that is one deliberate, player-initiated action rather than a loop risk.
   */
  auto?: boolean;
}

export interface UpdateState {
  /** A new release has been precached and is waiting to take over. Drives the "New version
   * available" banner (manual §2: Reload / Not now). Always false in dev — see module doc below. */
  updateAvailable: boolean;
  /** The current release just finished precaching for offline use. Informational only. */
  offlineReady: boolean;
}

type Listener = () => void;

let state: UpdateState = { updateAvailable: false, offlineReady: false };
const listeners = new Set<Listener>();

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** Registers a listener for update-state changes. Returns an unsubscribe function. */
export function subscribeToUpdateState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current snapshot — safe to call at any time, including before registration resolves. */
export function getUpdateState(): UpdateState {
  return state;
}

// registerSW() itself is a no-op in a dev server (vite-plugin-pwa's own `devOptions.enabled:
// false` in vite.config.ts makes `virtual:pwa-register` resolve to a stub with an inert
// `registerSW`, see node_modules/vite-plugin-pwa/dist/client/dev/register.js). The `import.meta.
// env.PROD` guard below is a second, explicit line of defence on top of that: this module makes
// *no* call into the service worker machinery at all — not even the inert stub — unless running a
// production build. Between the two, nothing here can register, cache, or intercept a single
// request while `npm run dev` is running.
let updateServiceWorker: (reloadPage?: boolean) => Promise<void> = async () => {};

if (import.meta.env.PROD) {
  updateServiceWorker = registerSW({
    // We drive the prompt ourselves (registerType: "prompt" in vite.config.ts) — never reload out
    // from under the player.
    immediate: true,
    onNeedRefresh() {
      setState({ updateAvailable: true });
    },
    onOfflineReady() {
      setState({ offlineReady: true });
    },
    onRegisterError(error) {
      // Registration failures should reach the game's error bus (manual §20), not vanish into the
      // console. No error-bus hook exists yet in this module's scope (App.tsx/src/ui/ own it) —
      // console.error is the honest placeholder until that's wired.
      console.error("[pwa] service worker registration failed", error);
    },
  });
}

/**
 * Activates the waiting service worker and reloads the page so the new release takes over. See
 * ApplyUpdateOptions re: the automatic-reload cap. No-ops entirely outside a production build.
 */
export async function applyUpdate(options?: ApplyUpdateOptions): Promise<void> {
  if (!import.meta.env.PROD) return;
  if (options?.auto) {
    const count = readAutoReloadCount();
    if (count >= MAX_AUTOMATIC_RELOADS_PER_SESSION) return;
    writeAutoReloadCount(count + 1);
  }
  await updateServiceWorker();
}
