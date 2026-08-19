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
        // renderer-3d.md §5 point 5 / §4 "pipeline infrastructure": models and their textures are
        // part of the same offline guarantee, and are precached unconditionally — they're content
        // the game genuinely needs. 'assets/models/**/*.glb' and 'assets/textures/**/*.ktx2' are
        // the pipeline's output (scripts/models/build.ts, "npm run models").
        //
        // The KTX2 transcoder (public/basis/basis_transcoder.{js,wasm}, ~515 KB) is deliberately
        // NOT in this list — see the runtimeCaching entry below for why and how it's still covered
        // by the offline guarantee without being paid for by every player on every first load.
        globPatterns: [
          "**/*.{js,css,html,svg,png,jpg,jpeg,webp,woff,woff2,ico}",
          "assets/models/**/*.glb",
          "assets/textures/**/*.ktx2",
        ],
        // The generic '**/*.js' pattern above would otherwise also catch
        // basis/basis_transcoder.js (its .wasm sibling is already excluded, since .wasm isn't in
        // that extension list) — public/ files are copied into the build output verbatim, so a
        // same-origin .js file living anywhere under dist/ matches a "**/*.js" glob whether or not
        // it's also named in a category-specific pattern above. Excluded explicitly so removing
        // 'basis/*.{js,wasm}' from globPatterns actually keeps both transcoder files out of the
        // precache, not just the .wasm half.
        globIgnores: ["basis/**"],
        // §5: 2 MB ceiling on any individually precached file. Generous headroom above §4's actual
        // per-file caps (120 KB hard cap on any model) so a future asset that blows its budget
        // fails the pipeline's own validator loudly, rather than silently vanishing from the
        // precache manifest here.
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        // Runtime caching: for requests NOT in the precache manifest above. This is the only entry
        // today, and it exists specifically so the KTX2 transcoder can stay out of the eager
        // precache while still honouring "second load works offline" for a player who has actually
        // loaded a textured model.
        //
        // Why the transcoder isn't precached (renderer-3d.md §4 "pipeline infrastructure", decided
        // after the first pass at this pipeline shipped it precached and got called out for it):
        // vehicles carry no texture at all (DECISIONS #69 — livery is a runtime recolour of named
        // material slots), and buildings are instanced procedural prisms until model-pipeline step
        // 4 lands. Today, every player would download and cache 515 KB — ~7× the entire game
        // bundle (75.2 KiB gzipped at f06ce54) — for a file that is never actually used. §6's own
        // load-order table is explicit that "zero .glb requests" happens before the first frame;
        // the same discipline applies to a file only a *textured* .glb needs.
        //
        // KTX2Loader itself is already lazy about this at the loader level — `.detectSupport()`
        // only records renderer capabilities, and the actual network fetch of
        // basis_transcoder.{js,wasm} happens inside `.init()`, called only from `_createTexture()`
        // when a KTX2 texture is actually being transcoded (see
        // node_modules/three/examples/jsm/loaders/KTX2Loader.js). So "load on first KTX2
        // encounter" requires no extra code at the call site — see studio/viewer/main.ts for where
        // that loader is constructed and the matching comment. This runtimeCaching route is the
        // other half: once that lazy fetch happens once, cache the result so it doesn't repeat.
        //
        // CacheFirst (not StaleWhileRevalidate/NetworkFirst) because these two files are
        // content-addressed by three.js's own release, not by our build hash — they don't change
        // between deploys the way our hashed JS/CSS does, so there's no staleness to guard against,
        // only a fetch to avoid repeating. Do not move this back into globPatterns "to simplify" —
        // that's exactly the eager-download regression this route exists to prevent.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/basis/"),
            handler: "CacheFirst",
            options: {
              cacheName: "ktx2-transcoder",
              expiration: { maxEntries: 4 },
            },
          },
        ],
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
