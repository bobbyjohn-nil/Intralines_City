# City packs and the bake pipeline

**Intent.** The player picks Boston, waits a few seconds behind an honest progress bar, and gets a
real city — every street, harbour and census tract — that then works forever with the cable pulled.

**Loop placement.** Session start, once. Nothing here runs per frame, per tick, or inside the 250 ms
debounce. The pack is Stage A's *input* ([demand-model.md](demand-model.md) §1) and the offline
basemap's only source of truth. Manual authority: §21 (pipeline), §1 (sources), §19 (storage).
`SPEC` = stated, `# tune` = chosen here. Produces the `City` shape in `src/game/types.ts`.

## 0. The finding, up front

**The manual's 10–40 MB is a JSON artefact, not an information floor, and pack size is not what breaks
at LA scale.** A quantised binary layout with procedurally generated buildings (SPEC §2 — we ship no
footprints) puts all four cities under **1 MB gzipped**, including the full LA basin. Arithmetic in §3.

What actually breaks is **zone resolution**. `ZONE_CAP = 512` over LA County's 12,300 km² gives zones
of 24 km², ~4.9 km across, against a 650 m walk radius — seven times wider than the distance that
decides whether anyone can reach a stop, so coverage grading and B1 access lists become noise. The
binding constraint on the playable bbox is therefore not bytes: **a zone must be no wider than a
walk.** That sets a land-area budget (§4) of **~400 km² per city**, and it is why LA is a corridor and
not a county. `ZONE_CAP` belongs to `demand-model.md` and this spec does not change it — it sizes
bboxes so the cap is not binding, and §7 names the measurement that would justify asking for 1024.

## 1. Sources and what each contributes

| Source | Contributes | Pack section | Fallback if missing |
|---|---|---|---|
| OSM ways by `highway` | Routable street graph; class sets speed (motorway 88 → living street 15 km/h) SPEC | `NODE` `EDGE` `EGEO` | none — hard failure |
| OSM `natural=water`/`waterway`/coastline, `leisure=park`, `landuse=grass/forest` | Water + park polygons (basemap, depot exclusion) | `WATR` `PARK` | empty |
| OSM `landuse=industrial` | Depot zoning SPEC §21 | `LAND` | census fallback (jobs > residents below median density) |
| OSM airports (IATA-coded = big) and heavy-rail stations (node / building / `public_transport`; **metro excluded**) SPEC | Air + rail trip generators | `POIS` | empty; visitors degrade |
| TIGERweb block groups | Zone polygons + GEOIDs | `ZONE` | none |
| ACS population (LODES fallback) SPEC; LODES workplace jobs with education/tourism splits SPEC | `zonePop`, `zoneJobs`, `zoneEduJobs`, `zoneTourismJobs` | `ZONE` | LODES residence-area; jobs estimated from density SPEC |
| FHWA/BTS AADT by bbox, reduced to ~1 km grid SPEC | Congestion baseline, √-normalised to busiest corridor SPEC §7 | `AADT` | urban-density estimate SPEC §7 |

Only OSM streets and TIGER block groups are load-bearing. Every other source degrades documentedly,
and the bake records which fallbacks fired in `META.fallbacks[]`.

## 2. Pack format — `.ipk`

One file per city. Little-endian, section payloads 8-byte aligned so fixed-width ones wrap as typed
arrays with zero copying. `[0..127]` **header** — magic `IPK1`, `packFormat` u16, `bakeVersion`
(16 B ascii), `contentHash` (32 B), `bounds` (4 × f64), `sectionCount` u16. `[128..]` **directory** —
`sectionCount × { tag u32, offset u32, byteLength u32, encoding u8 }`. Then payloads.
`encoding`: `0` raw fixed-width (wrap directly), `1` zigzag-varint deltas (one linear decode pass
into a preallocated typed array), `2` UTF-8 JSON (small metadata only).

| Tag | Contents | Encoding |
|---|---|---|
| `META` | id, name, seed, `carSpeedKmh`, source hashes, fallbacks, stage names | 2 |
| `NODE` | `qx[N]`, `qy[N]` — integer 1e-6°, Hilbert-ordered, delta-coded | 1 |
| `EDGE` | `from[E]`, `to[E]` (delta), `class[E]` (4 bits, 2/byte), `lengthDm[E]` u16, `geomOff[E+1]` | 1 |
| `EGEO` | edge shape points, integer 4e-6°, delta-coded per edge | 1 |
| `WATR` `PARK` `LAND` | ring offsets + integer 1e-5° coords | 1 |
| `ZONE` | `Z`, `pop/jobs/eduJobs/tourismJobs` f32, centroid `cx/cy` i32, ring offsets + coords, GEOID table | 1 |
| `AADT` | grid origin, `cellM=1000`, cols, rows, `value[cols*rows]` u16 (AADT ÷ 10) | 0 |
| `POIS` | airports (IATA, size class), rail stations (lng/lat, size class) | 2 |

**Derived at load, never shipped:** CSR adjacency (counting sort over `EDGE`, O(E)), the 250 m edge
grid index for stop snapping, and the Stage A O–D tables. Shipping adjacency would add ~500 KB to
Houston plus a second surface that can disagree with `EDGE`.

**Versioning** SPEC §19/§21. `packFormat` u16 is matched against a `PACK_FORMAT` constant in
`src/game/constants.ts`; mismatch ⇒ the IndexedDB record is deleted and refetched, no prompt, so
bumping it refreshes everyone on next load. `bakeVersion` and `contentHash` are diagnostic only and
never gate loading. Packs are stored **gzipped** in IndexedDB and inflated with `DecompressionStream`
— quota is the scarce resource, not CPU.

## 3. Size budget — the arithmetic

Node density from measured OSM drive graphs: ~60 nodes/km² in a dense pre-car core (Boston,
Cambridge), ~50 in Californian grid suburbia, ~45 in Houston superblocks. Planar road graphs run
`E ≈ 1.4 × N`. Shape points per edge after degree-2 collapse: 4 in Boston's curves, 2.5 elsewhere.

Per-element cost after quantisation and delta-varint: **node 4 B**, **edge 6 B**
(from+to+class+length+geomOff), **shape point 2.5 B**. Gzip on varint payloads ≈ ×0.78.

| City | Playable land | Nodes | Edges | Shape pts | Graph | +scenery/zones/AADT | **Gzipped** |
|---|---|---|---|---|---|---|---|
| Boston | 225 km² × 60 | 13.5k | 18.9k | 75.6k | 54+113+189 = 356 KB | +180 KB = 536 KB | **~0.42 MB** |
| Los Angeles (rec.) | 390 km² × 50 | 19.5k | 27.3k | 68.3k | 78+164+171 = 413 KB | +190 KB = 603 KB | **~0.47 MB** |
| Orange County | 365 km² × 50 | 18.3k | 25.6k | 64.0k | 73+153+160 = 386 KB | +170 KB = 556 KB | **~0.43 MB** |
| Houston | 380 km² × 45 | 17.1k | 23.9k | 59.9k | 68+144+150 = 362 KB | +160 KB = 522 KB | **~0.41 MB** |
| *LA, full basin (Option B)* | *750 km² × 50* | *37.5k* | *52.5k* | *131k* | *150+315+328 = 793 KB* | *+260 KB = 1,053 KB* | ***~0.82 MB*** |

**Every city fits under 20 MB with a factor of 20 to spare, even at 3× estimation error.** The full
LA basin — the case the scale warning was written about — is 0.82 MB. Two things buy this: no
building footprints (procedural, SPEC §2) and no shipped O–D table (Stage A computes 512² gravity
exponentials at load in ~5 ms rather than shipping 2.1 MB). Nothing here needs tiling; do not build
tiling.

## 4. Simplification levers and what each costs the player

| Lever | Setting | Cost to the player |
|---|---|---|
| Road class filter | Keep motorway/trunk/primary/secondary/tertiary + `_link`, residential, unclassified, living_street. Drop service, track, alley, driveway, parking aisle, foot/cycle/pedestrian. | A handful of legitimate mall and hospital bus loops vanish. Buses can no longer route through parking lots — which is correct. Saves ~40 % of nodes. |
| Douglas–Peucker | 6 m streets, 12 m parks/landuse, 20 m water, 30 m block groups # tune | A curve reads slightly polygonal at max zoom. **Compute `lengthDm` from unsimplified geometry** — DP shortens lines ~0.3 %, and a bus that is 0.3 % early everywhere is a silent sim bug. |
| Quantisation | 1e-6° nodes (0.11 m), 4e-6° shape points (0.44 m), 1e-5° scenery (1.1 m) | None visible. Sub-lane-width everywhere. |
| Degree-2 collapse | Mandatory | None. Stops split edges (SPEC §21), so mid-chain stop placement still works — shape points carry cumulative length so a split is exact. |
| **Bbox clip** | §4.1 | **The big one.** Edges crossing the boundary are clipped at it and terminate in a degree-1 node; no dangling half-edges. Outside is masked grey with a dashed boundary (already the contract in `types.ts`). |

### 4.1 Playable bounding boxes

Budget derivation: a zone must be no wider than a walk. Target zone square ≤ 900 m on a side
(half-diagonal 636 m ≈ the 650 m walk radius SPEC), so ≤ 0.81 km² per zone × `ZONE_CAP = 512` =
**415 km² of developed land**. Round to **400 km²** as the bake's hard budget # tune.

| City | Box | Land | What's in | What's cut, and what that costs |
|---|---|---|---|---|
| **Boston** | 20 × 16 km | 225 km² | Boston, Cambridge, Somerville, Brookline, Chelsea, Everett, **BOS airport** | Nothing that matters. Under budget, so zones are ~660 m — the best resolution of the four. |
| **Los Angeles** | 26 × 16 km, Downtown–Hollywood–Beverly Hills–Exposition–East LA, north edge pushed to 34.21° for **BUR** | 390 km² | Wilshire/Sunset/Vermont corridors, Union Station, Century City, USC | LAX, the Valley, the harbour, Santa Monica. **This is the real cost: LA's identity is distance, and a 26 km box halves it.** What survives is the genuine part — Wilshire vs the I-10, which is the hardest mode-choice in the game. |
| **Orange County** | 24 × 17 km, Buena Park–Anaheim–Santa Ana–Costa Mesa–north Irvine, **SNA** at the south edge | 365 km² | Disneyland (tourism jobs), Santa Ana civic core, Irvine business parks, South Coast Plaza | The coast — Huntington, Newport, Laguna. Polycentricity, the reason OC is on the list, is fully intact: four unrelated centres and no downtown. |
| **Houston** | 22 × 18 km, the 610 loop plus Uptown/Galleria, extended ESE for **HOU** | 380 km² | Downtown, Texas Medical Center, Heights, EaDo, Galleria | Katy, Sugar Land, the Energy Corridor, IAH. **Second-biggest identity loss:** clipped to the loop, Houston plays like a normal medium-density city. The Hobby extension preserves exactly one genuinely long corridor. |

If the Boston bake shows 512 zones is comfortable (§7 measurement 3), the follow-up is to ask
`demand-model` for `ZONE_CAP = 1024` — priced there at 8 MB per Float64 table and 4× search — and
buy LA's basin and Houston's beltway back with it. Do not pre-emptively widen a box on hope.

## 5. Bake vs in-browser assembly

**CI bake is primary and the only player-facing path.** `npm run bake` runs in CI; packs ship
pre-built as static assets.

**In-browser assembly is not viable for any of these four cities.** It needs the raw OSM extract
(200–400 MB `.osm.pbf` for the LA basin), TIGER shapefiles and a live Overpass/ACS call at play time
— a 300× larger download than the pack it produces, non-deterministic, and a network dependency the
Hard Constraints forbid. It stays a **dev-only tool behind a flag**, never in the UI. Cost to the
player: none; they get 0.5 MB instead of 400 MB.

**Feel note.** The manual's staged-progress screen (§21) survives unchanged in *shape* — it names
decode stages instead of assembly stages, which is all the player ever saw: `Fetching city →
Unpacking → Reading streets → Building junctions → Indexing → Reading the census → Estimating trips`.
Real percentages from real byte and element counts, never a fake timer; ~2.5 s cold budget; any stage
over 400 ms yields to the event loop so the bar animates rather than freezing.

## 6. Determinism

Same sources + same `bakeVersion` ⇒ byte-identical pack, verified by `contentHash`.

- **Pin the sources.** A dated Geofabrik `.osm.pbf` with a recorded SHA-256, plus TIGER/ACS/LODES
  vintage year and file SHA-256, in a `sources.lock.json` the bake refuses to run without. **Never a
  live Overpass query** — the single largest determinism risk here.
- **Quantise before you compute.** Coordinates become integers as step one; Douglas–Peucker then runs
  on integer perpendicular-distance-squared. No float accumulation, no platform variance.
- **Deterministic ordering.** Sort features by `(featureType, osmId)` first; node ids by Hilbert
  index with `osmId` as tiebreak. Never iterate a hash map. Byte-wise string sort, never locale-aware.
- **No wall clock, no RNG, no environment reads** in the bake.
- **CI asserts it:** bake twice on different runners, compare hashes, fail the build on mismatch.

**The requirement this places on saves.** §19 says stops re-anchor to the fresh road graph, so byte
identity is not enough — edge *ids* must not silently move a player's line on rebake. A saved stop
anchor must therefore be `(lng, lat, roadClass)`, re-anchored by nearest-edge query at load, never
`(edgeId, t)`. That field belongs to `save-format.md`; stated here, handed over there.

## 7. Build order — Boston first (GAME.md)

Bake Boston alone. Measure these nine, publish the numbers, then decide.

| # | Measurement | Target | Abort threshold |
|---|---|---|---|
| 1 | Pack size, gz, per section | < 2 MB | **> 8 MB** ⇒ format is wrong, revisit before tiling |
| 2 | N, E, shape points | N < 20k, E < 28k | > 2× estimate ⇒ re-derive §3 for all four |
| 3 | **Z after merge, and zone width p50/p95** | p95 < 900 m | **p95 > 1,100 m at 225 km² ⇒ the big three shrink to ~250 km² each, and we say so out loud** |
| 4 | Cold load: fetch → inflate → decode → adjacency → index | < 2.5 s | > 8 s ⇒ drop varints for raw typed arrays, eat the size |
| 5 | Stage A wall time (A5 is Z² exps) | < 150 ms | > 600 ms ⇒ Stage A moves to the bake and ships in the pack |
| 6 | Stage B recompute, 12-line network | < 250 ms SPEC | > 400 ms ⇒ demand-model's problem, not the pack's |
| 7 | IndexedDB stored bytes + inflate time | < 1 MB, < 300 ms | quota errors ⇒ error bus, not a crash |
| 8 | **Two bakes, two runners, same SHA-256** | identical | **any diff ⇒ stop everything.** This one corrupts saves silently |
| 9 | % block-group population within 650 m of a kept road | > 99 % | < 99 % ⇒ the class filter ate real streets |

Measurement 3 and measurement 8 are the ones that decide whether the other three cities are attempted
as specified. Everything else is tuning.

## Failure and edge cases

- **Fetch fails / offline first load.** Error-bus toast ("Couldn't download Boston — check your
  connection"), city stays locked, Riverton always playable. Never a partial pack in IndexedDB —
  write only after `contentHash` verifies.
- **Corrupt or truncated pack.** Hash mismatch ⇒ delete the record, one automatic retry, then the
  toast. Saves are never touched by this path.
- **IndexedDB quota exceeded.** Evict stale-`packFormat` packs first (SPEC §19), then
  least-recently-played, then name the city removed and confirm its save is safe.
- **`packFormat` newer than the build.** Refuse the pack, do not delete it, load Riverton, tell the
  player to reload. Symmetric with the newer-save rule.
- **Tab closed mid-load.** No partial state persists; next load restarts at stage 1.
- **Player switches city mid-load.** Abort the decode via `AbortController`. No two decodes in flight.
- **Resize / controller unplug.** Irrelevant — the pack loads before any input is bound.
- **Spam-clicking a city button.** Idempotent; second click is a no-op while a load is in flight.
- **Zero-edge bbox** (a bad bake). CI fails on measurement 9, so this cannot ship.

## Cut line

Half the time: ship **Boston and Riverton only** and cut the three optional sources — `AADT` (falls
back to the urban-density estimate, SPEC §7), `LAND` (falls back to the census depot-zoning rule,
already referenced by demand-model §5), and the education/tourism splits (which takes visitors with
it, and demand-model's own cut line already cuts them). ~40 KB of pack, a third of the bake's source
integrations. Do **not** cut determinism (§6) or the class filter (§4): determinism cut now is save
corruption later, and without the class filter the graph triples and every §7 measurement goes red.
