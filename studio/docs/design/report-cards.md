# Report cards

**Intent.** Every ten days the city tells you, in seven numbers you have been watching climb all
quarter, whether you are running a transit agency or just a bus company.

**Loop placement.** Session-to-session — the quarter close is the game's only scored beat. But the
*card* is minute-to-minute: a running grade sits in the top bar all quarter, so the close confirms a
number the player has been steering, never announces one.

Manual authority: §18 (this system), §14 (satisfaction), §13 (staffing), §12 (wear), §17 (grant,
fine, credit). `SPEC` = stated. `# tune` = chosen here. Coverage, satisfaction and mode share come
from [demand-model.md](demand-model.md) — this spec reads its outputs and does not restate them.

---

## 1. The seven categories

All seven are **integrated over the quarter**, not sampled at close — see §4. Instantaneous score is
recomputed on each demand debounce and held between recomputes.

| Category | Weight | Instantaneous score | Source |
|---|---|---|---|
| Network coverage | 20 % SPEC | `100 × min(1, covered / COVERAGE_TARGET)` | demand-model B1 |
| Connectability | 15 % SPEC | §2 | B4 clusters + line graph |
| Passenger happiness | 20 % SPEC | satisfaction 0–100, verbatim | §14 model |
| Staff happiness | 15 % SPEC | `60 + 40 × (0.6×driverFill + 0.4×mechFill)` | §13 headcounts |
| Safety | 15 % SPEC | `100 − 0.65×avgWear − 25×(1−mechFill)`, floor 0 | §12 wear |
| Reliability | 10 % SPEC | §7 (v1 = headway gap) | B3 headways |
| Environment | 5 % SPEC | `45×min(1, busShare/0.12) + 55×electricShare` | B6 + fleet |

- `covered` = `Σ zonePop[i]` over zones with ≥ 1 eligible access stop **on a running line**, over
  `Σ zonePop`. `COVERAGE_TARGET = 0.55` # tune, per-city overridable as `city.coverageTarget`.
  **Why not identity:** SPEC says "% residents within a short walk". Mapping that straight to a score
  puts A+ at 93 % of all residents inside 650 m — unreachable in Houston or LA, which are half the
  roster. 55 % is a strong real-agency figure and makes the top grade a goal rather than a taunt.
- `driverFill = min(1, drivers / driversNeeded)`, `mechFill = min(1, mechanics / ceil(buses/6))`.
  0.6/0.4 # tune — drivers weigh more because a driver shortage actually removes buses from lines
  (§13), while a mechanic shortage only raises costs and wear.
- `avgWear` is km-weighted across owned buses # tune: the board grades the vehicles that carried
  passengers, not the one parked ragged in the yard.
- `electricShare` = Volt-E share of in-service km. Until the 60k-rider unlock, Environment caps at
  **45** — an F in a 5 % category, worth 2.75 points of overall. That is SPEC and correct. Do not
  "fix" it; it is the first visible reason to want electric buses.
- `busShare` is city-wide bus share of all trips, from B6.

**Grade ladder** (SPEC fixes only the ends: A+ ≥ 93, F < 40; the rest is chosen):

| A+ | A | B | C | D | F |
|---|---|---|---|---|---|
| ≥ 93 | ≥ 85 | ≥ 70 | ≥ 55 | ≥ 40 | < 40 |

Six clean bands, no plus/minus, and deliberately aligned to the money: **C starts exactly at 55, the
grant line. F starts at 40, five points above the fine at 35.** A player who learns "a C pays, a D is
a warning, an F costs money" has learned the whole economy from the letters alone.

**Overall** `= Σ(weight × score) / Σ(weight)` over *graded* categories, rounded once to an integer.
The grant and fine read that integer.

**Withholding.** A category with no basis is withheld and its weight redistributed pro-rata, shown as
"—" with a reason. Withhold: Safety, Staff and Reliability when the agency had **zero buses in
service** for the entire quarter. # tune — otherwise owning no buses scores 100 on Safety, and the
optimal agency is one that runs nothing.

---

## 2. Connectability — the exact computation

The manual gives a phrase, not a formula. This is the category most likely to be built wrong, so all
of it is specified.

**When two lines meet.** Lines `a` and `b` meet iff both are **running** and there exists an
interchange cluster containing a stop of `a` and a stop of `b`. Clusters are demand-model **B4** —
union-find over stop pairs within `WALK_RADIUS_M`. Not exact shared stop identity: §14 already treats
nearby stops as one interchange, and a network the sim happily transfers across must not be graded as
disconnected. **One shared predicate `linesMeet(a, b)`**, used by the report card, the line editor
badge, and any UI that draws the connection — per the house rule.

**Half A — largest component (60 %).** Nodes are running lines, edges are meeting pairs. `L` = running
lines, `Lmax` = size of the largest connected component.

```
reach = Lmax / L                                        # is the network one system or islands?
scale = min(1, (Lmax - 1) / (CONNECT_TARGET_LINES - 1)) # is that system big enough to be a network?
halfA = 100 * reach * scale        CONNECT_TARGET_LINES = 4   # tune
```

**A single-line network scores 0 on both halves — Connectability F.** This is the correct answer and
the reason `scale` exists: one line cannot connect to anything, and `Lmax/L = 1/1` would otherwise
award it a perfect score for being alone. Worked: 2 lines meeting → 33; 3 → 67; 4 → 100; 5 meeting →
100 (growth is never punished); 4 meeting + 1 orphan → `0.8 × 1 × 100` = 80.

**Half B — interchange density (40 %).** `meetShare` = share of stops whose cluster is served by ≥ 2
running lines.

```
halfB = 100 * min(1, meetShare / CONNECT_MEET_TARGET)   CONNECT_MEET_TARGET = 0.18   # tune
```

18 % # tune, because raw share is not a target a real network hits — a healthy system is mostly
through-running stops, and demanding 100 % would ask the player to build a star.

**Combine:** `score = 0.6 × halfA + 0.4 × halfB`. Topology outranks density: an agency of four
islands has a worse problem than an agency of one system with thin interchange. `L = 0` → score 0, no
division. Suspended lines are invisible to both halves — a line that runs nothing connects nothing.

---

## 3. The economics

SPEC: grant `(overall − 55) × $1,600` at overall ≥ 55; flat **$8,000 fine** below 35; nothing between.

| Overall | Letter | Payment |
|---|---|---|
| 90 | A | **+$56,000** |
| 70 | B | **+$24,000** |
| 55 | C | **$0** — the grant exists but pays nothing at its own floor |
| 45 | D | $0 |
| 34 | F | **−$8,000** |
| 100 | A+ | +$72,000 (the ceiling) |

For scale: office overhead plus one level-1 depot is ~$5,500 a quarter before wages. A B-grade quarter
is a bus every eleven quarters; an A-grade quarter is one every five. **The grant is a tailwind, not
an income** — a player who tries to live on it starves. Keep it that way.

**Is the 35–55 gap a dead zone?** No — it is the best-designed part of the payout, and it should be
made legible rather than filled.

1. It is where every honest new agency lives. A company charging $2.25 with two lines and a driver
   shortage lands around 45. Fining that player is fining them for playing the tutorial.
2. It separates two feelings that a continuous curve would blur: *not yet earning* and *actively
   failing*. Twenty points of runway between them means the fine is rare, and a rare fine is a fine
   that means something. A smooth penalty curve makes every mediocre quarter feel identical.
3. The cliff at 35 is a discontinuity, which is exactly what makes it visible. A threshold can be put
   on a gauge and counted down to; a gradient cannot.

The gap's only real cost is surprise, and surprise is a UI problem — see §5. Fix it there, not here.

---

## 4. The quarterly rhythm — what is integrated, what is sampled

`DAYS_PER_QUARTER = 10`, `QUARTERS_PER_YEAR = 4` (SPEC, in `constants.ts`).

**Every category is a time integral, weighted by in-service game-minutes** (`DEFAULT_SERVICE_HOURS`,
so 16 h × 10 d = 9,600 game-minutes a quarter). One accumulator per category:
`acc[c] += instantScore[c] × dtServiceMinutes`; at close `score[c] = acc[c] / servedMinutes[c]`.

This is the whole point. **An agency is graded on the service it delivered, not the service it owned
at 23:59 on day 10.** A player who hires six drivers on day 9 moves Staff happiness by two tenths of
the delta, because that is how much of the quarter those drivers worked. Nothing is sampled at close.

Two refinements:

- **Passenger happiness is boardings-weighted, not minute-weighted** # tune:
  `acc += satisfaction × boardingsThisStep`. A blissful 21:00 with four riders must not cancel a
  miserable 17:30 with four hundred.
- **Reliability is boardings-weighted** for the same reason (§7).

**Charter grace.** Year 1 Quarter 1 is **advisory** # tune: fully graded and displayed, but pays no
grant and levies no fine, labelled "Advisory — first quarter". No board fines an agency for the
quarter in which it was chartered, and the player spent a third of it deciding where the depot goes.

Pause freezes the integral (it is in game-minutes). Clock speed is irrelevant to it. Accumulators are
save fields, optional-with-default; a save that predates report cards begins accumulating at load and
marks the current quarter advisory.

---

## 5. Making the grade legible before it lands

A report card that arrives as a surprise is a punishment. One you can see coming is a goal. Everything
in this section is required, not polish.

**Top bar** — one new chip after Coverage: **Grade**, showing the letter of the quarter-to-date
overall plus a trend arrow (comparing the last 2 game-days to the quarter mean). Ink at ≥ 55, amber
40–54, red < 40. A small dot when any single category is currently below 40. Click opens the panel.
Reachable all quarter at Company ▸ Report cards (SPEC §5).

**Report card panel, open mid-quarter.** For each of the seven, four columns:

| Today | Quarter to date | Weight | Points to next letter |
|---|---|---|---|

plus a 10-day sparkline of the daily average. **Two numbers, not one** — "Today 82 / Quarter 61" is
the readout that teaches the integral, and its absence is what produces "I fixed it, why didn't it
count?"

**The projection line, and it is the most important text in the system:**

> Projected close: **58 (C)** · grant **+$4,800**
> Even at 100 in every category from now, this quarter closes at **71**.

That second sentence is the honest arithmetic of a time integral, and it converts an unfair-feeling
mechanic into a strategic one: on day 8 the player learns that this quarter is already decided and
next quarter is where the fix lands. Recompute both lines once per game-day.

**Warnings.** At the start of day 7, if projected overall < 42, one amber notice: "Q3 is heading for a
fine — Report card ▸". Once per quarter, dismissible, never a toast storm. 42 not 35, so the warning
arrives while it can still be acted on.

**Diagnosis with a price tag.** The panel ranks the three cheapest available fixes by projected
overall-points per dollar — "Hire 1 mechanic · $260/day · +4.1 Safety", "Suspend Line 4 · free · +2.2
Reliability". This is the anti-spiral feature (§6): it guarantees the player always knows the next
move, and that at least one move is affordable.

---

## 6. The failure spiral

Let the mechanism run. Floor the money. Make the exit legible.

Low grade → no grant → less service → lower grade is a real thing real agencies live, and it is the
most honest lesson in the game. Cutting it would make the grant decorative. But a spiral a player
cannot climb out of is not a lesson, it is a quit, so three floors:

1. **The dead zone is the primary damper.** An agency loses the grant at 55 and is not fined until 35.
   Twenty points of warning is a long runway, and it is free — it costs no new mechanism.
2. **The fine never creates unpayable debt.** It is charged against available treasury; any shortfall
   is written off, not carried. The $8,000 figure is untouched (SPEC) in every normal case; this only
   binds when the treasury is already under $8,000, where the alternative is a save that cannot be
   played. # tune
3. **The escape hatch already exists and is deliberately ugly.** Talon & Grasp (§17) has no credit
   check and is always available. The spiral can make a player unable to act *cheaply*; it must never
   make them unable to act. That is the right shape and it is already in the design.

Do **not** add grade-based interest, escalating fines, or a game-over. And note the levers that
actually exit a spiral are nearly free — suspend a bleeding line, stretch a headway, hire one
mechanic — which is exactly what §5's ranked-fixes list exists to say out loud.

---

## 7. Reliability, and what stands in

SPEC: "scheduled vs actually-run headways". Per-vehicle schedule adherence telemetry does not exist.
It does not need to: §10 already states the measurement. *"Fleet shortage: if a period wants more
buses than the line has, the effective headway stretches to round-trip ÷ buses on hand. Reliability
measures exactly this gap."*

**v1 — ships with the first card.** Available the moment demand-model B3 exists:

```
adherence = Σ_lp boardings_lp × min(1, schedHeadway_lp / effHeadway_lp) / Σ_lp boardings_lp
score     = 100 × adherence
```

over every line `l` and period `p`. Driver shortage stretches headway too (§13) and is caught by the
same term — correctly, it is the same gap. A network that promised what it can deliver scores 100;
this category is a specific-mistake detector, not a grind, which is why it is only worth 10 %.

**v2 — when per-vehicle telemetry lands.** Multiply in traffic lateness:
`score = 100 × adherence × (1 − min(1, avgLateMin / 8.0))` # tune (8.0 mirrors §14's ≤ 8 lateness
penalty). Until then the panel labels it **"Reliability (schedule adherence pending)"** and the
tooltip names what is and is not counted. **Do not withhold the category** — the SPEC-blessed half is
the half the player controls, and an absent grade teaches less than an honest partial one.

---

## 8. History

One record per closed quarter, appended at close:

```ts
interface ReportCardRecord {
  year: number;                 // 1-based
  quarter: number;              // 1..4
  scores: Int16Array;           // 7 ints 0-100, fixed category order; -1 = withheld
  overall: number;              // int 0-100
  grantUsd: number;             // >= 0
  fineUsd: number;              // >= 0
  advisory: boolean;            // graded, not paid (Y1Q1)
}
```

~40 bytes a record. **Retain 80 records (20 game-years) # tune**; on overflow drop the oldest into a
running `lifetime { quarters, meanOverall, totalGrantUsd, totalFineUsd }` so the save never grows
unbounded and the long view survives. The panel plots the last 12 quarters; the full list is
scrollable.

Credit score reads the latest record only — SPEC §17 "latest report (×1.2 around 50)", i.e.
`creditDelta = (overall − 50) × 1.2`, range ±60. Advisory quarters still write a record and still
feed credit; they only skip the payment.

---

## 9. Build order

1. **Quarter boundary, panel shell, history record, grant/fine.** Graded on Coverage, Passenger
   happiness, Staff happiness only (weights renormalise over 55 %). All three exist by demand-model
   step 8 and §13. The loop closes here.
2. **Safety** (needs §12 wear) and **Environment**'s mode-share half.
3. **Connectability** — needs demand-model step 4 (B4 clusters). Not before; without transfers there
   is nothing to grade.
4. **Reliability v1** — needs B3 headways.
5. **Top-bar Grade chip, running projection, day-7 warning, ranked fixes.**
6. Environment's electric half (needs Volt-E), Reliability v2.

**Milestone cut — half the time.** Drop the sparklines, the ranked-fix list, the day-7 warning, and
the 20-year history (keep 12 quarters). Keep the top-bar chip, keep the two-column Today /
Quarter-to-date readout, and keep the "even at 100 from now" projection line. Without those three the
card is a verdict delivered to a player who never saw it coming, and the whole feedback loop fails.

---

## 10. Edge cases

- **Quarter closes while paused** — it cannot; the clock is paused, so the boundary is not crossed.
- **Save/load mid-quarter** — accumulators persist; nothing recomputes from scratch.
- **Zero lines all quarter** — Coverage 0, Connectability 0, Passenger 0; Staff/Safety/Reliability
  withheld; overall ≈ 0 → fine, except in the advisory charter quarter.
- **Sandbox** — cards arrive and history is written (SPEC §2). Grant and fine are computed and shown,
  then discarded; cash is pinned at ∞.
- **Resize / controller unplug** — panel reflows; it holds no input state.
- **Spam input** — the panel is read-only apart from dismiss and scroll. The close-of-quarter card
  cannot be dismissed by the same keypress that opened it (150 ms input guard # tune).
- **Determinism** — accumulators are Float64; scores round once, at close. Two identical runs produce
  identical records.
