# Intralines Bus Simulator

Read [studio/GAME.md](studio/GAME.md) before doing anything — engine, pillars, conventions, palette,
key tunables, and the constraints that cannot be broken.

## Repository layout

**Game code and crew files are strictly separate.**

- **The game** lives in `src/` and ships. `src/game/constants.ts` holds every tunable number.
- **The crew** lives in `studio/` and `.claude/` and ships nothing. `.claude/` and this file must sit
  at the repo root because the tooling resolves them from there; everything else is under `studio/`.

Never write crew output into game directories, and never import anything from `studio/` into `src/`.

## Working here

Use the `/gamedev` skill to orchestrate work across the specialist agents in `.claude/agents/`:
`game-designer`, `gameplay-coder`, `test-engineer`, `modeler`, `2d-artist`, `vfx-artist`, `animator`,
`audio-designer`, `level-designer`, `ui-designer`, `writer`, `playtester`, `build-engineer`,
`devlog-writer`, `reference-analyst`.

Reference material from other games goes in [studio/reference/](studio/reference/README.md).
3D models to import go in [studio/assets/incoming/](studio/assets/incoming/README.md) — `modeler`
only ever *prototypes* geometry itself; final art comes from you.

For small, obvious changes, just do the work directly — the orchestrator is for multi-discipline tasks.

## Work tracking

[studio/BACKLOG.md](studio/BACKLOG.md) is the living work queue — add anything you want built under
**Up next**, one sentence is enough. The orchestrator moves items to **In progress** when it starts
them, and on completion deletes them from the backlog and appends them to **Unreleased** in
[studio/CHANGELOG.md](studio/CHANGELOG.md).

Versions are cut only on request, with `/ship <version>`. Nothing versions itself.

## House rules

- **Old saves must always load.** This game is live at v1.18 with real companies in the wild; every
  new save field is optional with a default, and a newer-than-current save is never overwritten.
- The game must be runnable at the end of every session. A broken build is the next task, never a
  later one.
- Tunable numbers live in `src/game/constants.ts`, never as literals inside logic. Read the file
  before quoting a number — never quote one from memory.
- One shared predicate per rule, used by sim, money, and UI alike, so they cannot disagree.
- Nothing is "verified" until `playtester` has actually run it.
- Design specs go in `studio/docs/design/`, devlogs in `studio/docs/devlog/`.
