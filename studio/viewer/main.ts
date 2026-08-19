// Standalone model viewer — renderer-3d.md deliverable 2.
//
// Loads one .glb (from disk, or one already processed into public/assets/models/) and renders it
// at 1 unit = 1 metre under the exact lighting envelope §6 specifies, so the owner can judge a
// model without waiting for the game renderer to exist. Never imports from src/render/ (the
// Canvas 2D renderer) or src/game/ — the only game-side import is the two static, ship-safe data
// modules under src/render/three/ (the budget table and the generated manifest), which is what
// keeps this tool from disagreeing with the pipeline about what "in budget" means.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { MODEL_BUDGETS, type ModelCategory } from "../../src/render/three/modelBudgets";
import { modelManifest } from "../../src/render/three/modelManifest";

// ---- renderer-3d.md §6 lighting model — a contract, not a look ------------------------------

const PALETTE = {
  paper: 0xf6f1e1,
  muted: 0x7a7259,
  key: 0xfff8e8,
};

// HemisphereLight has one intensity shared by both colours (three.js interpolates between the two
// supplied colours by surface normal, then scales by a single intensity). The spec gives sky and
// ground different intensities (0.55 / 0.25), which isn't directly expressible that way, so each
// colour is pre-scaled by its own intensity here and the light's own intensity left at 1 — a face
// pointing straight up still lands on paper×0.55, straight down on muted×0.25, exactly as spec'd,
// and everything between blends proportionally. Flagged in the task report as the one genuinely
// ambiguous instruction in §6.
function scaledColor(hex: number, intensity: number): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(intensity);
}

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false; // §3/§6: no shadow maps, ground-shadow decals only in-game.

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.paper);

// §1: perspective, 30° vertical FOV — the same camera the game uses, so "map scale" here means
// what it will mean in the renderer.
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 500);
camera.position.set(8, 6, 10);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.update();

const hemi = new THREE.HemisphereLight(
  scaledColor(PALETTE.paper, 0.55),
  scaledColor(PALETTE.muted, 0.25),
  1,
);
scene.add(hemi);

const key = new THREE.DirectionalLight(PALETTE.key, 0.45);
// Elevation clamped ≥25° (§6). No clock in a standalone viewer, so this is a fixed stand-in
// roughly mid-morning — 45° elevation, comfortably above the floor, azimuth arbitrary.
const elevationRad = THREE.MathUtils.degToRad(45);
const azimuthRad = THREE.MathUtils.degToRad(35);
key.position.set(
  Math.cos(azimuthRad) * Math.cos(elevationRad),
  Math.sin(elevationRad),
  Math.sin(azimuthRad) * Math.cos(elevationRad),
).multiplyScalar(20);
scene.add(key);

// ---- reference geometry: always in frame, always correct, so a scale error is obvious ---------

const grid = new THREE.GridHelper(20, 20, 0x2c2a24, 0xcfc7ae);
scene.add(grid);

const refCubeGeo = new THREE.BoxGeometry(1, 1, 1);
const refCubeEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(refCubeGeo),
  new THREE.LineBasicMaterial({ color: 0xc94f35 }),
);
refCubeEdges.position.set(-3, 0.5, -3);
scene.add(refCubeEdges);
const refCubeLabel = document.createElement("div");
refCubeLabel.textContent = "1 m³ reference cube";

// ---- loaders ------------------------------------------------------------------------------

const ktx2Loader = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(renderer);
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.setKTX2Loader(ktx2Loader);

let current: THREE.Object3D | null = null;

interface LoadedStats {
  fileName: string;
  bytes: number;
  triangles: number;
  size: THREE.Vector3;
  materialSlots: string[];
}

function countTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as THREE.Mesh).isMesh) return;
    const geom = mesh.geometry;
    if (!geom) return;
    const index = geom.getIndex();
    const count = index ? index.count : (geom.getAttribute("position")?.count ?? 0);
    total += count / 3;
  });
  return Math.round(total);
}

function collectMaterialSlots(root: THREE.Object3D): string[] {
  const names = new Set<string>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m?.name) names.add(m.name);
    }
  });
  return [...names].sort();
}

function frameCamera(size: THREE.Vector3, center: THREE.Vector3): void {
  const radius = Math.max(size.x, size.y, size.z, 0.5) * 0.5;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const distance = (radius * 1.6) / Math.tan(fovRad / 2);
  camera.position.set(center.x + distance * 0.6, center.y + distance * 0.45, center.z + distance * 0.6);
  controls.target.copy(center);
  controls.update();
}

async function loadFromUrl(url: string, fileName: string, bytes: number): Promise<void> {
  const gltf = await loader.loadAsync(url);
  if (current) {
    scene.remove(current);
  }
  current = gltf.scene;
  scene.add(current);

  const box = new THREE.Box3().setFromObject(current);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  frameCamera(size, center);

  const stats: LoadedStats = {
    fileName,
    bytes,
    triangles: countTriangles(current),
    size,
    materialSlots: collectMaterialSlots(current),
  };
  renderStats(stats);
}

async function loadFile(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    await loadFromUrl(url, file.name, file.size);
  } catch (err) {
    renderError(file.name, err as Error);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- stats panel ----------------------------------------------------------------------------

const statsEl = document.getElementById("stats")!;
const categorySelect = document.getElementById("category-select") as HTMLSelectElement;

function currentCategory(): ModelCategory {
  return categorySelect.value as ModelCategory;
}

function renderError(fileName: string, err: Error): void {
  statsEl.innerHTML = `<p class="empty" style="color:#c94f35">${fileName}: failed to load — ${err.message}</p>`;
}

function renderStats(stats: LoadedStats): void {
  const budget = MODEL_BUDGETS[currentCategory()];
  const trisOk = stats.triangles <= budget.maxTriangles;
  const bytesOk = stats.bytes <= budget.maxBytes;
  const slotRows = budget.requiredMaterialSlots
    .map((slot) => {
      const has = stats.materialSlots.includes(slot);
      return `<span class="slot-chip${has ? "" : " slot-missing"}">${slot}${has ? "" : " (missing)"}</span>`;
    })
    .join("");
  const otherSlots = stats.materialSlots
    .filter((s) => !budget.requiredMaterialSlots.includes(s))
    .map((s) => `<span class="slot-chip">${s}</span>`)
    .join("");

  statsEl.innerHTML = `
    <dl>
      <dt>File</dt><dd>${stats.fileName}</dd>
      <dt>Size</dt><dd class="${bytesOk ? "pass" : "fail"}">${(stats.bytes / 1024).toFixed(1)} KB (budget ${(budget.maxBytes / 1024).toFixed(0)} KB)</dd>
      <dt>Triangles</dt><dd class="${trisOk ? "pass" : "fail"}">${stats.triangles.toLocaleString()} (budget ${budget.maxTriangles.toLocaleString()})</dd>
      <dt>Bounding box</dt><dd>${stats.size.x.toFixed(2)} × ${stats.size.y.toFixed(2)} × ${stats.size.z.toFixed(2)} m</dd>
      <dt>In budget</dt><dd class="${trisOk && bytesOk ? "pass" : "fail"}">${trisOk && bytesOk ? "yes" : "no"} — as "${budget.label}"</dd>
      <dt>Material slots</dt><dd class="slots">${slotRows}${otherSlots}${stats.materialSlots.length === 0 ? "(none named)" : ""}</dd>
    </dl>
  `;
}

// ---- UI wiring --------------------------------------------------------------------------------

const fileInput = document.getElementById("file-input") as HTMLInputElement;
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

const dropZone = document.getElementById("drop-zone")!;
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

categorySelect.addEventListener("change", () => {
  if (current) {
    // Re-render stats against the newly selected budget without reloading the model.
    const box = new THREE.Box3().setFromObject(current);
    const size = new THREE.Vector3();
    box.getSize(size);
    renderStats({
      fileName: statsEl.querySelector("dd")?.textContent ?? "(loaded model)",
      bytes: Number(fileInput.files?.[0]?.size ?? 0),
      triangles: countTriangles(current),
      size,
      materialSlots: collectMaterialSlots(current),
    });
  }
});

const processedListEl = document.getElementById("processed-list")!;
if (modelManifest.length === 0) {
  processedListEl.innerHTML = `<p class="empty">None yet — run "npm run models" after dropping a .glb in studio/assets/incoming/.</p>`;
} else {
  for (const entry of modelManifest) {
    const btn = document.createElement("button");
    btn.textContent = `${entry.category}/${entry.name}.glb (${(entry.bytes / 1024).toFixed(1)} KB, ${entry.triangles} tris)`;
    btn.addEventListener("click", () => {
      categorySelect.value = entry.category;
      void loadFromUrl(`/${entry.path}`, `${entry.name}.glb`, entry.bytes);
    });
    processedListEl.appendChild(btn);
  }
}

// ---- render loop + resize --------------------------------------------------------------------

function resize(): void {
  const viewport = document.getElementById("viewport")!;
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
