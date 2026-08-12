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

**41. A stop is anchored to a place, not to an edge id** (2026-08-12)
Saved stops record `(lng, lat, roadClass)` and re-anchor to the rebuilt graph on load. `edgeId`/`edgeT`
are derived-and-rebuilt, in the same category as schedules and bus positions.
*Why `roadClass` is part of the anchor:* it breaks ties when two candidate edges sit at similar
distance, and stops a residential-street stop silently migrating onto an arterial that a later OSM
extract widened. A stop that cannot re-anchor is kept and flagged `orphaned` — **never deleted**. An
agency does not quietly drop a stop from a timetable, and neither does this game.

**42. `contentHash` is promoted from diagnostic to load-bearing — for saves only** (2026-08-12)
The pack spec defines `contentHash` as diagnostic and never lets it gate pack loading. The save spec
needs it, because `packFormat` alone cannot detect a fresh OSM vintage baked under the same version,
and that is exactly the case that silently moves a player's stops.
*Ruling:* the promotion is fine. It gates whether **the save** takes the loud re-anchor path, not
whether the pack loads. The two specs stay compatible. Flagged here because it is the kind of
cross-document coupling that rots when nobody wrote down that it was deliberate.

**43. A rebake never invalidates a built depot** (2026-08-12)
Depots are position-anchored like stops, but they sit on land rather than on an edge. Zoning is a
**placement-time** check only — if a later OSM extract reclassifies the parcel, the depot the player
paid $150k for stays. Retroactively invalidating built infrastructure because a data vintage changed
would be indefensible, and no real agency loses a bus yard to a map update.

**44. Report cards are integrated over the quarter, never sampled at close** (2026-08-12)
Every category accumulates weighted by in-service game-minutes. A player who hires six drivers on
day 9 moves Staff happiness by two tenths of the delta, because that is how much of the quarter those
drivers worked.
*Why:* an agency is graded on the service it delivered, not the service it owned at 23:59 on day 10.
This is also why the panel must show **two** numbers — "Today 82 / Quarter 61" — since one number
produces "I fixed it, why didn't it count?"

**45. Coverage is scored against a 55% target, not mapped identity** (2026-08-12) **⚠︎ REVIEW**
A literal reading of §18 puts A+ at 93% of all residents within 650 m of a stop — unreachable in
Houston or LA, which are half the city roster. Scoring against a 55% target makes the top grade a
goal rather than a taunt. This is the one place the spec deviates from a literal reading of the
manual, and it is per-city overridable.

**46. A single-line network scores zero on Connectability** (2026-08-12)
The naive `Lmax / L` gives a lone line a perfect score for being alone. A `scale` term against a
4-line target fixes it. Flagged because an implementer reading only the manual's one-sentence
description will build the wrong thing.

**47. The 35–55 payout gap stays, and surprise is fixed in the UI instead** (2026-08-12)
Below 35 fines, 55+ pays, nothing between. It is where every honest new agency lives — two lines, a
driver shortage, around 45 — and fining that player is fining them for playing the tutorial. It also
separates *not yet earning* from *actively failing*, which a smooth curve would blur, and a
discontinuity is what makes a threshold something you can put on a gauge and count down to.
*The gap's only real cost is surprise*, so the fix is the top-bar grade chip and the projection line
— "even at 100 in every category from now, this quarter closes at 71" — not a gentler curve.

**48. The failure spiral runs, with three floors under it** (2026-08-12)
Low grade → no grant → worse service → lower grade is real and is the most honest lesson in the game;
cutting it makes the grant decorative. But the fine never creates unpayable debt, the 20-point dead
zone is a long runway, and Talon & Grasp is always available with no credit check. **The spiral may
make a player unable to act cheaply. It must never make them unable to act.**
*Explicitly rejected:* grade-based interest, escalating fines, any game-over.

**49. My fix for the line-splitting exploit was wrong, and the corrected one is different** (2026-08-12)
I proposed accumulating `fareMin` per boarding. `fareMin` is a *deviation* from $2.25, so that is
**exactly zero at the default fare** — changing nothing where it matters most — and *negative* below
it, where doubling a −6.94 min term makes a forced transfer more attractive. My fix would have turned
a +69% exploit into a **+117%** one.
*The actual fix:* the first boarding pays the deviation (the baseline is already inside the logit
calibration); every later boarding pays the **full fare**, 12.5 perceived minutes at $2.25. Splitting
goes from +69% to −9%.
*Kept as the clearest lesson of the session:* a fix that sounds right and is arithmetically inert.
The brief demanded the numbers be worked before and after, which is the only reason it was caught.

**50. Crowding was the same bug class, undetected** (2026-08-12)
`(1/load)^0.65` applied per leg and multiplied would shed a transfer rider **twice**, breaking the
model's own "one transfer = exactly two boardings" conservation test. Now: **minimum over legs,
applied once.** Station crowding likewise counts boarding stops only — origin and transfer, never
egress.
*Generalisation worth carrying:* wherever a per-trip quantity meets a per-boarding one, check the
composition. Two specs had it; nobody had looked.

**51. Fleet unlocks count linked trips, not boardings** (2026-08-12)
Unlocks keyed to "riders ever served" would otherwise be the same exploit again — split every line and
buy the Goliath at half the real ridership. Same for the top-bar Riders/day figure. Both now read
`linkedTripsLineHour`. The ledger still charges fare per boarding; **both numbers are correct for
their own purpose and confusing them is the bug.**

**52. Express halves the deviation only, never the extra-boarding fare** (2026-08-12)
The natural composition is the wrong one. Halving the full extra-boarding term lets a player split a
12 km express into two 6 km expresses — both still qualifying — and double a $2.40/boarding subsidy
for **+24%**. Halving the deviation only is also the more faithful reading of §11, whose "fare
sensitivity" is explicitly about deviation from $2.25.

**53. A residual low-fare exploit is real, structural, and left in for now** (2026-08-12) **⚠︎ REVIEW**
Below roughly $1.90, splitting still pays: **+29% at $1.25, +41% at $1.00.** The brake scales with
`fare`, the prize with `fare + subsidy`, and a $1.60/boarding subsidy exceeds a $1.00 fare.
*This is a real perverse incentive in per-boarding subsidy regimes, not a modelling error* — actual
agencies face it. It cannot be closed from the demand side without contradicting §17.
*The real fix, if playtest shows players find it:* pay the subsidy **per linked trip** rather than per
boarding. That is a ledger change and a deviation from the manual, so it waits for evidence.

**54. Legibility is defended with RGB distances, not opinions** (2026-08-12)
Parks were invisible not because their alpha was too low but because amber and paper have nearly the
same *lightness* — no alpha of amber-over-paper separates them. Mixing toward `--muted` first took the
park/paper distance from 20.4 to 69.4 at noon and 16.4 to 54.1 under the night tint. The road ladder's
worst gap was **motorway→trunk at 6.4 RGB units**, the pair a player most needs to tell apart, and
`service`/`living_street` shared an identical width floor — zero separation. Now evenly spaced, worst
case 15.8 noon / 12.8 night.
*The method is the decision:* every visual change that must stay distinguishable is defended with a
computed distance table at noon **and** at the 0.22 night alpha, not by looking at it.

**55. `mixHex` and `withAlpha` could not be chained** (2026-08-12)
`mixHex` returns an `rgb(...)` string; `withAlpha` parses only hex. Chaining them silently produced a
corrupt colour. Fixed with a single `mixHexAlpha` helper rather than leaving a trap for the next
person who reasonably assumes two colour helpers compose.

**56. Worktree copies were being counted in the test suite** (2026-08-12)
Agents running in isolated worktrees under `.claude/worktrees/` leave a full copy of the repo,
including its tests, and vitest's default glob was discovering them — running every test twice, half
of them against **another agent's in-progress code**. Every "the full suite passes" report during that
window was partly fiction.
*Fixed by excluding `.claude/**` from test discovery and gitignoring the worktree directory.* Worth
recording because worktree isolation is otherwise the right tool, and this is its sharp edge.

**57. Three refactors bundled into one pass, and the blast radius proved it right** (2026-08-12)
Hoisting stops out of `Line`, stable branded ids, and `roadClass` on `Stop` landed together.
`buildRouteSchedule` needed a `stopsById` parameter and every hand-built `Line` fixture across three
test files had to change — because after the hoist **a `Line` cannot answer "what are my stops" on
its own anymore.** Done separately, that same set of call sites would have been rewritten three
times, with two intermediate shapes that were nobody's target.
*Branded ids (`number & { __brand }`) are the durable part:* the id/index collision existed because
the two were the same type and the compiler could not object. Renumbering fixed today's bug; the
brand stops the class of bug returning.

**58. My own ownership rules have to be applied consistently or they do not work** (2026-08-12)
I forbade `src/game/constants.ts` to the zone agent and forgot to forbid it to the error-bus agent.
Both it and the worktree refactor appended constants to the tail of that file, creating a merge
conflict that the rules exist to prevent. Small and mechanical to resolve — but it was my
inconsistency, not an agent's mistake.
*Rule going forward:* shared files are named in **every** brief that could plausibly touch them, not
only the ones where I happen to think of it.

**59. I mistook the root cause for a cosmetic complaint, three times** (2026-08-12)
Buses invisible, parks invisible, road hierarchy illegible — three findings, three separate fixes,
each verified correct in isolation. All three were the **same bug**: `fitToBounds` renders the whole
city into a ~262×273 px square inside a 1317×507 canvas, so everything on the map is drawn at about a
third of the scale it should be. An 18 px bus marker against a city filling the screen is a different
object from 18 px against a city occupying a third of it.
*I had the evidence twice and misread it.* The second playtest reported "the map occupies about a
third of the screen width, centred in a large empty void" and I filed it as dead space — a layout
nicety — while separately chasing the symptoms it was producing. A third playtest connected them.
*The transferable lesson:* when three independent fixes all fail to show up, stop fixing and look for
what they share. Repeated failure of correct fixes is itself the evidence.

**60. The missing assertion is the one that lets a bug survive verification** (2026-08-12)
Nothing anywhere asserted that the city occupies a reasonable fraction of the viewport. Every
individual marker had its size tested, its colour distance measured, its contrast defended — and the
one property that made all of that moot went unchecked through three playtests.
*Now a regression test:* `fitToBounds` must place the bounds across at least a stated fraction of the
smaller viewport axis, at several aspect ratios.

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
