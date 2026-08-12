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

- [ ] Project skeleton — Vite + TypeScript + React, `dev`/`build`/`test` scripts, empty `constants.ts`
- [ ] Riverton: procedural demo city — street graph with road classes and speeds, water, parks
- [ ] Map render of the procedural city in the paper palette, with the grey out-of-bounds mask
- [ ] Game clock — pause/play, three speeds (0.25 / 2 / 10 game-min per real second), `Space` and `1`/`2`/`3`
- [ ] Draw a line — click stops, snap to road, shortest-path between them, draft bar, `Esc` cancels
- [ ] Bus motion — accelerate 1.1 m/s², brake 1.3, 20 s dwell, schedule as a pure function of the clock
- [ ] Money floor — treasury, per-tick ledger, stop cost $4k, one bus model, driver wages $26/h

### Milestone 2 — it's a game

Goal: riders decide whether to ride, and the decision is legible.

- [ ] Save envelope — versioned, every field optional with a default, newer-save refusal. Do this **before** the save surface grows
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

<!-- The orchestrator moves items here when it starts them, and annotates with the crew and start time. -->

## Blocked

<!-- Items that cannot proceed. Each must state what would unblock it. -->

## Icebox

<!-- Good ideas, not now. The orchestrator never starts these on its own. -->

- [ ] Audio — the manual describes none. Decide whether the game has sound at all.
- [ ] Distribution target — itch.io, own domain, or unlisted.
