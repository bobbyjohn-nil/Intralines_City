# Reference

Drop reference material here and tell the orchestrator what you want taken from it.

```
reference/screenshots/   images, GIF frames, footage stills
reference/docs/          wikis, patch notes, postmortem transcripts, design docs
```

**Name files so the intent is obvious** — `hollowknight-dash-frames.png` beats `Screenshot 2026-08-10.png`.
If several images belong together, prefix them: `celeste-jump-01.png`, `celeste-jump-02.png`.

Useful things to capture:

- **A sequence of frames** for any motion you want replicated — the timing between frames is the spec.
- **The same moment in both games** when something feels wrong in ours. Side-by-side is far more diagnostic than a description.
- **Patch notes and postmortems**, which are the only places developers publish real frame data.

Then just say what you want: *"the game feel from these dash frames"*, *"the HUD density in this shot"*,
*"why does their camera feel better than ours."* The orchestrator routes it to `reference-analyst`.

Note: this folder is for study, not for assets. Nothing in here ships in the game.
