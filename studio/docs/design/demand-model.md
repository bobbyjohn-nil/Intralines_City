# Demand model

**Intent.** The player draws a line between two places people actually travel between, and within a quarter-second
the map fills with riders who chose the bus for a reason they can read back.

**Loop placement.** Minute-to-minute. The player edits the network; a debounced ~250 ms worker recompute returns
rates; the second-to-second tick spends those rates on visible agents and money. Nothing here runs per frame.

Manual authority: §14 (demand), §11 (fares/express), §9 (stop tiers), §17 (ledger). `SPEC` = stated in the manual or
already in `src/game/constants.ts`; `# tune` = chosen here. **Amended 2026-08-12:** §3.1 and §3.2 are new, and §2,
§3, §4 and §7 changed with them — closing the line-split exploit flagged in
[fares-and-express.md](fares-and-express.md) §1.

## 1. Pipeline

Zones, not people. The unit is the **census block group** (Riverton: a synthetic equivalent) — a 270k city is ~320
zones, not 270k agents, and §14's on-map riders are presentation sampled from rates, not the simulation.

**Stage A — city statics,** once at city load, cached in the pack, never in the debounce: A1 zone table (`zonePop`,
`zoneJobs`, `zoneTourismJobs`, `zoneX/Y` in equal-area metres) → A2 `zoneDistM[Z²]` → A3 `carMin[Z²]` → A4 `prod[Z]`
→ **A5 gravity O–D** → A6 hourly profiles. A5 is the expensive stage (Z² exponentials) and depends on **nothing the
player can change** — keeping it out of the debounce is what makes the 250 ms budget hold.

**Stage B — network recompute,** all of it and only it inside the ~250 ms debounce: B1 zone→stop access lists, CSR
(stops added/moved/removed, tier changed) → B2 per-line cumulative ride minutes (route, fleet, congestion) → B3
headway per line per period (timetable, buffer, service hours, fleet, drivers) → B4 interchange clusters → **B5
zone×zone best bus minutes** (2-round RAPTOR, §4) → B6 mode split → B7 assign trips to lines/legs/hours → B8 crowding
falloff → B9 aggregate boardings **and linked trips** per line/stop/hour plus satisfaction inputs. **Stage C — per
tick** reads B9 as a rate, never recomputing it.

**Feedback loops, deliberately open.** Congestion ← ridership (§15, 87 % of bus trips displace a car) uses the
**previous** recompute's ridership — one pass, no fixed point, and no Z² stage is ever iterated. Crowding (B8)
rescales already-assigned flows, so it *may*: 3 damped passes, damping 0.5 # tune.

## 2. Data layout

Buffers are allocated once in a `DemandBuffers` record sized at city load and passed as arguments to pure functions;
no allocation in B1–B9. `Float64Array` wherever trips accumulate, since conservation must survive summation
(`odCommute`/`odVisitor` at `Z²`, `boardingsLineHour`, `linkedTripsLineHour`, `boardingsStopHour`); `Float32Array`
for minutes and distances, **plus the new `raptorFareMin[S·2]`**; `Int32Array` for indices and counts, **plus
`raptorBoardCount[S·2]`**. Madison ≈ **3.1 MB** at `Z = 320, S = 600, L = 24, K = 720`; memory is O(Z²), so the only
guard is zone count — **if a bake yields Z > 512, merge nearest-neighbour block groups** (`ZONE_CAP = 512` # tune).

**Worker boundary.** In: one `NetworkSnapshot` of small typed arrays — stop lng/lat/tier, `stopLines`,
`lineOffset`/`lineStop`/`lineCumMin`, headways, blended capacities, **one scalar `fareUsd`**, per-line `isExpress`
flags — as transferables. Out: one `DemandResult` (`boardingsLineHour`, `linkedTripsLineHour`, `boardingsStopHour`,
a ~12-field scalar header). No object graph either way.

> **Fare scope — confirmed consistent.** Fare is **company-wide, one scalar** (§17's "*your* fare";
> fares-and-express.md §1). The snapshot carries `fareUsd`, never a `fares[L]` array; the only per-line variation is
> `isExpress`, which halves sensitivity — exactly what the per-line `fareMin` exists for. The pre-amendment "fares"
> plural in this block was the one place this document did not read that way, and it is now fixed.

## 3. Formulas

Gravity, singly constrained — conserves trips by origin (SPEC §14). Visitors (SPEC §14):
`visitorTrips[j] = zoneTourismJobs[j] * 1.2` on their own gravity at `BETA_VISITOR = 0.6 * BETA_M`, airport and rail
zones attracting at `0.8 ×` another sight. Walk access is budgeted in *perceived* minutes, so a nicer stop reaches
further (§9/§14); wait is **per boarding**, so a transfer trip waits twice; the transfer penalty is `6 min`, `2 min`
at a tier-5 Transfer Hub, charged `boardings − 1` times. **Every term below is per boarding except the two walks.**

```
prod[i]  = zonePop[i] * WORKFORCE_RATE                    # 0.46–0.52 SPEC, Riverton 0.49
w[i][j]  = zoneJobs[j] * exp(-zoneDistM[i][j] / BETA_M)   # BETA 3.2–5 km SPEC, Riverton 4.0 km
od[i][j] = prod[i] * w[i][j] / sum_k w[i][k]
walkPerceived = max(0, distM/1000*12 - [0,.8,1.8,2.6,3.4][tier-1])  # SPEC §9; eligible iff <= 7.8 min
wait_b  = min(15, 0.70*max(0, delayMin - bufferMin) + 0.30*0.5*headwayMin)     # SPEC §14
busMin  = walkAccess + Σ_b (wait_b + onboard_b * e_b + fareMinBoarding(b))
                     + (boardings - 1) * transferPenalty + walkEgress
e_b     = 0.85 if line_b is express else 1.0              # SPEC §11, the leg's own line
carMin  = zoneDistM/1000 / cityCarSpeedKmh * 60 * 1.3 + 10
final   = 0.13 + 0.87 * 0.92 / (1 + exp((busMin - carMin) / 9))    # CAPTIVE_SHARE 0.13, SPEC §14
```

Captive riders ride if any path exists; if `busMin` is infinite they are stranded, not riders. Non-bus trips under
1 km walk at 85 % (SPEC), 8 % of the rest under 5 km bike # tune. Hourly: commuter twin peak (07–08 ≈ 9.5 %,
17–18 ≈ 10 %), visitors one midday hump, blended per line by who rides it. Crowding (SPEC §14): if
`load = peakHourDemand / seatsOfferedThatHour` exceeds 1, scale by `(1/load)^0.65`, taken as the **minimum over the
trip's legs and applied once** (§3.2); station crowding, same shape, at **boarding stops only**.

### 3.1 Fare is a per-boarding cost — amended

`fareMin` was applied once per **trip** while §17 charges fare *and* subsidy per **boarding**. That asymmetry paid
$3.85 a rider for splitting a line at an arbitrary midpoint — a cosmetic edit the rider perceived not at all. Fare
now accumulates in the RAPTOR label, one term per boarding:

```
fareMinBoarding(b, line) = ( (fareUsd - DEFAULT_FARE_USD) * sens(line)
                 + (b > 1 ? DEFAULT_FARE_USD * TRANSFER_FARE_MULT : 0) ) / USD_PER_PERCEIVED_MIN
sens(line) = EXPRESS_FARE_SENSITIVITY (0.5) if isExpress(line) else 1.0   # SPEC §11
DEFAULT_FARE_USD = 2.25, USD_PER_PERCEIVED_MIN = 0.18                    # both SPEC §11
TRANSFER_FARE_MULT = 1.0   # tune — never ship below 0.85, see the floor
```

Two terms, two jobs. The **deviation** term is the slider's effect and keeps its per-line express halving — §11's
"the perceived-minutes fare penalty is halved" — so a trip crossing an express and a local pays `0.5` on one leg and
`1.0` on the other, each at its own boarding. The **extra-boarding** term is the second $2.25 the ledger genuinely
takes off the rider, at $0.18/min = **12.5 perceived minutes**; it is *not* halved on express, because express buys
tolerance for a higher fare, not for paying twice, and halving it reopens the exploit (last table row). RAPTOR is
2-round, so `b ∈ {1,2}`: at most one extra fare, ever. It does **not** double-count the transfer penalty — that 6/2
min is *time and risk*, this is *money*, and the second wait is separate again. **Why not the simpler fix:** the
deviation alone is exactly zero at $2.25 and *negative* below it, so it leaves the exploit untouched at the default
fare and worsens it at $1.00.

**Verified — revenue per 1,000 O–D trips/day,** on the marginal pair fares-and-express.md §6 uses (`busMin = carMin`
at $2.25: walk 4.0 + wait 1.8 + onboard 20 + walk 4.0 = 29.8); a split adds a 1.8 min second wait plus the penalty:

| Case | Δ = busMin−carMin | share | brdg | $/1k trips | vs through |
|---|---|---|---|---|---|
| Through line, $2.25 | 0 | 0.530 | 1 | $2,041 | — |
| Split @ plain stop, **today** | +7.8 | 0.367 | 2 | $2,825 | **+38 %** |
| Split @ Transfer Hub, **today** | +3.8 | 0.447 | 2 | $3,441 | **+69 %** |
| Split @ hub, deviation-only fix | +3.8 | 0.447 | 2 | $3,441 | **+69 %, unchanged** |
| Split @ hub, deviation-only, $1.00 | −10.1 | 0.734 | 2 | $3,815 | **+117 %** |
| Split @ plain stop, **this fix** | +20.3 | 0.206 | 2 | $1,586 | **−22 %** |
| Split @ hub, **this fix** | +16.3 | 0.242 | 2 | $1,867 | **−9 %** (−5 % at $3.25) |
| Express→express split, extra fare halved | +10.1 | 0.327 | 2 | $3,045 | +24 % ← why it is not halved |

Splitting is now a **loss at and above the default fare**, and a player who does it anyway sheds 54–61 % of the
corridor. The margin is thin: break-even needs the split to add **14.35 perceived minutes** and a hub split adds
16.3 — hence `TRANSFER_FARE_MULT ≥ 0.85` (0.844 exactly), below which the hub split turns profitable again. Two
residuals, quantified, left in deliberately. **Low fares:** the brake scales with `fare` while the prize scales with
`fare + subsidy`, so below ≈ **$1.90** splitting pays again — **+29 % at $1.25, +41 % at $1.00** (hub; +16 % at a
plain stop). Not a modelling error but §17's $1.60/boarding subsidy exceeding a $1.00 fare, already pushed back on by
30 % lost ridership feeding the report grant and by a second line's layovers and fleet. **Needs playtest** — if it
survives contact the fix belongs in the ledger (subsidy per *linked* trip), not here. **Strong-bus corridors:** where
the bus beats the car by 10 min, splitting still nets **+8 %**, acceptable and realistic. Breaking a through-route is
one of the most reliably ridership-destroying moves a transit agency can make — the rider pays a second fare, waits a
second time and risks the connection — so the model must charge that rather than pay for it.

### 3.2 Per-boarding / per-trip audit — everywhere else the same mismatch could hide

| Quantity | Ledger | Model | Verdict |
|---|---|---|---|
| Fare | per boarding §17 | per boarding | **fixed in §3.1** |
| Wait, transfer penalty, on-board `×e` | — / per bus-km | per boarding, per transfer, per leg | correct as they stand — a local+express trip pays 1.0 then 0.85 |
| **Subsidy** | per boarding §17 | **nothing** | by construction — the rider never sees the city's money. This is the entire residual above and cannot be closed here without contradicting §17. |
| **Crowding, station crowding** | — | was per leg / per stop, unstated | **now specified: min over legs, applied once**, and station crowding at **boarding stops only** (origin + transfer, never egress). Taking the product instead would shed transfer riders twice and break the "one transfer = exactly 2 boardings" conservation test. |
| **Riders ever served** (§12 unlocks 25k/40k/60k) and top-bar Riders/day | boardings? | — | **same bug class, not this document's.** If unlocks count boardings, splitting buys the Goliath early for nothing. Both must count **linked trips**; `DemandResult` now exports `linkedTripsLineHour`. Flagged to the fleet spec's owner. |

## 4. Best-path search

**2-round RAPTOR, one run per origin zone, multi-source seeded** — exactly the manual's "direct or with one
transfer", with no special-casing and no S³ intermediate loop. Per origin zone `i`:

1. Seed `raptorArrMin[0][s] = accessWalkMin[i][s]` for every access stop `s`, `raptorFareMin = 0`,
   `raptorBoardCount = 0`; mark them. All other stops `+∞`.
2. **Round 1** — for each line touching a marked stop (`stopLines`, ≤ 3 per stop SPEC): board at the
   earliest-improving marked stop `b`, walk forward along `lineStop`, relax
   `arr = arr[b] + wait(line, period) + (lineCumMin[t] - lineCumMin[b]) * e`, and on each improvement also write
   `raptorFareMin[t] += fareMinBoarding(raptorBoardCount[b] + 1, line)`, `raptorBoardCount[t] = raptorBoardCount[b] + 1`.
3. **Interchange expansion** — relax each marked stop's cluster peers at
   `transferPenalty(peerTier) + walkPerceived(peer)`, **carrying `raptorFareMin` and `raptorBoardCount` across
   unchanged**: walking within one interchange costs no fare. Clusters (B4) are union-find over stop pairs within
   `WALK_RADIUS_M` — §14 says nearby stops act as one interchange.
4. **Round 2** — repeat step 2 from round-1 labels; the second boarding reads `b = 2` and pays the full-fare term.
5. Egress: `busMin[i][j] = min over j's access stops of (arr[s] + raptorFareMin[s] + walkPerceived(s→j))`.

**Dominance.** Labels compare on `arr + raptorFareMin`, never `arr` alone — otherwise a two-boarding label dominates
a cheaper one-boarding label and the fix leaks straight back out; `raptorArrMin` stays the time-only accumulator for
relaxation and the sum is what ranks. Cost is `2 * (K + S*3)` relaxations plus `Z*A` egress per origin ≈ **4.5 M ops
per recompute** at Madison scale, inside 250 ms; the fare labels add two writes per relaxation, under 5 %. Prune any
label above `carMin[i][j] + 25` min # tune.

## 5. Riverton (no census data)

Procedurally generated, so demand is synthesised; the real-city bake plugs into the same Stage A shape. Seeded PRNG —
same seed ⇒ bit-identical arrays. `Z = 96` # tune, a Voronoi over 96 jittered lattice points; one core plus 3
secondary nodes at weight 0.45 # tune with `density(r) = exp(-r/1800 m)`; population `42,000` # tune by
`density × zoneArea`, floor 120; `jobWeight(r) = 0.35 + 1.9 * exp(-r/1100 m)` — core job-heavy, edge resident-heavy,
which is what makes a radial line worth drawing — normalised so `Σjobs = Σprod`; tourism 12 % # tune of jobs in the 4
core-nearest zones; workforce 0.49, `BETA_M = 4000`, car `34 km/h` # tune. Guarantee ≥ 6 zones with
`jobs > residents` below median density, so §8's depot-zoning fallback can build.

## 6. Build order

Each step leaves the game runnable and puts something on screen. **1 — "a line carries riders":** Riverton zones (§5)
+ A1–A5 + B1 + direct-only path (round 1, no clusters) + B6 logit + captive + B7 flat all-day assignment; Riders/day
in the top bar and line editor, Residents and Destinations layers, everything below absent. **2 — hourly + waits**
(A6, B3, two periods, 70/30). **3 — crowding** (B8, min-over-legs). **4 — transfers** (round 2, B4 clusters,
penalty). **5 — fares, express, tiers:** §3.1's per-boarding `fareMin`, `×0.85`, tier walk bonuses — **ship §3.1 with
`fareMin`, never after it**, because a released deviation-only version teaches the split and players do not unlearn a
dominant strategy just because it was patched. **6 — visitors. 7 — congestion. 8 — satisfaction.**

## 7. Testability

Pure functions over pre-allocated arrays, so every one of these is a unit test.

- **The split test — the regression this amendment exists for.** Build a 12-stop corridor, measure revenue, cut it at
  the middle stop, remeasure. **Revenue must not increase** at `fare ≥ 1.90`, at a plain stop *and* a Transfer Hub,
  local *and* express-to-express. Assert `TRANSFER_FARE_MULT ≥ 0.85` with the break-even in the failure message, and
  below $1.90 assert the *known* residual (+41 % at $1.00, hub) so it cannot silently grow.
- **Neutrality, restated.** At `fare == 2.25` the *deviation* term is exactly 0 on every boarding, so ridership is
  bit-identical to a run with it disabled — direct trips are untouched at $2.25, exactly as the manual promises. The
  extra-boarding term is **not** a slider effect and stays active: it is the second fare §17 has always charged.
- **Conservation, monotonicity, bounds.** `Σ_j odCommute[i][j] == prod[i]` within `1e-9 * prod[i]`; modes sum to 1.0
  per O–D pair; one transfer = exactly 2 boardings and 1 linked trip. Ridership non-increasing in headway, in fare
  above $2.25, in crowding load and **in boardings per trip**; non-decreasing in stop tier and stops added.
  `busShare ∈ [0.13, 1.0]`; wait `≤ 15`; `raptorBoardCount ≤ 2`; `busMin ≥ 0` — clamp the **trip**, never the term.
- **RAPTOR correctness, determinism, budget.** Round-2 labels `≤` round-1 labels on `arr + fareMin`; exact match
  against a brute-force Dijkstra-with-2-boardings reference on a 12-stop toy network, fares included; identical inputs
  ⇒ bit-identical buffers; buffers reused, heap flat over 100 recomputes; Z=512, S=600, L=24 under 250 ms.

## Cut line

Half the time: cut visitors (tourism, `odVisitor`, the second hourly profile) and the two-period split — run one
all-day headway; both are additive layers over a model that already reads. Do **not** cut transfers or crowding:
without transfers the network is a set of unrelated lines and Connectability has nothing to grade, and without
crowding there is no reason to buy a second bus. **Never cut §3.1** — four lines of arithmetic, without which the best
move in the game is to cut every line in half.
