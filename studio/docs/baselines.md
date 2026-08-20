# Measured baselines

Numbers taken before a change, so the same numbers after it mean something. **Re-measure with the
identical method or the comparison is worthless** — the method notes below are not optional detail.

---

## Boot, before Route B

Measured at `f06ce54`, the last commit before any 3D code. Canvas 2D renderer, no three.js in
`package.json`. Machine: 8-core Mac, load average 6.7–6.8 throughout, Discord and several agent
processes running concurrently — moderately loaded, not idle, stable.

### The numbers

| | dev (`vite`, :5173) | production (`vite preview`, :4173) |
|---|---|---|
| TTFB | 8.7 / 15.7 / 16.6 ms | **25.3** / 15.2 / 1.3 ms |
| `domContentLoadedEventEnd` | 61.8 / 84.0 / 99.3 ms | **49.6** / 33.4 / 12.9 ms |
| `loadEventEnd` | 62.1 / 84.4 / 99.7 ms | **49.9** / 33.7 / 13.3 ms |

**Bold** = the one genuinely cold trial (service worker unregistered, Cache Storage cleared
immediately before). The others reuse Chrome's disk cache — normal repeat-visit behaviour, not three
independent cold loads.

- **Time to first playable frame: ~13–100 ms.** See the definition and the proxy argument below.
- **Long tasks during boot: zero**, every trial, dev and prod. Nothing blocks the main thread for
  50 ms.
- **`generateRiverton(42)`: ~31 ms cold, settling to ~7–9 ms once V8 is warm.** Measured two ways
  (in-browser dynamic import, and `vite-node` standalone) against the same source and seed.
- **Critical-path transfer, cold, gzipped: 76,957 B ≈ 75.2 KiB.**
  `index.html` 476 B · app bundle 72,190 B · CSS 1,948 B · workbox-window 2,343 B.
  Cross-checked three ways that agree: `vite build` output, `curl` with `Accept-Encoding: gzip`
  straight at the preview server, and `encodedBodySize` on the one truly cold browser trial.
- **Not on the critical path:** `sw.js` 701 B + workbox runtime 5,169 B, fetched after mount; the
  service worker then precaches 228.79 KiB decompressed for offline. None of it blocks play.

### Method, and why it is what it is

**"First playable frame" means the city is drawn *and* the dock is clickable** — not
`DOMContentLoaded`, not the first paint of an empty page. Verified concretely: after a cold
production load, clicking "New line" produced the draft bar, proving the dock was live rather than
merely painted.

**`loadEventEnd` is the honest proxy, and only because this app has no async gap after it.**
`generateRiverton` runs synchronously inside `App`'s first render, the dock mounts in the same commit,
and `MapCanvas` draws on the first `requestAnimationFrame` after mount. There is no later event that
unlocks play, so first-playable is bounded above by `loadEventEnd` plus roughly one frame. **If Route
B introduces an async model load, this proxy stops being valid** and the after-measurement must
instrument the real moment instead.

**FCP and LCP were unusable here and must not be used for the comparison.** The browser automation
harness keeps the tab `visibilityState: "hidden"` for its entire life, and Chrome defers paint-timing
entries for hidden pages — so FCP only received a timestamp when a screenshot was forced. The numbers
it produced (1,316–2,404 ms) track *when a screenshot happened*, not render latency, and are 20–70×
larger than `loadEventEnd`, which is the tell. LCP additionally chose a `<span>` in the top bar,
confirming a bare `<canvas>` is not an LCP candidate at all — so LCP was never going to answer "is the
map drawn."

**Known gaps, stated rather than papered over:** `generateRiverton` was timed by post-boot
re-invocation, not inside the one call `App` makes at mount, and not in the minified production
bundle — the zero-longtask result is the only direct evidence about production's real boot cost.
Three independent cold-cache browser trials were not obtainable; `curl` substituted for the byte
counts and agrees exactly with the build output.

### What the after-measurement must do

1. Use **`loadEventEnd`**, not FCP or LCP, unless the harness gains a foreground tab.
2. Re-check the **no-async-gap assumption**. If models load asynchronously, instrument the real
   first-playable moment directly — the proxy no longer holds.
3. Report the **spread across at least three runs**, and the machine's load average, as here.
4. Measure the **production build**, not the dev server.
5. Report critical-path bytes separately from after-mount bytes. Per pillar 4, models arriving after
   the city is playable are not a boot cost — but they must be shown to actually arrive after.

---

## Boot, after WebGL (Route B, step 1)

Measured at `0e4740e`, "The renderer is WebGL, at parity with the Canvas it replaces" — three.js in
`package.json`, camera pitch locked at zero, no models yet (none exist in the repo at this commit).
Machine: same 8-core Mac as the before-measurement, load average 5.7–6.9 throughout — comparable load,
not idle.

**Method note:** the interactive `Claude Browser` harness used for the before-measurement keeps its
tab hidden, and this time that hiding did more than defer paint timing — it deferred the app's own
`requestAnimationFrame`-driven redraw loop too (see "Does the `loadEventEnd` proxy still hold?"
below), and it also failed to register the service worker (`TypeError: Failed to register a
ServiceWorker … unknown error occurred when fetching the script`). Both are artifacts of that specific
harness, not the app: a plain headless-Chromium Playwright session against the same production build,
same URL, same port, registered the service worker fine (`active: activated` within 4 s) and produced
zero console errors. **The numbers below come from that Playwright session** — production build
(`vite preview`, port 4173), `--use-gl=angle --use-angle=metal` so the GPU path is real hardware
(Apple M1 Pro via ANGLE Metal, confirmed via `WEBGL_debug_renderer_info`) rather than the software
SwiftShader fallback Chromium otherwise defaults to headless. Both configurations were measured; see
the long-task section for why the distinction matters.

### The numbers, production preview (`vite preview`, :4173), 5 trials, GPU-accelerated

| trial | TTFB (`responseStart`) | `loadEventEnd` | first real WebGL frame† |
|---|---|---|---|
| 1 | 2.5 ms | 58.6 ms | 135.4 ms |
| 2 | 4.9 ms | 52.7 ms | 126.4 ms |
| 3 | 2.5 ms | 50.1 ms | 126.4 ms |
| 4 | 2.4 ms | 48.5 ms | 119.0 ms |
| 5 | 2.4 ms | 51.0 ms | 122.0 ms |

†"First real WebGL frame" = the moment the canvas element's backing size flips from the browser's
unset default (300×150) to its real rendered size, which only happens inside `MapCanvas`'s
`tick()` — i.e. after `buildCityScene` and the first `renderer.render()` (shader compile + upload)
have actually run. Detected by polling `canvas.width` every 2 ms from an init script, independent of
`requestAnimationFrame` so the harness's own rAF throttling can't hide it. Cross-checked against
`getEntriesByType('longtask')` on the same page (see below).

Three additional `domContentLoadedEventEnd`/`loadEventEnd`-only trials, different run: 49.4 / 46.8 /
67.1 ms — same range as above, consistent.

### 1. Time to first playable frame

**Baseline: ~13–100 ms** (using `loadEventEnd` as the proxy). **After: `loadEventEnd` alone is now
49–67 ms** (comparable order of magnitude, slightly higher — bigger bundle, same "no async work before
mount" shape). **But the real first-playable moment — the first WebGL frame — lands at 119–135 ms**,
not at `loadEventEnd`. That is the direct answer to the question below.

Verified genuinely live the same way the baseline did: clicked "New line" in the `Claude Browser`
pane against the production build and got the draft bar (`STOPS 0 · LENGTH 0 m · ROUND TRIP 8 min ·
COST $0`, "This line needs at least 2 stops before you can create it", Undo/Cancel/Create line) —
screenshot confirms the city was drawn and the dock was live, not merely painted. Also verified
programmatically in all 15 Playwright trials across both builds (`page.getByText('New line').click()`
→ waited for `text=Create line` → succeeded every time).

### Does the `loadEventEnd` proxy still hold?

**No — and the same instrumentation shows it was already a loose bound before Route B, just not by
enough to matter.** Same polling method run against `f06ce54` (Canvas 2D, rebuilt fresh in a worktree,
`vite preview` on a different port, identical Playwright harness) for comparison:

| | `loadEventEnd` | first real frame | gap |
|---|---|---|---|
| **Before** (Canvas 2D, 5 trials) | 31.2–77.1 ms | 67.2–140.7 ms | 35.0–63.6 ms (avg ~42 ms) |
| **After** (WebGL, 5 trials) | 48.5–58.6 ms | 119.0–135.4 ms | 70.5–76.8 ms (avg ~74 ms) |

The gap between `loadEventEnd` and the first real frame roughly **doubled** (~42 ms → ~74 ms). The
extra ~30 ms is real and attributable to `buildCityScene` (constructing ground/water/parks/roads/
ribbons/stops geometry) plus the first `renderer.render()` call, which is where three.js compiles and
links its shader programs and uploads the first geometry to the GPU — none of which existed in the
Canvas 2D path. It is architecturally still synchronous: `MapCanvas.tsx`'s redraw effect calls
`requestAnimationFrame(tick)` unconditionally on mount, and `tick()` builds the scene and renders
inline, with no `await`, no `.then()`, no dynamic `import()`, no texture/model loader anywhere in
`buildCityScene` or `scene.ts` (checked by grep — the only matches for loader-shaped code are
type-only imports). **So there is still no async gap in the strict sense the baseline defined it** —
but the proxy's own stated bound ("`loadEventEnd` plus roughly one frame," i.e. ~16 ms) was already
too tight even at baseline (the real gap was 2–4 frames, not one), and Route B made that existing gap
~30 ms bigger. Verdict: **the proxy is directionally fine (nothing moved outside a couple hundred
milliseconds) but should not be quoted as *the* first-playable number going forward — use the first-
real-frame instrumentation above.**

### 2. Long tasks during boot

**Baseline: zero, every trial.** **After, on real GPU hardware (Metal, M1 Pro): still zero, every
trial** (5/5) — `performance.getEntriesByType('longtask')` empty in all 5 GPU trials above.

**After, on Chromium's default headless software renderer (SwiftShader, no GPU flags): two long tasks
every trial, 5/5** — one huge (726–926 ms!) right at the first `requestAnimationFrame` tick, plus a
second smaller one (113–119 ms) about 800 ms later. Confirmed via `WEBGL_debug_renderer_info`:
`SwiftShader Device (LLVM 10.0.0)` vs. `ANGLE Metal Renderer: Apple M1 Pro` with the GPU flags.

This is the real finding the task asked me to check for. **On hardware acceleration, shader
compilation did not cost a long task.** But **on software rendering it costs a 700–900 ms main-thread
block that has no equivalent in the Canvas 2D build**, because Canvas 2D never touches a GPU context
at all — the old build is immune to this failure mode by construction, the new one is not. Real users
essentially always have GPU acceleration, but this is a real new tail risk for anyone who doesn't:
GPU-blocklisted machines, some corporate/locked-down laptops, virtual desktops/remote sessions, old
integrated graphics Chrome has denylisted. Worth watching, not (yet) worth panicking about — it's a
tail case, not the default path — but it's a category of failure that did not exist before this
commit and should be checked again once the WebGL scene grows (more materials, more shaders, actual
models).

### 3. `generateRiverton` cost

**Baseline: ~31 ms cold, ~7–9 ms warm.** **After, `vite-node` standalone (same method), 3 separate
process runs:** cold 29.4 ms / 43.9 ms / 34.2 ms, warm (last-3-of-8 average within each run) 6.8 ms /
6.75 ms / 6.6 ms. **Unchanged, as expected** — it's untouched pure CPU and the numbers land in the
same band as baseline, run-to-run process noise accounts for the spread. Same caveat as baseline
carries forward: this is the unminified TS source via `vite-node`, not the one call inside the
minified production bundle — the production bundle doesn't export internals to time directly, same as
before.

### 4. Critical-path transfer, gzipped

**Baseline: 76,957 B ≈ 75.2 KiB** (`index.html` 476 B · app bundle 72,190 B · CSS 1,948 B ·
workbox-window 2,343 B).

**After: 225,557 B ≈ 220.3 KiB** — same four files, same method (`curl -H "Accept-Encoding: gzip"`
straight at the `vite preview` server, `Content-Encoding: gzip` confirmed on JS/CSS/workbox-window;
`index.html` stays uncompressed both times, it's under the compression middleware's threshold either
way):

| file | before | after |
|---|---|---|
| `index.html` | 476 B | 476 B |
| app bundle | 72,190 B | 220,790 B |
| CSS | 1,948 B | 1,948 B |
| workbox-window | 2,343 B | 2,343 B |
| **total** | **76,957 B (75.2 KiB)** | **225,557 B (220.3 KiB)** |

Cross-checked against the build output: `vite build` reports the JS chunk at "220.79 kB" gzip, and
`curl` against the preview server returns exactly 220,790 bytes with `Content-Encoding: gzip` — same
number, two ways, as baseline's method requires. **~2.9× the old total**, all of it three.js (CSS and
workbox-window are byte-for-byte unchanged). The commit message's "roughly three times" refers to the
JS bundle alone against the old *total*; measured the same way as baseline (whole critical-path
bucket vs. whole critical-path bucket) it's 2.93×.

### 5. Anything new after mount

Checked resource timing out to 4 s post-load against the production build:

- **Confirmed NOT fetched during or shortly after boot:** `sw.js`, its workbox runtime chunk
  (`workbox-2ff6bd68.js`), and the Basis Universal texture transcoder (`basis/basis_transcoder.js` —
  15,169 B — and `basis/basis_transcoder.wasm` — 527,333 B, not gzip-compressible). None of the three
  appear in `performance.getEntriesByType('resource')` in any trial. The transcoder is also absent
  from the service worker's own precache manifest (`dist/sw.js`'s `precacheAndRoute` list has exactly
  5 entries: `index.html`, the JS bundle, the CSS, the workbox-window script, and the favicon) —
  confirms commit `6c6d1c7`'s "the texture transcoder is lazy, not precached" claim is true in the
  shipped build, not just in intent.
- **Confirmed IS fetched after mount, same as baseline:** `workbox-window` (starts loading right at
  `loadEventEnd`, not before) and the service worker itself, which reached `active: activated` within
  4 s in the clean Playwright session.
- **Service-worker precache size grew with the bundle:** build log reports "precache 5 entries
  (793.68 KiB)" now vs. baseline's 228.79 KiB — expected, it's precaching the same (bigger) app
  bundle, still none of it blocks first play.
- **Nothing model-related loads yet, because no models exist in this commit.** This is the one line
  item that is *projected, not measured*: once `.glb` files exist and the transcoder + models actually
  fetch, that fetch needs the same "does it block play" check applied to it that the transcoder itself
  just passed. Today there is nothing to fetch, so "arrives after mount" is trivially true and proves
  nothing about the real cost once it isn't.

### Verdict — what this cost at boot

| | before | after | change |
|---|---|---|---|
| `loadEventEnd` | 12.9–99.7 ms | 47–67 ms (production) | same order, slightly up |
| real first-playable frame | 67–141 ms (not measured this way at the time) | 119–135 ms | ~+30 ms, see above |
| long tasks (GPU) | 0/trial | 0/trial | unchanged |
| long tasks (software fallback) | n/a (Canvas 2D needs no GPU) | 2/trial, 726–926 ms + 113–119 ms | **new failure mode** |
| `generateRiverton` | ~31 ms cold | ~29–44 ms cold | unchanged |
| critical-path gzip | 75.2 KiB | 220.3 KiB | **2.93×** |

**Against pillar 4 ("plays in five seconds"): comfortably fine, today.** Every real-first-frame number
measured is under 150 ms on real GPU hardware — roughly 33× inside budget, not 5–10% inside it. The
2.93× byte growth and the ~30 ms extra latency are real costs of Route B, but neither is close to
threatening the five-second bar by itself.

**What would make it worse, and hasn't happened yet:** this measurement has zero models in it. Pillar
4's own text says models must load *after* the city is playable, not before — that's a design
intent, not something this commit had to prove, because there is nothing to load yet. The thing to
re-run once `.glb` files exist: does the transcoder + first model fetch actually stay off the critical
path in practice (own service worker precache list currently agrees it isn't precached, so it will be
a real network fetch triggered by something, at some time, after mount — trace what triggers it and
when), and does decoding/uploading a real (non-placeholder) mesh reproduce the same
GPU-vs-software-fallback long-task split found here, at a larger scale.

**One flag worth carrying forward regardless of models:** the software-rendering long-task finding
above is new, real, and untested by the baseline (which had nothing GPU-shaped to fail). It costs
nothing today because it's a tail case, but the crew should know it exists before the GPU workload
grows.
