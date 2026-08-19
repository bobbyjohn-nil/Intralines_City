import { describe, expect, it } from "vitest";

import { modelManifest } from "./modelManifest";
import { HARD_CAP_FILE_BYTES, MODEL_BUDGETS, TOTAL_BUDGET_DISK_BYTES } from "./modelBudgets";

// renderer-3d.md §5: "A test asserts every manifest entry is inside budget, so the budget cannot
// rot silently." This runs against whatever `npm run models` last generated, not against the
// pipeline's own logic — it is the independent check that the checked-in output still obeys §4
// even if someone hand-edits the manifest or the pipeline regresses.

describe("modelManifest budget", () => {
  it("has zero entries today (no models supplied yet) — not an error", () => {
    // Deliberately not `toHaveLength(0)`: this test's job is to stay true as entries are added,
    // not to gate the count. This assertion documents current state; the per-entry checks below
    // are what actually enforce the budget once models exist.
    expect(Array.isArray(modelManifest)).toBe(true);
  });

  it.each(modelManifest)(
    "$category/$name.glb is inside budget",
    (entry) => {
      const budget = MODEL_BUDGETS[entry.category];
      expect(budget, `unknown category "${entry.category}"`).toBeDefined();

      expect(
        entry.triangles,
        `${entry.category}/${entry.name}.glb: ${entry.triangles} triangles, budget ${budget.maxTriangles}`,
      ).toBeLessThanOrEqual(budget.maxTriangles);

      expect(
        entry.bytes,
        `${entry.category}/${entry.name}.glb: ${entry.bytes} bytes, per-category cap ${budget.maxBytes}`,
      ).toBeLessThanOrEqual(budget.maxBytes);

      expect(
        entry.bytes,
        `${entry.category}/${entry.name}.glb: ${entry.bytes} bytes, hard cap ${HARD_CAP_FILE_BYTES}`,
      ).toBeLessThanOrEqual(HARD_CAP_FILE_BYTES);

      if (budget.requiredMaterialSlots.length > 0) {
        for (const slot of budget.requiredMaterialSlots) {
          expect(
            entry.materialSlots,
            `${entry.category}/${entry.name}.glb: missing required material slot "${slot}"`,
          ).toContain(slot);
        }
      }
    },
  );

  it("total manifest size is inside the on-disk budget", () => {
    const totalBytes = modelManifest.reduce((sum, entry) => sum + entry.bytes, 0);
    // TOTAL_BUDGET_DISK_BYTES covers public/assets/models + public/assets/textures; the manifest
    // only tracks models, so this is a lower bound on the real total, but it can never pass while
    // the models alone already blow the budget.
    expect(totalBytes).toBeLessThanOrEqual(TOTAL_BUDGET_DISK_BYTES);
  });
});
