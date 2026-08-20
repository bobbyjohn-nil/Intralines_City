// Model budget — the single source of truth for §4 of studio/docs/design/renderer-3d.md.
//
// Shared by two consumers that must never disagree: `scripts/models/build.ts` (the pipeline that
// validates and optimises what the owner drops in studio/assets/incoming/) and
// `src/render/three/modelManifest.test.ts` (the regression test that asserts the checked-in
// manifest is still inside budget, so the budget cannot rot silently). Ships with the game because
// the manifest test lives under src/, but it is pure data — nothing here executes at play time.
//
// Numbers copied verbatim from renderer-3d.md §4. Read that file before changing any of them.

export type ModelCategory = "vehicles" | "depots" | "stops" | "buildings" | "people";

/**
 * §4 "Three assertions": `maxConcurrent × lod1Triangles ≤ classAllowance`, checked per scene
 * context that the spec publishes numbers for (a class can have more than one — people are
 * checked once for the map crowd, against LOD1, and once for the station crowd, against LOD0).
 * This is a static invariant on the *budget config itself*, not on any supplied file — it exists
 * so raising a per-model triangle number can't silently blow the on-screen triangle cost.
 */
export interface ClassProductCheck {
  /** e.g. "map fleet (LOD1)", "station crowd (LOD0)". */
  label: string;
  maxConcurrent: number;
  triangles: number;
  classAllowance: number;
}

export interface CategoryBudget {
  /** Folder name under studio/assets/incoming/<category>/ and public/assets/models/<category>/. */
  category: ModelCategory;
  /** Human label matching the spec table's "Class" column. */
  label: string;
  /** Triangle ceiling per model (LOD0, owner-authored). Reject tier fires above 2× this. */
  maxTriangles: number;
  /** Optimised .glb byte ceiling per model. Reject tier fires above 2× this. */
  maxBytes: number;
  /** Required named material slots — livery/recolour depends on these existing. */
  requiredMaterialSlots: readonly string[];
  /** Named slots reported if present but not enforced — renderer-3d.md §4 People: Hair, Bag. */
  optionalMaterialSlots?: readonly string[];
  /**
   * Reject threshold for skin joint count. §4 People: "a skin with > 20 bones" is a reject rule
   * of its own — distinct from every other rig-handling rule in this file, which is auto-fix. A
   * rig within the limit is still stripped (v1 riders are static poses; instancing doesn't skin),
   * but with a warning, not a rejection — the bone cap exists only to keep the door open for the
   * station-view exception §4 names, not because v1 uses it.
   */
  maxBones?: number;
  /** Triangle ceiling for the pipeline-generated (or owner-supplied `<name>_lod1`) low mesh. */
  lod1MaxTriangles?: number;
  classProductChecks?: readonly ClassProductCheck[];
}

export const MODEL_BUDGETS: Record<ModelCategory, CategoryBudget> = {
  vehicles: {
    category: "vehicles",
    label: "Vehicle (5 models × Mk I–III)",
    // NOTE: §4's re-derivation moved the vehicle LOD0/byte ceilings to 6,000 tris / 80 KB (from
    // 4,000 / 45 KB) as part of the whole-budget re-derivation this task's brief does not cover —
    // this task's scope is the People gap plus the two new cross-class assertions below, and
    // touching the vehicle per-file ceiling is out of scope here (see task report). Left as-is
    // deliberately; flag to whoever picks up the vehicle re-derivation.
    maxTriangles: 4000,
    maxBytes: 45 * 1024,
    // renderer-3d.md §4: "Body, Stripe, Glass, Light_L, Light_R". Body + Stripe are the two that
    // livery recolour actually depends on (brand colour, line colour); the rest are optional detail
    // slots and are reported, not enforced, so a bus without headlight geometry isn't rejected.
    requiredMaterialSlots: ["Body", "Stripe"],
    lod1MaxTriangles: 900,
    classProductChecks: [{ label: "map fleet (LOD1)", maxConcurrent: 60, triangles: 900, classAllowance: 60_000 }],
  },
  depots: {
    category: "depots",
    label: "Depot (3 levels)",
    maxTriangles: 6000,
    maxBytes: 60 * 1024,
    requiredMaterialSlots: [],
  },
  stops: {
    category: "stops",
    label: "Stop furniture (5 tiers)",
    maxTriangles: 2500,
    maxBytes: 30 * 1024,
    requiredMaterialSlots: [],
  },
  buildings: {
    category: "buildings",
    label: "Building/landmark kit piece",
    maxTriangles: 1500,
    maxBytes: 20 * 1024,
    requiredMaterialSlots: [],
  },
  people: {
    category: "people",
    label: "Person (3 poses + 1 spare)",
    // renderer-3d.md §4 People: "one mesh per pose at ≤ 600 tris"; the pipeline generates (or
    // accepts a supplied) 200-tri LOD1. Bytes: "600 + 200 tris is ~9 KB, so the cap is 12 KB".
    maxTriangles: 600,
    maxBytes: 12 * 1024,
    // "The owner authors five named material slots — Skin, Top, Bottom required, Hair, Bag
    // optional". Not Body/Stripe: a person has no livery, variation is per-instance palette.
    requiredMaterialSlots: ["Skin", "Top", "Bottom"],
    optionalMaterialSlots: ["Hair", "Bag"],
    // "Rigs in supplied files are accepted and stripped with a warning; > 20 bones is rejected".
    maxBones: 20,
    lod1MaxTriangles: 200,
    classProductChecks: [
      { label: "map crowd (LOD1)", maxConcurrent: 240, triangles: 200, classAllowance: 48_000 },
      { label: "station crowd (LOD0)", maxConcurrent: 120, triangles: 600, classAllowance: 72_000 },
    ],
  },
};

export const MODEL_CATEGORIES = Object.keys(MODEL_BUDGETS) as ModelCategory[];

/** Any single file, any category — renderer-3d.md §4 "Hard caps". */
export const HARD_CAP_FILE_BYTES = 120 * 1024;

/** Any texture, any category — renderer-3d.md §4 "Hard caps". */
export const HARD_CAP_TEXTURE_DIMENSION = 1024;

// renderer-3d.md §4 "Hard caps", re-derived: "220.3 KiB of critical path + 670 KB of assets ≈
// 890 KB of first run" — 720/670 replaces the old 900/600 pair, which "implied 33% compression"
// that meshopt geometry (~5–10%) doesn't deliver. This is also the cap the new "per total"
// assertion in build.ts checks Σ manifest bytes against.

/** Total public/assets/models + public/assets/textures, on disk. */
export const TOTAL_BUDGET_DISK_BYTES = 720 * 1024;

/** Total public/assets/models + public/assets/textures, gzip-transferred. */
export const TOTAL_BUDGET_TRANSFERRED_BYTES = 670 * 1024;

/**
 * "Flag anything an order of magnitude off" (task brief) for the 1-unit-=-1-metre convention.
 * Expected longest-axis bounding-box range per category, in metres. A model whose longest bbox
 * axis falls outside `[min / ORDER_OF_MAGNITUDE, max * ORDER_OF_MAGNITUDE]` is almost always an
 * exporter that left the scene in centimetres, not an unusual design.
 */
export const EXPECTED_SIZE_METRES: Record<ModelCategory, { min: number; max: number }> = {
  vehicles: { min: 5, max: 20 }, // a Metro 40 is ~12 m
  depots: { min: 10, max: 60 },
  stops: { min: 0.5, max: 6 },
  buildings: { min: 2, max: 40 },
  // renderer-3d.md §4 People: "a seated figure is ~1.3 m, a standing one ~1.75 m".
  people: { min: 1.0, max: 2.2 },
};

export const ORDER_OF_MAGNITUDE = 10;

/** Origin tolerance for "pivot at floor centre of footprint" — renderer-3d.md §4 reject tier. */
export const ORIGIN_HEIGHT_TOLERANCE_M = 0.05;
export const ORIGIN_HORIZONTAL_TOLERANCE_FRACTION = 0.1;

/** Accepted-with-a-warning tier thresholds. */
export const WARN_MAX_MATERIALS = 8;
export const WARN_MAX_NODES = 60;

/**
 * §4 "Three assertions... Per class product, new": `maxConcurrent × lod1Triangles ≤
 * classAllowance`, "so the on-screen cost cannot rot when someone raises a per-model number".
 * A pure predicate over the budget config itself (not over any supplied file), shared by the
 * pipeline (`scripts/models/build.ts`, fails the build before touching any file) and the
 * regression test (`modelManifest.test.ts`) so they can't drift — same reasoning as
 * requiredMaterialSlots above.
 */
export function classProductViolations(): string[] {
  const violations: string[] = [];
  for (const budget of Object.values(MODEL_BUDGETS)) {
    for (const check of budget.classProductChecks ?? []) {
      const product = check.maxConcurrent * check.triangles;
      if (product > check.classAllowance) {
        violations.push(
          `${budget.category} "${check.label}": ${check.maxConcurrent} × ${check.triangles.toLocaleString()} = ${product.toLocaleString()} triangles, exceeds the ${check.classAllowance.toLocaleString()} class allowance (renderer-3d.md §4) — lower maxConcurrent or the LOD triangle count, or raise the allowance deliberately in the spec first.`,
        );
      }
    }
  }
  return violations;
}
