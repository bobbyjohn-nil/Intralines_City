// Small console-report helpers for `npm run models`. Kept separate from build.ts so the
// human-facing formatting is easy to scan on its own — the validator's output is for the owner
// authoring models, not a machine, per the task brief.

export interface ModelReport {
  file: string; // "vehicles/metro-40-mk1.glb", relative to studio/assets/incoming/
  errors: string[]; // reject tier — build fails if any file has one
  warnings: string[]; // auto-fixed or accepted-with-a-warning tier
  info: string[]; // measured facts, always printed, pass or fail
  accepted: boolean;
}

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function color(code: string, s: string): string {
  return process.stdout.isTTY ? `${code}${s}${RESET}` : s;
}

export function printReport(report: ModelReport): void {
  const header = report.accepted
    ? color(GREEN, `✓ ${report.file}`)
    : color(RED, `✗ ${report.file}`);
  console.log(`\n${header}`);
  for (const line of report.info) {
    console.log(`  ${color(DIM, "·")} ${line}`);
  }
  for (const line of report.warnings) {
    console.log(`  ${color(YELLOW, "⚠")} ${line}`);
  }
  for (const line of report.errors) {
    console.log(`  ${color(RED, "✗")} ${line}`);
  }
}

export function printSummary(reports: ModelReport[]): void {
  const accepted = reports.filter((r) => r.accepted).length;
  const rejected = reports.length - accepted;
  const warned = reports.filter((r) => r.accepted && r.warnings.length > 0).length;
  console.log(`\n${color(BOLD, "models:")} ${reports.length} found, ${accepted} written${warned > 0 ? ` (${warned} with warnings)` : ""}, ${rejected} rejected.`);
}
