# Fleet and staff

**Intent.** The player stops counting buses and starts buying *service*: they say "this corridor
deserves a bus every ten minutes", and the game answers with the fleet, the payroll and the bill.

**Retires decision #8.** `BUSES_PER_NEW_LINE` exists only because there is no Fleet panel. §2 below
is its replacement and the reason this spec is a priority.

**Core loop placement.** Minute-to-minute, between "run a line between them" and "offer a frequency
worth showing up for". Second-to-second it is invisible; session-to-session it is the Safety and
Staff halves of the report card (30% of the grade, SPEC §18).

Sources: manual §12 (fleet), §13 (staff), §10 (timetables), §9 (line editor), §8 (depots), §18
(report card). `SPEC` = stated in the manual. Everything else is chosen and justified inline.

---

## 1. Buying and assigning

Five models, stats **SPEC** and already in `src/game/constants.ts` as `BUS_MODELS` — read them
there, never re-derive. **Note for the implementer:** `BUS_MODELS` currently holds only `sparrow`
and `metro40`. Goliath / Skyline / Volt-E must be transcribed from manual §12's table and tagged
`SPEC` before this spec can be built past Milestone 1a.

| Model | Unlock | SPEC |
|---|---|---|
| Sparrow, Metro 40 | available at founding | ✓ |
| Goliath Articulated | 25,000 total riders ever served | ✓ |
| Skyline Double-Decker | 40,000 total riders | ✓ |
| Volt-E Electric | 60,000 total riders **and** a depot with Chargers ($120k add-on, §8) | ✓ |

`ridersEverServed` is a monotonic company-lifetime counter, never decremented, saved.

**It counts linked trips, not boardings** — `Σ linkedTripsLineHour` from demand-model.md's
`DemandResult`, never `boardingsLineHour`. A rider who transfers once is **one** rider served; count
boardings and the player splits every line in half and unlocks the whole fleet at half the real
ridership, for free (demand-model.md §3.2 — the same exploit as the fare one, wearing a different hat).
The rule covers **every player-facing ridership figure**: the unlock thresholds and their progress bars
here, and the top bar's Riders/day, which would otherwise overstate the network by exactly the transfer
rate. This is deliberately a **different number** from the boardings the ledger charges fare and subsidy
on (§17; fares-and-express.md §1) — money is per boarding because the rider pays twice, service is per
trip because the rider travelled once. Both are correct for their own purpose; confusing them is the bug,
so name the variables so they cannot be swapped by accident.

**Locked models are shown, not hidden** — full stat row visible, greyed body, buy button replaced by
a progress bar: `18,400 / 25,000 riders — about 6 days at your current rate`. Rate estimate = last
3 game-days of **linked trips**, matching the counter it predicts. Three reasons: the stat table is
the player's planning document (you pick today's line length knowing a 115-seat bus is coming); it
turns "riders served" from a number into a
destination; and a Fleet panel with two rows reads as a finished feature, so the player never
learns the fleet has depth. Volt-E shows **two** ticks, and the Chargers tick deep-links to the
Depot panel rather than merely reporting failure.

Purchases are capped by total depot capacity (6/14/30 per level, max 5 depots — SPEC §8). At the
cap the buy button reads `0 of 6 depot spaces free — upgrade a depot` and links there.

## 2. Headway ↔ fleet, both directions — and the death of `BUSES_PER_NEW_LINE`

One underlying number: **`busesAssigned` (integer, per line)**. Everything else is a reading of it.

```
roundTripMin  = RouteSchedule.roundTripDurationS / 60          # built at the SLOWEST assigned model's speed, SPEC §9
              + bufferSec * intermediateStops / 60             # SPEC §10
              + BUS_REFUEL_MINUTES * (roundTripKm / minRangeKm) # amortised refuel, SPEC §9
headwayMin(n) = max(MIN_HEADWAY_MINUTES, roundTripMin / n)     # SPEC §10, floor 2 min
busesFor(h)   = ceil(roundTripMin / h)
```

`buildRouteSchedule` takes a cruise speed, so its cache key is `(lineId, slowestAssignedModelId)`
and it is rebuilt whenever the assignment's slowest model changes — not on every stepper click.

**Both readings, one control.** The line editor shows a single **Service** row with two coupled,
both-editable faces:

- **Fleet face** (Normal timetable, SPEC §10 — "how many buses go out?"): a stepper per model.
  Under it, live: `4 buses → every 9.5 min`.
- **Headway face** (Advanced timetable, SPEC §10 — "how long will riders wait?"): a slider
  10–15 min in half-minute steps. Under it, live: `every 10 min → 4 buses · $1.04M to buy ·
  $1,860/day to run`.

The two timetable modes *are* the two directions; do not invent a third UI. Because `n` is an
integer the headway slider snaps to the achievable ladder `roundTripMin / n`; show the ladder as
tick marks so the player can see that 9.5 and 12.7 min exist on this line and 11 min does not.
Round displayed headways to 0.5 min; never display a headway the line cannot actually run.

**New lines.** Delete `BUSES_PER_NEW_LINE`. A new line is created with a **target headway of
12 minutes** (`NEW_LINE_TARGET_HEADWAY_MIN = 12`, TUNE) and the game resolves the fleet from it:

```
wanted   = busesFor(12)
assigned = min(wanted, spares of the slowest-owned model)   # spares only; never auto-buys
```

Chosen, and here is the reasoning an operations planner would give: 12 min sits mid-band in the
Advanced slider's own 10–15 range; 30% of riders wait half a headway (SPEC §14), so 12 min costs an
unplanned rider 6 min, still inside the logit's 9-minute scale before the marginal rider drives.
Target headway is stored on the line, so **the answer to "how many buses?" changes when the route
changes** — extend the line and it asks for more, which is the correct direction of causation.

If `spares == 0` the line is created **suspended**, with a banner: `Every 12 min needs 3 buses.
You have none spare. Buy 3 Metro 40 — $780,000 →`. That is a purchase requisition, and it is a
better first lesson than two free buses appearing.

Planning model when nothing is assigned yet: slowest of (spares) → slowest owned → slowest
unlocked. Chosen, so the estimate never flatters the player with a speed they cannot field.

## 3. Mixed fleets

SPEC §12: "capacity, fuel and running cost blend across the assigned fleet, the slowest model sets
the timetable, and the smallest tank decides refuel frequency." Arithmetic (chosen, consistent):

```
N            = Σ n_m
cruiseKmh    = min over assigned m of cruiseSpeedKmh_m          # sets roundTripMin for ALL buses
minRangeKm   = min over assigned m of rangeKm_m                 # sets refuel cadence for ALL buses
seatsPerHour = 60 * (Σ n_m * capacity_m) / roundTripMin         # ≡ (60/headway) × mean capacity
kmPerBusDay  = 2 * routeLengthKm * serviceMin / roundTripMin
costPerDay   = Σ n_m * (costPerKm_m + fuelPerKm_m) * kmPerBusDay * wearMult_m * mechanicMult
```

Crowding (SPEC §14) consumes `seatsPerHour`, not per-bus capacity — blended, as stated.

**Nudge away from mixing, never forbid it.** Two of the three pressures are already SPEC and only
need to be *visible*: a 26 km/h Sparrow parked behind a 22 km/h Skyline drives Skyline round trips,
so you pay Sparrow capital and get nothing back; and one 300 km tank drags every bus onto a 300 km
refuel cadence. Surface both as named lines in the line's cost breakdown — `Slowest model: Skyline
(−4 km/h vs your Sparrows)`, `Refuel cadence set by Volt-E (300 km)`. Third, chosen:
`FLEET_STANDARDISATION_MULT = { 1: 0.92, 2: 1.00, 3: 1.06 }` (TUNE) applied to a line's maintenance
cost by count of distinct assigned models — one parts bin and one training course is cheaper, and
that is why real agencies standardise per garage. It appears as a visible line item, not a hidden
multiplier (pillar 1). Mixing stays correct for two real cases the player should be free to use:
a peak-only capacity top-up, and a Sparrow on a tight branch a Goliath cannot turn.

## 4. Wear, refurbishment, upgrades

Wear is one scalar 0–100 **per model group** (not per bus) — that is what "refurbish resets a model
group's wear" (SPEC §12) implies, and it halves the save size.

```
wearPerDay_m = 2.2 * (rolling_m / owned_m) * mechanicWearMult * workshopMult   # SPEC
mechanicWearMult = 1.5 when short of mechanics, else 1.0                       # SPEC
workshopMult     = 0.75 with a Workshop at the group's home depot, else 1.0    # SPEC §8
runCostMult_m    = 1 + 0.35 * wear_m / 100                                     # SPEC
Safety           = 100 − 0.65 * avgWear − 25 * max(0, 1 − mechanics/need)      # SPEC §18; the
                   # 25-point ramp is a chosen linear reading of "up to 25"
```

Labels **SPEC**: Fresh <25 ≤ Good <50 ≤ Worn <75 ≤ Ragged. Colour on the paper palette:
muted / ink / amber / red. Wear accrues only while the clock runs and only for rolling buses.

**Refurbish** = `0.12 × listPrice × busesInGroup × (wear/100)`, resets wear to 0 (SPEC, pro-rated).
Allowed while assigned and instant — stripping a line to maintain it would punish maintenance, and
real programmes are rolling. Fires an autosave.

**Refurbish vs replace — make the crossover legible.** Note what the SPEC numbers actually do:
refurbish cost and running-cost saving are *both* linear in wear, so

```
payback_days = 0.12*list*(W/100) / (0.35*(W/100)*dailyRunCost) = 0.343 * list / dailyRunCost
```

— **independent of wear**. A Metro 40 at ~220 km/day pays back in ~190 game-days. So refurbishment
is not a fuel-bill decision at all: it is bought for the **Safety grade** (15% of the card, and
0.65 pts per wear point) and to protect resale. Say that in the panel, in those words. The Fleet
panel's decision row compares three options on one number — **cost per seat-km over the next four
quarters** — for *Keep* / *Refurbish* / *Replace with ‹best unlocked›*, and names the winner.
Replace wins when a newer model or an unbought Mk upgrade beats the wear penalty, or when resale is
about to slide from Worn into Ragged. If playtesting says nobody ever refurbishes, the lever is the
Safety weight, not the 12% price — that price is SPEC.

**Upgrades** (per model line, SPEC): Mk I→II costs 15% of list per bus, +10% capacity, −7% running
cost; →III costs 22%, +20%, −13%. Applied to the whole group at once; capacity/cost multipliers
compose with wear multiplicatively. Mk level does not change speed, range or resale value.

## 5. Selling

`resale = listPrice × (0.50 − 0.20 × wear/100)` — 50% Fresh, ~30% Ragged (SPEC; the linear
interpolation between is chosen). Mk upgrade spend is not recovered — computed off base list,
chosen, because that is how a bus auction works.

Assigned buses cannot be sold (SPEC). **The flow when the player tries is not a dead grey button** —
that violates pillar 1. Sell is always enabled and always explains: selling within spares completes
silently; selling beyond spares opens a confirm naming the consequence per line —
`Line 3 drops from every 8 min to every 12 min. Line 5 would have 0 buses and will be suspended.`
Buttons: `Unassign & sell` / `Cancel`. Newest lines give up buses first, matching the driver-shortage
rule (SPEC §13) so the player only learns one ordering.

## 6. Staff

| | Need | Pay | Source |
|---|---|---|---|
| Drivers | one per bus **rolling** | $26/h, accrued per game-minute in service only | SPEC |
| Mechanics | `ceil(ownedBuses / 6)` | $260/day flat, always | SPEC |

Shortage effects, all SPEC: drivers short → newest lines lose buses first, in line creation order;
mechanics short → running costs +40%, wear ×1.5, Safety penalty per §4.
Staff happiness (15% of the card) = `60 + 40 × min(1, filled/need)` across both roles weighted by
need — chosen reading of SPEC §18's "100 fully staffed, 60 with nobody employed".

**Surface the shortfall before it bites.** An agency reads its roster a day ahead; so does the
player. A **Roster strip** sits at the top of the Staff panel and is mirrored as a dock badge:

1. **Now** — `12 rolling / 12 drivers`.
2. **Next peak** — computed from the timetables already set, not from what happened:
   `AM rush 07:00–09:00 needs 14 · you have 12 · Line 5 will lose 2 buses` with a countdown. This
   updates the instant a stepper moves, so the warning arrives while the player is still deciding.
3. **If you buy this** — a preview delta inside the Fleet panel's buy button:
   `+1 driver · crosses into 3 mechanics (+$260/day)`. The mechanic threshold is the one that
   ambushes players, because it is a step function on a number they were not watching.

Colour: amber when `headcount == need` (no slack), red when below. Chosen thresholds.

## 7. "Hire a driver with every bus" — default ON

SPEC §12 says the toggle exists; the default is chosen, and ON. Drivers are paid **only while in
service**, so a surplus driver costs literally nothing until they drive — the toggle's downside is
zero and its upside is never discovering at 07:00 that a line silently lost buses. OFF exists for
players deliberately running a lean pool against known peaks. Symmetric by choice: with the toggle
on, selling a bus releases a driver and names them in the confirm, otherwise headcount ratchets up
forever and the toggle becomes a trap.

## 8. Feel notes

- Steppers repeat at 250 ms after a 400 ms hold; every readout (headway, cost, seats/hour) tweens
  over 180 ms `ease-out` so the player sees the number *move* rather than jump.
- Buy/sell/refurbish are **one transaction each** — spam-clicking a stepper queues quantity, not
  transactions, and commits on a 300 ms idle or on Enter. `Esc` cancels the pending quantity.
- Confirm dialogs are in-game panels, never `window.confirm` (GAME.md). `Enter` confirms, `Esc`
  cancels.
- An unlock firing mid-session pauses nothing: a toast plus a permanent dot on the Fleet dock icon.
- A wear label crossing a boundary (e.g. Good → Worn) toasts once per group per crossing, never
  per day.

## 9. Failure and edge cases

- **Pause** freezes payroll, wear and refuel — all are functions of the game clock (GAME.md).
- **Line deleted / suspended** returns its buses to spares; drivers stay hired (see §7).
- **Depot demolished below capacity**: buses over the new cap are force-unassigned to spares and the
  player is told; nothing is auto-sold, ever.
- **Last mechanic quits / need crosses a multiple of 6** mid-quarter: effects apply from the next
  game-day boundary, not mid-day, so a report card is never half-graded under two regimes.
- **`spares == 0` and a line wants more**: the line runs the stretched headway and the Reliability
  grade measures exactly that gap (SPEC §10) — this is a legal state, not an error.
- **Old saves**: `ridersEverServed`, `wear`, `mkLevel`, `targetHeadwayMin` and `autoHireDrivers` are
  all optional-with-default (GAME.md); default `targetHeadwayMin` from the line's existing bus count.
- **Resize**: the Fleet table collapses to one card per model below 720 px; the Roster strip never
  collapses.

## 10. Build order — the Milestone cut

1. **M1a — the minimum that deletes `BUSES_PER_NEW_LINE`.** Owned-bus counts per model; buy/sell for
   Sparrow and Metro 40; the per-model assignment stepper in the line editor; the two-way
   headway↔fleet readout; new-line default resolved from `NEW_LINE_TARGET_HEADWAY_MIN`. No wear, no
   staff, no upgrades, no unlocks. **This is the priority; decision #8 dies here.**
2. **M1b** — drivers, the auto-hire toggle, the Roster strip.
3. **M2** — wear, mechanics, refurbish, the Safety and Staff report-card feeds.
4. **M3** — the three unlocked models, Mk I–III, the standardisation modifier, the seat-km comparator.

**Cut line (half the time).** Drop Mk upgrades, `FLEET_STANDARDISATION_MULT`, the four-quarter
seat-km comparator (show raw refurbish vs replace prices instead), and the locked-model progress
estimate (show the bare threshold). **Do not cut** the headway↔fleet duality or the Roster
preview — they are the whole point of the spec.

**New constants to add** (names fixed here so nobody invents rivals): `BUS_UNLOCK_RIDERS`,
`NEW_LINE_TARGET_HEADWAY_MIN`, `WEAR_PER_DAY`, `WEAR_MULT_SHORT_MECHANICS`, `WEAR_MULT_WORKSHOP`,
`WEAR_RUNNING_COST_MAX_UPLIFT`, `WEAR_LABEL_THRESHOLDS`, `REFURBISH_COST_FRACTION`,
`MK_UPGRADE`, `RESALE_BASE_FRACTION`, `RESALE_WEAR_PENALTY`, `BUSES_PER_MECHANIC`,
`MECHANIC_WAGE_PER_DAY_USD`, `SHORT_MECHANIC_COST_UPLIFT`, `FLEET_STANDARDISATION_MULT`.
