# Save format

**Intent.** The player never thinks about saving: close the tab mid-line, come back to the same company, on any later version
of the game, forever. **Loop placement:** invisible — autosave fires on meaningful actions (build/buy/hire/timetable, SPEC §19),
so the loop never stops for a save step.

**SPEC** = stated in manual v1.18 (§ noted) or GAME.md Conventions; **[call]** = my choice + reason.

## 1. The envelope

Everything written to storage or exported is one JSON object — `{ format, gameVersion, cityId, companyName, sandbox, savedAtMs, data }` —
and nothing else is ever at a save key. `format` (SAVE_FORMAT integer from 1, bumped only for a breaking change, §3) and `savedAtMs`
(`Date.now()`) are top-level so a refusal never depends on understanding `data` **[call]**; `gameVersion` is display-only and never branched
on, `cityId` a stable slug, `companyName` ≤ 32 chars, `sandbox` permanent for the company (§4).

**Ordered check sequence on open.** First failure decides the outcome and stops. Steps 6–8 run on a throwaway copy; the stored
string is untouched until the first successful autosave *after* a clean load.

| # | Check | On failure |
|---|---|---|
| 1 | key present in `localStorage` | `NONE` — offer *New company* |
| 2 | `JSON.parse` succeeds | `UNREADABLE` |
| 3 | non-null object; `format` integer ≥ 1; `cityId` a string | `UNREADABLE` |
| 4 | `format <= SAVE_FORMAT` | `NEWER` |
| 5 | `cityId` is a known city | `WRONG_CITY` (import only) — refuse, keep file |
| 6 | migration chain `format → SAVE_FORMAT` runs without throwing | `UNREADABLE` |
| 7 | `readSave(data)` returns a complete `GameState` (defaults fill gaps; a throw means a field is structurally wrong, e.g. `lines` is not an array) | `UNREADABLE` |
| 8 | derived rebuild succeeds — pack loads, stops re-anchor (§5.2) | `UNREADABLE`. Orphaned stops are **not** a failure (§5.3) |

## 2. Version policy

| Outcome | Behaviour | Player sees |
|---|---|---|
| **OLDER** | Migrate on load (§3), play on. Next autosave writes at the current format. | Nothing. SPEC §19: "old saves always load". |
| **NEWER** | Never load, never write. Copy raw string to `intralines.backup.<cityId>.newer` (best effort, skipped on quota). Set `autosaveBlocked`. Return to menu. | Dialog: *"This company was saved by a newer version of Intralines. Reload to update — your save is safe and untouched."* **Reload** / **Close**. SPEC §19, §3. |
| **UNREADABLE** | Move raw string to `intralines.backup.<cityId>.unreadable` (single slot, overwritten), delete live key, fresh start. | Error-bus toast: *"That save could not be read. A backup was kept."* SPEC §19. |
| **WRONG_CITY** | Refuse, write nothing. | Dialog naming the city in the file. |

**"Autosave blocked for this session"** is one module-level boolean, never persisted: every write path (`autosave`, leave-to-menu,
`pagehide`, `visibilitychange → hidden`) returns before serializing, the top bar shows a persistent amber **Saving paused** chip whose
tooltip repeats the reason, and **Export save** (§17) still works, reading live state rather than storage. It clears only on page reload and
no UI can override it **[call]**: an override button destroys a newer company. Second cause, same flag: storage failure (§6).

## 3. Migration

**Both mechanisms, different jobs. [call]** (1) **Defaults-on-read is primary** — `readSave()` is total, every field read with `??` against a
default from `constants.ts`, covering additive change (the overwhelming majority) with no version bump and staying robust against
hand-edited imports. (2) **An ordered chain of pure migrations** handles what a default cannot express: a field changing meaning, type or
name, or a restructure (single depot → depot array, SPEC §19). `MIGRATIONS` is a sparse array of `(prev: unknown) => unknown`, index *n*
migrating *n → n+1*, applied ascending from the file's `format`; migrations are pure, never read `constants.ts`, and are **never edited**.

> **Contributor rule.** Adding a field: make it optional and default it in `readSave` — do not bump `SAVE_FORMAT`. Bump it and
> append one migration only when an existing field changes name, type, or meaning.

## 4. Persisted vs derived

**The boundary.** Persist only (a) player decisions, (b) accumulators that integrate over time and cannot be replayed, (c) records of state
that no longer exists, (d) the ids and seeds needed to regenerate the rest. Everything else is rebuilt: a persisted derivative is a second
source of truth that disagrees the day a constant is tuned, and that is how saves rot.

**Persisted (`SaveData`)**

- `clock.totalMinutes` (b), `speedIndex` — **not** `paused`, since entering a city always starts paused (SPEC §5). `company`:
  `brandColor`, `foundedAtMs`, `howToPlaySeen`. `city`: `seed` plus the pack identity `packFormat` / `packBuild` / `packHash` (§5.4).
- `stops[]`: `id`, `name`, `position: LngLat`, `roadClass`, `tier`, `orphanAcknowledged`. **Not** `edgeId`/`edgeT` — §5.1.
- `lines[]`: `id`, `name`, `color`, `stopIds[]` (order = travel order), `fareCents`, `timetable` (mode + headway),
  `assignedBusIds[]`. **Not** `legs`, **not** `totalLengthM`.
- `depots[]`: `id`, `position`, `level`, `addons[]`. `buses[]`: `id`, `model`, `mk`, `depotId`, `lineId | null`, `odometerKm`,
  `wearPoints`, `purchasedAtMinutes` (b). `staff`: `driverCount`, `mechanicCount`.
- `loans[]`: `lender`, `principalCents`, `takenAtMinutes`. `treasury`: `cashCents` **and all four `LedgerCarry` fields** — the
  carry is an accumulator, not a derivative; dropping it re-introduces the exact drift `ledger.test.ts` exists to prevent.
- `reports[]` per completed quarter (c); `ledgerHistory[]` **30** days and `transactions[]` last **100**, ring buffer `# tune`;
  `nextIds`: `{ stop, line, bus, depot }` (§5).

**Rebuilt on load, never in the file**

- `City.graph`/`scenery`/`bounds` — from the IndexedDB pack, or regenerated from `seed`.
- `Stop.edgeId`/`edgeT` (`lines/types.ts`) — rebuilt by the §5.2 pass. `RouteLeg[]`, `totalLengthM`, `isExpress` — re-routed
  between consecutive stops, one A* per leg.
- Schedules, bus positions, dwell/layover/refuel phase and fuel level — a pure function of `totalMinutes` (GAME.md: "saves and reloads never
  teleport a bus"). O–D tables, rider assignment, waiting, crowding, satisfaction, coverage, connectability; `CalendarTime`; credit score
  and band (§17); all UI state — selection, panels, drafts, camera.

## 5. Identity and stability

**Array index does not survive editing.** Delete stop 3 and every later stop renumbers; a saved `stopIndex: 5` now names a
different place, and the damage is indistinguishable from a legitimate edit.

- Every persisted entity carries a **monotonic integer id** from `nextIds`, **never reused**, including after deletion. Order
  lives in explicit id arrays (`line.stopIds`), so reordering is a data edit, not an identity change.
- Index lookup is fine *at runtime* in structures built at load (`Map<id, index>`, flat typed arrays for the sim); it must never
  be what reaches disk.

**5.1 A stop is anchored by `(lng, lat, roadClass)`, never `(edgeId, t)`.** `edgeId` indexes a graph rebuilt on every load, and a city-packs
§6 rebake resplits and renumbers edges with nothing the player did — an edge-anchored stop would move on every line at once, silently, with
no error a migration could detect or repair. `edgeId`/`edgeT` are **derived-and-rebuilt**, the same category as schedules and bus positions.
`roadClass` (motorway / arterial / collector / local, the manual's congestion tiers) is in the anchor because position alone is ambiguous
where two edges of different class run within metres of each other — a frontage road beside a motorway — and it keeps a shelter the player
put on a residential street from migrating onto the arterial a later OSM extract widened beside it. Recorded once, at placement, from the
edge the player actually clicked.

**5.2 The re-anchor pass** runs per stop, on every load, before routing. Candidates come from the pack's 250 m edge grid
(city-packs §2), never from a stored id. `d` = distance from the saved position to the nearest point on a candidate edge;
`cost = d + classPenalty` (0 same class, **12 m** one tier apart, **30 m** two or more `# tune`). The **40 m** radius `# tune`
applies to `d`, never to `cost`, so class preference can never drag a stop further from where the player put it. Depots re-anchor
by position alone — they sit on land and zoning is checked at placement, so a rebake never invalidates one already built. **[call]**

| Tier | Condition | Result |
|---|---|---|
| **Exact** | best `d ≤ 2 m` `# tune`, class matches | snap; silent |
| **Near** | best `d ≤ 40 m`, runner-up's `cost` worse by > 3 m `# tune` | snap; record `movedM`, session log only if > 15 m |
| **Ambiguous** | ≥ 2 candidates within 3 m of the best `cost` | break in order: class match → smaller `d` → longer edge → smaller snap-point `(lng, lat)`. **Never edge id** — that is the unstable thing this section exists to route around. Then snap as *Near*. |
| **None** | nothing within `d ≤ 40 m` | keep the stop, set `orphaned`, skip it in the router, report it (§5.3). **Never delete [call]** — deleting the player's work to satisfy a road graph is the one unforgivable outcome. |

**5.3 An orphan is told, not swallowed** — it is a hole in a line the player drew and paid for, and an agency does not quietly drop a stop
from a timetable. After the pack loads, before the game unpauses: one in-game dialog (SPEC §22, never a browser popup) — *"Boston's streets
have changed — 2 stops could not be placed on the new road network."* — one row per orphan naming **line, stop, tier**, buttons **Review
stops** (fly to the first, open its line panel) / **Continue**. The line keeps running past the orphan; length, round-trip time and timetable
recompute without it and **express is re-tested on the reduced line**, so the dialog says when a badge was lost. On the map: a hollow amber
ring with a dashed tie, matching an amber row in the line panel (pillar 1). The fix is the player's — drag it with the stop tool to re-place
it (clears the flag) or delete it; nothing auto-deletes, ever. `orphanAcknowledged` persists, so it nags once per change, not once per load.
Autosave is **not** blocked: an orphan is a known, reported state, not a corrupt one.

**5.4 Pack identity.** The save records what it was written against — `packFormat` (u16), `packBuild` (the pack's 16-byte `bakeVersion`) and
`packHash` (first 16 hex of its `contentHash`) — all three, since a pipeline change bumps `bakeVersion` while a newer OSM vintage under the
same `bakeVersion` changes only the hash, and either one renumbers edges. **All equal** ⇒ the pass still runs, but every stop is expected at
*Exact* and anything less is logged as pack corruption. **`packFormat` differs** ⇒ the pack was already deleted and refetched on DB open
(§6); treat as a rebake. **`packBuild` or `packHash` differs** ⇒ **rebake load**: full pass, §5.3 dialog armed, and the next autosave rewrites
the save's pack identity. This gates the *save*'s loud path only; city-packs §2 keeps `contentHash` diagnostic for the *pack*. **[call]**

**5.5 The invariant a test must assert.** `rebake-anchor.test.ts` bakes a fixture city, saves a three-line network, rebakes with a changed
`bakeVersion` from the **same pinned sources**, and reloads: every line's `stopIds` identical and in order with **zero orphans** — not a
tolerance; a drop or a reorder fails the build — and `totalLengthM` within **±0.5 %** `# tune`. Same sources mean the same road, so past
0.5 % the pass chose a *different* edge somewhere: a routing change wearing a rounding change's clothes. A rebake from a **newer source
vintage** is a report, not a gate, because streets genuinely changed — tolerate ±2 %, publish orphan counts per city before shipping a pack
update, and treat more than **1 %** of fixture stops orphaned as a pack to fix rather than a dialog to show every player. `# tune`

## 6. Storage

| Purpose | Location | Key |
|---|---|---|
| Save, one per city (SPEC §19) | `localStorage` | `intralines.save.<cityId>` |
| Unreadable backup / newer copy | `localStorage` | `intralines.backup.<cityId>.unreadable` / `.newer` |
| Settings | `localStorage` | `intralines.settings` |
| City packs (SPEC §19) | IndexedDB `intralines` v1, store `cityPacks` | `<cityId>` |

Keys carry no version number — an old tab must *find* a newer save in order to refuse it. Pack records carry `packFormat`; on DB
open every record whose `packFormat !== CITY_PACK_FORMAT` is deleted (SPEC §19: stale packs are what used to fill storage until
saving failed). No save is ever deleted with them.

**Timing.** Debounce **3 s** after the last meaningful action, floor **10 s** between writes, plus immediate writes on leave-to-menu,
`pagehide`, `visibilitychange → hidden` `# tune`. Serialize to a string first, then a single `setItem` — never a partial write. Budget
< 256 KB, < 16 ms at 5 lines / 60 stops / 40 buses. **Storage full** (`QuotaExceededError`), in order: (1) delete stale packs, retry;
(2) trim `ledgerHistory` to 7 days and `transactions` to 20, retry; (3) set `autosaveBlocked`, red toast *"Storage is full — your company
could not be saved. Export a save from Finance."* (SPEC §20). The stored save stays intact throughout.

**Export/import** (§3 Saves, §17 Finance). The file is the envelope verbatim, `JSON.stringify(env, null, 2)`, named
`intralines-<cityId>-<YYYYMMDD-HHmm>.json`, also offered to clipboard. Import runs the identical §1 sequence; overwriting a save for that
`cityId` needs the in-game confirm dialog — Esc cancels, Enter confirms, never a browser popup (SPEC §22).

## 7. Edge cases

- **Tab closed mid-write** — one `setItem` is atomic; worst case is the previous save. **Two tabs, same city** — last writer wins; accept
  for M2, a `storage`-event lock is later. **Spam-clicking a builder** — the debounce collapses writes; each action still marks dirty.
- **`localStorage` unavailable** (private mode) — probe-write at boot; play is allowed with `autosaveBlocked` and the amber chip explaining
  why. **Recovery card / Clear caches** — clears service worker and packs, which arms a rebake load (§5.4) on next entry, but never touches
  save keys (SPEC §2, §20: "saves are untouched").

## 8. The Milestone 2 cut

Ship first (roughly a day): the envelope at `SAVE_FORMAT = 1` and the full §1 sequence including the `NEWER` refusal and the `UNREADABLE`
backup; `readSave` with defaults-on-read plus an **empty** `MIGRATIONS` array carrying the contributor rule in a comment; persistence of
clock minutes, company, city seed and pack identity, stops, lines, depots, buses, treasury + carry, `nextIds`, with §4's derived list
rebuilt; stable ids, the §5.2 re-anchor pass and the §5.3 orphan dialog; autosave on action-debounce + `pagehide`. Defer
`reports`/`ledgerHistory`/`transactions`, loans and staff, pack eviction, quota ladder steps 1–2, export/import UI, multi-tab locking.

**Cut line at half the time:** drop export/import and the quota ladder, and reduce §5.3 to one error-bus toast naming the unplaced stops and
their lines. Do **not** drop the `NEWER` refusal, the unreadable-backup, stable ids, or the re-anchor pass — those four are the whole reason
to spec this before there are riders.
