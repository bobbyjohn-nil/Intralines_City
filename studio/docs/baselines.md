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
