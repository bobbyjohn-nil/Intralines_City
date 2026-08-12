# studio/

Everything the development crew uses. **None of it ships.**

Nothing in this directory is bundled, imported, or referenced by game code. It can be deleted
without affecting the build — it exists so the agents in `.claude/agents/` have somewhere to work
that is not the game.

| | |
|---|---|
| [GAME.md](GAME.md) | The bible. Every agent reads it first. |
| [BACKLOG.md](BACKLOG.md) | Work queue — add items under **Up next**. |
| [CHANGELOG.md](CHANGELOG.md) | Finished, verified work. **Not** the player-facing changelog. |
| `docs/design/` | Feature specs. |
| `docs/devlog/` | Devlogs. |
| `reference/` | Study material from other games. Never ships. |
| `assets/incoming/` | 3D models awaiting import. An inbox, not storage. |

The crew's definitions live in `.claude/` at the repo root rather than here, because Claude Code
resolves agents and skills from that fixed location.
