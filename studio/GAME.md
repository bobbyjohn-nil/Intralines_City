# Intralines Bus Simulator — Game Bible

> Every agent in the crew reads this file first.
>
> **The game is being built from its manual.** No source is inherited — [the complete v1.18
> manual](docs/design/manual-v1.18.md) is the specification, and we implement it. It describes a
> finished game in full detail: every mechanic, formula, threshold and UI decision.
>
> That makes the manual the authority on **what** to build. It is not authority on **how** — file
> layout, framework idiom and code structure are ours to choose. Where the manual names a number,
> use it exactly. Where it describes behaviour without a number, `game-designer` picks one and marks
> it `# tune`.
>
> Once `src/game/constants.ts` exists it becomes authoritative for tuning values, and the manual
> becomes the record of intent. Lines below marked **[derived]** were inferred rather than stated.

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
Stated in the manual where marked; otherwise **[chosen]** — a default picked to fit the manual's
evidence. Change any `[chosen]` row before implementation starts and the rest of the crew follows.

| | |
|---|---|
| Language | TypeScript — *stated* |
| Platform | Browser, offline-capable (service worker + IndexedDB) — *stated* |
| Build tool | **[chosen]** Vite |
| UI framework | **[chosen]** React — the manual says menus are "portaled outside the dock", which is React's idiom |
| Map rendering | MapLibre GL JS **[chosen]** for OpenFreeMap vector tiles restyled to the paper palette with 3D extrusions — *the tile source is stated*; **plus** a self-rendered offline basemap from the city pack — *stated* |
| 3D (buses, station diorama) | **[chosen]** Three.js, via a custom MapLibre layer for on-map buses |
| Simulation | Web Worker, debounced ~250 ms on network change — *stated* |
| Persistence | One save per city in `localStorage`; city packs (10–40 MB) in IndexedDB under a format version — *stated* |
| Tests | **[chosen]** Vitest |
| Data sources | TIGERweb block groups, ACS/LODES population and jobs, OpenStreetMap streets/water/parks/landuse, FHWA/BTS AADT traffic counts — *stated* |
| Distribution | **TBD** |

## Build & run

`npm run bake` is *stated* by the manual. The rest are **[chosen]** conventions — implement them to
match, and update this block if they change.

```bash
npm run dev      # dev server
npm run build    # production build
npm run test     # test suite
npm run bake     # bake real-city packs (also runs in CI; packs ship pre-built)
```

## Project layout

The game and the crew are kept strictly apart:

```
src/game/constants.ts   GAME — all tunable numbers, the single source of truth
src/**                  GAME — everything that ships

studio/                 CREW — none of this ships
  GAME.md               this file
  BACKLOG.md            work queue
  CHANGELOG.md          the crew's record of finished work
  docs/design/          feature specs (game-designer)
  docs/devlog/          devlogs (devlog-writer)
  reference/            study material from other games
  assets/incoming/      3D models awaiting import

.claude/                CREW — agent and skill definitions (must live at repo root)
CLAUDE.md               CREW — pointer file (must live at repo root)
```

**No agent writes outside `studio/` unless the task is game code.** Nothing under `studio/` is
bundled, imported, or shipped. The game's own source layout beyond `src/game/constants.ts` is
**TBD** — read the tree before assuming.

> `studio/CHANGELOG.md` is the crew's internal record. It is **not** the player-facing changelog the
> game displays in its home menu — that one lives with the game and is written for players.

## Hard constraints

These two shape every technical decision. Neither is negotiable.

### Offline is a requirement, not a feature

After the first load the game must work with the network cable pulled. No feature may depend on a
server at play time — no remote sim, no API call in a gameplay path, no font or asset fetched on
demand. Anything from the network is fetched once, cached deliberately (service worker for code,
IndexedDB for city packs), and has a working offline fallback. The self-rendered basemap exists for
exactly this reason: a real city must still render with zero network.

**Test the offline path, not just the online one.** A feature verified only with a live connection is
unverified. `playtester` checks both.

### The simulation must stay portable to WebAssembly

All heavy compute runs on the player's machine — that is what offline means — and the sim is where it
concentrates: gravity O–D tables, best-path search across lines with transfers, per-tick vehicle
kinematics, all recomputed on a ~250 ms debounce. TypeScript in a worker is the right call today, and
we are not porting anything on speculation. But write the sim so that a port is mechanical rather
than a rewrite:

- **Pure functions.** State goes in as arguments, results come out as return values. No hidden
  mutation, no reaching into module scope.
- **Flat typed arrays** (`Float64Array`, `Int32Array`) for anything indexed per-commuter, per-edge, or
  per-stop. Never an array of objects in a hot loop.
- **No class instances or object graphs in the hot path.** Indices into parallel arrays, not
  references between objects.
- **No allocation inside a tick.** Allocate buffers once, reuse them.
- **Keep the worker boundary narrow** — pass buffers, not deep structures, and prefer transferables.

This is better TypeScript on its own terms: it is what makes a worker cheap to feed and a profiler
readable. It also means that if profiling ever says the sim is the bottleneck, the hot kernel can be
swapped for Rust/WASM without touching the game around it. **Profile before proposing that port** —
we have no measurement yet, and rewriting on a guess is how weeks disappear.

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

**Nothing is built yet.** The repository holds the crew and the spec; `src/` does not exist.

The manual describes a v1.18 game, so it documents years of accumulated systems. **Do not try to
build it in manual order.** Follow the build order in [BACKLOG.md](BACKLOG.md): a playable slice
first — one procedural city, one line, buses that move, money that changes — then real city data,
then the depth. Most of the manual is unreachable until the loop underneath it runs.

The manual's save-compatibility rules describe a shipped game protecting live saves. Until v1.0
there are none, and the format is free to change. Build the **versioned save envelope** early
anyway — retrofitting it is the expensive path, and it is the one thing the manual is emphatic about.
