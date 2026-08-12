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

## Handoff — direction change to 3D, 2026-08-12

**Stopped mid-verification, deliberately.** The tree is clean at `360a823`, 276 tests pass, the build
is green. Nothing was half-applied, so there was no diff to stash.

**Where we got to.** Milestone 1 ships and is verified. Milestone 2's three systems — demand, saving,
depots — are built, tested, and demand and saving are wired into the app. Four defects from the last
playtest were fixed and committed: the missing return-trip factor (riders went to work and never came
home), route strokes overshooting, the top bar garbling its own text at narrow widths, and the riders
chip claiming zero before it had an answer.

**What was left unverified**, and is now partly moot:

- **Route overshoot fix — unconfirmed in a browser.** The fix is committed and unit-tested, including
  the half nobody reported: a stop sitting mid-edge at a *turn* appears in two legs and both drew its
  edge in full, so the stroke doubled back at every corner. Two playtests were spawned to confirm it
  visually; the first stalled on a watchdog, the second was stopped by the direction change.
  **Under Route B this code is replaced**, but the *geometry lesson* carries over — a 3D route ribbon
  will need the same clipping to `edgeT`, and the same trap is available.
- **Top bar container-query fix — unconfirmed in a browser.** Unaffected by the renderer change; the
  top bar is DOM, not canvas. Still needs a visual pass at several widths.
- **Riders-chip-absent-until-answered — unconfirmed in a browser.** Also DOM, also unaffected.
- **Riders magnitude — confirmed.** 143/day on a 3-stop 6.4 km line, against 16 before the fix. A
  sparse line legitimately carries tens until transfers exist.

**Still true and still open** (see the sections below): the sim is not in a worker despite the stack
table saying so, the possible input lag after rapid drawing was never reproduced, and depots have no
UI.

**Found verifying Milestone 2 (2026-08-12):**

- [ ] **The sim is not in a worker.** `GAME.md`'s stack table states "Web Worker, debounced ~250 ms on network change" and the manual says the same; `computeDemand` actually runs on the main thread via `setTimeout` in `App.tsx`. No long tasks were measured at Riverton's scale (96 zones, 8 lines) so it is not hurting yet — but `ZONE_CAP = 512` is 5× the zones and the spec's own note says that scale is "reasoning, not measurement". Either move it to a worker or correct the documentation; a stack table that describes a worker nobody built is worse than either
- [ ] Possible input lag after a rapid burst of line drawing — UI caught up ~1 s late, but `PerformanceObserver` recorded **zero** long tasks over the same window, so it may be automation-harness latency rather than game jank. Unresolved; needs a human hand on a real mouse

**Requested 2026-08-12:**

- [ ] **Route lines overshoot their terminus stops.** The coloured route stroke runs past the first and last stop instead of ending at them. Likely cause: `drawRoutes` renders each leg's `edgeIds` as whole edges, but a stop sits at `edgeT` *along* an edge — the terminal edges need trimming to the stop's position, not drawing end to end. Check the mid-route stops too; if intermediate stops sit mid-edge the same overshoot may exist at every corner and only be visible at the ends
- [ ] **Make buses look like buses.** They are oriented triangles — enough to be seen, not enough to be a bus. Manual §12 specifies a distinct silhouette per model: the Sparrow a cutaway van with a narrow cab and wide passenger box, the Goliath a bellows joint and third axle, the Skyline two window decks, the Volt-E a roof battery pack and green nose flash. Every bus wears the company colour with a full-length stripe in its line's colour, doors on both flanks, a destination blind, mirrors and lights. The canonical bus drawing in `src/ui/icons/Bus.tsx` is the reference for the hand — the map marker should read as the same vehicle at map scale
- [ ] **A 3D map.** Manual §6 specifies 3D building extrusions on the online vector-tile renderer, and §16 a full 3D diorama for the station view — tier-appropriate furniture, a crowd matching the live waiting count, and buses pulling in with doors opening. Neither renderer exists; today there is one Canvas 2D basemap. This is the largest single piece of unbuilt presentation in the manual and needs its own design pass before any code — decide what is genuinely 3D versus 2.5D, and what it costs the offline path, which must keep working with no network

**Still open from the playtests (2026-08-12):**

- [ ] `UpdateBanner.css` does not use the new `--ui-z-banner` token. A z-index scale now exists in `tokens.css` (chrome 10, notice 20, banner 30); the banner predates it and still sets its own value
- [ ] Verify `--ui-dock-height` matches the dock's real rendered height. It assumes the icon+label stack fits the 40px hit-target box; if it overflows, the map is inset short of or past the dock's edge. Needs a browser
- [ ] `GAME.md` promises buses run headlights and lit windows at night. Zero implementation exists — a documented, unbuilt feature
- [ ] Verify with more than two buses on a line. Every playtest so far ran the default pair; visibility and clutter at higher frequency are unverified

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
