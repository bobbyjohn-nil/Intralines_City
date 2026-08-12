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
  `--blue:#1d3f7a`, `--amber:#ffe9a8`, `--red:#c94f35`.
- **Light mode only** (decided 2026-08-12). The game no longer follows `prefers-color-scheme`. The
  map carries its own day/night tint, and dark chrome fights it — a night-tinted map inside a dark
  UI loses the day/night read entirely. The dark palette is kept in `src/styles.css` under an
  unapplied `:root[data-theme='dark']` selector so it can return behind a setting; nothing sets that
  attribute today. **A dark theme is not a missing feature — do not "fix" it.**
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

## Featured cities

Decided 2026-08-12, superseding the manual's Worcester / Des Moines / Madison. All real cities are
built from the same sources the manual specifies: **OpenStreetMap** streets, water, parks, airports,
rail stations and industrial land use; **TIGERweb** block-group geometry; **ACS/LODES** population
and jobs; **FHWA/BTS** AADT traffic counts. Baked into a city pack and cached locally, so a city
works fully offline after first load.

| City | Population | Why it plays differently |
|---|---|---|
| **Riverton** | procedural | Demo. Instant play, no download. |
| **Boston, MA** | ~650k core, ~4.9M metro | Dense, old, irregular street grid. Water everywhere. The one where geography fights you. |
| **Los Angeles, CA** | ~3.8M | Vast, low density, car-dominant. The hardest mode-choice problem in the game. |
| **Orange County, CA** | ~3.2M | Polycentric — no single downtown. Breaks any strategy that assumes trips flow to a centre. |
| **Houston, TX** | ~2.3M | Sprawling, freeway-shaped, minimal zoning. Enormous distances between origins and destinations. |

### The scale problem — corrected 2026-08-12, read before building the city pipeline

My first reading of this was wrong in an instructive way, and the corrected version is what governs.
See [city-packs.md](docs/design/city-packs.md) for the arithmetic.

**I assumed pack size was the binding constraint. It is not, and it is not close.** The manual's
10–40 MB figure is an artifact of JSON serialisation, not an information floor. With coordinate
quantisation, delta-varint encoding, degree-2 chain collapse, and the manual's own decision that
buildings are generated procedurally rather than shipped, every featured city lands at **0.4–0.5 MB
gzipped** — the full LA basin at ~0.82 MB. That clears the 20 MB budget twentyfold even at 3×
estimation error. **Do not build tiling.** It would be defensive engineering against a problem that
does not exist.

**The real constraint is zone resolution, and it sets the playable area.** `ZONE_CAP = 512` spread
over LA County's 12,300 km² gives zones 4.9 km across, against a 650 m walk radius — the unit of
demand would be seven times wider than the thing that decides whether anyone can reach a stop. Demand
would be meaningless mush regardless of how small the file is.

So the playable bounding box is budgeted from **zones, not bytes**: a zone square of ≤ 900 m
(half-diagonal ≈ the walk radius) × 512 zones ≈ **400 km² of developed land per city**. Boston fits
comfortably at 225 km² and gets the best resolution of the four; the other three clip to ~365–390 km².

**That clip has an identity cost, and it is not evenly distributed.** Houston reduced to the 610 loop
plays like an ordinary medium-density city, which loses most of why Houston is interesting — one long
corridor to Hobby preserves a little of it. LA loses LAX, the Valley and Santa Monica; the north edge
is pushed to catch Burbank so the airport generator still fires, but a 26 km box halves the vastness
that is LA's whole reason for being on the list. Orange County survives almost intact — its
polycentricity is the point and that fits in the box.

**The 250 ms debounced recompute** remains untested at these sizes. It is bounded by zone count
rather than population, so `ZONE_CAP` protects it too — but that is reasoning, not measurement.

[demand-model.md](docs/design/demand-model.md) already carries the main mitigation: demand is
modelled per **zone**, not per person, with a hard `ZONE_CAP = 512` that merges nearest-neighbour
block groups above the cap. That keeps the O–D table at ~3 MB regardless of city size — LA does not
blow up, it gets coarser. Whether 512 zones is enough *resolution* for a city of 3.8M is an open
question, and the honest answer will come from baking one and looking at it.

**Do not treat this as solved because it is written down.** The first real-city milestone should
bake **Boston** first — the smallest of the four and the most geographically interesting — measure
pack size and recompute time honestly, and only then commit to the other three. If the numbers do
not hold, the fix is a coarser demand grid, not shipping a city that stutters.

## Scope

- **In:** five cities — see Featured cities below; depots (max 5, three
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
