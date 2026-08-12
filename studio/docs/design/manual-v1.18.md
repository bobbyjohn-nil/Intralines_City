# Intralines Bus Simulator — Complete Manual (v1.18)

> **This is the specification.** The game is built *from* this document.
> Extracted from the manual artifact. Where an agent needs a number, it comes from here until
> `src/game/constants.ts` exists — after which the constants file is authoritative and this
> document records intent.

---

Intralines Bus Simulator — The Complete Manual
Documents v1.18 of the game. Every mechanic, number and UI decision in the game is described here, with the reasoning behind it. Numbers quoted are the actual constants from src/game/constants.ts unless noted.
ContentsWhat the game isStarting upThe home menuFounding a companyThe main screenThe mapDemand layers (the Map menu)DepotsStops and linesTimetablesFares and express serviceThe fleetStaffRiders: how demand worksTraffic and buses on the mapThe station viewMoneyReport cardsSaves, autosaves and versionsErrorsBehind the city packs (for the curious)Design principles the UI follows
1. What the game is
Intralines is a bus-company tycoon game played on real cities. You found a transit company, place a depot, draw bus lines along real streets, buy buses, hire drivers, set timetables and fares — and real census commuters decide whether your service beats driving. The city grades you quarterly; profit funds expansion.
The core loop: find where trips start and end → run a line between them → offer a frequency worth showing up for → watch the money.
Four cities ship with the game:
 |  | City | Kind | Data
 | Riverton | Demo | Procedurally generated — instant play, no downloads
 | Worcester, MA | Real (pop ≈ 206k) | US Census + OpenStreetMap
 | Des Moines, IA | Real (pop ≈ 214k) | US Census + OpenStreetMap
 | Madison, WI | Real (pop ≈ 272k) | US Census + OpenStreetMap
Real cities are built from: TIGERweb block-group geometry, ACS/LODES census population and jobs (with education and tourism sector splits), OpenStreetMap streets, water, parks, airports, rail stations and industrial land use, and FHWA/BTS traffic counts (AADT). Everything is baked into a single "city pack" and cached locally, so after the first load a city works fully offline.
2. Starting up
[IMG]Home menu
The boot splash
Before any game code loads, an inline splash shows the game's bus (the same drawing used everywhere else) over a progress shimmer. The status line beneath it cycles depot chatter — "Loading passengers…", "Performing safety checks…", "Setting the destination blinds…" and nine more, rotating just under a second apart from a random start. This line is decoration; real city-loading progress has its own screen with genuine stage names.
The hand-off transition
When the app is ready, the splash bus starts its engine and drives away, towing the loading screen off the right edge (total 2.4 s):
0–0.9 s — parked dead centre. Two hard shakes as the engine catches, settling to a faint idle wobble, with three puffs of exhaust from the tail.
0.9–2.4 s — pulls away on an ease-in curve: slow off the mark, still gathering speed as it exits, like a real bus leaving a stop.
[IMG]The bus towing the loading screen away
It plays once per browser visit and is skipped entirely under prefers-reduced-motion.
The tab icon
The favicon is the same bus, drawn as a plain dark outline with no background tile, legible at 16 px.
Updates (what a player sees)
The game manages its own updates so a new release never breaks an open tab:
A service worker keeps each release's page and files together as a set. A new deploy is picked up on your next visit; the old version's cache is deleted. Because the files are cached, the game opens with no internet.
A tab left open across a release shows a dark "New version available" banner in play (Reload / Not now — your company is saved before reloading); on the menu it updates itself automatically, capped at two automatic reloads per session so a half-propagated deploy can't loop you.
If boot ever fails, a recovery card appears with Reload and Clear caches & reload (which also drops the service worker — the escape hatch from a bad release). Saved games are never touched by either button.
3. The home menu
Four tabs down the left; the current version (from the changelog) shows as a chip and in the footer.
Play
[IMG]City picker
One card per city, with region and population. Real cities show whether their data is already downloaded; the first open either uses the pre-baked pack hosted with the game or downloads sources in the browser (with a staged progress screen). A city with an in-progress company shows Continue.
Saves
[IMG]Saves tab
One row per city with a save: company name, city, timestamp, sandbox badge if applicable. From here you can continue, export a save to a JSON file, import one, or delete. Import accepts saves from any older version of the game (they're upgraded on load) but refuses saves from a newer version rather than misread them.
Settings
[IMG]Settings
Basemap preference (Auto = online tiles when reachable / Offline = built-in self-rendered map), downloaded-city management (per-city delete, clear all — verified to actually empty the cache before reporting success), and the danger zone reset. All confirmations use the game's own dialog (Esc cancels, Enter confirms) — never browser popups.
Changelog
Full release notes, newest first, in player-facing language. One entry per working session; the newest entry's version is what the home screen displays.
4. Founding a company
[IMG]Founding screen
Shown once per city, before the map. You set:
Company name (up to 32 characters; defaults to "City Transit Co.").
Brand color from ten swatches — every bus you own wears this color as its body paint; each line's own color rides on a stripe.
Sandbox mode — infinite money. Cash is pinned at ∞ every tick, so nothing ever bites; report cards still arrive. Sandbox saves are labelled in the save list. The choice is permanent for that company.
5. The main screen
[IMG]First view of a city, with the how-to-play panel open
Entering a city always starts paused so you can look around and plan before wages start burning. A notice reminds you to press ▶ (or Space). First-time companies open with the How to play panel; returning saves don't.
Top bar (left to right)
 |  | Chip | Meaning
 | ‹ City name | Back to menu (saves first)
 | ● Company | Your brand color + name
 | Calendar/clock | Year 1 · Quarter 1 Day 1 06:00 — 10-day quarters, 4 quarters/year. A small congestion icon appears during heavy traffic
 | Pause / ▶ / ▶▶ / ▶▶▶ | Speeds: 0.25, 2, and 10 game-minutes per real second
 | Cash | Treasury (∞ in sandbox)
 | Drivers | Headcount
 | Riders/day | Network daily boardings
 | Satisfaction | 0–100 from the passenger model
 | Coverage | % of residents within a short walk of any stop
Keyboard
Space — pause/resume
1 / 2 / 3 — speed
Esc — cancel draft → drop tool → close panel → deselect line (in that order)
The dock (bottom bar)
Seven entries — the five constant-use tools stay top-level, everything else is grouped in two menus:
 |  | Button | Does
 | Select | Pan/click mode
 | New line | Draw a bus line
 | Place depot | Only visible until your first depot exists (pulses to draw the eye)
 | Map ▾ | Demand layers, traffic forecast, map options
 | Lines | Line list / editor
 | Fleet | Buy & sell buses
 | Staff | Drivers & mechanics
 | Company ▾ | Depot, Finance, Report cards, How to play
[IMG]The Map menu
 [IMG]The Company menu
Menus are portaled outside the dock (which is a clipped container) and close on outside-click or Esc. The Map button relabels itself to whatever layer is active.
6. The map
Two renderers:
Real cities online: vector tiles (OpenFreeMap) restyled into the game's warm paper palette, with roads, water, landuse and 3D building extrusions.
Offline / demo: a fully self-rendered basemap built from the city pack itself — streets by class, water, parks, and procedurally generated buildings — so a real city still renders with zero network.
Everything beyond the playable bounding box is masked grey with a dashed boundary. The map tints with the time of day — compare the pre-dawn and post-sunrise screenshots in this manual — and buses switch on headlights and lit windows at night.
District labels scale down and fade as you zoom out (8.5 px at z11 → 13 px at z15) instead of shouting at a city-wide view; city/town names cap at 14. Depot and landmark markers (DOM elements, so normally zoom-independent) shrink to 45 % via a CSS variable the map updates as you zoom.
7. Demand layers (the Map menu)
Three layers, consolidated deliberately — where trips start, where they end, and how people travel today:
Residents (purple) — where the trips start
[IMG]Residents demand, zoomed in
Drawn as a scatter: each dot stands for a few hundred people (the game targets ~2,600 dots city-wide, at most 40 per census area), sprinkled across the area's real footprint by a deterministic hash so the pattern never shifts between redraws. Zoom in and you can watch a corridor thin out street by street.
Zoom out and dots cluster: below zoom 13 neighbours merge into single blobs sized by the square root of their combined weight (so downtown doesn't become one giant circle) — the familiar calm overview.
[IMG]Residents demand, zoomed out — clustered
Destinations (teal) — where the trips end
[IMG]Destinations
Jobs plus campuses, hotels, venues (which the census counts as jobs anyway) plus airport and rail-station trips. Formerly six separate layers (Work, Tourism, Education, Airport, Rail…) that mostly redrew each other.
Travel modes — who drives, walks, bikes, rides
[IMG]Travel modes
One dot per census area, sized by commuters, colored by blending the four mode colors (car grey, bus green, walk blue, bike amber) in proportion to trips — passed through a mild power curve so minority modes tint visibly. Clicking a dot pops the exact split. This is the "is my network changing behaviour" view: areas near good lines drift green.
Traffic forecast
[IMG]Traffic forecast
Tints main roads green→red by congestion at a chosen hour (slider in Map options, 00–23). Congestion comes from the model in §15; where the city has measured traffic counts the tint says so in Map options, including how many counted road segments went into it.
8. Depots
Every bus needs a home; nothing runs without a depot.
[IMG]Depot zoning tint while placing
Zoning
Depots may only be built on industrial-style land. Where the city pack carries real OpenStreetMap land use (industrial, railway yards, ports, quarries, airfields, existing depots/bus stations — parcels ≥ 1 ha), those exact parcels are tinted green and are the same list the placement check tests (point-in-polygon with a 60 m kerb tolerance), so if it's green you can build there. Cities with no land-use data fall back to a census heuristic (more jobs than residents at below-median density). You also need street access within 400 m, no other depot within 120 m, and the click must land within the mapped city.
Costs & levels
 |  |  | Level 1 | Level 2 | Level 3
 | Capacity (buses) | 6 | 14 | 30
 | Upgrade cost | — | $220k | $450k
 | Upkeep/day | $300 | $700 | $1,400
First depot $150k; each additional one costs 50 % more ($150k → $225k → $340k → $505k → $760k), capped at 5 depots. Fleet size is capped by total depot capacity. Depots are named after their street ("40th Ave Depot") and renameable in the Depot panel.
Add-ons (per depot)
 |  | Add-on | Cost | Effect
 | Workshop | $80k | −25 % maintenance cost/km, and wear accrues at 0.75×
 | Wash bay | $45k | +6 satisfaction
 | Chargers | $120k | Unlocks buying/running electric buses
[IMG]Depot panel
Buses pull out from their depot at the start of service (each vehicle is allocated to the nearest depot with parking left, and you can watch the dead-head drive on the map) and return to refuel.
9. Stops and lines
Drawing a line
[IMG]Drawing a line — the draft bar
Choose New line, then click along streets. Each click places a stop ($4,000) snapped to the road network; the route between consecutive stops follows real streets (shortest-path over the pack's road graph). The draft bar shows live: stop count, length, a round-trip time preview using the baseline bus, and how many residents live within a short walk of the draft. Undo, Cancel, and Create line (needs ≥ 2 stops). Esc cancels.
Rules: stops can't sit on roads faster than 55 km/h (no motorway stops), and each leg must be routable — unroutable clicks are refused with a notice.
Stops are named after their streets ("Main St", "Mill St & Harbor St"). Lines are named "Line N", renameable, and take the next of ten line colors (your first line uses your brand color).
Stop tiers
Stops are infrastructure with five levels:
 |  | Tier | Name | Upgrade cost | Comfortable boardings/day | Walk bonus | Needs
 | 1 | Sign stop | ($4k to place) | 250 | — |
 | 2 | Shelter | $12k | 700 | −0.8 min perceived walk |
 | 3 | Station | $35k | 1,600 | −1.8 min |
 | 4 | Interchange | $90k | 3,500 | −2.6 min | ≥ 3 lines calling
 | 5 | Transfer Hub | $200k | 8,000 | −3.4 min | ≥ 5 lines calling
Nicer stops feel closer, so they pull riders from further out. A stop handling more boardings than its tier's capacity overcrowds: waiting riders spill off the curb, some give up, satisfaction drops, and you get a red notice. Transfer Hubs cut the transfer penalty from 6 min to 2 min.
Stops can be upgraded, moved (re-snapped to a new street point), or removed from a line (with refunds tracked against what was invested) via the route list in the line editor or by clicking them on the map.
The line editor
[IMG]Line editor
Everything about one line:
Name + Running toggle (a suspended line keeps its stops but runs nothing).
Route: stops · length · round-trip minutes. Round trip = driving time at the slowest assigned model's speed + 20 s dwell per intermediate stop + buffer + 4 min layover at each end + amortised refuelling time.
Within a short walk: residents reachable from its stops (650 m).
Buses on line — one stepper per bus model you own. Lines mix models freely: capacity, fuel and running cost blend across the assigned fleet, the slowest model sets the timetable, and the smallest tank decides refuel frequency. "Spare" counts unassigned buses of each model.
Timetable (§10), Buffer, Service hours, Fare (§11), and the route list with per-stop upgrade/move/remove.
Per-line statistics once the sim has run: riders/day, revenue, cost, fuel slice, peak load factor, round trip, and warnings (not enough buses for the timetable; crush-loaded at rush hour; refuel cadence).
10. Timetables
Two modes, because operators and passengers ask opposite questions. Both write the same schedule underneath, so switching modes carries your timetable across rather than resetting it.
Normal — "how many buses go out?"
The day splits in two: Rush hours (07–09 & 16–18) and Off-peak. You set a bus count for each; the game answers with the frequency that buys (headway = round-trip ÷ buses, floored at 2 min — buses can't physically follow closer). Counts are capped at the buses assigned to the line; zero buses in a period = no service that period.
Advanced — "how long will riders wait?"
[IMG]Advanced timetable
Four windows — AM rush 07–09, Midday 09–16, PM rush 16–18, Early & evening — each with a frequency slider from 10 to 15 minutes in half-minute steps. The game answers with the buses each window needs and warns when the line hasn't got them ("needs 3 buses and the line has 1 — the schedule will stretch").
Shared mechanics
Buffer (0/10/20/30/45 s per stop): timetable padding that slows the schedule but soaks up traffic delay before riders feel it.
Service hours: first/last hour of operation (default 06:00–22:00). Outside them nothing runs and no driver wages accrue.
Fleet shortage: if a period wants more buses than the line has, the effective headway stretches to round-trip ÷ buses on hand. Reliability (report card) measures exactly this gap.
Lines saved before timetable modes existed keep their old rush/off-peak headways and behave identically.
11. Fares and express service
Fares
Slider $1.00–$5.00 in 25¢ steps, default $2.25 — the fare riders in these cities consider normal. Fare feeds revenue and ridership: the gap from $2.25 converts to perceived minutes at $0.18/min, added to (or subtracted from) every trip's attractiveness. Charge $3.25 and every ride feels ~5.5 min longer, so marginal riders drive; charge $1.50 and cheap seats pull people out of cars. At exactly $2.25 the fare changes nothing — so pre-existing companies were unaffected when this mechanic arrived. The city also pays a $1.60 subsidy per boarding on top of whatever you charge.
Express lines
[IMG]An express line
A line runs as an EXPRESS by construction, not by a switch:
≥ 5 km long, ≥ 3 stops, and stops averaging ≥ 1.2 km apart.
Three rewards:
Riders prefer it beyond the time saved — perceived on-board time is ×0.85.
Half the fare sensitivity — the perceived-minutes fare penalty is halved.
+50 % subsidy — the city pays $2.40 per express boarding instead of $1.60.
The line editor shows the badge and current spacing — or, if you're close, exactly what's missing ("stops average 800 m apart, and an express needs 1.2 km — thin them out"). The Lines list tags express lines. Editing stops can win or lose the status at any moment; the sim, the money and the UI all share one isExpress test so they can never disagree.
[IMG]Lines list with an express tag
12. The fleet
[IMG]Fleet panel
 |  | Model | Capacity | Price | Cost/km | Fuel/km | Range | Speed | Unlocks at
 | Sparrow Minibus | 28 | $95k | $0.90 | $0.38 | 260 km | 26 km/h | start
 | Metro 40 City Bus | 70 | $260k | $1.50 | $0.62 | 420 km | 25 km/h | start
 | Goliath Articulated | 115 | $440k | $2.20 | $0.95 | 480 km | 23 km/h | 25k riders served
 | Skyline Double-Decker | 130 | $520k | $1.90 | $0.80 | 400 km | 22 km/h | 40k riders served
 | Volt-E Electric | 75 | $380k | $0.70 | $0.16 | 300 km | 26 km/h | 60k riders + depot chargers
Unlocks key off total riders ever served. The Volt-E adds a satisfaction bonus and needs a depot with chargers. Each model has a distinct 3D silhouette on the map — the Sparrow is a cutaway van (narrow cab, wide passenger box), the Goliath has a bellows joint and third axle, the Skyline two window decks, the Volt-E a roof battery pack and green nose flash — and every bus wears your company color with a full-length stripe in its line's color, passenger doors on both flanks, a destination blind, mirrors and lights.
[IMG]The 3D bus models
Wear
Buses in service wear at 2.2 points/day at full utilisation, scaled by the share of that model actually rolling, ×1.5 with too few mechanics, ×0.75 with a workshop. Wear raises running cost (up to +35 % at 100) and drags the Safety grade. Labels: Fresh < 25 ≤ Good < 50 ≤ Worn < 75 ≤ Ragged. Refurbish resets a model group's wear for 12 % of list price per bus (pro-rated by wear).
Upgrades (per model line)
Mk I → Mk II (15 % of list per bus): +10 % capacity, −7 % running cost. → Mk III (22 %): +20 % capacity, −13 % running cost.
Selling
Resale = 50 % of list, reduced further by wear (a ragged bus fetches ~30 %). Buses assigned to lines can't be sold. A toggle "hire a driver with every bus" automates the paperwork.
13. Staff
[IMG]Staff panel
Drivers — $26/hour, paid only while their bus is in service. Need = one per bus rolling. With a shortage, newest lines lose buses first (the sim assigns available drivers to lines in creation order).
Mechanics — $260/day flat. One keeps 6 buses healthy. Short-staffed: running costs +40 %, wear accrues ×1.5, and Safety suffers.
Both panels show need vs headcount and warn when short.
14. Riders: how demand works
The simulation runs in a worker thread and recomputes (debounced ~250 ms) whenever the network changes.
Commuters
Every census block group's residents (× city workforce rate, 46–52 %) are distributed to job locations by a gravity model (jobs × e^(−distance/β), β = 3.2–5 km per city). This produces a fixed daily origin–destination table: out in the morning, home at night.
A trip considers the bus if both ends have a stop within 650 m walk (walking 12 min/km, minus the stop-tier bonus). The best door-to-door bus time is computed across up to 3 lines per stop, direct or with one transfer (penalty 6 min, or 2 min at a Transfer Hub; nearby stops within a short walk act as one interchange).
Waiting is timetable-aware: 70 % of riders check the schedule and show up just before the bus — they wait only the bus's lateness (traffic delay minus your buffer); 30 % show up unplanned and wait half a headway. Waits cap at 15 min.
Mode choice: bus vs car by logit — share = 0.92 / (1 + e^((busMin − carMin)/9)), where car time = distance at the city's car speed × 1.3 + 10 min parking penalty. 13 % of commuters are captive (no car) and ride if service is usable at all. Short trips walk (85 % of non-bus trips under ~1 km) and a slice bikes. Fare and express adjustments enter as perceived minutes (§11).
Crowding sheds riders: if the busiest hour's demand exceeds seats offered that hour, ridership scales down by (1/load)^0.65 — people won't board sardine cans. Station overcrowding (§9) turns riders away too.
Visitors (tourism)
Everyone above commutes start→end→start. Visitors don't. Tourism-sector jobs generate 1.2 visitor trips/day each, flowing between attraction-heavy areas on their own gravity (shorter hops — 0.6× the commute decay), with the airport and rail station pulling at 0.8× the strength of another sight (people leaving town). Visitors ride on their own hourly profile — no dawn peak, a long middle of the day, an evening drift back to the hotel quarter — so a line through the tourist quarter fills out the afternoon instead of peaking twice. Each line blends the two profiles in proportion to who actually rides it.
Hourly shape
Commuter demand follows a twin-peak profile (7–8 am ≈ 9.5 %, 5 pm ≈ 10 % of the day); visitor demand a single broad midday hump. Riders appear on the map as little agents: they spawn at the modelled rate, walk to their stop, visibly wait, and board when a bus actually pulls in.
Satisfaction (0–100)
45 % coverage + 35 % (short waits) + 20 % (uncrowded buses) + up to 6 for upgraded stops − lateness penalty (≤ 8) − station-crowding penalty. Shown in the top bar; feeds the report card.
15. Traffic and buses on the map
Congestion model
A city-wide hourly curve (piecewise-linear: ~1.45× at 7:30, 1.52× at 17:30, 0.9× overnight) scaled per road by:
Road class (dominant): motorways 1.35, arterials 1.15, collectors 0.55, local streets 0.18 — commuting funnels onto big roads.
How busy that part of town measurably is: where the city pack carries real AADT counts (average annual daily traffic published by highway agencies, baked in at build time, ~1 km grid, normalised to the city's busiest corridor via square root), they replace the density estimate. Otherwise, urban density stands in.
Your own effect: bus riders along a corridor are cars removed — strong ridership visibly eases the tint (87 % of bus trips displace a car).
Congestion slows buses (they crawl through the middle third of a congested block, never stopping dead), lengthens delays that riders feel, and shows in the traffic layer and the topbar icon.
Bus motion
Buses move with real kinematics — accelerate at 1.1 m/s², brake at 1.3, cruise between — coming to a genuine halt at stops (20 s dwell) and staggering along the route by headway from a schedule that is a pure function of the game clock (so saves and reloads never teleport a bus). They keep to the right of the centreline so opposing buses pass instead of colliding, face their direction of travel, pull out from their depot at start of service, and return to refuel (7 min per fill) when the tank runs low. Off-peak, surplus buses visibly drop off the road.
16. The station view
[IMG]Station view
Clicking any stop opens a live 3D diorama of that stop: the actual tier's furniture (pole → shelter with bench and glass → full station with canopy and reader board → interchange/hub with a terminal hall, columns, lit name board, marked bays — the Transfer Hub adds a clock tower), a crowd that mirrors the live waiting count, and — when a bus serves the stop while you watch — a full pull-in: the bus (correct model, your livery, that line's stripe) arrives, its painted door slides open, waiting riders board, and it pulls away. At hubs, buses swing off the through-lane into a marked bay; other lines idle in the side bays. Visit pace follows game speed and pauses freeze mid-scene. The panel also shows the tier's capacity, the lines calling, and the upgrade button.
17. Money
In
 |  | Source | Amount
 | Fare | your fare × every boarding
 | City subsidy | $1.60/boarding ($2.40 on express lines)
 | Report grant | (overall − 55) × $1,600 each quarter, if ≥ 55
Out
 |  | Cost | Amount
 | Fuel | model's fuel/km × km driven (electric is 4× cheaper than diesel)
 | Maintenance | (cost/km − fuel/km) × km, ± workshop/mechanic/wear/tier multipliers
 | Driver wages | $26/h per bus in service, only during service hours
 | Mechanics | $260/day each
 | Depot upkeep | $300–$1,400/day per depot by level
 | Office overhead | $250/day
 | Report fine | $8,000 if overall < 35
Cash flows continuously per tick; the Finance panel shows the daily ledger.
[IMG]Finance panel
Credit score (300–850)
Starts at 580 and moves with: cash (up to +120), profitability (±80), latest report (×1.2 around 50), −90 for Talon debt, −30 for Harbor debt, −40 for a fleet averaging > 60 wear. Bands: Dismal < 500 ≤ Poor < 580 ≤ Fair < 640 ≤ Good < 700 ≤ Great < 780 ≤ Excellent.
Two lenders
Talon & Grasp Savings (predatory, always available): $500k minus a $50k fee up front, $2,300/day interest forever — it never amortises; the only exit is a $750k payoff.
Harbor Mutual (reputable): requires score ≥ 580; offers $60k–$400k scaled by score, at 0.06 %/day on the balance, repayable anytime.
Save-file tools
Finance also hosts Export save (JSON to clipboard/file) and Import.
18. Report cards
[IMG]Report panel
Every quarter (10 days) the Transit Authority grades seven categories, 0–100, each with a letter grade (A+ ≥ 93 … F < 40):
 |  | Category | Weight | Measures
 | Network coverage | 20 % | % residents within a short walk of a stop
 | Connectability | 15 % | Largest connected component of lines (sharing stops) + share of stops where lines meet
 | Passenger happiness | 20 % | The satisfaction model
 | Staff happiness | 15 % | Driver & mechanic shortages (100 when fully staffed; 60 with nobody employed)
 | Safety | 15 % | 100 − 0.65 × average wear, minus up to 25 for missing mechanics
 | Reliability | 10 % | Scheduled vs actually-run headways
 | Environment | 5 % | Bus mode share (45 pts at ≥ 12 %) + electric fleet share (55 pts)
Payout: overall ≥ 55 pays (overall − 55) × $1,600; below 35 fines a flat $8,000. History is kept per quarter and feeds the credit score.
19. Saves, autosaves and versions
Autosave fires on every meaningful action (build, buy, hire, timetable change…), on leaving to the menu, and on tab close.
One save per city per browser (localStorage), plus city data in IndexedDB (packs are 10–40 MB).
Old saves always load: every field added since v1.0 is optional with a default — stops re-anchor to the fresh road graph, single-depot saves gain the multi-depot shape, pre-timetable lines keep their headways, etc.
Newer saves are protected: a save written by a newer version of the game is never loaded or overwritten by an older tab — autosave is blocked for that session, a copy is kept, and you're told to reload.
Unreadable saves are backed up to a separate key before a fresh start, so a bad update can never silently eat a company.
City packs from older data-format versions are cleared automatically (they're what used to fill storage until saving failed).
20. Errors
Everything that goes wrong funnels through one error bus: a readable red toast in player language (storage full, download failed, graphics hiccup…), a ⚠ badge with a session log (copyable for bug reports, deduplicated repeats), and a full-screen recovery card if the UI itself crashes — with Reload / Clear-cache / Copy-error, and the promise (kept) that saves are untouched. The boot page has its own independent safety net from before the app loads (§2).
21. Behind the city packs (for the curious)
Streets: OSM ways by highway class, stitched into a routable graph; class sets speed (motorway 88 → living street 15 km/h). Stops split edges where they land.
People: TIGERweb block-group polygons; ACS population (LODES fallback); LODES workplace jobs with education/tourism sector splits; jobs estimated from density when LODES is down.
Special generators: airports (IATA-coded = big) and heavy-rail stations (every OSM tagging: node, building, public_transport; metro excluded) add air/rail trip demand to their neighbourhoods.
Traffic counts: FHWA/BTS AADT by bounding box, reduced to a ~1 km grid.
Industrial land: OSM landuse for depot zoning.
Scenery: water/parks polygons; demo city generates its own everything.
Real cities are baked in CI (npm run bake) and shipped pre-built; the in-browser loader can also assemble a pack from the same sources with staged progress. Packs cache in IndexedDB under a format version — bumping it refreshes everyone's copy on next load.
22. Design principles the UI follows
Never a browser popup — all confirmations are in-game dialogs.
No emoji in chrome — hand-drawn stroke icons everywhere, one bus drawing reused from favicon to fleet list to loading screen. [IMG]The bus at every model length
The map shows shapes, panels show numbers (the offline basemap has no fonts, so anything textual lives in the UI layer).
Rules you can see: the depot tint is the placement rule; the express badge names its thresholds; timetable modes show their arithmetic.
Everything explains itself in-place — hints under every control, warnings before problems compound, and the How to play panel for the loop. [IMG]How to play
Paused entry, visible cause and effect: the game never starts the meter while you're still looking around, and every mechanic (wear, traffic, crowding) has a visible on-map expression.