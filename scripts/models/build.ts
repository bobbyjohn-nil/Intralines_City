#!/usr/bin/env node
// `npm run models` — renderer-3d.md §5, the asset pipeline.
//
// Reads every .glb under studio/assets/incoming/<category>/, validates it against §4's budget,
// optimises it (dedup → prune → weld → [simplify if over budget] → meshopt → KTX2), writes the
// result to public/assets/models/<category>/<name>.glb, and regenerates
// src/render/three/modelManifest.ts.
//
// Zero models present is today's state and is not an error (§5 point 2: "Nothing under studio/
// ships; this is a staging area only.") — the script exits 0 with an empty manifest.
//
// This file is CREW tooling (studio-owned), not shipped game code — see CLAUDE.md's repository
// layout. It imports two small modules from src/render/three/ (modelBudgets.ts,
// modelManifestTypes.ts) because those are the single source of truth the game-side regression
// test (modelManifest.test.ts) also reads; duplicating the numbers would let them drift.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { Document, NodeIO, type Node as GltfNode } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRLightsPunctual } from "@gltf-transform/extensions";
import {
  dedup,
  getBounds,
  getGLPrimitiveCount,
  prune,
  simplify,
  weld,
  meshopt,
} from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";

import {
  classProductViolations,
  EXPECTED_SIZE_METRES,
  HARD_CAP_FILE_BYTES,
  HARD_CAP_TEXTURE_DIMENSION,
  MODEL_BUDGETS,
  MODEL_CATEGORIES,
  ORDER_OF_MAGNITUDE,
  ORIGIN_HEIGHT_TOLERANCE_M,
  ORIGIN_HORIZONTAL_TOLERANCE_FRACTION,
  TOTAL_BUDGET_DISK_BYTES,
  TOTAL_BUDGET_TRANSFERRED_BYTES,
  WARN_MAX_MATERIALS,
  WARN_MAX_NODES,
  type ModelCategory,
} from "../../src/render/three/modelBudgets";
import type { ModelManifestEntry } from "../../src/render/three/modelManifestTypes";
import { printReport, printSummary, type ModelReport } from "./report";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const INCOMING_DIR = join(ROOT, "studio", "assets", "incoming");
const OUTPUT_DIR = join(ROOT, "public", "assets", "models");
const MANIFEST_PATH = join(ROOT, "src", "render", "three", "modelManifest.ts");

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function discoverFiles(): { category: ModelCategory; name: string; path: string }[] {
  const found: { category: ModelCategory; name: string; path: string }[] = [];
  for (const category of MODEL_CATEGORIES) {
    const dir = join(INCOMING_DIR, category);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isFile()) continue;
      if (entry.startsWith(".")) continue;
      // README.md lives inside people/ (intake guidance) same as the top-level one below — not a
      // model, never treated as one.
      if (entry === "README.md") continue;
      const dot = entry.lastIndexOf(".");
      const name = dot === -1 ? entry : entry.slice(0, dot);
      found.push({ category, name, path: full });
    }
  }
  // Also flag anything dropped directly under studio/assets/incoming/ or in a category we don't
  // recognise, so a typo'd folder name doesn't silently vanish.
  if (existsSync(INCOMING_DIR)) {
    for (const entry of readdirSync(INCOMING_DIR)) {
      const full = join(INCOMING_DIR, entry);
      if (entry === "README.md" || entry.startsWith(".")) continue;
      if (statSync(full).isDirectory()) {
        if (!(MODEL_CATEGORIES as string[]).includes(entry)) {
          console.warn(
            `⚠ studio/assets/incoming/${entry}/ is not a recognised category (expected one of: ${MODEL_CATEGORIES.join(", ")}) — its contents were skipped.`,
          );
        }
      } else {
        console.warn(
          `⚠ studio/assets/incoming/${entry} sits outside a category folder — move it into studio/assets/incoming/<category>/ (${MODEL_CATEGORIES.join(", ")}).`,
        );
      }
    }
  }
  return found;
}

function countTriangles(doc: Document): number {
  const scene = doc.getRoot().listScenes()[0];
  if (!scene) return 0;
  let total = 0;
  scene.traverse((node: GltfNode) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    for (const prim of mesh.listPrimitives()) {
      total += getGLPrimitiveCount(prim);
    }
  });
  return total;
}

function hasLights(doc: Document): boolean {
  return doc
    .getRoot()
    .listExtensionsUsed()
    .some((ext) => ext.extensionName === KHRLightsPunctual.EXTENSION_NAME);
}

function hasCameras(doc: Document): boolean {
  return doc.getRoot().listNodes().some((node) => node.getCamera() !== null);
}

const WHITE_TOLERANCE = 0.02;

/** §4 People reject rule: "vertex colours present and not uniformly white (the pipeline owns
 * COLOR_0 for the slot mask)". Uniformly-white COLOR_0 is harmless noise and is left alone; the
 * min/max normalized bounds are enough to prove uniformity without walking every vertex. */
function findNonWhiteVertexColors(doc: Document): string | null {
  const scene = doc.getRoot().listScenes()[0];
  if (!scene) return null;
  let found: string | null = null;
  scene.traverse((node: GltfNode) => {
    if (found) return;
    const mesh = node.getMesh();
    if (!mesh) return;
    for (const prim of mesh.listPrimitives()) {
      const color = prim.getAttribute("COLOR_0");
      if (!color) continue;
      const min = color.getMinNormalized([]);
      const max = color.getMaxNormalized([]);
      const isWhite = min.slice(0, 3).every((v) => Math.abs(v - 1) <= WHITE_TOLERANCE) && max.slice(0, 3).every((v) => Math.abs(v - 1) <= WHITE_TOLERANCE);
      if (!isWhite) {
        found = `vertex colours (COLOR_0) present and not uniformly white — min ${min.slice(0, 3).map((v) => v.toFixed(2)).join(",")}, max ${max.slice(0, 3).map((v) => v.toFixed(2)).join(",")}. The pipeline owns COLOR_0 for the per-instance palette slot mask; remove authored vertex colours before export.`;
      }
    }
  });
  return found;
}

/** Highest joint count across any skin in the file, or 0 if unrigged. */
function maxSkinJointCount(doc: Document): number {
  let max = 0;
  for (const skin of doc.getRoot().listSkins()) {
    max = Math.max(max, skin.listJoints().length);
  }
  return max;
}

/** §4 People: "Rigs in supplied files are accepted and stripped with a warning" — v1 riders are
 * static poses (instancing cannot skin), so any rig within the bone budget is removed rather than
 * shipped inert. Detaches every skin from its nodes and drops the JOINTS_0/WEIGHTS_0 attributes. */
function stripRig(doc: Document): void {
  for (const node of doc.getRoot().listNodes()) {
    if (node.getSkin()) node.setSkin(null);
  }
  for (const skin of doc.getRoot().listSkins()) {
    skin.dispose();
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of ["JOINTS_0", "WEIGHTS_0"]) {
        const attr = prim.getAttribute(semantic);
        if (attr) prim.setAttribute(semantic, null);
      }
    }
  }
}

/** §4: "the owner authors LOD0, the pipeline generates LOD1 (or uses a supplied `<name>_lod1` if
 * present)" — a named node alongside the LOD0 hierarchy, the same convention as `Mk2_Add`. Returns
 * its triangle count, or null if no such node exists. */
function suppliedLod1Triangles(doc: Document, name: string): number | null {
  const lod1Name = `${name}_lod1`;
  for (const node of doc.getRoot().listNodes()) {
    if (node.getName() !== lod1Name) continue;
    const mesh = node.getMesh();
    if (!mesh) return 0;
    let total = 0;
    for (const prim of mesh.listPrimitives()) {
      total += getGLPrimitiveCount(prim);
    }
    return total;
  }
  return null;
}

interface ValidationResult {
  errors: string[];
  warnings: string[];
  info: string[];
  needsSimplifyToTriangles: number | null;
  /** True if a within-budget skin was found and should be stripped before optimise(). */
  needsRigStrip: boolean;
}

function validateSource(doc: Document, category: ModelCategory, name: string): ValidationResult {
  const budget = MODEL_BUDGETS[category];
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  let needsSimplifyToTriangles: number | null = null;
  let needsRigStrip = false;

  // --- triangles ---
  const triangles = countTriangles(doc);
  info.push(`${triangles.toLocaleString()} triangles (budget ${budget.maxTriangles.toLocaleString()}, class "${budget.label}")`);
  if (triangles > budget.maxTriangles * 2) {
    errors.push(
      `${triangles.toLocaleString()} triangles, limit ${budget.maxTriangles.toLocaleString()} (reject threshold is 2×, ${(budget.maxTriangles * 2).toLocaleString()}) — decimate or reduce loop cuts before export.`,
    );
  } else if (triangles > budget.maxTriangles) {
    warnings.push(
      `${triangles.toLocaleString()} triangles over the ${budget.maxTriangles.toLocaleString()} budget — auto-decimating to fit.`,
    );
    needsSimplifyToTriangles = budget.maxTriangles;
  }

  // --- textures ---
  const textures = doc.getRoot().listTextures();
  for (const tex of textures) {
    const size = tex.getSize();
    const texName = tex.getName() || tex.getURI() || "(unnamed texture)";
    if (!size) continue;
    const [w, h] = size;
    info.push(`texture "${texName}": ${w}×${h}`);
    if (w > HARD_CAP_TEXTURE_DIMENSION || h > HARD_CAP_TEXTURE_DIMENSION) {
      errors.push(
        `texture "${texName}" is ${w}×${h}, limit ${HARD_CAP_TEXTURE_DIMENSION}×${HARD_CAP_TEXTURE_DIMENSION} — resize before export.`,
      );
    } else if (!isPowerOfTwo(w) || !isPowerOfTwo(h)) {
      errors.push(
        `texture "${texName}" is ${w}×${h}, not a power of two — resize to e.g. ${Math.pow(2, Math.round(Math.log2(w)))}×${Math.pow(2, Math.round(Math.log2(h)))} before export.`,
      );
    }
  }
  if (category === "vehicles" && textures.length > 0) {
    warnings.push(
      `${textures.length} texture(s) found on a vehicle model — renderer-3d.md §4: "vehicles carry no per-model texture", livery is a runtime recolour of named material slots. These textures will still be optimised, but consider re-exporting without them.`,
    );
  }
  // §4 People reject rule: unlike every other category, a texture on a person is rejected
  // outright, not converted to KTX2 — instancing means one shared material, and "a face at 10 px
  // is noise". This is stricter than the generic per-texture checks above on purpose.
  if (category === "people" && textures.length > 0) {
    errors.push(
      `${textures.length} texture(s) found — renderer-3d.md §4 People: "no texture of any kind (a person carries none — a face at 10 px is noise)". A person is drawn instanced with one shared material; variation comes from the per-instance palette (Skin/Top/Bottom/Hair/Bag slots), not a bake. Remove all textures and re-export.`,
    );
  }

  // --- material slots ---
  const materials = doc.getRoot().listMaterials();
  const materialNames = materials.map((m) => m.getName()).filter((n) => n.length > 0);
  info.push(`material slots: ${materialNames.length > 0 ? materialNames.join(", ") : "(none named)"}`);
  for (const required of budget.requiredMaterialSlots) {
    if (!materialNames.includes(required)) {
      errors.push(
        `missing required material slot "${required}" — livery recolour targets this slot by name; add a material named exactly "${required}" in the DCC before export. Found: ${materialNames.length > 0 ? materialNames.join(", ") : "(none)"}.`,
      );
    }
  }
  if (materials.length > WARN_MAX_MATERIALS) {
    warnings.push(`${materials.length} materials, more than the ${WARN_MAX_MATERIALS} advisory ceiling — accepted, but check whether they can merge.`);
  }
  if (budget.optionalMaterialSlots && budget.optionalMaterialSlots.length > 0) {
    const present = budget.optionalMaterialSlots.filter((s) => materialNames.includes(s));
    info.push(
      `optional material slots (${budget.optionalMaterialSlots.join(", ")}): ${present.length > 0 ? `${present.join(", ")} present` : "none present"}`,
    );
  }

  // --- vertex colours (people only: the pipeline owns COLOR_0 for the palette slot mask) ---
  if (category === "people") {
    const nonWhite = findNonWhiteVertexColors(doc);
    if (nonWhite) errors.push(nonWhite);
  }

  // --- rig / skin (people only: §4 "a skin with > 20 bones" rejects; within budget, strip) ---
  if (budget.maxBones !== undefined) {
    const jointCount = maxSkinJointCount(doc);
    if (jointCount > 0) {
      if (jointCount > budget.maxBones) {
        errors.push(
          `skin with ${jointCount} bones — limit ${budget.maxBones} (renderer-3d.md §4 People: "> 20 bones is rejected"). Instancing cannot skin more than a handful of joints affordably; reduce the rig or strip it and export static poses instead.`,
        );
      } else {
        info.push(`${jointCount}-bone skin found`);
        warnings.push(
          `${jointCount}-bone skin found and will be stripped — renderer-3d.md §4 People: "Animation is out of scope for this category in v1: static poses plus positional movement." The rig is accepted but removed; re-export static poses (stand/walk/sit) if animation wasn't intended, or note the clip names for the animator if it was.`,
        );
        needsRigStrip = true;
      }
    }
  }

  // --- LOD1 (owner-supplied `<name>_lod1`, or generation — see report) ---
  if (budget.lod1MaxTriangles !== undefined) {
    const lod1Triangles = suppliedLod1Triangles(doc, name);
    if (lod1Triangles === null) {
      warnings.push(
        `no LOD1 supplied and the pipeline does not yet generate one (renderer-3d.md §4: "the owner authors LOD0, the pipeline generates LOD1"). Shipping LOD0 only for now — this model pays LOD0 triangle cost (${budget.maxTriangles.toLocaleString()} max) at every distance until LOD1 generation lands. Supply a "${name}_lod1" node (≤ ${budget.lod1MaxTriangles.toLocaleString()} tris) to opt out of that early.`,
      );
    } else {
      info.push(`supplied LOD1 node "${name}_lod1": ${lod1Triangles.toLocaleString()} triangles (budget ${budget.lod1MaxTriangles.toLocaleString()})`);
      if (lod1Triangles > budget.lod1MaxTriangles) {
        warnings.push(
          `supplied LOD1 is ${lod1Triangles.toLocaleString()} triangles, over the ${budget.lod1MaxTriangles.toLocaleString()} ceiling — accepted, but this weakens the density argument the LOD exists for; reduce it.`,
        );
      }
    }
  }

  // --- nodes ---
  const nodeCount = doc.getRoot().listNodes().length;
  info.push(`${nodeCount} nodes`);
  if (nodeCount > WARN_MAX_NODES) {
    warnings.push(`${nodeCount} nodes, more than the ${WARN_MAX_NODES} advisory ceiling — accepted, but check for redundant empties/groups.`);
  }

  // --- animations ---
  const animations = doc.getRoot().listAnimations();
  if (animations.length > 0) {
    const unnamed = animations.filter((a) => !a.getName());
    info.push(`${animations.length} animation clip(s)${unnamed.length > 0 ? `, ${unnamed.length} unnamed` : ""}`);
    if (unnamed.length > 0) {
      warnings.push(`${unnamed.length} animation clip(s) have no name — accepted, but name clips so animator can address them.`);
    }
  }

  // --- cameras / lights ---
  if (hasCameras(doc)) {
    errors.push(`contains a camera node — remove any camera from the scene before export; the game supplies its own.`);
  }
  if (hasLights(doc)) {
    errors.push(`contains a light (KHR_lights_punctual) — remove scene lights before export; lighting is the renderer's, per §6.`);
  }

  // --- bounds: scale, origin ---
  const scene = doc.getRoot().listScenes()[0];
  if (scene) {
    const bounds = getBounds(scene);
    const size: [number, number, number] = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    const longest = Math.max(...size);
    info.push(
      `bounding box: ${size[0].toFixed(2)} × ${size[1].toFixed(2)} × ${size[2].toFixed(2)} m (X×Y×Z)`,
    );

    const expected = EXPECTED_SIZE_METRES[category];
    if (longest < expected.min / ORDER_OF_MAGNITUDE || longest > expected.max * ORDER_OF_MAGNITUDE) {
      errors.push(
        `longest dimension is ${longest.toFixed(2)} m; a "${budget.label}" is normally ${expected.min}–${expected.max} m — this is off by roughly an order of magnitude, almost always an exporter that left the scene in centimetres (scale by 0.01) or left an Apply Scale unapplied. Apply the scale transform and re-export at 1 unit = 1 metre.`,
      );
    }

    // Origin: floor centre of footprint. min.y ~ 0, and (x,z) centre ~ 0.
    const floorOffset = bounds.min[1];
    const floorTolerance = Math.max(ORIGIN_HEIGHT_TOLERANCE_M, size[1] * 0.02);
    if (Math.abs(floorOffset) > floorTolerance) {
      errors.push(
        `origin is not at floor level — lowest point of the mesh is ${floorOffset.toFixed(3)} m from y=0 (tolerance ±${floorTolerance.toFixed(3)} m). Move the pivot to the floor centre of the footprint and re-export.`,
      );
    }
    const centreX = (bounds.max[0] + bounds.min[0]) / 2;
    const centreZ = (bounds.max[2] + bounds.min[2]) / 2;
    const footprintDiagonal = Math.hypot(size[0], size[2]);
    const horizontalTolerance = Math.max(0.05, footprintDiagonal * ORIGIN_HORIZONTAL_TOLERANCE_FRACTION);
    const horizontalOffset = Math.hypot(centreX, centreZ);
    if (horizontalOffset > horizontalTolerance) {
      errors.push(
        `origin is not centred on the footprint — horizontal centre is ${horizontalOffset.toFixed(3)} m from x=0,z=0 (tolerance ±${horizontalTolerance.toFixed(3)} m). Centre the pivot on the footprint and re-export.`,
      );
    }

    // Y-up heuristic, vehicles only (see modelBudgets.ts / renderer-3d.md §4 "not ... Y-up"). A
    // bus is never taller than it is long; if it measures taller than its own horizontal footprint
    // the far more likely explanation is a Z-up export that didn't get converted on the way out.
    // Restricted to vehicles because "taller than wide" is legitimate for a lamp post or a tower
    // kit piece — see the ambiguity note in the final report.
    if (category === "vehicles" && size[1] > Math.max(size[0], size[2])) {
      errors.push(
        `model is taller (${size[1].toFixed(2)} m) than it is long or wide (${Math.max(size[0], size[2]).toFixed(2)} m) — a vehicle should never be taller than its footprint. This usually means the file exported Z-up instead of Y-up. Re-export with the Y-up / +Z-forward convention (most DCCs have a "convert axes" or "+Y up" export toggle for glTF).`,
      );
    }
  }

  return { errors, warnings, info, needsSimplifyToTriangles, needsRigStrip };
}

function findToktx(): boolean {
  try {
    execFileSync("toktx", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TOKTX_AVAILABLE = findToktx();
let toktxWarningPrinted = false;

async function optimise(doc: Document, needsSimplifyToTriangles: number | null, currentTriangles: number): Promise<void> {
  // keepUniqueNames: true is load-bearing. Livery recolour depends on the Body/Stripe (etc.)
  // material slots existing by name — without this, dedup() happily merges two materials that
  // are visually identical at authoring time (a common placeholder/greybox state, and not unheard
  // of for a real model before livery colours are baked) and silently deletes the "Stripe" name
  // along with it. Caught by generating a fixture with matching Body/Stripe colours during this
  // task — see the task report.
  await doc.transform(dedup({ keepUniqueNames: true }), prune(), weld());

  if (needsSimplifyToTriangles !== null && currentTriangles > 0) {
    await MeshoptSimplifier.ready;
    const ratio = Math.min(1, needsSimplifyToTriangles / currentTriangles);
    await doc.transform(
      simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: true }),
    );
  }

  await MeshoptEncoder.ready;
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));
}

/** Runs the CLI's `etc1s` KTX2 pass out of process (it shells out to the external `toktx` binary
 * itself). Returns the compressed bytes, or the input bytes unchanged with a one-time warning if
 * `toktx` isn't installed — texture-bearing models still get everything else (meshopt, dedup,
 * prune, weld); they just ship PNG/JPG until KTX-Software is available on the build machine. */
function ktx2Pass(glbBytes: Uint8Array<ArrayBufferLike>, label: string): Uint8Array<ArrayBufferLike> {
  if (!TOKTX_AVAILABLE) {
    if (!toktxWarningPrinted) {
      console.warn(
        `\n⚠ toktx not found on PATH — KTX2 texture compression is skipped for this run. Install KTX-Software (https://github.com/KhronosGroup/KTX-Software/releases) to enable it. Affected models ship PNG/JPG textures instead, which counts harder against the byte budget.`,
      );
      toktxWarningPrinted = true;
    }
    return glbBytes;
  }
  const tmp = mkdtempSync(join(tmpdir(), "intralines-models-"));
  const inPath = join(tmp, "in.glb");
  const outPath = join(tmp, "out.glb");
  try {
    writeFileSync(inPath, glbBytes);
    execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["--no-install", "gltf-transform", "etc1s", inPath, outPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return new Uint8Array(readFileSync(outPath));
  } catch (err) {
    console.warn(`⚠ ${label}: KTX2 pass failed (${(err as Error).message.split("\n")[0]}) — kept PNG/JPG textures.`);
    return glbBytes;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // §4 "Three assertions... Per class product, new": a config-level invariant, checked before any
  // file is touched (it exists precisely to catch someone raising a per-model number in
  // modelBudgets.ts without re-deriving the arithmetic, not to catch a bad supplied file).
  const productViolations = classProductViolations();
  if (productViolations.length > 0) {
    console.error(`\n✗ model budget config is inconsistent (renderer-3d.md §4 "maxConcurrent × lod1Triangles ≤ classAllowance"):`);
    for (const v of productViolations) {
      console.error(`  ✗ ${v}`);
    }
    process.exitCode = 1;
    return;
  }

  const files = discoverFiles();

  if (files.length === 0) {
    console.log("npm run models: no files under studio/assets/incoming/<category>/ — nothing to do.");
    writeManifest([]);
    console.log(`Wrote empty manifest to ${relativeToRoot(MANIFEST_PATH)}.`);
    return;
  }

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
      "meshopt.decoder": MeshoptDecoder,
    });
  await MeshoptDecoder.ready;

  const reports: ModelReport[] = [];
  const manifest: ModelManifestEntry[] = [];

  for (const file of files) {
    const relLabel = `${file.category}/${file.name}.glb`;
    const errors: string[] = [];
    const warnings: string[] = [];
    const info: string[] = [];

    if (!file.path.toLowerCase().endsWith(".glb")) {
      errors.push(
        `not a .glb file — renderer-3d.md requires glTF 2.0 binary, one file per model. Re-export from the DCC as .glb (not .gltf, .fbx, .obj or .blend).`,
      );
      const report: ModelReport = { file: relLabel, errors, warnings, info, accepted: false };
      reports.push(report);
      printReport(report);
      continue;
    }

    const sourceBytes = statSync(file.path).size;
    info.push(`source file: ${(sourceBytes / 1024).toFixed(1)} KB`);

    let doc: Document;
    try {
      doc = await io.read(file.path);
    } catch (err) {
      errors.push(`failed to parse as glTF 2.0 binary: ${(err as Error).message}`);
      const report: ModelReport = { file: relLabel, errors, warnings, info, accepted: false };
      reports.push(report);
      printReport(report);
      continue;
    }

    const validation = validateSource(doc, file.category, file.name);
    errors.push(...validation.errors);
    warnings.push(...validation.warnings);
    info.push(...validation.info);

    if (errors.length > 0) {
      const report: ModelReport = { file: relLabel, errors, warnings, info, accepted: false };
      reports.push(report);
      printReport(report);
      continue;
    }

    if (validation.needsRigStrip) {
      stripRig(doc);
    }

    const trianglesBefore = countTriangles(doc);
    await optimise(doc, validation.needsSimplifyToTriangles, trianglesBefore);
    const trianglesAfter = countTriangles(doc);
    if (validation.needsSimplifyToTriangles !== null) {
      info.push(`decimated ${trianglesBefore.toLocaleString()} → ${trianglesAfter.toLocaleString()} triangles`);
    }

    // Safety net, independent of dedup()'s keepUniqueNames option above: if optimisation ever
    // drops a required slot (a regression here, not something the owner did wrong), fail loudly
    // rather than ship a vehicle that silently can't be recoloured.
    const postOptimiseMaterialNames = doc.getRoot().listMaterials().map((m) => m.getName());
    for (const required of MODEL_BUDGETS[file.category].requiredMaterialSlots) {
      if (!postOptimiseMaterialNames.includes(required)) {
        errors.push(
          `internal: required material slot "${required}" survived pre-optimisation validation but was lost during optimisation — this is a pipeline bug, not a source-file problem. Report it rather than re-exporting.`,
        );
      }
    }
    if (errors.length > 0) {
      const report: ModelReport = { file: relLabel, errors, warnings, info, accepted: false };
      reports.push(report);
      printReport(report);
      continue;
    }

    let bytes: Uint8Array<ArrayBufferLike> = await io.writeBinary(doc);
    if (doc.getRoot().listTextures().length > 0) {
      bytes = ktx2Pass(bytes, relLabel);
    }

    const budget = MODEL_BUDGETS[file.category];
    if (bytes.byteLength > budget.maxBytes * 2 || bytes.byteLength > HARD_CAP_FILE_BYTES * 2) {
      errors.push(
        `optimised file is ${(bytes.byteLength / 1024).toFixed(1)} KB, limit ${(budget.maxBytes / 1024).toFixed(0)} KB for "${budget.label}" (reject threshold 2×, ${((budget.maxBytes * 2) / 1024).toFixed(0)} KB) — even after dedup/prune/weld/meshopt${TOKTX_AVAILABLE ? "/KTX2" : ""}. Reduce texture count/resolution or geometry detail and re-export.`,
      );
      const report: ModelReport = { file: relLabel, errors, warnings, info, accepted: false };
      reports.push(report);
      printReport(report);
      continue;
    }
    if (bytes.byteLength > budget.maxBytes) {
      warnings.push(
        `optimised file is ${(bytes.byteLength / 1024).toFixed(1)} KB, over the ${(budget.maxBytes / 1024).toFixed(0)} KB budget for "${budget.label}" but under the 2× reject threshold — accepted, but shrink it before this ships.`,
      );
    }
    if (bytes.byteLength > HARD_CAP_FILE_BYTES) {
      warnings.push(
        `optimised file is ${(bytes.byteLength / 1024).toFixed(1)} KB, over the ${(HARD_CAP_FILE_BYTES / 1024).toFixed(0)} KB hard cap for any single file — accepted, but shrink it before this ships.`,
      );
    }

    info.push(`optimised: ${(bytes.byteLength / 1024).toFixed(1)} KB (was ${(sourceBytes / 1024).toFixed(1)} KB source)`);

    // §4: "the 11.5 B/tri rate is not measured... npm run models must report measured bytes per
    // triangle per file." The planning rate was `45 KB ÷ 4,000 tris` read backwards; this is the
    // actual number, so the allowance can ratchet against evidence instead of arithmetic
    // circularity.
    if (trianglesAfter > 0) {
      const bytesPerTriangle = bytes.byteLength / trianglesAfter;
      info.push(`measured ${bytesPerTriangle.toFixed(1)} B/tri (planning rate assumed 11.5 — renderer-3d.md §4)`);
    }

    const outDir = join(OUTPUT_DIR, file.category);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${file.name}.glb`);
    writeFileSync(outPath, bytes);

    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const materialNames = doc.getRoot().listMaterials().map((m) => m.getName()).filter((n) => n.length > 0);

    manifest.push({
      name: file.name,
      category: file.category,
      path: `assets/models/${file.category}/${file.name}.glb`,
      bytes: bytes.byteLength,
      triangles: trianglesAfter,
      hash,
      materialSlots: materialNames,
    });

    const report: ModelReport = { file: relLabel, errors, warnings, info, accepted: true };
    reports.push(report);
    printReport(report);
  }

  writeManifest(manifest);
  printSummary(reports);

  const totalDisk = manifest.reduce((sum, m) => sum + m.bytes, 0);
  const totalGzip = manifest.reduce((sum, m) => sum + gzipSync(readFileSync(join(ROOT, "public", m.path))).byteLength, 0);
  console.log(
    `assets/models total: ${(totalDisk / 1024).toFixed(1)} KB on disk (budget ${(TOTAL_BUDGET_DISK_BYTES / 1024).toFixed(0)} KB), ~${(totalGzip / 1024).toFixed(1)} KB gzipped (budget ${(TOTAL_BUDGET_TRANSFERRED_BYTES / 1024).toFixed(0)} KB).`,
  );
  const overTotalDisk = totalDisk > TOTAL_BUDGET_DISK_BYTES;
  const overTotalGzip = totalGzip > TOTAL_BUDGET_TRANSFERRED_BYTES;
  if (overTotalDisk || overTotalGzip) {
    // §4 "Per total, new... failing the build with the ledger printed" — a per-file sum, so print
    // the sum, worst offender first.
    console.error(`\n✗ total shipped size exceeds budget — ledger (${manifest.length} model${manifest.length === 1 ? "" : "s"}, largest first):`);
    const bySize = [...manifest].sort((a, b) => b.bytes - a.bytes);
    for (const entry of bySize) {
      console.error(`  ${(entry.bytes / 1024).toFixed(1).padStart(7)} KB  ${entry.category}/${entry.name}.glb`);
    }
    if (overTotalDisk) {
      console.error(`✗ total on-disk size ${(totalDisk / 1024).toFixed(1)} KB exceeds the ${(TOTAL_BUDGET_DISK_BYTES / 1024).toFixed(0)} KB budget.`);
    }
    if (overTotalGzip) {
      console.error(`✗ total gzip-transferred size ${(totalGzip / 1024).toFixed(1)} KB exceeds the ${(TOTAL_BUDGET_TRANSFERRED_BYTES / 1024).toFixed(0)} KB budget.`);
    }
  }

  const anyRejected = reports.some((r) => !r.accepted);
  if (anyRejected || overTotalDisk || overTotalGzip) {
    process.exitCode = 1;
  }
}

function relativeToRoot(p: string): string {
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
}

function writeManifest(entries: ModelManifestEntry[]): void {
  const sorted = [...entries].sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
  const body = sorted
    .map(
      (e) =>
        `  {\n    name: ${JSON.stringify(e.name)},\n    category: ${JSON.stringify(e.category)},\n    path: ${JSON.stringify(e.path)},\n    bytes: ${e.bytes},\n    triangles: ${e.triangles},\n    hash: ${JSON.stringify(e.hash)},\n    materialSlots: ${JSON.stringify(e.materialSlots)},\n  },`,
    )
    .join("\n");
  const contents = `// GENERATED FILE — do not edit by hand. Written by \`npm run models\` (scripts/models/build.ts) from
// whatever currently exists under public/assets/models/. Re-run the script instead of editing this.
//
// Empty by design when studio/assets/incoming/ holds no models yet — that is today's state (see
// renderer-3d.md §5) and is not an error.

import type { ModelManifestEntry } from "./modelManifestTypes";

export const modelManifest: ModelManifestEntry[] = [
${body}
];
`;
  writeFileSync(MANIFEST_PATH, contents);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
