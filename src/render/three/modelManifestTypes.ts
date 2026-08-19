// Hand-written type for the generated manifest — kept separate from modelManifest.ts itself
// because that file is overwritten wholesale by `npm run models` (scripts/models/build.ts) on
// every run and should not carry anything the codegen doesn't own.

import type { ModelCategory } from "./modelBudgets";

export interface ModelManifestEntry {
  /** File stem, e.g. "metro-40-mk1". */
  name: string;
  category: ModelCategory;
  /** Served path, relative to the site root, e.g. "assets/models/vehicles/metro-40-mk1.glb". */
  path: string;
  /** Optimised .glb size on disk, in bytes. */
  bytes: number;
  triangles: number;
  /** First 16 hex chars of a SHA-256 of the optimised file's contents — drives SW revisioning. */
  hash: string;
  /** Named material slots found on the optimised model (e.g. ["Body", "Stripe", "Glass"]). */
  materialSlots: string[];
}
