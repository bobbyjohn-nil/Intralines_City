# Errors — the bus

**Intent.** When something breaks, the player learns what broke, what it cost, and what to do — in one
sentence — and never once wonders whether their company survived.

**Loop placement:** outside it. Errors interrupt the minute-to-minute loop only when the loop already
broke; everything else accretes silently in a badge the player may never open.

**SPEC** = manual v1.18 (§ noted) or GAME.md Conventions. **[call]** = my choice + reason.
Numbers below live in `src/game/constants.ts` (GAME.md Conventions), never inline.

## 1. The bus

One entry point. `report(r: ErrorReport)` in `src/game/errors/bus.ts`. Nothing catches and stays quiet
(§6); nothing renders its own failure UI.

| Field | Type | Notes |
|---|---|---|
| `severity` | `'note' \| 'problem' \| 'fatal'` | §2 decides which |
| `source` | `'save' \| 'pack' \| 'sim' \| 'map' \| 'render' \| 'pwa' \| 'ui' \| 'boot'` | closed union, extended by PR **[call]** — a free string makes dedup keys drift |
| `code` | `string` | stable slug, e.g. `quota`, `worker-dead`. `source/code` is the identity |
| `message` | `string` | player language, §3. Required even for `note` — a log a dev must decode is a log nobody reads |
| `detail` | `string \| undefined` | dev-facing: `error.name`, `error.message`, first 5 stack frames, versions. Never a save body, never a company name |
| `action` | `{ label, run } \| undefined` | present ⇒ actionable; renders as one button on the toast |

**Dedup [call].** Key = `` `${source}/${code}` ``. A session log entry is created once per key and
carries `count`, `firstAtMs`, `lastAtMs`, latest `detail`. Repeats increment `count` and never
allocate a second entry. A key toasts at most once per `ERROR_TOAST_DEDUPE_MS` **120 000** and at most
`ERROR_TOAST_MAX_PER_CODE` **3** times per session; after that it is badge-only. So a storage-full
autosave firing every 10 s produces 3 toasts and one log row reading `×214`, which is the honest
number. Global caps: `ERROR_TOAST_MAX_ONSCREEN` **3**, older ones collapse into the badge.
Log ring buffer `ERROR_LOG_CAPACITY` **200** keys, evicting lowest severity then oldest `lastAtMs`.

**Sinks.** Console (always, dev and prod), session log, toast layer, recovery card. Sinks are
registered; the bus works with zero sinks attached, which is what makes it safe to call from boot code
and from a worker bridge before React mounts. Reports arriving pre-mount queue (cap **50**) and flush.

## 2. Severity tiers

The line is **cost to the player**, not technical severity.

| Tier | Surface | Test | Examples |
|---|---|---|---|
| `note` | badge + log only | Nothing the player asked for failed, and nothing they own changed | tile fetch retried and succeeded; a stop re-anchored > 15 m (save-format §5.2); SW registration failed while the app is already cached |
| `problem` | red toast (SPEC §20) + badge | Something the player asked for did not happen, or something they built is now at risk, and they would be *surprised later* if we stayed quiet | autosave refused; pack download failed; WebGL context lost; sim worker died |
| `fatal` | full-screen recovery card | The UI can no longer be trusted to render a toast | render loop throws twice in one frame; React error boundary trips; boot never completes |

Deliberately **not** `problem`: anything the game silently retried and won, anything with a visible
in-place expression already (pillar 1 — an orphan stop has its own dialog and amber ring, save-format
§5.3, and the bus only logs it), and anything the player caused on purpose and was refused with an
inline hint. Deliberately **not** `note`: everything in §6.

The amber **Saving paused** chip (save-format §2) is state, not an error surface. The toast that armed
it fires once; the chip carries it from then on.

## 3. Copy — the actual strings

House voice: state the threshold and the fix. Reassure about the company only where it is true.

- **Storage full** (save-format §6, verbatim — do not reword):
  *"Storage is full — your company could not be saved. Export a save from Finance."*
  Action **Export save**. Fires after the two reclaim attempts, not before.
- **Autosave failed, other cause:**
  *"Autosave failed, so anything built in the last minute isn't stored. Saving stays paused until you
  reload — export a save from Finance first."* Action **Export save**.
- **Pack download failed, online:**
  *"Boston's map stopped downloading at 12 of 34 MB. Check your connection and try again — saved
  companies are untouched."* Action **Retry**.
- **Pack download failed, offline** (`navigator.onLine === false` — offline is supported, not a fault):
  *"Boston hasn't been downloaded to this device yet, so it needs a connection once. Riverton plays
  offline right now."* Action **Play Riverton**.
- **Graphics hiccup, recovering:**
  *"The map lost its graphics context and is rebuilding — about a second. The simulation kept
  running."* `problem`, auto-dismiss on restore.
- **Graphics hiccup, unrecoverable** (restore fails within `RENDER_RESTORE_TIMEOUT_MS` **5 000**):
  *"The map can't restart its graphics. Reload the page — your company was saved 8 seconds ago."*
  Action **Reload**. Quote the real elapsed time or omit the clause; never guess.
- **Save refused, unreadable** (save-format §2, verbatim):
  *"That save could not be read. A backup was kept."*
- **Save refused, newer** — a dialog, not a toast (save-format §2 owns the copy). The bus logs a `note`.
- **Simulation stopped:** see §7.

Banned: "Oops", "Something went wrong", "An unexpected error occurred", any bare error code, any claim
that saves are safe when `autosaveBlocked` is set.

## 4. The recovery card

Full-screen, paper palette, inline SVG bus, no web font, no network (Hard constraint: offline).

> **The game hit a problem it couldn't recover from.**
> Your companies are saved on this device. Neither button below touches a save.
> **Reload** · **Clear caches & reload** · **Copy error**

**Copy error** puts the session log (all keys, counts, details), build version, UA, and pack identity
on the clipboard as plain text. Falls back to a selected `<textarea>` if the clipboard API refuses.

**`clearCaches()` — the contract.** Clears exactly:
1. every `caches.keys()` entry (the release's precache),
2. every `navigator.serviceWorker.getRegistrations()` → `unregister()` (SPEC §2: the escape hatch from
   a bad release),
3. every record in IndexedDB `intralines` → `cityPacks` (arms a rebake load, save-format §5.4),
4. `sessionStorage` keys prefixed `intralines:` (includes `register.ts`'s reload counter).

Must **never** touch: `localStorage` at all — not `intralines.save.*`, not `intralines.backup.*`, not
`intralines.settings`; and never `indexedDB.deleteDatabase('intralines')`, only records inside
`cityPacks`, so a later store cannot be destroyed by a function written before it existed **[call]**.

**Testable (`recovery.clear.test.ts`).** Seed a save, both backup keys, settings, two pack records, a
fake cache, a `sessionStorage` key. Run `clearCaches()`. Assert: `localStorage` is byte-identical
key-for-key; `cityPacks` is empty but the DB and store still exist; caches empty. This test is the
promise in SPEC §2/§20 — if it is deleted, the promise is gone.

## 5. The boot net

An inline `<script>` in `index.html`, ~40 lines, **no imports, no bundler transform, no app code** —
because the failure it exists for is *the app never loaded*: a stale service worker serving a chunk URL
the new deploy removed, a syntax error in the entry module, a CSP refusal. Anything it imported would
be the same thing that failed.

Covers, from parse time: `window.onerror`, `window.onunhandledrejection`, and a watchdog — if
`window.__intralinesBooted` is not `true` after `BOOT_WATCHDOG_MS` **12 000** `# tune`, show the card.
The card's markup and styles are inline in `index.html`, hidden, so displaying it is one class toggle.
Its buttons re-implement `clearCaches()` inline against the §4 contract; both copies are covered by the
same test through a shared fixture.

**Hand-off.** The app calls `bootNet.handoff()` after first paint: sets `__intralinesBooted`, cancels
the watchdog, drains queued boot errors into the bus as `fatal`, and leaves the global handlers
installed — they now forward to the bus instead of the inline card.

## 6. Never swallowed

Always surface, even when play can continue. Each is a `problem` minimum:

- a refused or blocked save (NEWER, UNREADABLE, WRONG_CITY, quota, `localStorage` unavailable);
- **any** autosave that did not complete, including the silent-success-looking ones;
- a pack that failed to download, decode, or whose identity mismatched when all three fields said it
  should not have (save-format §5.4 — that is corruption, not a rebake);
- the sim worker dying, hanging, or returning a tick it cannot explain;
- anything that dropped a player-owned entity from a computation (a line skipped by the router, a bus
  the sim lost).

**Review rule.** An empty `catch {}` outside the boot net and `register.ts`'s storage probes is a
review failure. `catch` either handles and `report`s, or rethrows. Lint: `no-empty` with allowlist.

## 7. How the sim reports

The worker cannot touch the DOM, so it does not try. `src/game/errors/worker.ts` exposes the same
`report()` signature; it posts `{ type: 'error', report }` on the existing sim port and the host bridge
calls the real bus. Worker-side `self.onerror` / `self.onunhandledrejection` forward the same way.
Host-side `worker.onerror` (nothing came back at all) is handled as death, below.

**Death and hang are the same failure, because the symptom is identical and the worst state in the game
is a running clock over a frozen sim [call].** Host pings every `SIM_PING_MS` **2 000**; a miss beyond
`SIM_PING_TIMEOUT_MS` **5 000** `# tune` means unresponsive. On either:

1. **Pause the game clock immediately**, before any UI. Show the pause state as a normal pause so the
   speed controls read honestly.
2. Terminate and respawn once, re-seeding from the main thread's authoritative state (the main thread
   holds the save, so **autosave is unaffected** — say so).
3. Respawn succeeds within **10 s** ⇒ toast *"The simulation restarted and the clock is paused.
   Press Space when you're ready — nothing was lost, your company saved normally."*
4. Respawn fails, or `SIM_MAX_RESPAWNS` **2** per session is spent ⇒ stop trying, clock stays paused,
   toast *"The simulation stopped and won't restart. Reload the page — your company is saved and the
   clock is paused where it stopped."* Action **Reload**.

Building stays enabled while the sim is down (edits queue and apply on respawn); the money and rider
panels show the last good values greyed with *"paused — simulation restarting"*, never stale numbers
presented as live.

## 8. Failure and edge cases

- **Recovery card while playing:** the clock is already stopped by the crash; do not autosave from a
  crashed state — the last good autosave is more trustworthy than a half-mutated one **[call]**.
- **Pause / tab hidden:** toast auto-dismiss timers are wall-clock and keep running; an actionable
  toast never auto-dismisses (cap **30 s**, then collapses to the badge).
- **Resize / very narrow viewport:** toasts full-width minus 16 px, max 3 lines then ellipsis with the
  full text in the badge. The recovery card is single-column and scrolls; buttons never clip.
- **Spam-input:** covered by dedup — a player mashing a refused build gets one toast, not forty.
- **Controller unplug:** n/a, mouse and keyboard only (GAME.md Controls). Input-device loss is not an
  error and must not be reported as one.
- **Error inside a sink:** the bus wraps every sink call in try/catch and drops a failing sink for the
  session. A toast renderer that throws must not become a fatal loop.
- **Never a browser popup** (SPEC §22) — no `alert`, no `confirm`, ever, including in the boot net.

## 9. Build order

1. **`bus.ts` + severities + dedup + console sink + constants.** No UI. Immediately rewire the three
   live failure sites: `register.ts:onRegisterError` (currently a `console.error` placeholder naming
   this spec), save-format §6 quota, pack download.
2. **Boot net + recovery card + `clearCaches()` + `recovery.clear.test.ts`.** This is the promise.
3. Toast surface.
4. ⚠ badge, session log panel, Copy.
5. Worker bridge + ping watchdog.

**Steps 1–2 are the minimum worth adopting now.** They are the parts that get more expensive with every
system added, and step 1 alone means no new system ships its own `console.error`.

## 10. Cut line

Cut steps 4 and 5's watchdog. Ship `report()`, the boot net, the recovery card, and toasts; the badge
becomes a console dump behind a key chord, and worker death is caught only by `worker.onerror` rather
than by ping. **Never cut:** the boot net, `clearCaches()`'s never-touch list, or §6.
