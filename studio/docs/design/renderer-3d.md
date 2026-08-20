# Renderer: WebGL / three.js ("Route B")

**Intent.** The player looks at a city with real volume and depth and still reads their network at a
glance — the map got a body without getting harder to plan on.

**Core loop placement.** Second-to-second: this *is* the watching. Minute-to-minute: it is the
surface every draw, place and select gesture happens on. It must never be the reason a decision is
slower.

**One renderer, not two.** The manual's §6 "vector tiles online / self-rendered offline" split dies
here. Offline is a hard constraint; the tile path was the online-only half. Every city — procedural
or baked pack — renders through the same scene graph.

---

## 1. The camera

**Perspective, 30° vertical FOV, orbiting a focus point pinned to the ground plane (y = 0).** A
narrow FOV reads almost like a plan view while still giving buildings parallax — chosen over
orthographic because §6 wants extrusions to read as volume, and over a wide FOV because a transit
planner reads a network, not a skyline.

| Axis | Default | Range | Notes |
|---|---|---|---|
| Pitch (from nadir) | **35°** | 0°–60° | 0° = straight down. `# tune` |
| Yaw | 0° (north up) | free 360° | `N` snaps to north over 300 ms |
| Roll | 0° | locked | never exposed |
| Zoom | fit (see below) | `zoomFloor(city)` … 20 | `pxPerM = 0.1 · 2^(z − 14)` — identical semantics to `projection.ts` |
| FOV | 30° | fixed | |

Camera distance is derived, never stored: `d = (viewportHeightPx / 2) / (pxPerM · tan(FOV/2))`. So
"zoom" keeps meaning metres-per-pixel *at the focus point*, and every number tuned against the Canvas
renderer transfers unchanged.

**The perspective equivalent of "the map fills the window" (DECISIONS #61).** There is no
contain/cover choice to get wrong, because **the ground plane fills 100% of the framebuffer at every
legal camera state.** Max pitch 60° + half-FOV 15° = 75° from nadir < 90°, so the top of the frustum
always intersects the ground at a finite distance. **The horizon is never visible and no sky is ever
rendered.** What *can* still go wrong is the city occupying a fraction of that ground, so the fill
rule becomes a **void-share budget**: at the default framing, ≤ **2%** of pixels may show the
out-of-bounds mask; at any clamped camera state, ≤ **35%**.

**Whole-city overview survives as a bounded gesture, not the default.** `zoomFloor(city)` is the zoom
at which the city's larger axis spans **0.70** of the smaller viewport axis — you can zoom out to see
everything and no further, so the "428 px city in a 1317 px canvas" state is unreachable by
construction. `Home` eases the camera to default framing over 400 ms (ease-out cubic).

**Feel.** Pan is 1:1 — the ground point under the cursor stays under the cursor (ray/plane
intersection, the 3D form of `zoomAt`'s guarantee). Pan inertia decays over 220 ms, suppressed below
6 px/frame. Zoom is exponentially smoothed, 120 ms time constant, and also holds its cursor anchor
exactly. Tilt/yaw drag is 1:1 with 80 ms smoothing. **No screenshake, ever** — this is a planning
tool.

---

## 2. What is 3D and what is not

**Lit 3D geometry (has volume, casts a shadow decal, is occluded):** buildings (procedural extruded
prisms; landmarks are `.glb`), vehicles, depots, stop-tier furniture.

**Unlit world geometry (real geometry on the ground plane, but shaded flat):** the ground plane,
water polygons (y = 0.02 m), parks (y = 0.04 m), road ribbons (y = 0.06 m), route ribbons
(y = 0.10 m). Real meshes, correct perspective, **rendered `MeshBasicMaterial`-flat so their pixel
colour equals their intended colour.** This is the single most important legibility decision in the
spec: lighting is reserved for the things whose job is to look like objects. Every data layer keeps
the palette exactly.

**Screen-space (world position, pixel size, drawn in an unlit pass with depth test off):** stop
markers, demand-layer scatter dots, the out-of-bounds mask + dashed boundary, the night tint (a
full-screen composite at the existing ≤ 0.22 alpha), the draft rubber band, and all UI/DOM.

**Route lines: ground-hugging world-space ribbons with screen-space width.** Picked over a
screen-space overlay line because the entire premise is that a line follows real streets — a
screen-space line slides off its street the instant the camera tilts, and the player would be
planning against a lie. Width is resolved in the vertex shader against a pixel target
(`routeWidthPx`, ported unchanged: 1.25× rendered motorway width, floor 6.25 px), so the far end of a
tilted ribbon never thins below its legibility floor.

**Stop markers stay billboards even when furniture exists.** Above zoom 17 the tier's `.glb` fades in
*underneath* the marker; the marker shrinks toward its floor but never disappears. A stop is a
gameplay object first and scenery second.

---

## 3. Legibility in a lit scene

### Lighting model (a contract, not a look)

- Hemisphere: sky `--paper` @ 0.55, ground `--muted` @ 0.25.
- One directional key `#fff8e8` @ 0.45, azimuth follows the clock, **elevation clamped ≥ 25°** so no
  raking near-black faces.
- **No shadow maps.** Each building/vehicle gets a baked ground shadow decal at ≤ 0.18 opacity.
- `toneMapping = NoToneMapping`, `outputColorSpace = SRGB`, no fog, no bloom, no SSAO.

**The contract these numbers exist to satisfy:** the luminance multiplier applied to any lit
material's base colour stays within **[0.75, 1.15]** on every surface normal at every clock minute.
That is what keeps an intended-colour distance from collapsing — and it is itself asserted, not
assumed.

### Measurement — on rendered pixels

`GAME.md` is right that the current assertions compare intent and would keep passing while measuring
nothing. Replacement:

- **Where.** A second vitest project, `render`, using **vitest browser mode + Playwright Chromium
  headless with `--use-gl=swiftshader`** (deterministic software rasterisation, so CI and laptop
  produce identical pixels). `npx vitest run` runs both projects; the existing node project is
  untouched. New file: `src/render/three/contrast.rendered.test.ts`.
- **How elements are located.** The scene renders a second **id pass**: every gameplay element is
  drawn with a flat unique id colour into an offscreen target. The test therefore knows exactly which
  pixels belong to the bus, its route, the road under it, the stop. Segmentation from the id buffer,
  colour from the beauty buffer. This survives a model being replaced with a different shape, which a
  hard-coded sample coordinate would not.
- **What is asserted**, at 640×360, at the default camera *and* at pitch 60°, at clock 12:00 *and*
  03:00 (night composite applied), for each pair — mean RGB of element A's pixels vs element B's:

| Pair | Min RGB distance | Canvas-measured reference |
|---|---|---|
| bus body ↔ paper | 70 | 106 noon / 52 night |
| bus body ↔ nearest road class | 60 | 126 |
| bus body ↔ its own route ribbon | 55 | 56 |
| bus stripe ↔ route ribbon | 70 | 91 |
| stop marker ↔ route ribbon | 55 | — |
| route ribbon ↔ heaviest road | 40 | — |
| adjacent road classes | 12 | 15.8 noon / 12.8 night |
| park ↔ paper | 45 | 69.4 / 54.1 |

  All `# tune`: **ratchet each up to the first measured value once it is measured.** A gate set below
  what ships is a gate that only catches regressions, which is the job.
- **Coverage is asserted alongside colour** (DECISIONS #59 in one line): the bus's id-buffer footprint
  is ≥ **120 px** at 640×360 default framing, scaling with resolution. A colour-correct 3-pixel bus is
  the original bug wearing a passing test.
- **Void share** ≤ 2% at default framing, ≤ 35% clamped, measured by counting mask-id pixels — the
  direct port of DECISIONS #60/#61's missing assertion.
- **The lighting envelope itself:** render a `--muted`→`--amber` reference sphere and assert every
  sampled pixel's luminance ratio to base colour ∈ [0.75, 1.15].

**Migration, in one change.** The rendered assertions land in the same commit that deletes the Canvas
renderer. Palette-arithmetic assertions (`mixHex`, `withAlpha`, `mixHexAlpha`, colour tables) stay in
`paperPalette.test.ts` — they are still true. Every assertion in `drawOverlays.test.ts` that claims to
gate legibility is either re-expressed as a rendered assertion or deleted with the module. **Nothing
is deleted before its replacement exists, and no old assertion gates CI after it stops measuring.**

---

## 4. Model budget

Baseline: the production bundle is ~72 KB gzipped. The budget is set so `assets/` can never turn the
first run into a download.

| Class | Count (v1) | Tris each | Bytes each (`.glb`, meshopt + KTX2) |
|---|---|---|---|
| Vehicle (5 models × Mk I–III) | 15 | ≤ 4,000 | ≤ 45 KB |
| Depot (3 levels) | 3 | ≤ 6,000 | ≤ 60 KB |
| Stop furniture (5 tiers) | 5 | ≤ 2,500 | ≤ 30 KB |
| Building/landmark kit piece | 12 | ≤ 1,500 | ≤ 20 KB |
| Person (3 poses + 1 spare) | 4 | ≤ 600 LOD0 / 200 LOD1 *(generated)* | ≤ 12 KB |
| Shared texture atlas | 1 | — | 512×512 KTX2/ETC1S, ≤ 40 KB |

**Pipeline infrastructure** — decoders/transcoders the above formats need at runtime, not model
content, and not counted against the model classes' byte budgets above. Added after the first pass
at the model pipeline shipped one of these unbudgeted and it went unnoticed until it was measured:

| Component | Real size | Precached? |
|---|---|---|
| Meshopt decoder (geometry) | ~5 KB | Yes — bundles inline in the JS that needs it, so this is not a separate fetch at all (§5 point 6). |
| KTX2/Basis transcoder (`basis_transcoder.js` + `.wasm`, textures only) | ~515 KB | **No — lazy.** Fetched same-origin on first KTX2 texture actually transcoded (not at startup, not merely because a `.glb` loaded), then runtime-cached (`CacheFirst`) so a repeat visit stays offline-safe. Never in `workbox.globPatterns`. Today this is 515 KB nobody pays: vehicles carry no texture (this section, "no per-model texture" below) and buildings are procedural prisms until model-pipeline step 4 lands — precaching it unconditionally would be ~7× the entire game bundle spent on a file currently unused by anything. |

**Hard caps:** any single file ≤ **120 KB**; any single texture ≤ 1024², power-of-two; total
`assets/` ≤ **900 KB on disk, ≤ 600 KB transferred**. Pipeline infrastructure above is exempt from
this total on the same basis it's exempt from the precache: it is fetched, if ever, only in
response to content that isn't shipped yet, and is never part of what a first load pays for.
Vehicles carry **no per-model texture** — livery is the company brand colour and the line stripe
applied at runtime to named material slots (`Body`, `Stripe`, `Glass`, `Light_L`, `Light_R`), so a
growing fleet costs geometry only.

### People — the budget is set by instance count, not by the model

**A person's budget cannot be a vehicle's, and the whole difference is how many times it is drawn.**
A bus appears a dozen times; a crowd is hundreds. At the vehicle allowance, 300 riders would cost
1.2 M triangles of background detail against 48,000 for the entire fleet. So the count is decided
first and the model is derived from it — not the other way round.

**How many exist is a choice, not an emergent number.** [demand-model.md](demand-model.md) §1: on-map
riders are *presentation sampled from rates, not the simulation*. Nothing downstream reads the render
count — no fare, no satisfaction, no save field — so it is free to differ from the waiting count, and
must, or a successful player builds themselves a framerate problem.

**The mapping is compressive.** One shared predicate, `crowdShown(waiting, knee, cap)`, used by the
map and the station view with different constants so they cannot drift:

```
shown(n) = n                                            for n ≤ knee
shown(n) = knee + (cap − knee)·(1 − e^−(n − knee)/(cap − knee))   for n > knee
```

Chosen over a `sqrt` or a hard `min` because it is exactly identity at the bottom (two riders look
like two riders), C¹ at the knee, monotonic, and asymptotic rather than clamped — there is no count
at which its behaviour changes character.

| Waiting | Map, per stop (knee 8, cap 24) | Station view (knee 24, cap 120) |
|---|---|---|
| 1 / 5 | 1 / 5 | 1 / 5 |
| 20 | 16 | 20 |
| 100 | 24 | 77 |
| 500 | 24 | 119 |

The station view gets the gentler curve because the crowd is the subject there, not background, and
the counts that matter are the ones near capacity. `# tune` on all four constants.

**§16 says the station crowd "mirrors the live waiting count" — read *mirrors* as reflects, not
equals.** That is pillar 3 doing its job: the diorama shows the shape, the panel shows the exact
number. The panel already carries the waiting figure; it is never contradicted, only not duplicated.

**Overcrowding stays legible after the headcount saturates, because the signal moves off the
headcount.** With `load = waiting / stopCapacity(tier)` (§9's predicate, not a second one) and
`spillShare = 1 − 1/load` for load > 1 — 0.33 at 1.5×, 0.5 at 2×, 0.8 at 5×, bounded but never
saturating:

- **Position.** That share of agents stands *outside* the platform footprint, on a ring reaching
  `min(6 m, 1.5·(load−1))` past its edge. Footprint keeps growing after count stops.
- **Posture.** The same share swaps to the `walk` mesh and paces inside a 1.5 m radius at 0.4 m/s. A
  milling crowd reads as an unhappy one, and costs nothing we are not already drawing.
- **A flat ground decal** under the crowd in `--red` at `0.10 + 0.12·spillShare` alpha, cap 0.22 —
  unlit world geometry per §2, so it keeps the palette exactly.
- **Riders the sim sheds** walk away from the stop for 3 s, then fade. Departure is motion, and
  motion survives count saturation.

**No flicker.** `n` is an integer, so `shown` is a fixed value per `n`; compression alone means
41↔42 waiting both render 22. Above that: the rendered count only *decreases* after the underlying
value has been lower for 2 s, and agents enter and leave one at a time on a 400 ms stagger with a
200 ms scale/opacity fade — never a whole-crowd pop.

**Caps, and the arithmetic under them.**

| | Map | Station view |
|---|---|---|
| Concurrent agents | **240** | **120** |
| Per stop | 24 | — (one stop) |
| Visible above | zoom **18.5** (a 1.7 m person = 3.9 px) | always |
| Crowd triangle allowance | **48,000** | **72,000** |
| ⇒ triangles per person | 48,000 / 240 = **200** (LOD1) | 72,000 / 120 = **600** (LOD0) |

Zoom 18.5 is where a true-scale person first clears 4 px — riders get **no minimum-size floor** and
none of §7.1's exaggeration, because a rider is scenery and a bus is a gameplay object; below the
threshold they are culled outright, not shrunk. It is 1.5 steps above the zoom-17 furniture fade so
the shelter arrives before anyone stands in it. At 18.5 a 1600 px viewport spans ~707 m of ground, so
3–8 stops are in frame: 8 × 24 = 192 < 240, and the global cap is headroom rather than the usual
case. Over it, per-stop counts scale by `240/Σ`, floored at 1 for any stop with anyone waiting.

The 48,000 map allowance is deliberately **exactly the fleet's** (15 × 4,000): the crowd may be a
large geometry class but never outweighs the vehicles it is background to. The station allowance is
1.5× that, affordable because the camera is at one stop and the city behind it is mostly culled.

**So a person is ~600 triangles, and that is the constraint worth knowing before authoring.** Six
hundred triangles is a blocked-out figure — 6- or 8-sided limbs, a head, no fingers, no face, no
separate hair shell, no folds. The owner authors **one mesh per pose at ≤ 600 tris**; the pipeline
generates the 200-tri LOD1 (or uses a supplied `<name>_lod1` if present) and switches at **25 m**
from the camera. **No impostor tier**: a billboard atlas is a texture, and pulling the 515 KB KTX2
transcoder in for 4 px background dots is the worst trade in this file.

**Bytes fall out of that.** Meshopt-encoded, the vehicle class runs ~11.5 B/tri (4,000 tris → 45 KB);
600 + 200 tris at that rate is ~9 KB, so the cap is **12 KB** with headroom for the slot mask and
node names. Four models = **48 KB**, ~5% of the 900 KB disk total — the cheapest class in the table,
because the expensive resource here was never the file.

**Variation comes from the shader, because instancing means one mesh and one material.** The owner
authors five named material slots — `Skin`, `Top`, `Bottom` required, `Hair`, `Bag` optional — and
the pipeline merges them into a single material, baking the slot index into a per-vertex byte. Per
instance the renderer supplies: a packed `uvec4` of palette indices (skin 6 entries, top 12, bottom
8, hair 6 — 3,456 combinations from one mesh), a uniform scale in **0.90–1.10** (real adult height
spread, not caricature), a random yaw jitter of ±25° about the direction the bus comes from, and a
`phase` in 0–1 driving a ±3° sway at 0.25 Hz. Four bytes and two floats per instance, no per-instance
material, no second draw call.

**What must not be baked in, and this is the half the owner cannot fix later:** no texture of any
kind (a person carries none — a face at 10 px is noise), no UV0 required, no vertex colours (the
pipeline owns `COLOR_0` for the slot mask), no baked AO (it fights §3's [0.75, 1.15] envelope), and
no colour authored into the material itself — the slot's base colour is overwritten every instance.

**Animation is out of scope for this category in v1: static poses plus positional movement.** Three
meshes — `stand`, `walk`, `sit` (§16's shelter has a bench) — and an agent changing state moves
between instance buffers. Riders walk at **1.39 m/s**, which is §14's own 12 min/km rather than a
new number, so the on-screen walk and the sim's walk time cannot disagree. Life comes from the
vertex shader: walkers get a ±1.5 cm bob at 1.9 Hz (stride rate at that speed) and a ±4° forward
lean, both driven by `phase`. Boarding is a 200 ms fade-and-collapse at the door position, so it
depends on nothing the bus model does.

**Why not skinned glTF, plainly:** `InstancedMesh` does not skin, so hundreds of animated riders
means vertex-animation textures — a float texture per clip, against a 600 KB transferred total, to
animate something 4 px tall. The door it leaves open is the station view alone: 120 instances, one
`walk` clip, ≤ 20 bones, revisited only if a playtest says the diorama looks dead. Rigs in supplied
files are accepted and stripped with a warning; > 20 bones is rejected so that door stays open.

**What happens when a supplied model misses, in three tiers** — actionable by a person, because the
owner supplies these:

- **Rejected at bake, build fails, message names the file and the number:** not `.glb`; > 2× the
  triangle budget; texture > 1024² or non-power-of-two; file > 2× the byte cap; missing a required
  material slot; not metres / Y-up / +Z-forward / origin at ground-centre of footprint; contains
  cameras or lights.
- **Auto-fixed with a warning:** triangles between 1× and 2× budget → `meshoptimizer` simplify to
  budget; uncompressed geometry → meshopt-encoded; PNG/JPG → KTX2; unused UV sets and vertex
  attributes stripped.
- **Accepted with a warning:** > 8 materials, > 60 nodes, unnamed animation clips.

**People add three reject rules of their own**, because each is a thing instancing cannot survive:
any texture at all (rejected outright, not auto-converted to KTX2); vertex colours present and not
uniformly white (the pipeline owns `COLOR_0`); a skin with > 20 bones. Longest bounding-box axis is
expected in **1.0–2.2 m** — a seated figure is ~1.3 m, a standing one ~1.75 m. A rig within 20 bones
is *auto-fixed*: stripped, with a warning naming the clips lost.

---

## 5. Asset pipeline

1. **Author externally** (any DCC), export `.glb`, glTF 2.0 binary, one model per file.
2. **Drop into `studio/assets/incoming/<category>/<name>.glb`** — the existing intake folder and its
   documented convention. Nothing under `studio/` ships; this is a staging area only.
3. **`npm run models`** validates against §4, optimises via `gltf-transform` (dedup → prune → weld →
   meshopt → KTX2), writes `public/assets/models/<category>/<name>.glb`, and generates
   `src/render/three/modelManifest.ts` (name → path, bytes, triangles, content hash). A test asserts
   every manifest entry is inside budget, so the budget cannot rot silently.
   **`people` is a fifth category** alongside `vehicles`, `depots`, `stops`, `buildings`, and it is
   the only one with extra pipeline stages: merge the five named slots into one material and bake the
   slot index into `COLOR_0`; generate the 200-tri LOD1 into the same `.glb` as a second primitive;
   strip any skin. The manifest gains `lod1Triangles` and `maxInstances` per category, and the
   manifest test asserts **`maxInstances × lod1Triangles ≤ crowdTriangleAllowance`** — the crowd
   budget is a product, so checking the per-model number alone would let the cap rot instead.
4. **Served** from `assets/` next to `index.html`, same origin, no third-party fetch. Filenames are
   stable; the content hash lives in the manifest and drives the service-worker revision.
5. **Precached** by extending `vite-plugin-pwa`'s `workbox.globPatterns` with
   `'assets/models/**/*.glb'` and `'assets/textures/**/*.ktx2'`, `maximumFileSizeToCacheInBytes`
   2 MB. Second load works with the cable pulled, verified by cutting the network (DECISIONS #34),
   not by checking a registration. The waiting-worker behaviour of DECISIONS #33 is unchanged.
6. **Meshopt, not Draco** — the decoder is ~5 KB and bundles inline; Draco's fetches a wasm blob at
   runtime, which the offline constraint forbids.
7. **A rejection is written to be acted on, not decoded.** Four parts, in order: the file and the
   measured number, the budget it missed, *why that budget is what it is*, and the concrete next
   move. The third part is the one that stops the same file coming back:

   ```
   people/commuter_a.glb — 3,180 triangles. Budget 600 (rejected above 1,200).
   People are instanced up to 240 at once, so every triangle here is spent 240
   times: 3,180 tris = 763,000 on screen, against 48,000 for the entire fleet.
   Fix: decimate to ~600 — 6-sided limbs, no fingers, no face, no hair shell.
   ```

   The texture rejection says the same thing in its own terms: *"a person carries no texture; colour
   comes from the `Skin`/`Top`/`Bottom` slots at runtime, one palette for the whole crowd."*

---

## 6. Load order (pillar 4)

| t | State |
|---|---|
| 0 s | HTML + JS parsed. **Zero `.glb` requests issued.** |
| ~0.3 s | City generated from seed; ground, water, parks, roads, mask, route ribbons, stops rendered. |
| ~0.5 s | Input live. Pan, zoom, place a stop, draw a line. Buildings are instanced procedural prisms — no assets. **Buses are running.** |
| 2.0 s *or* first player input, whichever is sooner | Model loading starts, 2 concurrent fetches, low priority. |
| ~5 s cold / ~1.2 s warm | Vehicle and stop-furniture models have swapped in. |

**A bus before its model loads** is a 12.0 × 2.6 × 3.2 m rounded box in the company brand colour with
the line stripe down its centreline, correctly sized, oriented and outlined — it passes the contrast
gate on its own merits and is a bus you can plan around. When the model arrives it **cross-fades
material opacity over 250 ms at a frame boundary**; position, bearing and screen footprint are
identical before and after, because the sim owns all three. No scale pop, no reposition.

**Asserted, not hoped:** a test fails if any `.glb` request is issued before the first frame
containing a moving bus. If a model 404s or fails to decode, the placeholder is permanent for the
session, one toast through the error bus, and nothing else changes.

---

## 7. What the Canvas renderer's five causes become

1. **Fixed marker px, no zoom scaling** — *survives, worse.* A true-scale bus shrinks with distance
   and has no floor at all. Fix: per-frame world-scale multiplier `max(1, minPx / projectedPx)`
   targeting a **30 px** major-axis footprint (the same number that finally worked), capped at 8×
   exaggeration. Asserted on the id buffer, not on the constant.
2. **Fill with no stroke** — *survives, transformed.* Vehicles and stop markers get a screen-space
   outline from the id buffer, **1.5 px** at a 30 px footprint, in `--ink`. Same job as the 2D stroke:
   separating an object from whatever it sits on.
3. **Mount-time zoom race against a transitional rect** — *survives unchanged, plus a new sibling
   (`devicePixelRatio`).* The camera is never framed until a `ResizeObserver` reports a stable
   non-zero rect on two consecutive frames; `frameCity()` refuses any rect with an axis < 16 px and
   re-frames on every resize and DPR change.
4. **Camouflage against the route line** — *survives, harder, because lighting moves colours.* Keep
   the structural rule from DECISIONS #24 (bus body on the `muted→amber` axis no road or route can
   reach) **and** verify it in rendered pixels at both lighting extremes. Structure plus measurement;
   neither alone is enough now.
5. **Letterboxed contain-fit** — *evaporates in its old form* (the ground always fills the frustum)
   *and returns as void share*. Budgeted and asserted in §1 and §3.
6. **The sixth cause, from DECISIONS #60:** the property nobody asserted. Every item above has a
   rendered-pixel assertion, not an intent assertion. That is the actual carry-over.

**Also carried over:** the strict draw-order contract (mask last, above everything); one draw call per
class (now instanced); no allocation on the per-frame path; per-city derived data cached by object
identity; and `busPositionAt` staying a pure function of the game clock — the renderer asks, never
integrates.

---

## 8. Build order — the game runs after every step

1. **Flat WebGL parity.** Ground, water, parks, road ribbons, route ribbons, stop billboards, mask,
   night composite. Camera pitch locked at 0°, no yaw. Canvas renderer deleted; rendered-pixel
   contrast tests land here. *Looks like today's map, in WebGL.*
2. **Camera unlocked.** Pitch 0–60°, yaw, clamps, `zoomFloor`, `Home`, resize/DPR handling. *Same
   game, tiltable.*
3. **Procedural buildings.** Instanced extruded prisms, lighting envelope, shadow decals. No assets.
   *The city has volume — this alone satisfies §6.*
4. **Model pipeline + vehicles.** `npm run models`, manifest, SW precache, placeholder→model swap.
   Playable throughout by construction. *First `.glb` in the game.*
5. **Stop furniture and the §16 station view** as a second camera rig on the same scene graph, not a
   separate renderer.

**Failure and edge cases.** Context loss → rebuild the scene from state on `webglcontextrestored`,
placeholders first; the save is never touched. No WebGL2 → a one-line error card, no silent Canvas
fallback pretending to be the same product. Pause freezes vehicle motion but not the camera. Resize
and DPR change re-frame without changing zoom. Tab hidden → render loop parks at 0 fps, sim
unaffected. Spammed camera input is idempotent because every gesture writes absolute state.

**Cut line.** Drop step 5 and all shadow decals; lock the camera to pitch 0° and no yaw (keep zoom and
pan). Ship a top-down lit-buildings map with placeholder-shaped vehicles. That is still the whole
game, and every assertion in §3 still applies to it.
