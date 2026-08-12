# Intralines Bus Simulator — Game Bible

> Every agent in the crew reads this file first.
> Compiled from the **v1.18 Complete Manual**. Lines marked **[derived]** were inferred rather than
> stated — confirm or correct them. Lines marked **TBD** are genuinely absent from the manual.
>
> The manual is the authority on mechanics and numbers. `src/game/constants.ts` is the authority on
> tuning values — always read it before quoting a number.

## Elevator pitch

A bus-company tycoon game played on **real cities**: found a transit company, place a depot, draw
lines along real streets, buy buses, hire drivers, set timetables and fares — and real census
commuters decide whether your service beats driving.

## Design pillars **[derived from §22 and the systems design]**

1. **Rules you can see.** Every constraint has a visible on-map expression — the depot tint *is* the
   placement rule, the express badge names its own thresholds, timetable modes show their arithmetic.
2. **Real data, honestly modelled.** Census commuters, OSM streets, measured traffic counts. The sim
   is allowed to be complex because the player can always see why it did what it did.
3. **The map shows shapes, panels show numbers.** Spatial questions get answered spatially; exact
   figures live in the UI layer.

## Core loop

- **Second to second:** watch buses run the network — riders spawn, walk, wait, board.
- **Minute to minute:** find where trips start and end → run a line between them → offer a frequency
  worth showing up for → watch the money.
- **Session to session:** quarterly report cards (10 days, 4/year) grade seven categories; profit and
  grants fund expansion into new corridors, bigger depots, better fleet.

## Stack

| | |
|---|---|
| Language | TypeScript |
| Platform | Browser, offline-capable (service worker + IndexedDB) |
| UI framework | **TBD** — not stated in the manual |
| Map rendering | Vector tiles (OpenFreeMap) restyled to the paper palette, with 3D building extrusions; **plus** a fully self-rendered offline basemap built from the city pack |
| Simulation | Runs in a **worker thread**, debounced ~250 ms on network change |
| Persistence | One save per city in `localStorage`; city packs (10–40 MB) in IndexedDB under a format version |
| Data sources | TIGERweb block groups, ACS/LODES population and jobs, OpenStreetMap streets/water/parks/landuse, FHWA/BTS AADT traffic counts |
| Distribution | **TBD** |

## Build & run

```bash
npm run bake    # bakes real-city packs (runs in CI; packs ship pre-built)
# dev server / build / test commands — TBD, not stated in the manual
```

## Project layout

```
src/game/constants.ts   ALL tunable numbers — the single source of truth
docs/design/            feature specs (game-designer)
docs/devlog/            devlogs (devlog-writer)
reference/              study material from other games — never ships
assets/incoming/        3D models awaiting import
```
Everything else is **TBD** — read the tree before assuming.

## Conventions

- **Tunables live in `src/game/constants.ts`.** The manual quotes it directly. Never inline a
  gameplay number anywhere else, and never quote one from memory — read the file.
- **One shared predicate per rule.** The `isExpress` test is used by the sim, the money, and the UI
  so they can never disagree. Follow that pattern for every rule with more than one consumer.
- **Every save field added since v1.0 is optional with a default.** Old saves must always load.
  Newer-than-current saves are never loaded or overwritten.
- **Errors funnel through one error bus** — readable red toast, ⚠ badge with a copyable session log,
  full-screen recovery card if the UI crashes. Saves are never touched by any recovery path.
- Schedules are **a pure function of the game clock**, so saves and reloads never teleport a bus.

## Art direction

- **Warm paper palette.** `--paper:#f6f1e1`, `--panel:#fffdf6`, `--ink:#2c2a24`, `--muted:#7a7259`,
  `--blue:#1d3f7a`, `--amber:#ffe9a8`, `--red:#c94f35`. Dark theme flips to `--paper:#23211b`,
  `--panel:#2c2a24`, `--ink:#ece5d2`, `--blue:#8fb0e8`, `--red:#e08668`.
- **Hand-drawn stroke icons everywhere. No emoji in chrome.** One bus drawing is reused from favicon
  to fleet list to loading screen.
- **Demand layer colors:** residents purple, destinations teal, travel modes blend car grey / bus
  green / walk blue / bike amber. Traffic forecast tints green→red.
- Map tints with time of day; buses run headlights and lit windows at night.
- Buses wear the company brand color with a full-length stripe in the line's color.

## Audio

**None described in the manual.** Either the game is silent or audio is undocumented — confirm before
`audio-designer` is given any work.

## Controls

| Action | Input |
|---|---|
| Pause / resume | `Space` |
| Speed 0.25 / 2 / 10 game-min per real second | `1` / `2` / `3` |
| Cancel draft → drop tool → close panel → deselect line | `Esc` (in that order) |
| Pan / select | Mouse |
| Dialogs | `Esc` cancels, `Enter` confirms — **never a browser popup** |

## Key numbers

Quoted from the manual; **verify against `src/game/constants.ts` before use.**

- **Fare** $1.00–$5.00 in 25¢ steps, default **$2.25** (the neutral point). Deviation converts at
  **$0.18/perceived minute**. City subsidy **$1.60/boarding**, **$2.40** on express.
- **Express** requires ≥ 5 km, ≥ 3 stops, ≥ 1.2 km average spacing. Rewards: on-board time ×0.85,
  half fare sensitivity, +50% subsidy.
- **Mode choice** logit: `share = 0.92 / (1 + e^((busMin − carMin)/9))`. Car time = distance at city
  car speed ×1.3 + 10 min parking penalty. **13%** captive riders.
- **Walk radius** 650 m at 12 min/km, minus the stop tier's perceived-walk bonus. Transfer penalty
  **6 min**, **2 min** at a Transfer Hub.
- **Waiting:** 70% of riders are timetable-aware (wait only the bus's lateness), 30% wait half a
  headway. Capped at 15 min.
- **Crowding** sheds riders by `(1/load)^0.65`.
- **Satisfaction** = 45% coverage + 35% short waits + 20% uncrowded + up to 6 for stop tiers, minus
  lateness (≤8) and station crowding.
- **Congestion** hourly curve ~1.45× at 07:30, 1.52× at 17:30, 0.9× overnight; road class multipliers
  motorway 1.35 / arterial 1.15 / collector 0.55 / local 0.18. **87%** of bus trips displace a car.
- **Bus kinematics:** accelerate 1.1 m/s², brake 1.3 m/s², 20 s dwell, 7 min refuel, 4 min layover
  each end, headway floor 2 min.
- **Wear** 2.2 points/day at full utilisation; ×1.5 short on mechanics, ×0.75 with a workshop. Raises
  running cost up to +35%.
- **Staff** drivers $26/h (only in service), mechanics $260/day (one per 6 buses), office $250/day.
- **Report card** weights: coverage 20, connectability 15, happiness 20, staff 15, safety 15,
  reliability 10, environment 5. Grant `(overall − 55) × $1,600` at ≥55; **$8,000 fine** below 35.
- **Credit score** starts 580, range 300–850.

## Scope

- **In:** four cities (Riverton demo, Worcester MA, Des Moines IA, Madison WI); depots (max 5, three
  levels, three add-ons); five bus models with Mk I–III upgrades; five stop tiers; two timetable
  modes; fares and express; two lenders; quarterly report cards.
- **Explicitly out:** **TBD** — worth writing down.
- **Deadline:** **TBD**

## Current state

Shipped at **v1.18**. This is a live game with real saves in the wild — **backward save
compatibility is a hard constraint on every change**, not a nice-to-have.

> ⚠️ The game's source is **not in this repository**. Point the crew at the real repo, or move this
> bible alongside the code, before asking anyone to implement anything.
