/**
 * Shortest-path search over a `StreetGraph`, weighted by travel time (`lengthM` ÷ the edge's
 * class speed) rather than raw distance — a short residential block and a short motorway
 * shoulder are not equally fast, and a bus line should prefer the fast one.
 *
 * Dijkstra with a binary min-heap (no naive O(n²) scan). Per `studio/GAME.md`'s hard
 * constraint that the sim stay portable to WASM: this is pure (a `StreetGraph` and two node
 * ids in, a result or `null` out, no hidden mutation of the graph itself), uses flat typed
 * arrays for every per-node quantity, and never allocates inside the search loop — the scratch
 * buffers live in a `PathfindContext` the caller creates once and reuses across many searches
 * (e.g. once per stop added to a line draft).
 */

import type { RoadEdge, StreetGraph } from '../types';
import { ROAD_SPEED_KMH } from '../constants';

const KMH_TO_MS = 1000 / 3600;

/** No edges beat "not found" — a shared empty array instead of allocating `[]` on every miss. */
const EMPTY_EDGE_IDS: readonly number[] = [];

export interface RouteResult {
  /** Edges from the start node to the end node, in travel order. Empty if start === end. */
  readonly edgeIds: readonly number[];
  readonly totalLengthM: number;
  /** Total travel time at each edge's class speed, seconds. */
  readonly totalTimeS: number;
}

/**
 * Reusable scratch space for one `StreetGraph`. Every per-node array is sized once, at
 * creation, to the node count — never resized or reallocated by a search. Create one per
 * graph and pass it to every `findPath` call against that graph; a fresh context is only
 * needed for a different graph (e.g. a different city).
 */
export interface PathfindContext {
  readonly nodeCount: number;
  /** Node id → dense array index. `RoadNode.id` need not be contiguous or sorted. */
  readonly nodeIndexById: ReadonlyMap<number, number>;
  /** Array index → node id, the inverse of `nodeIndexById`. */
  readonly nodeIds: readonly number[];
  readonly edgeById: ReadonlyMap<number, RoadEdge>;
  /** Best known travel time (seconds) to reach the node at this index, by node index. */
  readonly travelTimeS: Float64Array;
  readonly visited: Uint8Array;
  /** Edge id used to reach the node at this index, or -1 if none yet. */
  readonly cameFromEdge: Int32Array;
  /** Predecessor node index, or -1 if none yet. */
  readonly cameFromNode: Int32Array;
  /** Binary min-heap of node indices, ordered by `travelTimeS`. */
  readonly heapNodes: Int32Array;
  /** Node index → its position in `heapNodes`, or -1 if it isn't currently in the heap. */
  readonly heapPos: Int32Array;
  /** Number of live entries in `heapNodes`. Mutated by the heap ops; not `readonly` like the
   * arrays above because, unlike them, the count itself (not just its contents) changes. */
  heapSize: number;
}

/** Builds the scratch buffers for `graph`. O(nodes + edges) once; reuse the result. */
export function createPathfindContext(graph: StreetGraph): PathfindContext {
  const nodeCount = graph.nodes.length;
  const nodeIndexById = new Map<number, number>();
  const nodeIds = new Array<number>(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const node = graph.nodes[i];
    if (node === undefined) continue;
    nodeIndexById.set(node.id, i);
    nodeIds[i] = node.id;
  }

  const edgeById = new Map<number, RoadEdge>();
  for (const edge of graph.edges) edgeById.set(edge.id, edge);

  return {
    nodeCount,
    nodeIndexById,
    nodeIds,
    edgeById,
    travelTimeS: new Float64Array(nodeCount),
    visited: new Uint8Array(nodeCount),
    cameFromEdge: new Int32Array(nodeCount),
    cameFromNode: new Int32Array(nodeCount),
    heapNodes: new Int32Array(nodeCount),
    heapPos: new Int32Array(nodeCount),
    heapSize: 0,
  };
}

/** Travel time to cross `edge` at its road class's free-flow speed, seconds. The one shared
 * formula for edge cost — draft round-trip estimates should derive from distance and a bus's
 * own cruise speed instead, since that's a different question ("how long does the timetable
 * say") from this one ("which streets are fastest"). */
export function edgeTravelTimeS(edge: RoadEdge): number {
  const speedMs = ROAD_SPEED_KMH[edge.roadClass] * KMH_TO_MS;
  return edge.lengthM / speedMs;
}

function resetContext(ctx: PathfindContext): void {
  ctx.travelTimeS.fill(Infinity);
  ctx.visited.fill(0);
  ctx.cameFromEdge.fill(-1);
  ctx.cameFromNode.fill(-1);
  ctx.heapPos.fill(-1);
  ctx.heapSize = 0;
}

function heapSwap(ctx: PathfindContext, i: number, j: number): void {
  const a = ctx.heapNodes[i];
  const b = ctx.heapNodes[j];
  if (a === undefined || b === undefined) return;
  ctx.heapNodes[i] = b;
  ctx.heapNodes[j] = a;
  ctx.heapPos[a] = j;
  ctx.heapPos[b] = i;
}

function heapSiftUp(ctx: PathfindContext, start: number): void {
  let i = start;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const iNode = ctx.heapNodes[i];
    const parentNode = ctx.heapNodes[parent];
    if (iNode === undefined || parentNode === undefined) return;
    if (ctx.travelTimeS[parentNode]! <= ctx.travelTimeS[iNode]!) break;
    heapSwap(ctx, i, parent);
    i = parent;
  }
}

function heapSiftDown(ctx: PathfindContext, start: number): void {
  let i = start;
  for (;;) {
    const left = i * 2 + 1;
    const right = i * 2 + 2;
    let smallest = i;

    const smallestNode = ctx.heapNodes[smallest];
    if (smallestNode === undefined) return;
    let smallestTime = ctx.travelTimeS[smallestNode]!;

    if (left < ctx.heapSize) {
      const leftNode = ctx.heapNodes[left]!;
      const leftTime = ctx.travelTimeS[leftNode]!;
      if (leftTime < smallestTime) {
        smallest = left;
        smallestTime = leftTime;
      }
    }
    if (right < ctx.heapSize) {
      const rightNode = ctx.heapNodes[right]!;
      const rightTime = ctx.travelTimeS[rightNode]!;
      if (rightTime < smallestTime) {
        smallest = right;
      }
    }
    if (smallest === i) break;
    heapSwap(ctx, i, smallest);
    i = smallest;
  }
}

function heapPush(ctx: PathfindContext, nodeIdx: number): void {
  const i = ctx.heapSize++;
  ctx.heapNodes[i] = nodeIdx;
  ctx.heapPos[nodeIdx] = i;
  heapSiftUp(ctx, i);
}

function heapPopMin(ctx: PathfindContext): number {
  const top = ctx.heapNodes[0]!;
  const last = ctx.heapNodes[--ctx.heapSize]!;
  ctx.heapNodes[0] = last;
  ctx.heapPos[last] = 0;
  ctx.heapPos[top] = -1;
  if (ctx.heapSize > 0) heapSiftDown(ctx, 0);
  return top;
}

/** Decreases (or, if the node isn't in the heap yet, sets) the key backing `nodeIdx`'s heap
 * position. Dijkstra only ever improves a distance, so this never needs to *increase* a key. */
function heapDecreaseKey(ctx: PathfindContext, nodeIdx: number): void {
  const pos = ctx.heapPos[nodeIdx];
  if (pos === undefined || pos === -1) {
    heapPush(ctx, nodeIdx);
  } else {
    heapSiftUp(ctx, pos);
  }
}

/**
 * Shortest path from `fromNodeId` to `toNodeId` by travel time. Returns `null` — never
 * throws — if either id isn't in the graph or no route connects them. `ctx` must have been
 * built from `graph` (or an equivalent graph with the same node ids); reuse it across calls.
 */
export function findPath(
  ctx: PathfindContext,
  graph: StreetGraph,
  fromNodeId: number,
  toNodeId: number
): RouteResult | null {
  const fromIdx = ctx.nodeIndexById.get(fromNodeId);
  const toIdx = ctx.nodeIndexById.get(toNodeId);
  if (fromIdx === undefined || toIdx === undefined) return null;
  if (fromIdx === toIdx) return { edgeIds: EMPTY_EDGE_IDS, totalLengthM: 0, totalTimeS: 0 };

  resetContext(ctx);
  ctx.travelTimeS[fromIdx] = 0;
  heapPush(ctx, fromIdx);

  while (ctx.heapSize > 0) {
    const currentIdx = heapPopMin(ctx);
    if (ctx.visited[currentIdx]) continue; // stale heap entry from an earlier, worse decrease-key
    ctx.visited[currentIdx] = 1;
    if (currentIdx === toIdx) break;

    const currentId = ctx.nodeIds[currentIdx];
    if (currentId === undefined) continue;
    const incidentEdgeIds = graph.adjacency.get(currentId) ?? EMPTY_EDGE_IDS;

    for (let k = 0; k < incidentEdgeIds.length; k++) {
      const edgeId = incidentEdgeIds[k];
      if (edgeId === undefined) continue;
      const edge = ctx.edgeById.get(edgeId);
      if (edge === undefined) continue;

      const otherId = edge.from === currentId ? edge.to : edge.from;
      const otherIdx = ctx.nodeIndexById.get(otherId);
      if (otherIdx === undefined || ctx.visited[otherIdx]) continue;

      const candidate = ctx.travelTimeS[currentIdx]! + edgeTravelTimeS(edge);
      if (candidate < ctx.travelTimeS[otherIdx]!) {
        ctx.travelTimeS[otherIdx] = candidate;
        ctx.cameFromEdge[otherIdx] = edge.id;
        ctx.cameFromNode[otherIdx] = currentIdx;
        heapDecreaseKey(ctx, otherIdx);
      }
    }
  }

  if (!ctx.visited[toIdx]) return null;

  const edgeIds: number[] = [];
  let totalLengthM = 0;
  let cursor = toIdx;
  while (cursor !== fromIdx) {
    const edgeId = ctx.cameFromEdge[cursor];
    if (edgeId === undefined || edgeId === -1) return null; // shouldn't happen once visited, but never throw
    const edge = ctx.edgeById.get(edgeId);
    if (edge === undefined) return null;
    edgeIds.push(edgeId);
    totalLengthM += edge.lengthM;
    const prev = ctx.cameFromNode[cursor];
    if (prev === undefined || prev === -1) return null;
    cursor = prev;
  }
  edgeIds.reverse();

  return { edgeIds, totalLengthM, totalTimeS: ctx.travelTimeS[toIdx]! };
}
