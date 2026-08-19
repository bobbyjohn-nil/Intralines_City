/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Service worker is generated and registered for production builds only. `injectRegister:
      // null` stops the plugin from auto-injecting a <script> registration tag into index.html —
      // registration happens explicitly from src/pwa/, guarded by `import.meta.env.PROD`, so
      // `npm run dev` never sees a service worker touch the page (see src/pwa/register.ts).
      injectRegister: null,
      // devOptions.enabled defaults to false, which is what we want: no SW, no precache manifest,
      // no virtual:pwa-register work happens under `vite`/`vite dev`. Left explicit for clarity.
      devOptions: {
        enabled: false,
      },
      // "prompt" (not "autoUpdate"): the plugin must never swap the SW and reload on its own.
      // src/pwa/register.ts owns the decision of *when* to activate a waiting worker, so the
      // manual's "banner in play, silent update in menu, capped at two auto-reloads" behaviour is
      // possible instead of an uncontrolled auto-refresh.
      registerType: "prompt",
      manifest: false,
      workbox: {
        // Precache every hashed build artifact (JS, CSS, HTML, and any assets Vite emits) so the
        // app shell opens with the network cable pulled after the first successful load.
        //
        // renderer-3d.md §5 point 5: models and their textures are part of the same offline
        // guarantee. 'assets/models/**/*.glb' and 'assets/textures/**/*.ktx2' are the pipeline's
        // output (scripts/models/build.ts, "npm run models"); 'basis/*.{js,wasm}' is the
        // self-hosted KTX2 transcoder (public/basis/) that KTX2Loader needs at runtime — hosted
        // same-origin and precached for the same reason meshopt's decoder needs no fetch at all
        // (it bundles its ~5 KB inline): no third-party network dependency, ever, per GAME.md's
        // offline constraint.
        globPatterns: [
          "**/*.{js,css,html,svg,png,jpg,jpeg,webp,woff,woff2,ico}",
          "assets/models/**/*.glb",
          "assets/textures/**/*.ktx2",
          "basis/*.{js,wasm}",
        ],
        // Models are individually capped well under this (§4: 120 KB hard cap per file), but the
        // basis transcoder .wasm is ~515 KB — raise the default 2 MB ceiling explicitly so a
        // future larger asset doesn't silently fall out of the precache instead of failing loudly.
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        // A same-origin SPA fallback for any navigation not already precached (e.g. deep links),
        // so offline reloads never hit the network and 404.
        navigateFallback: "index.html",
        // Old release's precache entries are removed once the new SW activates — this is what
        // makes "old version's cache is deleted" (manual §2) true rather than aspirational. Note
        // this only deletes the Cache Storage entries workbox itself owns (the precache); it has
        // no access to and never touches localStorage or IndexedDB, where saves and city packs
        // live (requirement 6).
        cleanupOutdatedCaches: true,
        // Deliberately NOT setting clientsClaim/skipWaiting here. Both are generated *into the
        // service worker file* and would make every new SW call `self.skipWaiting()` unconditionally
        // on install, activating itself immediately regardless of `registerType: "prompt"` — that
        // would silently swap the running app out from under an open tab, exactly what the manual's
        // "New version available" banner (Reload / Not now) exists to prevent. Leaving both unset
        // (workbox's default: off) means a new worker installs and then waits; it only activates
        // when src/pwa/register.ts's `applyUpdate()` sends the skip-waiting message — i.e. when the
        // player clicks Reload, or the game itself decides to auto-update on the menu.
      },
    }),
  ],
  test: {
    environment: "jsdom",
    // Vitest's `exclude` replaces its own defaults rather than merging with them, so we spread
    // `configDefaults.exclude` (node_modules, dist, .git, etc.) and add `.claude/**` on top. That
    // last pattern is what actually matters here: agents sometimes run inside git worktrees under
    // `.claude/worktrees/<agent-id>/`, which are full copies of this repo — test files included.
    // Without this, vitest's default glob happily discovers and runs those copies too, double-
    // counting every test and running half the suite against another agent's in-progress code.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
