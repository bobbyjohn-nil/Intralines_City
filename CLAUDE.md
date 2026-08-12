# The True Gamer

A game project. Read [GAME.md](GAME.md) before doing anything — it holds the engine, pillars, conventions, and build commands.

## Working here

Use the `/gamedev` skill to orchestrate work across the specialist agents in `.claude/agents/`:
`game-designer`, `gameplay-coder`, `test-engineer`, `modeler`, `2d-artist`, `vfx-artist`, `animator`, `audio-designer`, `level-designer`, `ui-designer`, `writer`, `playtester`, `build-engineer`, `devlog-writer`, `reference-analyst`.

Reference material from other games goes in [reference/](reference/README.md) — screenshots, frame sequences, patch notes. `reference-analyst` measures it into specs; nothing in that folder ships.

3D models you want in the game go in [assets/incoming/](assets/incoming/README.md) — `modeler` imports and wires them up. `modeler` only ever *prototypes* geometry itself; final art comes from you.

For small, obvious changes, just do the work directly — the orchestrator is for multi-discipline tasks.

## Work tracking

[BACKLOG.md](BACKLOG.md) is the living work queue — add anything you want built under **Up next**, one sentence is enough. The orchestrator moves items to **In progress** when it starts them, and on completion deletes them from the backlog and appends them to **Unreleased** in [CHANGELOG.md](CHANGELOG.md).

Versions are cut only on request, with `/ship <version>`. Nothing versions itself.

## House rules

- The game must be runnable at the end of every session. A broken build is the next task, never a later one.
- Tunable numbers live in data or named constants, never as literals inside logic.
- Nothing is "verified" until `playtester` has actually run it.
- Design specs go in `docs/design/`, devlogs in `docs/devlog/`.
