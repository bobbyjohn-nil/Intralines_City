# Incoming assets

Drop `.glb` models here, sorted into the category they belong to, and run `npm run models`.
`scripts/models/build.ts` validates each file against the budget below, optimises it
(dedup → prune → weld → simplify-if-over-budget → meshopt → KTX2), writes the result to
`public/assets/models/<category>/<name>.glb`, and regenerates
`src/render/three/modelManifest.ts`. Nothing under `studio/` ships — this folder is a staging
area only. See [renderer-3d.md](../../docs/design/renderer-3d.md) §4–5 for the full spec this
implements.

```
assets/incoming/vehicles/<name>.glb    a bus, one file per Mk/model
assets/incoming/depots/<name>.glb      a depot building, one per level
assets/incoming/stops/<name>.glb       stop furniture, one per tier
assets/incoming/buildings/<name>.glb   a landmark or building kit piece
```

If a model needs loose textures instead of embedded ones, that's fine — glTF binary (`.glb`)
embeds everything in one file, which is what the pipeline expects. **`.glb` only** — not `.gltf`,
`.fbx`, `.obj` or `.blend`; export from the DCC as glTF 2.0 binary.

## Budget, per category

| Category | Count (v1) | Triangles | Optimised bytes | Required material slots |
|---|---|---|---|---|
| `vehicles/` | 15 (5 models × Mk I–III) | ≤ 4,000 | ≤ 45 KB | `Body`, `Stripe` — **no per-model texture**; livery is a runtime recolour of these two named slots, so paint it correctly by naming the material, not by baking a texture |
| `depots/` | 3 (one per level) | ≤ 6,000 | ≤ 60 KB | — |
| `stops/` | 5 (one per tier) | ≤ 2,500 | ≤ 30 KB | — |
| `buildings/` | 12 (kit pieces) | ≤ 1,500 | ≤ 20 KB | — |

Hard caps regardless of category: any single file ≤ **120 KB**; any texture ≤ 1024², power-of-two;
total `public/assets/` ≤ **900 KB on disk, 600 KB gzip-transferred**. The numbers above and the
per-file caps live in one place, [`src/render/three/modelBudgets.ts`](../../../src/render/three/modelBudgets.ts)
— that file is what both the pipeline and its regression test read, so it can't drift.

## Conventions the validator checks

- **1 unit = 1 metre.** A Metro 40 is ~12 m long — the validator flags anything roughly an order of
  magnitude off (the classic case: a scene authored in centimetres, exported without rescaling).
- **Y-up, +Z-forward, origin at the floor centre of the footprint** (not the geometric centre —
  `min.y` should sit at `y=0`, and the horizontal centre should sit at `x=0, z=0`). The validator
  checks scale and origin directly; it cannot check forward-axis from geometry alone, so get that
  right at export and confirm it visually in the viewer (below).
- **No cameras, no lights** in the file — the renderer supplies both.
- **Vehicles carry no texture.** Livery (company colour + line stripe) is applied at runtime to
  materials named exactly `Body` and `Stripe`. A model that imports fine but is missing one of
  those two material names is the expensive failure — it can't be recoloured, and the validator
  rejects it at bake specifically so that doesn't reach the game silently.

## What happens when a model misses

Three tiers, from renderer-3d.md §4 — the pipeline's console output names the file, the rule, the
measured value and what to change:

- **Rejected, build fails:** not `.glb`; > 2× the triangle budget; texture > 1024² or non-power-of-
  two; optimised file > 2× the byte cap; missing a required material slot; off by an order of
  magnitude on scale; origin not at floor centre of footprint; contains a camera or light.
- **Auto-fixed with a warning:** triangles between 1×–2× budget (decimated to fit); uncompressed
  geometry (meshopt-encoded); PNG/JPG textures (converted to KTX2 — requires `toktx` on `PATH`,
  see below); unused UV sets/vertex attributes (stripped).
- **Accepted with a warning:** > 8 materials; > 60 nodes; unnamed animation clips.

**KTX2 texture compression needs [KTX-Software](https://github.com/KhronosGroup/KTX-Software/releases)
installed** (the `toktx` binary on `PATH`). If it isn't found, `npm run models` still runs
everything else and ships PNG/JPG textures with a warning instead of failing — but vehicles carry
no texture at all, so this only matters for depots/stops/buildings/landmarks that use one.

## Before you drop a file, or after — check it in the viewer

`npm run viewer` opens a standalone page that loads one `.glb` at true map scale, under the same
clamped lighting the game ships, with a 1 m reference cube and grid for scale. It shows triangle
count, file size, bounding-box dimensions, in-budget status and the material slot names it found —
useful for a scale/orientation/material sanity check before or after running the pipeline, since it
doesn't require the game (or even `npm run models`) to have run first.

## What to say when you drop a file

One line is enough: *"Metro 40 Mk I, should be ~12 m"*, *"stop shelter tier 3"*. Worth mentioning if
known: which way is forward, whether it's rigged, and where the pivot should sit — `modeler` infers
what's left out, but pivot is where it most often guesses wrong.

Processed files are written to `public/assets/models/` and this folder stays a staging area — it is
never read by the shipped game directly.
