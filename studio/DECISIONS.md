# Decision log

Every decision made without the owner in the room, with the reasoning. Newest last.

Format: **what was decided** — why — how to reverse it if it was wrong.

Decisions marked **⚠︎ REVIEW** are ones I'd most want a second opinion on.

---

## Stack and structure

**1. TypeScript + Vite + React + MapLibre + Three.js + Vitest** (2026-08-12)
The manual states TypeScript, a browser target, a worker-thread sim, OpenFreeMap tiles and IndexedDB
packs. React was inferred from the manual's own wording — menus are "portaled outside the dock",
which is React's idiom. The rest are conventional choices for that stack.
*Reverse:* cheap now, expensive after Milestone 2. Marked `[chosen]` in GAME.md.

**2. Not rewriting in Rust** (2026-08-12)
Asked whether Rust would be more efficient. For the whole game, no — nearly every requirement is
web-platform-shaped (service worker, IndexedDB, vector tiles), so Rust means doing that work through
a binding layer. For the sim kernel specifically the argument is real, but there is no sim yet and
therefore nothing to profile. Rewriting on a guess is how weeks disappear.
*Instead:* the sim is written pure-functions-over-flat-typed-arrays so a future WASM port is
mechanical rather than a rewrite. Recorded as a hard constraint in GAME.md.

**3. Crew files quarantined under `studio/`** (2026-08-12)
Owner asked for bot files separate from game files. `.claude/` and `CLAUDE.md` must sit at the repo
root because the tooling resolves them there; everything else moved to `studio/`, which ships
nothing and can be deleted without affecting the build.

**4. Git LFS enabled before any binary landed** (2026-08-12)
Assets committed before LFS is on stay in history at full size forever, and retrofitting means
rewriting history. Enabled `--local` so the owner's global git config is untouched.

## Game design

**5. Light mode only** (2026-08-12)
Owner asked for a light map. Went further and removed `prefers-color-scheme` entirely rather than
just flipping the default: the map carries its own day/night tint, and dark chrome fights it — a
night-tinted map inside a dark UI loses the day/night read completely. The dark palette is kept
unapplied under `:root[data-theme='dark']`.
*Reverse:* set that attribute and restore the media query. One file.

**6. Night tint capped at alpha 0.22** (2026-08-12)
A player must be able to plan a route at 03:00. Verified numerically rather than by eye — the
worst-case tint was composited over every base layer and pairwise RGB distances measured; layers
stay 78–266 apart. Data legibility beats atmosphere, per the game's own pillars.

**7. Choosing a speed resumes a paused game** (2026-08-12)
Found by playing: the speed buttons set the rate but left the clock stopped, so ▶ looked like a dead
button. Picking a speed now means "run at this speed". Fixed in the wiring so `TopBar` stays
presentational and does not need to know about pause state.

**8. Two buses on every newly created line** (2026-08-12) **⚠︎ REVIEW**
Milestone 1 has no fleet screen, so a new line would otherwise sit inert. Two buses is a token
service that makes the line visibly do something. Marked `# tune` in `App.tsx`.
*Real-agency note:* a real operator sizes the fleet from the headway the timetable demands, not the
other way round. This inverts that and should die the moment the Fleet panel exists.

**9. Starting cash $500,000** (2026-08-12) **⚠︎ REVIEW**
Not stated anywhere in the manual. Chosen so the player can afford a $150k depot, a $260k bus and a
handful of $4k stops with a little slack — roughly one line's worth of capital. Marked `TUNE`.

**10. Featured cities: Boston, LA, Orange County, Houston** (2026-08-12)
Owner's choice, replacing the manual's Worcester / Des Moines / Madison. Each was given a stated
reason to exist as a distinct problem: Boston's geography fights you, LA is the hardest mode-choice
case, Orange County is polycentric and breaks centre-seeking strategies, Houston is freeway sprawl.
*Consequence I flagged rather than absorbed:* these are 10–20× the population the manual's numbers
were tuned against. Instruction recorded to **bake Boston first**, measure pack size and recompute
time honestly, and only then commit to the other three.

**11. Riverton rebuilt around its river** (2026-08-12)
The original grid was non-uniform (a dense stripe, not a downtown) and ignored the river entirely.
Rebuilt with uniform blocks, embankment roads following each bank, **3–5 bridges rather than a
crossing at every street**, and one diagonal avenue.
*Real-agency reasoning:* chokepoints are what make transit planning interesting. A river you can
cross anywhere is scenery; a river with four bridges is a design constraint.

## Architecture

**12. Shared contracts written by the orchestrator, not by agents** (2026-08-12)
`src/game/types.ts` and `src/game/constants.ts` are owned centrally. Defining them before fan-out is
what let five agents build independently without silently disagreeing about data shapes.

**13. Every constant tagged SPEC or TUNE** (2026-08-12)
`SPEC` is stated in the manual and must not drift; `TUNE` was chosen to fit and is expected to move.
Without this, a later contributor cannot tell which numbers are load-bearing.

**14. Bus position is a pure function of the game clock** (2026-08-12)
Stated by the manual and enforced in tests. No frame-to-frame integration, so saves and reloads can
never teleport a bus, and the renderer can ask for a position at any time without the sim ticking.

**15. Demand is modelled per zone, not per person** (2026-08-12)
~320 zones for a mid-size city rather than 270k people, with a hard `ZONE_CAP = 512` merging
nearest-neighbour block groups above the cap. Keeps the O–D table at ~3 MB regardless of city size —
LA does not blow up, it gets coarser. On-map rider agents are presentation sampled from rates, not
simulated individuals.
*Open question:* whether 512 zones is enough resolution for 3.8M people. Answerable only by baking
one and looking.

**16. Walk radius specced as a perceived-minute budget** (2026-08-12) **⚠︎ REVIEW**
The manual conflicts with itself: §14 says riders walk 650 m *minus* the stop-tier bonus, §9 says
nicer stops "pull riders from further out". Resolved as a 7.8-perceived-minute budget, so a Transfer
Hub physically reaches ~933 m.
*Why:* §9's intent only makes sense if better stops widen the catchment — otherwise upgrading a stop
shrinks it, which no agency would build. One constant to change if wrong, but it materially changes
how valuable stop upgrades are.

**17. Save format designed before any saves exist** (2026-08-12)
There are no live saves today, so the envelope is free to change; once there are players it never is
again. Spec covers the versioned envelope, an 8-step ordered check, defaults-on-read plus an ordered
migration chain, and the refusal path for newer-than-current saves.
*Two problems it caught in existing code:* `Stop.edgeId` indexes a graph that is regenerated on load
(so `position` becomes authoritative and stops re-anchor within 40 m), and `Line.stops` nests stop
objects so a shared stop is duplicated. Both are now must-fix-first backlog items.

**18. Buses scale with zoom** (2026-08-12)
Playtest root-caused the "invisible buses" report: the marker was a fixed 11×6 CSS pixels with no
zoom scaling, unlike stops and routes which both scale. At fit-to-bounds zoom — the zoom players
actually plan at — that is an invisible speck.
*Principle:* the bus is the most important moving thing on the map, because it is what the player
built the line for. It should read as such at every zoom.

**19. `refund` promoted into the economy module** (2026-08-12)
It lived unexported in `App.tsx` with no counterpart to `spend`, violating the project's own "one
shared predicate per rule" convention. Safe only because the stop cost is a whole-dollar amount; a
fractional cost would have let the undo and cancel paths diverge by a cent with nothing in
`src/game/` catching it.

**23. `vite-plugin-pwa` rather than a hand-rolled service worker** (2026-08-12)
Offline is a hard constraint that was entirely unimplemented — the playtest could not verify it
because there was nothing to verify. Hand-rolling cache invalidation and update flows for an
offline-first game is effort spent on a solved problem.
*Required:* disabled in development, because a caching layer during dev would confuse every other
agent working in this repo. Production builds only.
*Split:* `build-engineer` builds the update mechanism and exports a hook; `ui-designer` owns the
"New version available" banner. Neither blocks the other.

**24. Legibility guaranteed structurally, not by eye** (2026-08-12)
Two examples worth generalising into a house rule. The bus marker's minimum size is derived from the
stop marker's maximum (`BUS_MARKER_LENGTH_MIN_PX > STOP_RADIUS_MAX_PX * 2`) and asserted in a test,
so a bus is larger than a stop at *every* zoom by construction rather than at the zooms someone
happened to check. The bus body colour was moved onto a `muted→amber` axis that roads (`ink`/`muted`)
and route lines (`blue`/`red`/`amber`/`ink`) cannot structurally reach, rather than picking a value
that merely looked different.
*Rule:* when two things must stay visually distinct, derive one from the other and assert it. A
tuned value drifts the first time someone adjusts the other end.

**25. A line stores a target headway, not a bus count** (2026-08-12) — *retires decision #8*
`BUSES_PER_NEW_LINE = 2` is replaced by `NEW_LINE_TARGET_HEADWAY_MIN = 12` stored on the line. The
line asks for `ceil(roundTrip / 12)` buses and is filled from spares only, never auto-purchased; with
no spares it is created suspended behind a purchase requisition naming the cost.
*Why this is the right direction of causation:* an operator decides the headway a corridor deserves
and the headway tells it what that costs — not the reverse. Storing a headway also means extending a
route changes the bus requirement automatically, which a stored count could never do.

**26. Refurbishment is a Safety decision, not a fuel-bill decision** (2026-08-12)
Both the refurbish price and the running-cost saving are linear in wear, so they cancel:
`payback_days ≈ 0.343 × list ÷ dailyRunCost`, about 190 game-days for a Metro 40. It will never pay
for itself through running costs. It is bought to protect the Safety grade (15% of the report card)
and resale value, and the game should say so in those words rather than let players discover the
maths the hard way.
*If playtesting shows nobody refurbishes,* the lever is the Safety weight, not the 12% price — the
price is SPEC.

**27. "Line" is the player's creation; "route" is the street path** (2026-08-12)
These are not synonyms in the transit industry and the game will not treat them as such. The player
draws and owns a *line*; *routing* is what the pathfinder does along real streets. Matches the
manual's own usage throughout.

**28. I was wrong about pack size, and the correction changed the design** (2026-08-12)
I warned that LA-scale cities would blow the 20 MB budget and would need tiling. The city-pack spec
did the arithmetic and the warning was wrong: the manual's 10–40 MB is a JSON artifact, not an
information floor. Binary-packed, every featured city is 0.4–0.5 MB gzipped. **"Do not build tiling"
is now written into the spec** so nobody defends against a problem that does not exist.
*The real constraint is zone resolution.* `ZONE_CAP = 512` over LA County gives 4.9 km zones against
a 650 m walk radius — demand would be mush no matter how small the file is. So the playable bounding
box is budgeted from zones, not bytes: ~400 km² of developed land per city.
*Kept because it is the honest record:* a plausible-sounding constraint that survives unchallenged
becomes architecture. This one was challenged because the brief demanded the arithmetic be shown.

**29. Playable-area clipping costs each city differently** (2026-08-12) **⚠︎ REVIEW**
Boston fits at 225 km² with the best resolution of the four. The others clip to ~365–390 km².
Orange County survives nearly intact — polycentricity is the point and it fits. **Houston reduced to
the 610 loop plays like an ordinary medium-density city**, which loses most of why Houston is
interesting; one corridor to Hobby preserves a little. LA loses LAX, the Valley and Santa Monica,
with the north edge pushed to catch Burbank so the airport generator still fires.
*Worth your call:* Houston may not earn its slot under these constraints. A fifth city chosen for how
it plays at 400 km² might serve better than a famous one that does not survive the clip.

**30. In-browser city assembly is dead** (2026-08-12)
It would need a 200–400 MB source extract plus live Overpass/ACS calls at play time — 300× the pack
it produces, non-deterministic, and a network dependency in a path the offline constraint forbids.
Demoted to a dev-only tool behind a flag. The manual's staged-progress screen survives unchanged in
shape; it names decode stages instead of assembly stages, which is all the player ever saw.

**31. Dead-heading costs money, time and wear** (2026-08-12)
Buses are allocated to depots by driving *time* over the road graph, not crow-flies distance, and
non-revenue kilometres burn fuel, maintenance and driver wages exactly like revenue ones. Broken out
as its own Finance row, the way agencies report non-revenue miles.
*Why:* free dead-head deletes the entire reason depot siting is a decision. The worked example — five
buses moving from a 7 km yard to a 1 km yard saves ~$162/day, with a ~3 km break-even against
upgrading in place — is what makes "second depot or bigger depot" a real question rather than a cost
comparison.

**32. One canonical timetable, two views** (2026-08-12)
`busesRequested` per window is the stored truth; headway is derived. `mode` is a view flag the sim
never reads. That is what makes switching between Normal and Advanced lossless rather than
destructive, and it is the difference between one honest feature and two half-features.

**33. A new release never swaps a running tab** (2026-08-12)
The service worker is configured **without** `clientsClaim`/`skipWaiting`. Those were set to true
initially and caught during verification: they make every new worker activate on install, silently
replacing the running app under a player mid-game. The new worker now installs, waits, and activates
only on an explicit message from the Reload button.
*Why this is the whole point:* the manual's banner exists precisely so the player chooses when to
take an update. Auto-activation would make the banner decorative. Auto-reloads stay capped at two per
session in `sessionStorage` so a half-propagated deploy cannot loop anyone.

**34. Offline is verified by cutting the network, not by checking a registration** (2026-08-12)
"A service worker registered" is not evidence. The verified test is: build, serve, load, disable the
network at the browser level, reload, and confirm the actual game UI renders — plus a control check
that a cross-origin fetch really fails, so the test cannot pass against a network that was never
down. This is the standard for every future offline claim.

**35. Riverton is planned around its river, not laid over it** (2026-08-12)
Uniform 140 m blocks (measured stddev 0.29 m), arterials every 6th line, two grid rows bent to hug
the river as embankment roads, **exactly 4 bridges** with every other crossing cut, and one diagonal
avenue built by splitting the grid edges it crosses so the intersections are real.
*Why bridges rather than a crossing per street:* a river you can cross anywhere is scenery. Four
crossings make the river a constraint the player has to plan around, which is what a transit planner
actually does. The property worth protecting is not "there are 4 bridges" but "every cross-river
route uses one" — now being asserted directly, because bridge count alone would still pass if a
future change quietly reconnected the banks.

**36. Verification stays with `playtester`, not with the agents that build** (2026-08-12)
`ui-designer` and `2d-artist` have no browser and correctly refuse to claim their work looks right.
I chose not to give them one. One agent whose whole job is driving the game and hunting for defects
has outperformed what four agents glancing at their own output would produce — today it root-caused
the invisible buses, the dead ▶ button, and the page-scroll bug, none of which the building agent
would have gone looking for in its own work.
*Fixed instead:* `writer` had no shell at all and could not even build-check its string edits. That
was a gap, not a design; it now has Bash.

**37. The manual's own arithmetic is slightly wrong, and the constant wins** (2026-08-12)
The manual says a $3.25 fare feels "~5.5 min" longer. `(3.25 − 2.25) / 0.18 = 5.5556`, so the UI will
read **+5.6 min**. Reproducing "5.5" exactly would need $0.1818/min.
*Decision:* keep `$0.18` — it is the stated SPEC constant and the prose is rounded-down narration.
Never retune a constant to match prose.

**38. Fare is perceived per boarding, not per trip** (2026-08-12) — *closes an exploit*
The manual charges fare and subsidy per **boarding** (§17) but converts fare to perceived minutes per
**trip** (§11). Splitting one line into two therefore doubled fare *and* subsidy from the same rider
at zero perceived cost — $3.85 of free revenue per rider for a cosmetic edit, and a dominant strategy
the moment anyone noticed. The transfer penalty was the only counterweight, and at a Transfer Hub it
is nearly free.
*Fix:* accumulate `fareMin` per boarding in the RAPTOR label. A rider who boards twice pays two fares
and perceives two fares.
*Real-agency justification:* breaking a through-route into two with a forced transfer loses ridership.
That is well understood by anyone who has done it, and the model should reproduce it rather than
reward it.

**39. Express stays earned by geometry, with feedback instead of a toggle** (2026-08-12)
A toggle would not remove the predicate — something must still stop a 14-stop local collecting
$2.40/boarding. It would only add a "designated but ineligible" state and a way to lose a reward you
earned by forgetting to click. The trap the manual creates is real but it is a *feedback* failure:
the guard rail is a warning before an edit that would lose the status, a transition notice, and
highlighting the shortest gap. Zero mechanics change.

**40. Low fares can out-earn high ones, and that is the best decision in the game** (2026-08-12)
At a marginal O–D pair: $1.00 returns $1.761 per candidate rider at 0.677 mode share; $5.00 returns
$1.676 at 0.254. The cheap fare earns more *and* carries 2.7× the riders. Remove the $1.60 subsidy
and it inverts to $0.68 vs $1.27 — **the subsidy is the entire reason**, exactly as in real transit
funding. It stays a genuine decision rather than a dominant strategy because it is corridor-dependent:
where the bus badly beats the car, high fares extract more.

## Process

**20. Nothing enters the changelog until `playtester` has run it** (2026-08-12)
Agents reporting success is a claim; the game running is evidence. Two bugs this session were
invisible to a passing test suite — the dead ▶ button and the 8px body margin that let the page
scroll out of place.

**21. Model tiering** (2026-08-12)
Design on the expensive tier, build on the middle, audio wiring and devlogs on the cheap one, with
escalation on stall. A bad spec makes every downstream agent correctly build the wrong thing, so
design is the one place cheapness is expensive.

**22. Test files are the parallelism escape hatch** (2026-08-12)
They are not part of the app bundle, so `test-engineer` can work in `src/` without hot-reloading the
page underneath a live playtest. That, not agent count, was the real constraint on running work
concurrently.
