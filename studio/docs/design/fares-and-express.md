# Fares and express service

**Intent.** The player drags one slider and watches a whole city change its mind about the bus — and
earns an EXPRESS badge by drawing a shape, not by ticking a box.

**Loop placement.** Minute-to-minute. Fare and express are inputs to the ~250 ms debounced recompute
([demand-model.md](demand-model.md) B6); their money lands per tick in Stage C. Nothing here runs per
frame except `isExpress()`, which is O(1). Authority: manual §11, §14 for perceived minutes, §17 for
the ledger. `SPEC` = stated in the manual or in `src/game/constants.ts`; `# tune` / `[choice]` = mine.

## 1. The fare mechanism

Slider **$1.00–$5.00 in 25¢ steps, default $2.25** (SPEC). 17 positions, emitting
`FARE_MIN_USD + i * FARE_STEP_USD`, `i ∈ 0..16` — every fare is exactly representable in binary
floating point and `fare − 2.25` is exact, so **neutrality needs no epsilon.** It is **one fare for the
company, not per line** `[choice]`: §17 says "*your* fare × every boarding", §11 puts the slider
outside the line editor, and it makes §6's strategy one decision instead of twenty. `fareMin` is still
**per line** because the express halving is — that is what demand-model.md's per-line fare array holds.

```
fareMin(line) = (fareUsd − DEFAULT_FARE_USD) / USD_PER_PERCEIVED_MINUTE
                * (isExpress(line) ? EXPRESS_FARE_SENSITIVITY : 1.0)      # SPEC §11
```

Added once per trip to `busMin` (demand-model.md §3): positive above $2.25, negative below, **exactly
zero at $2.25**. Worked and verified — the manual's "~5.5 min" is prose; the number is 5.56.

| Fare | `(F − 2.25) / 0.18` | local | express (×0.5) |
|---|---|---|---|
| $3.25 | `1.00 / 0.18` | **+5.5556 → displays +5.6 min** | +2.7778 → +2.8 |
| $1.50 | `−0.75 / 0.18` | **−4.1667 → displays −4.2 min** | −2.0833 → −2.1 |

§11 rounded 5.5556 down. **Do not retune $0.18 to make 5.5 come out** — that needs $0.1818. Display
is 1 dp, so the UI reads **+5.6 min at $3.25**; the constant is authority, the manual is intent.
**Subsidy** (SPEC §17): `SUBSIDY_PER_BOARDING_USD` $1.60 `× EXPRESS_SUBSIDY_MULT` 1.5 = **$2.40** —
spec the multiplier, derive the dollars, so they cannot drift. Revenue per boarding =
`fareUsd + subsidy(line)`, accruing **per boarding**: a one-transfer trip pays twice.

> ⚠ **Open asymmetry — flag, do not silently pick.** Money charges per *boarding* (§17), perceived
> minutes once per *trip* (§11, "every trip"), so splitting one line into two doubles fare + subsidy on
> the same rider at no perceived cost. Recommended fix `[choice]`: accumulate `fareMin` per boarding in
> the RAPTOR label, so a transfer trip feels two fares. It touches demand-model.md, which I do not own.

## 2. The express predicate

**One pure function, `isExpress(line: LineMetrics): boolean`.** The sim (B6's `e` and `fareMin`), the
ledger (subsidy rate) and the UI (badge, list tag, reason copy) **all call it**; none may reimplement
or approximate it. This is the convention's named example (GAME.md).

```
EXPRESS_MIN_LENGTH_M = 5000, EXPRESS_MIN_STOPS = 3, EXPRESS_MIN_AVG_SPACING_M = 1200   # all SPEC
avgSpacingM = routeLengthM / (stopCount − 1)            # closed loop: / stopCount   [choice]
isExpress   = stopCount >= 3 && routeLengthM >= 5000 && avgSpacingM >= 1200
             # total: stopCount < 2 or routeLengthM <= 0 → false. Never NaN.
```

- `routeLengthM` is the **one-way length along the drawn street path** — not straight-line, not the
  round trip `[choice]`. It is already maintained for `lineCumMin`, so the predicate is O(1) and safe
  in a render. Gaps are `stopCount − 1` `[choice]`: "averaging 1.2 km apart" is a mean over the gaps.
- **Never stored** — not in the save, not on the line record, not cached across a recompute; derived
  state that disagrees with its source is the exact bug this convention exists to prevent. **Evaluated
  on demand, every time:** editing stops wins or loses the status at any moment (SPEC §11), and a draft
  line is evaluated live so the badge appears while drawing. All three rewards below therefore flip
  together, from the one predicate, on the same recompute — **there is no partial express.**

## 3. The three rewards

| Reward (all SPEC) | Constant | Consumer | Enters at |
|---|---|---|---|
| On-board time ×0.85 | `EXPRESS_ONBOARD_MULT` | sim | demand-model.md §3's `e`, and §4 step 2 |
| Fare sensitivity halved | `EXPRESS_FARE_SENSITIVITY = 0.5` | sim | §1 above; survives transfers via `raptorFareMin[S]` |
| Subsidy +50 % → $2.40 | `EXPRESS_SUBSIDY_MULT = 1.5` | ledger | §17 "City subsidy", per boarding, Stage C |

## 4. Telling the player why they are not express

The editor's express slot is **always populated**: either the badge with its three measurements, or
every unmet condition in fix order (length → stops → spacing). "If you're close" then needs no
threshold — when you are close, only one line is red. Voice: *measured value, comma, the threshold, em
dash, an imperative fix.* Lowercase after the dash; no exclamation, no praise, no "oops".

| Unmet | Copy |
|---|---|
| Length | `this line runs 3.4 km, and an express needs 5 km — push an end further out.` |
| Stops | `2 stops, and an express needs 3 — add one more.` |
| Spacing | `stops average 800 m apart, and an express needs 1.2 km — thin them out.` |

Passing badge: `EXPRESS · 7.1 km · 5 stops · 1.8 km apart` — it names its thresholds by naming its
measurements (pillar 1). Units: metres below 1 000, kilometres above, 1 dp. **Rounding guard:** spacing
rounds to 50 m, length to 0.1 km — **except** where rounding would print a passing value for a failing
condition (1.19 km → "1.2 km"); then show 2 dp. A UI printing a number that contradicts the predicate
is the same bug as a second predicate.

## 5. Judgment call — by-construction is right; the trap is a feedback bug

**Keep the SPEC rule. Fix the feedback.** A toggle does not remove the predicate, it *adds a failure
mode*: something must still stop a player branding a 14-stop local as EXPRESS and collecting
$2.40/boarding, and that something is `isExpress()`. So a toggle buys a new UI state ("designated but
ineligible"), a new way to be denied a reward you earned by forgetting to click, and zero
expressiveness. Geometry-only also teaches the true lesson — express is stop spacing, not livery — and
it does not block the real-agency pattern: draw the local *and* the express down one corridor and the
game already scores it correctly. But the trap is real, and it is this project's worst failure mode:
add one useful stop, lose $0.80 a boarding and a ×0.85 on every rider, find out a quarter later.

**Guard rail — presentation only, no mechanic changes.** (1) **Pre-commit warning:** when a committed
stop edit would flip `isExpress()` either way, the confirm step names it — `adding this stop drops the
average to 1.05 km — Line 3 stops being an express.` `Enter` confirms, `Esc` cancels (GAME.md dialogs,
never a browser popup). (2) **Flip toast** through the error bus, informational not red, both
directions. (3) **The shortest gap is highlighted** on map and stop list, so "thin them out" has a
target. The predicate still decides; nothing here changes a number.

## 6. Making the fare strategy legible without a tutorial

At $2.25 fare is neutral; below it you buy ridership with revenue, above it you sell ridership for
revenue — and with a $1.60 subsidy the low side can win outright. Verified on a marginal O–D pair where
`busMin == carMin` at $2.25, using demand-model.md's logit and 13 % captive share:

| Fare | fareMin | bus share | $/boarding | revenue index |
|---|---|---|---|---|
| $1.00 | −6.94 | **0.677** | $2.60 | **$1.761** |
| $2.25 | 0 | 0.530 | $3.85 | $2.041 |
| $2.50 | +1.39 | 0.499 | $4.10 | $2.048 ← peak |
| $3.25 | +5.56 | 0.410 | $4.85 | $1.991 |
| $5.00 | +15.28 | **0.254** | $6.60 | **$1.676** |

**$1.00 earns more than $5.00 and carries 2.7× the riders.** Delete the subsidy and it inverts — $0.68
vs $1.27, high fare wins by 1.9×; the subsidy is the entire reason. It stays a *decision* because it is
corridor-dependent: where the bus badly beats the car, high fares extract more. Made legible by:

- **The slider is an instrument.** Beside the handle, on the same 250 ms debounce: perceived effect
  (`+5.6 min` / `−4.2 min` / `neutral`), riders/day, net $/day — each a delta against the current fare.
- **The subsidy is printed next to the fare, always:** `$1.00 fare + $1.60 subsidy = $2.60 per boarding`
  — one line, the whole lesson, and nobody has to ask for it.
- **$2.25 is a labelled tick** reading `normal`, so the player reads deviation, not price.
- **Finance keeps Fare and City subsidy as separate rows** (already SPEC §17), and **the report card
  closes it** — more riders → coverage and happiness → the grant. A cut pays twice.
- **No tooltip ever suggests lowering the fare.** The number that teaches it is `$/boarding`, sitting
  under a slider the player is already dragging.

## 7. Feel, edges, build order

**Feel.** Steps snap with a 1-frame tick; ←/→ moves one 25¢ step, Shift+← four. While a recompute is
pending, rider and money figures dim to 60 % opacity rather than show stale values `# tune`. Badge
gain/loss cross-fades 180 ms, 4 px settle, ease-out-cubic `# tune` — the panel's only animation, so it
reads. **Edges:** fare applies immediately on each step, including while paused (nothing accrues
until resume); spam-dragging costs one recompute per 250 ms, never more; `fareUsd` is an optional save
field defaulting to `DEFAULT_FARE_USD`, so pre-fare saves load neutral and unaffected — the manual's
own promise; `isExpress` is never saved, so an old save gets the right status the instant it loads;
bankruptcy, resize and reload change nothing here; no controller path exists (GAME.md: mouse and
keyboard). **Tests:** neutrality — `fare == 2.25` ⇒ bit-identical to fare disabled (exact, per §1);
ridership non-increasing in fare; boundaries at exactly 5 000 m / 3 stops / 1 200 m all pass (`>=`) and
one under each fails; a grep test proves no second implementation of the three thresholds.

**Build order.** (1) `isExpress()` + line metrics + tests + list tag + badge/reason copy — ships
*before* the sim reads it, since the ledger consumer ($2.40) needs only boardings. (2) Fare slider,
`$/boarding` line, Finance rows; fare revenue-only, matching demand-model.md step 1. (3) `fareMin` + the
neutrality test (step 5 there). (4) `×0.85` and the halved sensitivity. (5) §5's guard rails.

**Cut line.** Drop 5 entirely, and drop the slider's live riders/day preview — keep `$/boarding`, the
one that teaches. **Never cut §4's reason copy:** without it express is an invisible rule, the one
thing this game has promised never to ship. Never cut the neutrality test.
