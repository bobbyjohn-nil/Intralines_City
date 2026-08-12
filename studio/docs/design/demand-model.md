# Demand model

**Intent.** The player draws a line between two places people actually travel between, and within a
quarter-second the map fills with riders who chose the bus for a reason they can read back.

**Loop placement.** Minute-to-minute. The player edits the network; a debounced ~250 ms worker
recompute returns rates; the second-to-second tick spends those rates on visible agents and money.
Nothing in this document runs per frame.

Manual authority: §14 (demand), §11 (fares/express), §9 (stop tiers). `SPEC` = stated in the manual
or already in `src/game/constants.ts`. `# tune` = chosen here.

---

## 1. Pipeline

Zones, not people. The unit of demand is the **census block group** (Riverton: a synthetic
equivalent). A 270k-person city is ~320 zones, not 270k agents. The on-map rider agents in §14 are
presentation sampled from rates — they are not the simulation.

### Stage A — city statics. Once at city load, cached in the pack. Never in the debounce.

| # | Stage | In | Out |
|---|---|---|---|
| A1 | Zone table | pack block groups | `zonePop`, `zoneJobs`, `zoneTourismJobs`, `zoneX/Y` (metres, local equal-area) |
| A2 | Zone distances | `zoneX/Y` | `zoneDistM[Z²]` straight-line |
| A3 | Car time | A2, city car speed | `carMin[Z²]` |
| A4 | Productions | `zonePop` × workforce rate | `prod[Z]` |
| A5 | **Gravity O–D** | A2, A4, `zoneJobs` | `odCommute[Z²]`, `odVisitor[Z²]` |
| A6 | Hourly profiles | — | `commuterHourly[24]`, `visitorHourly[24]` |

A5 is the single most expensive stage (Z² exponentials) and it depends on **nothing the player can
change**. Keeping it out of the debounce is what makes the 250 ms budget hold.

### Stage B — network recompute. All of this, and only this, is inside the ~250 ms debounce.

| # | Stage | Recompute trigger |
|---|---|---|
| B1 | Zone→stop access lists (CSR) | stop added/moved/removed, stop tier changed |
| B2 | Per-line cumulative ride minutes | route edited, assigned fleet changed, congestion snapshot rolled |
| B3 | Headway per line per period | timetable, buffer, service hours, fleet, driver shortage |
| B4 | Interchange clusters | B1 |
| B5 | Zone×zone best bus minutes (2-round RAPTOR, §4) | B1–B4 |
| B6 | Mode split (logit + captive + walk/bike) | B5, fare, express flag |
| B7 | Assign bus trips to lines/legs/hours | B5, B6, A6 |
| B8 | Crowding + station-crowding falloff | B7, capacity |
| B9 | Aggregate: boardings per line per hour, per stop per hour, satisfaction inputs | B8 |

### Stage C — per tick. Reads B9 as a rate. Never recomputes it.

Vehicle kinematics, agent spawn/walk/wait/board, fare + subsidy accrual, wages, wear.

### Feedback loops — deliberately open

- **Congestion ← ridership** (§15, 87 % of bus trips displace a car) uses the **previous** recompute's
  ridership. One pass, no fixed point. A recompute must never iterate a Z² stage.
- **Crowding** (B8) is a scalar rescale of already-assigned flows, so it *may* iterate: 3 damped
  passes, damping 0.5 # tune. It never re-runs B5.

---

## 2. Data layout

All buffers are allocated once in a `DemandBuffers` record sized at city load and passed as arguments
to pure functions. No allocation in B1–B9. `Float64Array` where trips accumulate (conservation must
survive summation); `Float32Array` for minutes and distances (0.001 min resolution is ample);
`Int32Array` for every index.

Symbols: `Z` zones, `S` stops, `L` lines, `K` total stop-visits across all lines, `P = 2` periods
(rush / off-peak), `A` mean access stops per zone.

| Buffer | Type | Length | Madison |
|---|---|---|---|
| `zonePop`, `zoneJobs`, `zoneTourismJobs`, `prod` | Float64Array | Z | 10 KB |
| `zoneX`, `zoneY` | Float64Array | Z | 5 KB |
| `odCommute`, `odVisitor` | Float64Array | Z² | 1.6 MB |
| `carMin` | Float32Array | Z² | 410 KB |
| `busMin` | Float32Array | Z²·P | 819 KB |
| `accessOffset` / `accessStop` / `accessWalkMin` | Int32 / Int32 / Float32 | Z+1 / Z·A / Z·A | 25 KB |
| `lineOffset` / `lineStop` / `lineCumMin` | Int32 / Int32 / Float32 | L+1 / K / K | 6 KB |
| `stopLines` (≤ 3 lines per stop, SPEC §14) | Int32Array | S·3 | 7 KB |
| `raptorArrMin` (2 rounds) / `raptorMarked` | Float32 / Int32 | S·2 / S | 7 KB |
| `boardingsLineHour` | Float64Array | L·24 | 5 KB |
| `boardingsStopHour` | Float64Array | S·24 | 115 KB |

**Madison total ≈ 3.1 MB** at Z = 320, S = 600, L = 24, K = 720. It fits with room to spare; the
design is viable. Memory is O(Z²), so the only guard is zone count: **if a baked pack yields Z > 512,
merge nearest-neighbour block groups until Z ≤ 512** (`ZONE_CAP = 512` # tune) — 512 zones is 2.1 MB
per Float64 table, still fine; 1024 would be 8 MB per table plus a 4× search cost. Keep the O–D
dense; sparsifying saves ~60 % of one table and costs indirection in the hot loop.

**Worker boundary.** In: one `NetworkSnapshot` of small typed arrays (stop lng/lat/tier, `stopLines`,
`lineOffset`/`lineStop`/`lineCumMin`, headways, blended capacities, fares, express flags), posted as
transferables. Out: one `DemandResult` (`boardingsLineHour`, `boardingsStopHour`, plus a ~12-field
scalar header). No object graph crosses in either direction.

---

## 3. Formulas

Gravity, singly constrained — conserves trips by origin (SPEC §14):

```
prod[i]  = zonePop[i] * WORKFORCE_RATE                    # 0.46–0.52 SPEC, Riverton 0.49
w[i][j]  = zoneJobs[j] * exp(-zoneDistM[i][j] / BETA_M)   # BETA 3.2–5 km SPEC, Riverton 4.0 km
od[i][j] = prod[i] * w[i][j] / sum_k w[i][k]
```

Visitors (SPEC §14): `visitorTrips[j] = zoneTourismJobs[j] * 1.2`, own gravity with
`BETA_VISITOR = 0.6 * BETA_M`, airport/rail zones attract at `0.8 ×` another sight's strength.

Walk access (SPEC §9/§14). Budget is perceived minutes, so a nicer stop reaches further:

```
WALK_BUDGET_MIN   = 650 m / 1000 * 12 = 7.8            # SPEC
tierBonusMin      = [0, 0.8, 1.8, 2.6, 3.4][tier-1]     # SPEC
walkPerceived     = distM/1000 * 12 - tierBonusMin      # clamp >= 0
eligible iff walkPerceived <= WALK_BUDGET_MIN and distM <= WALK_HARD_CAP_M (1200)  # tune, bounds CSR
```

Wait, timetable-aware (SPEC §14): `wait = min(15, 0.70*max(0, delayMin - bufferMin) + 0.30*0.5*headwayMin)`.

Transfer penalty (SPEC §14/§9): `6 min`, `2 min` if the transfer stop is tier 5 Transfer Hub.

Perceived bus minutes for one path:

```
busMin = walkPerceivedAccess + wait_1 + onboard_1*e + transferPenalty
                             + wait_2 + onboard_2*e + walkPerceivedEgress + fareMin
e       = 0.85 if express else 1.0                                     # SPEC §11
fareMin = (fare - 2.25) / 0.18 * (0.5 if express else 1.0)             # SPEC §11
```

Mode choice (SPEC §14):

```
carMin[i][j] = zoneDistM/1000 / cityCarSpeedKmh * 60 * 1.3 + 10
busShare     = 0.92 / (1 + exp((busMin - carMin) / 9))
final        = CAPTIVE_SHARE + (1 - CAPTIVE_SHARE) * busShare          # CAPTIVE_SHARE = 0.13 SPEC
```

Captive riders ride if any path exists; if `busMin` is infinite they are stranded, not riders. Non-bus
trips under 1 km walk at 85 % (SPEC); of the remainder under 5 km, 8 % bike # tune (the manual says
"a slice").

Crowding (SPEC §14): `load = peakHourDemand / seatsOfferedThatHour`; if `load > 1`, scale ridership
by `(1/load)^0.65`. Station crowding: same shape against the tier's comfortable boardings/day (§9).

Hourly (SPEC §14): commuter twin peak, 07–08 ≈ 9.5 %, 17–18 ≈ 10 % of the day; visitors a single
midday hump. Per line, blend the two profiles by who actually rides it.

---

## 4. Best-path search

**2-round RAPTOR, one run per origin zone, multi-source seeded.** Two rounds is exactly the manual's
"direct or with one transfer" — it needs no special-casing and no S³ intermediate loop.

Per origin zone `i`:

1. Seed `raptorArrMin[0][s] = accessWalkMin[i][s]` for every access stop `s`; mark them. All other
   stops `+∞`.
2. **Round 1** — for each line touching a marked stop (via `stopLines`, ≤ 3 per stop SPEC): board at
   the earliest-improving marked stop, walk forward along `lineStop`, relax
   `arr = boardTime + wait(line, period) + (lineCumMin[t] - lineCumMin[b]) * e`. Mark improvements.
3. **Interchange expansion** — for each marked stop, relax its cluster peers at
   `transferPenalty(peerTier) + walkPerceived(peer)`. Clusters (B4) are built once per recompute by
   union-find over stop pairs within `WALK_RADIUS_M`; §14 says nearby stops act as one interchange.
4. **Round 2** — repeat step 2 from round-1 labels. Stop.
5. Egress: `busMin[i][j] = min over j's access stops of (arr[s] + walkPerceived(i→s))`, plus `fareMin`
   of the *boarded* line (carried in a parallel `raptorFareMin[S]` label so express halving survives).

Cost per origin: `2 * (K + S*3)` relaxations plus `Z*A` egress. Madison: ~4.3k + 2.6k ≈ 7k ops,
×320 zones ×2 periods ≈ **4.5 M ops per recompute**. Comfortably inside 250 ms in TS, and the kernel
is a flat loop over Int32/Float32 arrays — a mechanical WASM port if profiling ever asks.

Bounding: prune any label above `carMin[i][j] + 25` min # tune — a path 25 perceived minutes worse
than driving has a logit share under 0.06 and cannot change a decision.

---

## 5. Riverton (no census data)

Riverton is procedurally generated, so its demand must be synthesised. This unblocks Milestone 2
entirely — the real-city bake (Milestone 3) plugs into the same Stage A output shape and nothing
downstream changes. From the city seed, with a seeded PRNG (same seed ⇒ bit-identical arrays):

- **Zones:** `Z = 96` # tune — a Voronoi over 96 jittered lattice points in the playable bbox. Small
  enough that a recompute is instant while the model is being debugged, large enough to show corridors.
- **Density:** one core at bbox centre plus 3 secondary nodes; `density(r) = exp(-r / 1800 m)` summed
  over nodes, secondary weight 0.45 # tune.
- **Population:** total `42,000` # tune, distributed by `density × zoneArea`, floor 120 per zone.
- **Jobs:** `jobWeight(r) = 0.35 + 1.9 * exp(-r / 1100 m)` — the core is job-heavy, the edge is
  resident-heavy, which is what makes a radial line worth drawing. Normalise `Σjobs = Σprod` so the
  gravity model balances.
- **Tourism:** 12 % # tune of jobs in the 4 zones nearest the core, tagged `zoneTourismJobs`.
- **Constants:** workforce rate `0.49`, `BETA_M = 4000` (both midpoints of the SPEC ranges),
  city car speed `34 km/h` # tune.
- Guarantee at least 6 zones with `jobs > residents` below median density, so the §8 depot-zoning
  census fallback has somewhere legal to build.

---

## 6. Build order

Each step leaves the game runnable and puts something on screen.

**Step 1 — first shippable slice, "a line carries riders."** Riverton synthetic zones (§5) + A1–A5 +
B1 + direct-only path (round 1 of RAPTOR, no clusters) + B6 logit + captive + B7 flat all-day
assignment. On screen: top-bar Riders/day moves, line editor shows riders/day, Residents and
Destinations demand layers render from `zonePop`/`zoneJobs`.
**Deliberately omitted:** transfers, hourly profile, timetable-aware waits, crowding, stop tiers,
fare and express perceived minutes, visitors, congestion feedback, satisfaction. One headway, one
period, no capacity, fare is revenue-only.

2. **Hourly + waits** — A6, B3, two periods, the 70/30 wait split. Peak load factor appears.
3. **Crowding** — B8 and the "crush-loaded at rush hour" line warning.
4. **Transfers** — round 2, B4 clusters, transfer penalty. Connectability becomes real.
5. **Fares, express, stop tiers** — `fareMin`, `×0.85`, tier walk bonuses. Sliders now move ridership.
6. **Visitors** — `odVisitor` and the second hourly profile.
7. **Congestion feedback** — 87 % car displacement, Traffic forecast and Travel modes layers.
8. **Satisfaction** — the §14 weights, feeding the top bar and the report card.

---

## 7. Testability

Pure functions over pre-allocated arrays, so every one of these is a unit test.

- **Conservation.** `Σ_j odCommute[i][j] == prod[i]` within `1e-9 * prod[i]`, every `i`. Modes sum to
  1.0 per O–D pair. A one-transfer trip contributes exactly 2 boardings, a direct trip exactly 1.
- **Monotonicity** (the manual implies each): ridership is non-increasing in headway, in fare above
  $2.25, and in crowding load; non-decreasing in stop tier and in stops added. Coverage never falls
  when a stop is added.
- **Neutrality.** `fare == 2.25` ⇒ ridership bit-identical to a run with the fare term disabled. The
  manual is explicit that existing companies were unaffected when fares shipped.
- **Bounds.** `busShare ∈ [0.13, 1.0]`; `(1/load)^0.65 == 1` exactly when `load ≤ 1`; every
  `busMin ≥ 0`; wait `≤ 15`.
- **RAPTOR correctness.** Round-2 labels `≤` round-1 labels everywhere. Against a brute-force
  Dijkstra-with-2-boardings reference on a 12-stop toy network, exact match.
- **Determinism.** Two runs on identical inputs give bit-identical output buffers; Riverton generation
  from the same seed gives bit-identical Stage A arrays.
- **No allocation.** Recompute twice, assert every output buffer is the same object identity; heap
  delta across 100 recomputes stays flat.
- **Budget.** Madison-scale synthetic network (Z=512, S=600, L=24) recomputes in < 250 ms — assert it;
  the whole design rests on this number.

## Cut line

Half the time: cut visitors (tourism, `odVisitor`, second hourly profile) and the two-period split —
run one all-day headway. Both are additive layers over a model that already reads. Do **not** cut
transfers or crowding: without transfers the network is a set of unrelated lines and Connectability
has nothing to grade, and without crowding there is no reason to buy a second bus.
