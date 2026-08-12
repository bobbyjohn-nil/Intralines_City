# Depots and Timetables

Authority: manual §8, §10, §12, §13. `SPEC` = stated in the manual. `# tune` = chosen here.

**Intent.** You feel like an operations planner: where you park the buses decides what service costs
before a rider boards, and the timetable is a promise you must be able to keep. **Loop placement:**
siting is a session-to-session capital decision that gates everything (no depot → no buses), the
timetable is the minute-to-minute knob, and dead-heading is the second-to-second proof that siting
mattered — you watch empty buses drive to work.

## 1. Depot placement

Check order — cheapest-first, and the order a real siting review runs: is it our territory, is it
zoned, can a bus get out, does it duplicate what we already have. Fail on the first, one reason at a time.

| # | Check | Failure message (cursor chip) |
|---|---|---|
| 0 | Depots owned < 5 · cash ≥ next price · SPEC | Tool won't arm: "Depot limit reached (5)" / "Needs $225,000 — you have $180,000." |
| 1 | Click inside the mapped city · SPEC | "Outside the mapped city." |
| 2 | Point-in-polygon vs zoning layer, 60 m kerb tolerance · SPEC | "Not industrial land — build on the green." |
| 3 | Nearest routable road node ≤ 400 m · SPEC | "No street access — nearest road is 640 m." |
| 4 | No existing depot within 120 m · SPEC | "Too close to Mill St Depot (85 m)." |

Checks 1–4 run on pointer-move at ≤ 20 Hz (`# tune`; cheap with a grid index) so the chip updates as you
drag, not on click. Ghost marker amber while failing, `--blue` when clear; clicking while amber is a
no-op plus a 200 ms shake — never a dialog. **The tint is the rule** (pillar 1): eligible parcels fill
`--amber` at 35% over `--paper` with a 1 px `--muted` outline, drawn only while the tool is armed, from
the same polygons check 2 tests — one shared predicate `isDepotSitable(point)` for tint, click handler and
save loader. The 60 m tolerance is a dilation baked into the pack, not computed at click time; a depot's
gate is on the street, not inside the parcel.

**Zoning A — real cities (OSM).** `landuse=industrial|railway|port|quarry|depot`, `aeroway=aerodrome`,
`amenity=bus_station`; parcels ≥ 1 ha (SPEC). Dissolved and dilated at bake time.

**Zoning B — Riverton, or any pack with no land use.** Manual: "more jobs than residents at below-median
density". Per demand zone `z`: `eligible(z) = jobs[z] > residents[z] && density[z] < medianDensity &&
areaHa[z] >= 1`, where `density = (residents + jobs) / areaHa`, the median is taken over all zones with
`areaHa > 0`, and 1 ha reuses the SPEC parcel floor.

Eligible polygons dissolve, subtract water and parks buffered 20 m (`# tune` — you cannot pave a pond),
then dilate 60 m; rings under 1 ha are dropped. **Riverton's generator must emit**, or the demo has zero
legal sites and is unplayable at minute one: (a) zone polygons carrying `residents`, `jobs`, `areaHa` —
the shape the demand model already reads; (b) at least **3** zones passing `eligible()`, ≥ 400 m apart,
each with a routable road node within 400 m of its centroid, generated deliberately as *industrial
districts* (jobs 4–8× residents, density in the bottom tercile) off an arterial near the city edge,
because that is where yards go and it makes the dead-head lesson land; (c) a bake-time post-check that
**fails the build loudly** if fewer than 3 survive — a demo city that cannot host a depot is a broken
build, not a bad seed. Depots are named for the nearest street ("40th Ave Depot"), renameable. SPEC.

## 2. Depot economics — all SPEC

Price by depots already owned (0→4): **$150,000 · $225,000 · $340,000 · $505,000 · $760,000**, cap 5.
Ship as a literal `DEPOT_COSTS_USD` array, not `150_000 × 1.5^n` — the manual's rounding is authority.
Levels: **L1** capacity 6, upkeep $300/day · **L2** capacity 14, upgrade $220,000, upkeep $700/day ·
**L3** capacity 30, upgrade $450,000, upkeep $1,400/day. Add-ons per depot: **Workshop** $80k (−25%
maintenance $/km, wear ×0.75) · **Wash bay** $45k (+6 satisfaction) · **Chargers** $120k (unlocks
electric). Fleet size is capped by *total* depot capacity.

**Second depot vs upgrade — the question the manual leaves open.** Cost cannot decide it, which is the
point: L1→L2 buys 8 slots for $220k and $400/day, depot #2 buys 6 slots for $225k and $300/day. An
agency settles it on dead-head: `dailySaving = buses × 2 (out+in) × kmSaved × (costPerKm + wagePerKm)`.
Five buses on a line starting 7 km from your only depot — Metro 40 at $1.50/km plus ~$1.20/km of driver
time (`# tune` blend) — moved to a yard 1 km out: 5 × 2 × 6 km × $2.70 ≈ **$162/day**, so two such lines
cover the new depot's upkeep and repay $225k inside a few game-years. Under ~3 km saved it never pays;
upgrade instead. The buy sheet says it live: *"Nearby lines would dead-head 1.2 km instead of 7.0 km —
saves ~$162/day."* The other half is time: a yard 7 km out means the first bus leaves 17 min before service
starts and the last driver is paid 17 min after it ends, forever.

## 3. Dead-heading

Buses pull out from the nearest depot with parking free and return to refuel. SPEC.

- **Nearest** = shortest driving *time* over the road graph from the depot's access node to the line's
  first terminus, free-flow × the pull-out hour's congestion multiplier (`# tune` — planners allocate on
  running time, not crow-flies). Unroutable → great-circle ÷ 25 km/h, logged; never leave a bus
  unallocated. Recomputed on line create, bus assign, depot build/remove, never per tick; ties break to
  more free parking, then lower id, so saves stay stable.
- **It costs money.** Dead-head km accrue fuel, maintenance and wear exactly like revenue km, and the
  driver is paid for every minute (`# tune` — agencies pay platform time, and free dead-head would delete
  the reason siting exists). No fare, no subsidy, no boarding. Finance breaks it out as its own row,
  **Dead-head**, beside Fuel: non-revenue miles are always reported separately, and watching that row
  grow *is* the lesson.
- **Service hours.** Pull-out is timed so the bus reaches the terminus at `firstHour`, leaving the yard
  at `firstHour − deadheadMinutes` with wages already running. That is the sting.
- **Refuel** triggers when range left < deadheadKm + 1.15 × roundTripKm (`# tune`, 15% reserve); time cost
  `2 × deadheadS + 420 s` (SPEC), amortised into §9's round trip as `amortisedRefuelS = (2×deadheadS + 420)
  / max(1, floor(smallestTankKm / roundTripKm))`. **On screen** the dead-head runs in the line color at 40%
  opacity with an unlit destination blind — an empty bus reads as empty.

## 4. Timetables — one schedule, two views

Both modes write the same schedule underneath, so switching carries the timetable across rather than
resetting it (SPEC). That is only true with exactly one stored representation:

```ts
/** The ONLY stored timetable state. `mode` is a view flag; nothing is stored per mode. */
interface LineTimetable {
  mode: 'normal' | 'advanced';                       // never read by the sim
  busesRequested: [number, number, number, number];  // AM, Midday, PM, Evening
  bufferSecondsPerStop: 0 | 10 | 20 | 30 | 45;
  serviceHours: { firstHour: number; lastHour: number };
}
```

Four canonical windows, always: **AM** 07–09, **Midday** 09–16, **PM** 16–18, **Evening** = `firstHour`–07
plus 18–`lastHour` (SPEC). **Buses are canonical; headway is derived** — buses are what you own and pay for,
headway is what that buys given *today's* round trip, so editing a route visibly changes the arithmetic
instead of silently re-planning your fleet. `headwayS(w) = max(120, roundTripS / busesRequested[w])`;
0 buses = no service that window. SPEC.

- **Normal view:** two steppers — *Rush* bound to `[AM]`, *Off-peak* to `[Midday]`; editing writes the
  paired window too. If a pair already differs (set in Advanced) the stepper shows an `≠` chip reading
  "PM 4" and equalises only when you touch it — no silent data loss. Counts cap at buses assigned. SPEC.
- **Advanced view:** four sliders, 10.0–15.0 min in 0.5 min steps (SPEC). Position is *derived*,
  `snap(roundTripS / buses)`; if the true headway falls outside the range the slider pins to its end and
  the label states the truth beside it — *"actual 22.5 min · slider starts at 15.0"* — changing nothing
  until you move it. Moving it commits `busesRequested[w] = ceil(roundTripS / headwayS)`, uncapped:
  Advanced may ask for buses you do not own (see §5).
- Normal → Advanced → Normal is lossless in `busesRequested` — that is the acceptance test. Legacy saves
  convert on load, `buses = ceil(roundTrip / oldHeadway)` into both members of each pair, so they "behave
  identically" (SPEC). Both views print their arithmetic: *"4 buses · 38.5 min round trip → every 9.6 min"*.

## 5. Fleet shortage — told before you are punished

A window wanting more buses than the line has stretches effective headway to `roundTrip / busesOnHand`;
Reliability (10% of the report card) measures exactly that gap. SPEC. Surfaced three times over, so it
can never be a surprise: **(1) while dragging**, the row previews it in `--red` before you release —
*"needs 5 · have 3 → 12.0 min becomes 20.0 min"*; **(2) at rest**, a persistent amber chip in the line
editor header ("AM rush short 2 buses") with a *Buy* shortcut, plus an amber dot on the Lines list row;
**(3) in the Fleet panel**, a vehicle-requirement table — peak requirement across all lines vs buses
owned vs total depot capacity — with a spare-ratio note when `owned − peak < ceil(0.1 × peak)` (`# tune`):
*"12 buses, 12 needed at peak — no spares. One refuel opens a gap."* Agencies plan a spare ratio; the
number you need is not the number you run. No modal, no block: you may always promise service you cannot
deliver, you just cannot claim you weren't told.

## 6. Buffer and layover

Buffer 0/10/20/30/45 s **per stop call** (SPEC). A round trip has exactly `2 × (stops − 1)` stop calls —
one per `LegSchedule` in `buses/schedule.ts` — so buffer adds to `waitDurationS` on every leg; no new
structure. Default **10 s** (`# tune` — ~5% running-time recovery, the low end of a real schedule). So
`roundTripS = driving + 20s × intermediateCalls + 2 × 240s layover + bufferS × 2 × (stops − 1) +
amortisedRefuelS`, and because headway = roundTrip ÷ buses, padding is paid for in frequency.

Layover 4 min each end (SPEC) is recovery, not padding: a late bus may eat it down to a **60 s** floor
(`# tune` — drivers get a break), so each terminus recovers ≤ 3 min and anything worse cascades into the
next trip. Rider-perceived lateness = `max(0, trafficDelay − bufferAccrued − layoverUsed)`, and the 70%
who are timetable-aware wait only that. Hint text under the buffer control, house voice:

> Padding costs frequency and buys honesty. Ten seconds of buffer on a 12-stop line adds about 3.7 min to
> the round trip, and with 4 buses that pushes your headway out by nearly a minute. What you get back is
> a bus that arrives when the timetable says it will. Riders who trust the schedule wait only for your
> lateness; riders who don't wait half a headway. Pad enough to be believed.

## 7. Failure and edge cases

- **Depot removed** with buses parked: re-allocate to the nearest free depot; refuse with the blocking
  count if capacity would be exceeded — never auto-sell. **Fleet over capacity on load:** excess buses are
  *Stored — no parking*, do not run, and a red toast names the shortfall.
- **Deadhead longer than the service day**: refuse allocation ("depot too far to serve this line").
  **`firstHour ≥ lastHour`**: clamp `lastHour = firstHour + 1`; a zero-length day is refused.
- **Pause / reload** mid-dead-head: schedules stay a pure function of the clock, so nothing to do.
  **Resize or DPR change** while tinted: re-project from source coords, never cached screen space.
- **Spam-click the depot tool**: purchase idempotent per pointer-down, cash debited once. **Slider spam**:
  timetable writes debounce 250 ms into the sim recompute, matching the network debounce.

## 8. Build order — each step leaves the game playable and shows something

1. **Depot placement, level 1, one depot.** Zoning layer, tint, the four checks, $150k purchase; buses now
   require a depot, fleet cap 6. On screen: the tint and a depot marker.
2. **Dead-head.** Allocation, cost, the Finance row, the faded empty bus driving to work — this is what
   justifies step 1; do not defer it.
3. **`LineTimetable` + Normal mode.** Canonical four windows, visible arithmetic, buffer, service hours.
4. **Shortage surfacing.** Live stretch preview, header chip, fleet requirement table.
5. **Advanced mode.** Four sliders over the same stored state, plus the mode-switch projection.
6. **Multi-depot, levels 2–3, upkeep, add-ons.** The capital game.

**Milestone 2 cut line.** Ship 1, 2, 3; cut 4, 5, 6 — with one exception: keep step 4's static "not enough
buses" chip, because a stretched headway with no explanation reads as a bug. One level-1 depot with real
dead-head cost and a Normal timetable is a complete, honest slice of the fantasy.
