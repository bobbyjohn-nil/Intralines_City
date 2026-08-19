#!/usr/bin/env node
// Copies the KTX2 transcoder that `three` already ships from node_modules into public/basis/, so
// it is never committed to git. See .gitattributes' Git LFS header for why that matters, and
// studio/docs/design/renderer-3d.md §5 for the pipeline this transcoder serves.
//
// public/basis/ is .gitignore'd and rebuilt by this script every time — before `dev`, `build`, and
// `viewer` (see package.json). That means the vendored copy always matches the installed `three`
// version exactly; there is no vendored-file-drifts-from-installed-library class of bug to have.
//
// Source: node_modules/three/examples/jsm/libs/basis/{basis_transcoder.js,basis_transcoder.wasm}
// Destination: public/basis/ — same two filenames. Referenced by
// studio/viewer/main.ts's `new KTX2Loader().setTranscoderPath("/basis/")`, and by the game's own
// KTX2Loader the same way once textured models ship.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_DIR = join(ROOT, "node_modules", "three", "examples", "jsm", "libs", "basis");
const DEST_DIR = join(ROOT, "public", "basis");
const FILES = ["basis_transcoder.js", "basis_transcoder.wasm"];

let ok = true;
for (const file of FILES) {
  const src = join(SRC_DIR, file);
  if (!existsSync(src)) {
    console.error(
      `vendor-basis: ${src} not found — is "three" installed (npm ci / npm install)? The KTX2 ` +
        `transcoder ships inside the three package at examples/jsm/libs/basis/.`,
    );
    ok = false;
    continue;
  }
  mkdirSync(DEST_DIR, { recursive: true });
  copyFileSync(src, join(DEST_DIR, file));
}

if (!ok) {
  process.exitCode = 1;
} else {
  const sizes = FILES.map((f) => `${f} (${(statSync(join(DEST_DIR, f)).size / 1024).toFixed(1)} KB)`);
  console.log(`vendor-basis: copied into public/basis/: ${sizes.join(", ")}.`);
}
