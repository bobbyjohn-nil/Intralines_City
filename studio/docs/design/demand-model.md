# Demand model

**Intent.** The player draws a line between two places people actually travel between, and within a quarter-second
the map fills with riders who chose the bus for a reason they can read back.

**Loop placement.** Minute-to-minute. The player edits the network; a debounced ~250 ms worker recompute returns
rates; the second-to-second tick spends those rates on visible agents and money. Nothing here runs per frame.

Manual authority: §14 (demand), §11 (fares/express), §9 (stop tiers), §17 (ledger). `SPEC` = stated in the manual
or already in `src/game/constants.ts`; `# tune` = chosen here. **Amended 2026-08-12:** §3.1 and §3.2 are new, and
§2, §3, §4 step 5 and §7 changed with them — they close the line-split exploit flagged in
[fares-and-express.md](fares-and-express.md) §1.

---

## 1. Pipeline

Zones, not people. The unit of demand is the **census block group** (Riverton: a synthetic equivalent). A
270k-person city is ~320 zones, not 270k agents. The on-map rider agents in §14 are presentation sampled from
rates — they are not the simulation.

**Stage A — city statics.** Once at city load, cached in the pack, never in the debounce. A1 zone table
(`zonePop`, `zoneJobs`, `zoneTourismJobs`, `zoneX/Y` in equal-area metres) → A2 `zoneDistM[Z²]` straight-line →
A3 `carMin[Z²]` → A4 `prod[Z]` → **A5 gravity O–D** (`odCommute`, `odVisitor`) → A6 `commuterHourly[24]`,
`visitorHourly[24]`. A5 is the expensive stage (Z² exponentials) and depends on **nothing the player can
change**; keeping it out of the debounce is what makes the 250 ms budget hold.

**Stage B — network recompute.** All of this, and only this, inside the ~250 ms debounce.

| # | Stage | Recompute trigger |
|---|---|---|
| B1 | Zone→stop access lists (CSR) | stop added/moved/removed, tier changed |
| B2 | Per-line cumulative ride minutes | route edited, fleet changed, congestion snapshot rolled |
| B3 | Headway per line per period | timetable, buffer, service hours, fleet, driver shortage |
| B4 | Interchange clusters | B1 |
| B5 | Zone×zone best bus minutes (2-round RAPTOR, §4) | B1–B4 |
| B6 | Mode split (logit + captive + walk/bike) | B5, fare, express flag |
| B7 | Assign bus trips to lines/legs/hours | B5, B6, A6 |
| B8 | Crowding + station-crowding falloff | B7, capacity |
| B9 | Aggregate boardings **and linked trips** per line/stop/hour, satisfaction inputs | B8 |

**Stage C — per tick.** Reads B9 as a rate, never recomputes it: kinematics, agent spawn/walk/wait/board, fare +
subsidy accrual, wages, wear.

**Feedback loops, deliberately open.** Congestion ← ridership (§15, 87 % of bus trips displace a car) uses the
**previous** recompute's ridership — one pass, no fixed point; a recompute must never iterate a Z² stage.
Crowding (B8) is a scalar rescale of already-assigned flows, so it *may* iterate: 3 damped passes, damping 0.5
# tune. It never re-runs B5.

---

## 2. Data layout

Buffers are allocated once in a `DemandBuffers` record sized at city load and passed as arguments to pure
functions; no allocation in B1–B9. `Float64Array` where trips accumulate (conservation must survive summation):
`zonePop`/`zoneJobs`/`zoneTourismJobs`/`prod`/`zoneX`/`zoneY` at `Z`, `odCommute`/`odVisitor` at `Z²`,
`boardingsLineHour`/`linkedTripsLineHour` at `L·24`, `boardingsStopHour` at `S·24`. `Float32Array` for minutes
and distances (`carMin[Z²]`, `busMin[Z²·P]`, `accessWalkMin`, `lineCumMin`, `raptorArrMin[S·2]`,
**`raptorFareMin[S·2]`**). `Int32Array` for every index and count (`accessOffset`, `accessStop`, `lineOffset`,
`lineStop`, `stopLines[S·3]` — ≤ 3 lines per stop, SPEC §14 — `raptorMarked`, **`raptorBoardCount[S·2]`**).

**Madison ≈ 3.1 MB** at `Z = 320, S = 600, L = 24, K = 720`. Memory is O(Z²), so the only guard is zone count:
**if a baked pack yields Z > 512, merge nearest-neighbour block groups until Z ≤ 512** (`ZONE_CAP = 512`
# tune). Keep the O–D dense; sparsifying saves ~60 % of one table and buys indirection in the hot loop.

**Worker boundary.** In: one `NetworkSnapshot` of small typed arrays (stop lng/lat/tier, `stopLines`,
`lineOffset`/`lineStop`/`lineCumMin`, headways, blended capacities, **one scalar `fareUsd`**, per-line
`isExpress` flags), posted as transferables. Out: one `DemandResult` (`boardingsLineHour`,
`linkedTripsLineHour`, `boardingsStopHour`, a ~12-field scalar header). No object graph either way.

> **Fare scope — confirmed consistent.** Fare is **company-wide, one scalar** (§17's "*your* fare";
> fares-and-express.md §1's `[choice]`). The snapshot carries `fareUsd`, never a `fares[L]` array; the only
> per-line variation is `isExpress`, which halves sensitivity — exactly what the per-line `fareMin` exists for.
> The pre-amendment "fares" plural in this block was the one place this document did not read that way.

---

## 3. Formulas

Gravity, singly constrained — conserves trips by origin (SPEC §14). Visitors (SPEC §14):
`visitorTrips[j] = zoneTourismJobs[j] * 1.2` on their own gravity at `BETA_VISITOR = 0.6 * BETA_M`, airport and
rail zones attracting at `0.8 ×` another sight's strength. The walk-access budget is in *perceived* minutes, so a
nicer stop reaches further (SPEC §9/§14).

```
prod[i]  = zonePop[i] * WORKFORCE_RATE                    # 0.46–0.52 SPEC, Riverton 0.49
w[i][j]  = zoneJobs[j] * exp(-zoneDistM[i][j] / BETA_M)   # BETA 3.2–5 km SPEC, Riverton 4.0 km
od[i][j] = prod[i] * w[i][j] / sum_k w[i][k]
WALK_BUDGET_MIN = 7.8                                     # 650 m at 12 min/km, SPEC
tierBonusMin    = [0, 0.8, 1.8, 2.6, 3.4][tier-1]         # SPEC
walkPerceived   = max(0, distM/1000 * 12 - tierBonusMin)
eligible iff walkPerceived <= WALK_BUDGET_MIN and distM <= WALK_HARD_CAP_M (1200)   # tune, bounds CSR
```

Wait is timetable-aware (SPEC §14) — `min(15, 0.70*max(0, delayMin - bufferMin) + 0.30*0.5*headwayMin)` — and is
**per boarding**, so a transfer trip waits twice. The transfer penalty (SPEC §14/§9) is `6 min`, `2 min` at a
tier-5 Transfer Hub, charged `boardings − 1` times. In the path total, **every term is per boarding except the
two walks**:

```
busMin = walkAccess + Σ_b (wait_b + onboard_b * e_b + fareMinBoarding(b))
                    + (boardings - 1) * transferPenalty + walkEgress
e_b    = 0.85 if line_b is express else 1.0                   # SPEC §11, the leg's own line
carMin[i][j] = zoneDistM/1000 / cityCarSpeedKmh * 60 * 1.3 + 10
busShare     = 0.92 / (1 + exp((busMin - carMin) / 9))
final        = CAPTIVE_SHARE + (1 - CAPTIVE_SHARE) * busShare  # CAPTIVE_SHARE = 0.13 SPEC
```

Captive riders ride if any path exists; if `busMin` is infinite they are stranded, not riders. Non-bus trips
under 1 km walk at 85 % (SPEC); of the remainder under 5 km, 8 % bike # tune. Hourly: commuter twin peak
(07–08 ≈ 9.5 %, 17–18 ≈ 10 % of the day), visitors one midday hump, each line blending the two by who rides it.
Crowding (SPEC §14): `load = peakHourDemand / seatsOfferedThatHour`; above 1, scale by `(1/load)^0.65`, taken as
the **minimum over the trip's legs and applied once** (§3.2). Station crowding is the same shape against the
tier's comfortable boardings/day (§9), at **boarding stops only**.

### 3.1 Fare is a per-boarding cost — amended

`fareMin` was applied once per **trip** while §17 charges fare *and* subsidy per **boarding**. That asymmetry paid
$3.85 a rider for splitting a line at an arbitrary midpoint — a cosmetic edit the rider perceived not at all.
Fare now accumulates in the RAPTOR label, one term per boarding:

```
fareMinBoarding(b, line) = ( (fareUsd - DEFAULT_FARE_USD) * sens(line)
                 + (b > 1 ? DEFAULT_FARE_USD * TRANSFER_FARE_MULT : 0) ) / USD_PER_PERCEIVED_MIN
sens(line) = EXPRESS_FARE_SENSITIVITY (0.5) if isExpress(line) else 1.0   # SPEC §11
DEFAULT_FARE_USD = 2.25, USD_PER_PERCEIVED_MIN = 0.18                    # both SPEC §11
TRANSFER_FARE_MULT = 1.0   # tune — never ship below 0.85, see the floor
```

Two terms, two jobs. The **deviation** term is the slider's effect and keeps its per-line express halving — that
is what §11 means by "the perceived-minutes fare penalty is halved", and a trip crossing an express and a local
pays `0.5` on one leg and `1.0` on the other, each at its own boarding. The **extra-boarding** term is the second
$2.25 the ledger genuinely takes off the rider, at $0.18/min = **12.5 perceived minutes**. It is *not* halved on
express — express buys tolerance for a higher fare, not for paying twice, and halving it reopens the exploit (last
table row). RAPTOR is 2-round, so `b ∈ {1,2}`: at most one extra fare, ever. **No double-count with the transfer
penalty:** the 6/2 min penalty is *time and risk* — crossing to another bay, and the connection you may miss —
while the extra fare is *money*; two disincentives on one event, each named separately by the manual, and the
second wait is likewise separate and already per boarding. **Why not the simpler fix:** accumulating only the
deviation is exactly zero at $2.25 and *negative* below it, so it leaves the exploit untouched at the default fare
and worsens it at $1.00.

**Verified — revenue per 1,000 O–D trips/day.** Marginal pair, same calibration as fares-and-express.md §6
(`busMin = carMin` at $2.25: walk 4.0 + wait 1.8 + onboard 20 + walk 4.0 = 29.8); a split adds a 1.8 min second
wait plus the transfer penalty. One through line versus the same corridor cut in two:

| Case | Δ = busMin−carMin | share | brdg | $/1k trips | vs through |
|---|---|---|---|---|---|
| Through line, $2.25 | 0 | 0.530 | 1 | $2,041 | — |
| Split @ plain stop, **today** | +7.8 | 0.367 | 2 | $2,825 | **+38 %** |
| Split @ Transfer Hub, **today** | +3.8 | 0.447 | 2 | $3,441 | **+69 %** |
| Split @ hub, deviation-only fix | +3.8 | 0.447 | 2 | $3,441 | **+69 %, unchanged** |
| Split @ hub, deviation-only, $1.00 | −10.1 | 0.734 | 2 | $3,815 | **+117 %** |
| Split @ plain stop, **this fix** | +20.3 | 0.206 | 2 | $1,586 | **−22 %** |
| Split @ hub, **this fix** | +16.3 | 0.242 | 2 | $1,867 | **−9 %** |
| Split @ hub, this fix, $3.25 | +21.9 | 0.195 | 2 | $1,890 | −5 % |
| Express→express split, extra fare halved | +10.1 | 0.327 | 2 | $3,045 | +24 % ← why it is not halved |

Splitting is now a **loss at and above the default fare**, and a player who does it anyway sheds 54–61 % of the
corridor. The margin is thin: break-even needs the split to add **14.35 perceived minutes** and a hub split adds
16.3 — hence `TRANSFER_FARE_MULT ≥ 0.85` (0.844 exactly), below which the hub split turns profitable again. Two
residuals, quantified, left in deliberately. **Low fares:** the brake scales with `fare` while the prize scales
with `fare + subsidy`, so below ≈ **$1.90** splitting pays again — **+29 % at $1.25, +41 % at $1.00** (hub; +16 %
at a plain stop). That is not a modelling error but §17's $1.60/boarding subsidy exceeding a $1.00 fare, a real
perverse incentive in per-boarding subsidy regimes; it is already pushed back on by losing 30 % of riders into
coverage and happiness → the report grant (fares-and-express.md §6, "a cut pays twice") and by two extra 4-min
layovers plus the fleet to hold both headways. **Needs playtest** — if it survives contact, the fix belongs in the
ledger (subsidy per *linked* trip), not here. **Strong-bus corridors:** where the bus already beats the car by
10 min, splitting still nets **+8 %** — acceptable and realistic, since riders with no alternative do tolerate a
forced transfer.

Breaking a through-route is one of the most reliably ridership-destroying moves a transit agency can make — the
rider pays a second fare, waits a second time and risks the connection — so the model must charge that rather
than pay for it.

### 3.2 Per-boarding / per-trip audit

Everywhere the model applies a per-trip quantity to something the ledger charges per boarding, or the reverse:

| Quantity | Ledger | Model | Verdict |
|---|---|---|---|
| Fare | per boarding §17 | per boarding | **fixed in §3.1** |
| Wait / transfer penalty | — | per boarding / per transfer | correct, no ledger twin |
| On-board `×e` | per bus-km | per leg, leg's own line | correct — local+express pays 1.0 then 0.85 |
| **Subsidy** | per boarding §17 | **nothing** | by construction — the rider never sees the city's money. This is the entire residual above, and it cannot be closed here without contradicting §17. |
| **Crowding** | — | was per leg, unstated | **now specified: min over legs, applied once.** The product would shed transfer riders twice and break the "one transfer = exactly 2 boardings" conservation test. |
| **Station crowding** | — | per stop | **now specified: boarding stops only** (origin + transfer, never egress), combined as `min`. |
| **Riders ever served** (§12 unlocks, 25k/40k/60k) | boardings? | — | **same bug class, not this document's.** If unlocks count boardings, splitting buys the Goliath early for nothing. `DemandResult` now exports `linkedTripsLineHour`; flagged to the fleet spec's owner. |
| Top-bar "Riders/day" | — | linked trips | must stay linked trips, or the headline number rewards splitting |

---

## 4. Best-path search

**2-round RAPTOR, one run per origin zone, multi-source seeded** — exactly the manual's "direct or with one
transfer", with no special-casing and no S³ intermediate loop. Per origin zone `i`:

1. Seed `raptorArrMin[0][s] = accessWalkMin[i][s]` for every access stop `s`, `raptorFareMin = 0`,
   `raptorBoardCount = 0`; mark them. All other stops `+∞`.
2. **Round 1** — for each line touching a marked stop (`stopLines`, ≤ 3 per stop SPEC): board at the
   earliest-improving marked stop `b`, walk forward along `lineStop`, relax
   `arr = arr[b] + wait(line, period) + (lineCumMin[t] - lineCumMin[b]) * e`. On every improvement also write
   `raptorFareMin[t] = raptorFareMin[b] + fareMinBoarding(raptorBoardCount[b] + 1, line)` and
   `raptorBoardCount[t] = raptorBoardCount[b] + 1`. Mark improvements.
3. **Interchange expansion** — relax each marked stop's cluster peers at
   `transferPenalty(peerTier) + walkPerceived(peer)`, **carrying `raptorFareMin` and `raptorBoardCount` across
   unchanged**: walking between stops of one interchange costs no fare. Clusters (B4) are union-find over stop
   pairs within `WALK_RADIUS_M`; §14 says nearby stops act as one interchange.
4. **Round 2** — repeat step 2 from round-1 labels. The second boarding reads `b = 2` and pays the full-fare term.
5. Egress: `busMin[i][j] = min over j's access stops of (arr[s] + raptorFareMin[s] + walkPerceived(s→j))`.

**Dominance.** Labels compare on `arr + raptorFareMin`, never `arr` alone — otherwise a two-boarding label
dominates a cheaper one-boarding label and the fix leaks straight back out. `raptorArrMin` stays the time-only
accumulator used for relaxation; the sum is what ranks.

Cost per origin: `2 * (K + S*3)` relaxations plus `Z*A` egress. Madison ~7k ops, ×320 zones ×2 periods ≈ **4.5 M
ops per recompute** — comfortably inside 250 ms, and a mechanical WASM port if profiling ever asks; the fare
labels add two writes per relaxation, under 5 %. Bounding: prune any label above `carMin[i][j] + 25` min # tune —
25 perceived minutes worse than driving is a share under 0.06.

## 5. Riverton (no census data)

Procedurally generated, so demand is synthesised; the real-city bake plugs into the same Stage A shape. Seeded
PRNG — same seed ⇒ bit-identical arrays. `Z = 96` # tune, a Voronoi over 96 jittered lattice points in the
playable bbox. One core at bbox centre plus 3 secondary nodes at weight 0.45 # tune, `density(r) = exp(-r/1800 m)`
summed over nodes; population `42,000` # tune spread by `density × zoneArea`, floor 120 per zone.
`jobWeight(r) = 0.35 + 1.9 * exp(-r / 1100 m)` — core job-heavy, edge resident-heavy, which is what makes a radial
line worth drawing — normalised so `Σjobs = Σprod`. Tourism is 12 % # tune of jobs in the 4 zones nearest the
core. Constants: workforce 0.49, `BETA_M = 4000`, car speed `34 km/h` # tune. Guarantee ≥ 6 zones with
`jobs > residents` below median density, so §8's depot-zoning census fallback has somewhere legal to build.

## 6. Build order

Each step leaves the game runnable and puts something on screen.

1. **"A line carries riders."** Riverton zones (§5) + A1–A5 + B1 + direct-only path (round 1, no clusters) + B6
   logit + captive + B7 flat all-day assignment. On screen: Riders/day in the top bar and line editor, Residents
   and Destinations layers. **Omitted:** transfers, hourly profile, timetable-aware waits, crowding, tiers,
   fare/express minutes, visitors, congestion, satisfaction.
2. **Hourly + waits** — A6, B3, two periods, the 70/30 split. 3. **Crowding** — B8, min-over-legs, and the
   "crush-loaded at rush hour" warning. 4. **Transfers** — round 2, B4 clusters, transfer penalty.
5. **Fares, express, tiers** — §3.1's per-boarding `fareMin`, `×0.85`, tier walk bonuses. **Ship §3.1 with
   `fareMin`, never after it:** a released deviation-only version teaches the split, and players do not unlearn a
   dominant strategy just because it was patched.
6. **Visitors** → 7. **Congestion feedback** (87 % displacement, Traffic and Travel-modes layers) →
   8. **Satisfaction** (the §14 weights, feeding the top bar and the report card).

## 7. Testability

Pure functions over pre-allocated arrays, so every one of these is a unit test.

- **Conservation.** `Σ_j odCommute[i][j] == prod[i]` within `1e-9 * prod[i]`; modes sum to 1.0 per O–D pair; a
  one-transfer trip contributes exactly 2 boardings and exactly 1 linked trip.
- **The split test — the regression this amendment exists for.** Build a 12-stop corridor, measure revenue, cut it
  at the middle stop, remeasure. **Revenue must not increase** at `fare ≥ 1.90`, at a plain stop *and* a Transfer
  Hub, local *and* express-to-express. Assert `TRANSFER_FARE_MULT ≥ 0.85` with the break-even in the failure
  message. Below $1.90, assert the *known* residual (+41 % at $1.00, hub) so it cannot silently grow.
- **Monotonicity.** Ridership non-increasing in headway, in fare above $2.25, in crowding load, and **in boardings
  per trip**; non-decreasing in stop tier and in stops added.
- **Neutrality, restated.** At `fare == 2.25` the *deviation* term is exactly 0 on every boarding, so ridership is
  bit-identical to a run with the deviation disabled — direct trips are untouched by fares at $2.25, exactly as the
  manual promises. The extra-boarding term is **not** a slider effect and stays active: it is the second fare §17
  has always charged.
- **Bounds.** `busShare ∈ [0.13, 1.0]`; `(1/load)^0.65 == 1` exactly when `load ≤ 1`; wait `≤ 15`;
  `raptorBoardCount ≤ 2`; `busMin ≥ 0` — clamp the **trip**, never the term, since two sub-$2.25 fares can net
  negative.
- **RAPTOR correctness.** Round-2 labels `≤` round-1 labels on `arr + fareMin`; exact match against a brute-force
  Dijkstra-with-2-boardings reference on a 12-stop toy network, fares included.
- **Determinism / no allocation.** Identical inputs ⇒ bit-identical buffers; same seed ⇒ bit-identical Riverton
  Stage A; output buffers are the same objects across recomputes, heap flat over 100 recomputes.
- **Budget.** Madison-scale synthetic network (Z=512, S=600, L=24) recomputes in < 250 ms — assert it.

## Cut line

Half the time: cut visitors (tourism, `odVisitor`, the second hourly profile) and the two-period split — run one
all-day headway. Both are additive layers over a model that already reads. Do **not** cut transfers or crowding:
without transfers the network is a set of unrelated lines and Connectability has nothing to grade, and without
crowding there is no reason to buy a second bus. **Do not cut §3.1** — it is four lines of arithmetic, and without
it the best move in the game is to cut every line in half.
