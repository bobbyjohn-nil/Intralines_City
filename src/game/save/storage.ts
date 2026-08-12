/**
 * The only interface this module uses to touch persistent storage. Kept tiny and injectable so
 * every test in `save.test.ts` runs against `createMemoryStorage()` and never touches a real
 * `localStorage` — see studio/GAME.md's WASM-portability conventions for why the rest of the sim
 * follows the same "pass the dependency in" shape.
 */
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** An in-memory `SaveStorage` for tests — same semantics as `localStorage` (missing key reads as
 * `null`), none of its persistence or quota behaviour. */
export function createMemoryStorage(): SaveStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/** The real adapter, backed by `window.localStorage`. Never imported by a test — only by whatever
 * wires this module into the app. */
export function createLocalStorageAdapter(): SaveStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  };
}
