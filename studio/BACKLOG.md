# Backlog

Living work queue. **You add items; the orchestrator moves them.** Items leave this file only by
being finished (→ [CHANGELOG.md](CHANGELOG.md) under Unreleased) or by you deleting them.

Add a line under **Up next** in any form — one sentence is enough. The orchestrator will spec it out.

The build order below is derived from [the manual](docs/design/manual-v1.18.md) by dependency, not
by chapter. Each milestone must be **playable** before the next begins. Reorder freely; just keep
the game runnable.

---

## Up next

### Milestone 1 — it moves

Goal: a bus drives a line you drew, on a fake city, and it costs money. No real data, no depth.

**Milestone 1 is complete and committed (`c489047`).** Skeleton, Riverton, map render, clock, line
drawing, bus motion and the money floor all ship and are verified in a browser. Everything below is
follow-up work found while building it.

**Found in the second full playtest (2026-08-12) — queued, not yet fixed:**

- [ ] **Buses are still invisible.** The size fix landed but `drawBuses()` fills the marker and never strokes it, in a tan within a few RGB units of the paper background. `drawStops()` fills *and* strokes, which is why stops read and buses do not. Fix after the stop-hoisting refactor merges, since both touch `drawOverlays.ts`
- [ ] The diagonal avenue spans only 10 of 43 grid columns (`DIAGONAL_HALF_SPAN_COLUMNS = 5`) — about 200 m in a 6 km city. It reads as a stray pencil scratch, and "creates triangular blocks" is barely achievable at that span
- [ ] The draft bar reflows the map. It is a normal-flow flex sibling, so opening it shrinks and re-fits the map viewport. `Notice` is `position: fixed` and correctly causes no shift — the draft bar should match
- [ ] The map occupies about a third of the screen width, centred in a large empty void. **Diagnosed: not CSS.** The container and canvas are edge-to-edge; the canvas is drawing a small city inside a full-size box. Route to `src/render/` — fit-to-bounds leaving excess padding, or a resize not tracking the container. Blocked until the stop-hoisting refactor merges out of its worktree
- [ ] `UpdateBanner.css` does not use the new `--ui-z-banner` token. A z-index scale now exists in `tokens.css` (chrome 10, notice 20, banner 30); the banner predates it and still sets its own value
- [ ] Verify `--ui-dock-height` matches the dock's real rendered height. It assumes the icon+label stack fits the 40px hit-target box; if it overflows, the map is inset short of or past the dock's edge. Needs a browser
- [ ] `GAME.md` promises buses run headlights and lit windows at night. Zero implementation exists — a documented, unbuilt feature

**Found while verifying the first playable build (2026-08-12):**

- [ ] Riverton has no road above 55 km/h, so the "stops can't sit on fast roads" refusal is unreachable in the demo city and cannot be tested by playing. Add a trunk or motorway on the edge of the map — it also gives the map a visible hierarchy top end
- [ ] Riverton's grid is fully connected, so the unroutable-leg refusal is unreachable too. Either accept it as untestable by play and cover it only in unit tests, or give the map a genuine dead-end district
- [ ] The pause button is a 32×32px target and a first click after page load occasionally did not register. May be a test-harness artifact rather than a real defect — but the target is small either way. Check against the UI craft rules

- [ ] Canvas does not redraw when the palette changes — a theme switch needs a manual page reload. The dirty flag isn't set on a CSS variable change
- [ ] Parks are nearly invisible on the paper palette — pale yellow on cream. They need to read as parks without shouting
- [ ] The downtown grid reads as a tight stripe of vertical lines rather than a denser core. Density falloff needs to apply to both axes, and more gradually
- [ ] Street classes are too subtle to tell apart at the default fit-to-bounds zoom. Widths differentiate on close zoom but not at a glance
- [x] ~~Verify the offline path against a production build~~ — **done 2026-08-12.** Verified for real: headless Chrome, network cut via CDP, page reloaded and the game UI rendered; a cross-origin fetch was checked to confirm the network was genuinely down. Full deploy cycle exercised — new worker installs, waits without swapping the running tab, activates only on explicit message, old precache cleaned. Baseline ~70 KB gzip
- [ ] Spot-check `Space` pause with a real keyboard. Browser automation sends the space bar with an empty `code`, so it could not be verified end to end; the handler itself is correct under direct event dispatch

### Milestone 2 — it's a game

- [ ] **Blocks depots entirely:** Riverton has no zones. `generateRiverton()` returns no `residents`/`jobs`/`areaHa` concept at all, so the census fallback in [depots-and-timetables.md](docs/design/depots-and-timetables.md) §1 has nothing to test eligibility against — the demo city has **no legal depot site on turn one**. Needs zone polygons plus ≥3 planted industrial districts ≥400 m apart with road access, and a generation-time assertion that fails the build if fewer than 3 survive. Documented as a skipped test in `src/game/integration.test.ts`

Goal: riders decide whether to ride, and the decision is legible.

- [ ] Save envelope — implement to [save-format.md](docs/design/save-format.md). Envelope, the 8-step ordered check, empty migration chain, stable ids, position-anchored stops
- [ ] **Do before the save envelope:** hoist stops out of `Line`. `Line.stops` nests `Stop` objects, so a stop shared by two lines is duplicated — becomes a top-level `stops[]` with `line.stopIds[]`. Connectability scoring (§18) needs this shape anyway, and every day it waits is more code to change
- [ ] **Do before the save envelope:** `Stop` needs a persisted `roadClass` plus derived `orphaned`/`movedM`, and the re-anchor constants (2 m / 3 m / 12 m / 30 m / 40 m / 15 m) belong in `constants.ts`. Per [save-format.md](docs/design/save-format.md) §5
- [ ] **Confirmed latent corruption, found 2026-08-12:** stop ids collide across lines. `addStop` uses `id: state.stops.length`, a per-draft counter, so every line's first stop is id `0`. Two lines sharing a click produce two distinct `Stop` objects with the same id. Harmless today only because nothing keys on `stop.id` alone — a save envelope that did would corrupt data silently. Pinned by a characterization test marked expected-to-flip
- [ ] **Do before the save envelope:** stable ids everywhere. Stops and lines are array indices today, which do not survive removal or reordering. Monotonic never-reused ids from a persisted counter
- [ ] Demand model — gravity O–D table, 650 m walk, mode-choice logit, captive riders
- [ ] Timetables — Normal mode (bus counts → headway), service hours, 2-min headway floor
- [ ] Fares — $1.00–$5.00, $2.25 neutral, $0.18/perceived-minute conversion, $1.60 subsidy
- [ ] Depots — placement rules, capacity, levels, upkeep
- [ ] Fleet — the five bus models, capacity/cost/range/speed, buy and sell
- [ ] Satisfaction score and the top bar
- [ ] Rider agents on the map — spawn, walk, wait, board

### Milestone 3 — it's real

- [ ] City pack format + IndexedDB caching under a format version
- [ ] Real-city bake pipeline (`npm run bake`) — TIGERweb, ACS/LODES, OSM, AADT
- [ ] Worcester, Des Moines, Madison
- [ ] Offline self-rendered basemap from the pack
- [ ] Congestion model — hourly curve, road-class multipliers, ridership feedback
- [ ] Demand layers — residents, destinations, travel modes, traffic forecast
- [ ] Port the day/night tint to the MapLibre vector-tile renderer when it exists — the offline Canvas renderer has it, and the two must not diverge

### Milestone 4 — depth

- [ ] Stop tiers 1–5 with walk bonuses and overcrowding
- [ ] Express lines — the ≥5 km / ≥3 stops / ≥1.2 km rule, as **one shared predicate**
- [ ] Advanced timetable mode
- [ ] Report cards — seven weighted categories, grants and fines
- [ ] Staff — mechanics, shortages, wear
- [ ] Loans and credit score
- [ ] Visitors / tourism demand
- [ ] Station view — the 3D diorama
- [ ] Depot add-ons, fleet Mk I–III upgrades, refurbishment

### Milestone 5 — ship

- [ ] Service worker, offline boot, update banner, two-reload cap
- [ ] Error bus — toast, session log, recovery card
- [ ] Home menu — Play / Saves / Settings / Changelog
- [ ] Founding screen, How-to-play panel, paused entry
- [ ] Boot splash and the bus drive-away hand-off (skipped under `prefers-reduced-motion`)

## In progress

- [~] Project skeleton — Vite + TypeScript + React, `dev`/`build`/`test` scripts — gameplay-coder — started 2026-08-12
- [~] Riverton: procedural demo city — street graph, road classes, water, parks — gameplay-coder — started 2026-08-12
- [~] Map render in the paper palette, with the grey out-of-bounds mask — vfx-artist — started 2026-08-12
- [~] Game clock — pause/play, three speeds, `Space` and `1`/`2`/`3` — gameplay-coder — started 2026-08-12

## Blocked

<!-- Items that cannot proceed. Each must state what would unblock it. -->

## Icebox

<!-- Good ideas, not now. The orchestrator never starts these on its own. -->

- [ ] Audio — the manual describes none. Decide whether the game has sound at all.
- [ ] Distribution target — itch.io, own domain, or unlisted.
