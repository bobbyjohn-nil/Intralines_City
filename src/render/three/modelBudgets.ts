// Model budget — the single source of truth for §4 of studio/docs/design/renderer-3d.md.
//
// Shared by two consumers that must never disagree: `scripts/models/build.ts` (the pipeline that
// validates and optimises what the owner drops in studio/assets/incoming/) and
// `src/render/three/modelManifest.test.ts` (the regression test that asserts the checked-in
// manifest is still inside budget, so the budget cannot rot silently). Ships with the game because
// the manifest test lives under src/, but it is pure data — nothing here executes at play time.
//
// Numbers copied verbatim from renderer-3d.md §4. Read that file before changing any of them.

export type ModelCategory = "vehicles" | "depots" | "stops" | "buildings";

export interface CategoryBudget {
  /** Folder name under studio/assets/incoming/<category>/ and public/assets/models/<category>/. */
  category: ModelCategory;
  /** Human label matching the spec table's "Class" column. */
  label: string;
  /** Triangle ceiling per model. Reject tier fires above 2× this. */
  maxTriangles: number;
  /** Optimised .glb byte ceiling per model. Reject tier fires above 2× this. */
  maxBytes: number;
  /** Required named material slots — livery/recolour depends on these existing. */
  requiredMaterialSlots: readonly string[];
}

export const MODEL_BUDGETS: Record<ModelCategory, CategoryBudget> = {
  vehicles: {
    category: "vehicles",
    label: "Vehicle (5 models × Mk I–III)",
    maxTriangles: 4000,
    maxBytes: 45 * 1024,
    // renderer-3d.md §4: "Body, Stripe, Glass, Light_L, Light_R". Body + Stripe are the two that
    // livery recolour actually depends on (brand colour, line colour); the rest are optional detail
    // slots and are reported, not enforced, so a bus without headlight geometry isn't rejected.
    requiredMaterialSlots: ["Body", "Stripe"],
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
};

export const MODEL_CATEGORIES = Object.keys(MODEL_BUDGETS) as ModelCategory[];

/** Any single file, any category — renderer-3d.md §4 "Hard caps". */
export const HARD_CAP_FILE_BYTES = 120 * 1024;

/** Any texture, any category — renderer-3d.md §4 "Hard caps". */
export const HARD_CAP_TEXTURE_DIMENSION = 1024;

/** Total public/assets/models + public/assets/textures, on disk. */
export const TOTAL_BUDGET_DISK_BYTES = 900 * 1024;

/** Total public/assets/models + public/assets/textures, gzip-transferred. */
export const TOTAL_BUDGET_TRANSFERRED_BYTES = 600 * 1024;

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
};

export const ORDER_OF_MAGNITUDE = 10;

/** Origin tolerance for "pivot at floor centre of footprint" — renderer-3d.md §4 reject tier. */
export const ORIGIN_HEIGHT_TOLERANCE_M = 0.05;
export const ORIGIN_HORIZONTAL_TOLERANCE_FRACTION = 0.1;

/** Accepted-with-a-warning tier thresholds. */
export const WARN_MAX_MATERIALS = 8;
export const WARN_MAX_NODES = 60;
