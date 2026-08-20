/**
 * Procedural buildings — renderer-3d.md §8 step 3: "Instanced extruded prisms... No assets. The
 * city has volume — this alone satisfies §6." One `InstancedMesh`, one `MeshLambertMaterial` (lit,
 * per §2 — buildings are never a data layer), built once per city and never rebuilt on the
 * per-frame path.
 *
 * Height carries the demand signal (`Zone.jobs`/`residents`/`areaHa` — "a job-heavy core producing
 * taller massing is both free and correct, and it makes the demand model visible"). Placement is
 * deliberately sparse and set back from every road (and, transitively, every route ribbon, which
 * runs along the same road graph), park and water polygon, so massing never sits on top of the
 * network it is meant to be context for — the task's "must not fight the map."
 *
 * Coverage/height jitter use a pure integer hash, not `city/rng.ts`'s stateful PRNG — this module
 * has no dependency on generation order (a zone/lot pair always hashes to the same value regardless
 * of which other lots were rejected first), which keeps "same seed -> same city" exact without
 * threading a shared RNG stream through a loop whose iteration count varies per zone.
 */

import * as THREE from 'three';
import type { City, Polygon, RoadClass, Zone } from '../../game/types';
import type { LocalOrigin } from './localProjection';
import { toLocalXZ } from './localProjection';
import { getRenderCache } from '../cityIndex';
import { mixHex, type PaperPalette } from '../paperPalette';
import { BUILDING_COLOR_MIX_T, ROAD_WIDTH_M } from '../style';
import {
  BUILDING_COVERAGE_FRACTION,
  BUILDING_FOOTPRINT_FRACTION,
  BUILDING_HEIGHT_JITTER,
  BUILDING_HEIGHT_JOBS_WEIGHT,
  BUILDING_HEIGHT_RESIDENTS_WEIGHT,
  BUILDING_HEIGHT_SATURATION_PER_HA,
  BUILDING_LOT_PITCH_M,
  BUILDING_MAX_HEIGHT_M,
  BUILDING_MIN_HEIGHT_M,
  BUILDING_ROAD_SETBACK_M,
  Y_BUILDING_BASE,
} from './constants';

export interface BuildingLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
}

/** Unit box, base at y=0 (translated up by half so a per-instance Y-scale extrudes *up* from the
 * ground plane rather than growing from its own center) — the one geometry every instance shares. */
const UNIT_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
UNIT_BOX_GEOMETRY.translate(0, 0.5, 0);

// ── Deterministic per-lot hash (coverage decision, height jitter) ────────────────────────────────

function hash01(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ── Geometry helpers (all local-XZ, one-time build cost) ─────────────────────────────────────────

function polygonToLocalXZ(origin: LocalOrigin, polygon: Polygon): Array<[number, number]> {
  const scratch: [number, number] = [0, 0];
  return polygon.map((point) => {
    const [x, z] = toLocalXZ(origin, point, scratch);
    return [x, z] as [number, number];
  });
}

/** Standard ray-casting point-in-polygon test. */
function pointInPolygon(x: number, z: number, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!;
    const [xj, zj] = polygon[j]!;
    const crosses = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lenSq)) : 0;
  return Math.hypot(px - (ax + t * abx), pz - (az + t * abz));
}

// ── Road spatial hash (only roads need one — see this module's own doc comment for park/water
// polygon counts, small enough for a plain per-candidate scan) ───────────────────────────────────

const ROAD_BUCKET_SIZE_M = 60;
/** Defensive cap on how many buckets one edge is allowed to register into — a generation-time
 * safety net, not a tuned constant: every edge this game's own city generator ever produces spans
 * one grid block (well under this), but a future baked pack is not guaranteed to. */
const ROAD_BUCKET_SPAN_CAP = 50;

interface RoadSegment {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly halfWidthM: number;
}

function bucketKey(i: number, j: number): string {
  return `${i},${j}`;
}

function buildRoadSpatialHash(city: City, origin: LocalOrigin): Map<string, RoadSegment[]> {
  const cache = getRenderCache(city);
  const buckets = new Map<string, RoadSegment[]>();
  const scratchA: [number, number] = [0, 0];
  const scratchB: [number, number] = [0, 0];

  for (const edge of city.graph.edges) {
    const fromNode = cache.nodeIndex.get(edge.from);
    const toNode = cache.nodeIndex.get(edge.to);
    if (!fromNode || !toNode) continue;
    const [ax, az] = toLocalXZ(origin, fromNode.pos, scratchA);
    const [bx, bz] = toLocalXZ(origin, toNode.pos, scratchB);
    const segment: RoadSegment = { ax, az, bx, bz, halfWidthM: ROAD_WIDTH_M[edge.roadClass as RoadClass] / 2 };

    const minI = Math.floor(Math.min(ax, bx) / ROAD_BUCKET_SIZE_M);
    const maxI = Math.floor(Math.max(ax, bx) / ROAD_BUCKET_SIZE_M);
    const minJ = Math.floor(Math.min(az, bz) / ROAD_BUCKET_SIZE_M);
    const maxJ = Math.floor(Math.max(az, bz) / ROAD_BUCKET_SIZE_M);
    if (maxI - minI > ROAD_BUCKET_SPAN_CAP || maxJ - minJ > ROAD_BUCKET_SPAN_CAP) continue; // see doc above

    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const key = bucketKey(i, j);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = [];
          buckets.set(key, bucket);
        }
        bucket.push(segment);
      }
    }
  }
  return buckets;
}

/** Clearance (can be negative, meaning overlap) from `(x, z)` to the nearest road's own edge —
 * i.e. distance-to-centerline minus that road's half-width — searching only the 3x3 bucket
 * neighborhood around the point. */
function nearestRoadClearanceM(buckets: ReadonlyMap<string, RoadSegment[]>, x: number, z: number): number {
  const i = Math.floor(x / ROAD_BUCKET_SIZE_M);
  const j = Math.floor(z / ROAD_BUCKET_SIZE_M);
  let clearance = Infinity;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const bucket = buckets.get(bucketKey(i + di, j + dj));
      if (!bucket) continue;
      for (const segment of bucket) {
        const d = distanceToSegment(x, z, segment.ax, segment.az, segment.bx, segment.bz) - segment.halfWidthM;
        if (d < clearance) clearance = d;
      }
    }
  }
  return clearance;
}

// ── Height from zone demand ───────────────────────────────────────────────────────────────────

/** `BUILDING_MIN_HEIGHT_M` + `(MAX - MIN) * (1 - e^-(densityScore / SATURATION_PER_HA))` — a
 * saturating curve (never a hard clamp) so an extreme-density zone still tops out at the ceiling
 * smoothly rather than pancaking flat against it, while an ordinary zone still reads multi-story. */
function zoneBuildingHeightM(zone: Zone): number {
  const areaHa = Math.max(zone.areaHa, 0.01);
  const jobsPerHa = zone.jobs / areaHa;
  const residentsPerHa = zone.residents / areaHa;
  const densityScore = jobsPerHa * BUILDING_HEIGHT_JOBS_WEIGHT + residentsPerHa * BUILDING_HEIGHT_RESIDENTS_WEIGHT;
  const saturation = 1 - Math.exp(-densityScore / BUILDING_HEIGHT_SATURATION_PER_HA);
  return BUILDING_MIN_HEIGHT_M + (BUILDING_MAX_HEIGHT_M - BUILDING_MIN_HEIGHT_M) * saturation;
}

// ── Build ──────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  readonly x: number;
  readonly z: number;
  readonly heightM: number;
}

/** Builds the whole city's buildings as one `InstancedMesh` — `null` if the city has no zones (or
 * every candidate lot gets filtered out), so the caller can skip adding anything rather than adding
 * an empty mesh. Never throws for a well-formed `City`; `three/scene.ts` still wraps the call so a
 * malformed one degrades to "no buildings" instead of an unplayable scene. */
export function buildBuildingLayer(city: City, origin: LocalOrigin, palette: PaperPalette): BuildingLayer | null {
  const roadHash = buildRoadSpatialHash(city, origin);

  const blockingPolygons: Array<ReadonlyArray<[number, number]>> = [];
  for (const polygon of city.scenery.parks) blockingPolygons.push(polygonToLocalXZ(origin, polygon));
  for (const polygon of city.scenery.water) blockingPolygons.push(polygonToLocalXZ(origin, polygon));

  const footprintSideM = BUILDING_LOT_PITCH_M * BUILDING_FOOTPRINT_FRACTION;
  const half = footprintSideM / 2;
  const halfFootprintDiagonalM = half * Math.SQRT2;

  const candidates: Candidate[] = [];

  for (const zone of city.zones) {
    const localPolygon = polygonToLocalXZ(origin, zone.polygon);
    if (localPolygon.length < 3) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of localPolygon) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const zoneHeightM = zoneBuildingHeightM(zone);

    const iStart = Math.floor(minX / BUILDING_LOT_PITCH_M);
    const iEnd = Math.ceil(maxX / BUILDING_LOT_PITCH_M);
    const jStart = Math.floor(minZ / BUILDING_LOT_PITCH_M);
    const jEnd = Math.ceil(maxZ / BUILDING_LOT_PITCH_M);

    for (let i = iStart; i <= iEnd; i++) {
      for (let j = jStart; j <= jEnd; j++) {
        if (hash01(zone.id, i, j) >= BUILDING_COVERAGE_FRACTION) continue;

        const cx = (i + 0.5) * BUILDING_LOT_PITCH_M;
        const cz = (j + 0.5) * BUILDING_LOT_PITCH_M;

        // All four footprint corners, not just the center — a building's actual built extent must
        // stay inside the zone, not just its middle.
        if (
          !pointInPolygon(cx - half, cz - half, localPolygon) ||
          !pointInPolygon(cx + half, cz - half, localPolygon) ||
          !pointInPolygon(cx - half, cz + half, localPolygon) ||
          !pointInPolygon(cx + half, cz + half, localPolygon)
        ) {
          continue;
        }

        if (nearestRoadClearanceM(roadHash, cx, cz) < halfFootprintDiagonalM + BUILDING_ROAD_SETBACK_M) continue;

        let blocked = false;
        for (const polygon of blockingPolygons) {
          if (pointInPolygon(cx, cz, polygon)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        const jitter = 1 + (hash01(zone.id, i * 131 + 7, j * 197 + 13) * 2 - 1) * BUILDING_HEIGHT_JITTER;
        candidates.push({ x: cx, z: cz, heightM: Math.max(BUILDING_MIN_HEIGHT_M, zoneHeightM * jitter) });
      }
    }
  }

  if (candidates.length === 0) return null;

  const material = new THREE.MeshLambertMaterial({ color: mixHex(palette.paper, palette.muted, BUILDING_COLOR_MIX_T) });
  const mesh = new THREE.InstancedMesh(UNIT_BOX_GEOMETRY, material, candidates.length);
  mesh.matrixAutoUpdate = false;

  const matrix = new THREE.Matrix4();
  for (let i = 0; i < candidates.length; i++) {
    const { x, z, heightM } = candidates[i]!;
    matrix.makeScale(footprintSideM, heightM, footprintSideM);
    matrix.setPosition(x, Y_BUILDING_BASE, z);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();

  return { mesh, count: candidates.length };
}
