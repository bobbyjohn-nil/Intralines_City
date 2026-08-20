# draft/ — models in progress

Drop any model here for **advice, not validation**. Nothing in this folder is checked against
budgets, nothing ships, and nothing is rejected — it is a workbench, not a gate.

The difference from `incoming/`:

| | `draft/` | `incoming/` |
|---|---|---|
| Purpose | feedback while you author | intake for the pipeline |
| Budgets | reported, never enforced | enforced, rejects |
| Formats | anything glTF can express — `.glb`, `.gltf` | `.glb` (others converted) |
| Output | a written review: what to fix, in what order, and why | pass/fail with reasons |

Ask for a review by telling the orchestrator a file landed, or just say "review my drafts".
What comes back, per model:

1. **The one thing to fix first** — usually not what you would guess. (The first vehicle batch's
   real problem was an 859 KB metallic-roughness texture, not the 31,000 triangles everyone would
   have started decimating.)
2. **Measurements against where it will end up** — size, triangles, measured bytes-per-triangle,
   bounding box against the real-world object, material slots against the recolour system.
3. **What is fine and should be left alone.** Advice that only lists faults teaches you to
   over-correct.

When a draft is ready, move it to the right `incoming/<category>/` folder and run `npm run models`.
