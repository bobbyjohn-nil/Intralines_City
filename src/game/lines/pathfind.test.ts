import { describe, expect, it } from 'vitest';
import { generateRiverton, RIVERTON_SEED } from '../city/generateRiverton';
import type { RoadEdge, RoadNode, StreetGraph } from '../types';
import { createPathfindContext, findPath } from './pathfind';

describe('findPath', () => {
  it('finds a path between two known-connected nodes with positive length', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const ctx = createPathfindContext(city.graph);
    const from = city.graph.nodes[0]!;
    const to = city.graph.nodes[city.graph.nodes.length - 1]!;

    const result = findPath(ctx, city.graph, from.id, to.id);

    expect(result).not.toBeNull();
    expect(result!.totalLengthM).toBeGreaterThan(0);
    expect(result!.totalTimeS).toBeGreaterThan(0);
    expect(result!.edgeIds.length).toBeGreaterThan(0);
  });

  it('is symmetric: A→B and B→A cover the same length', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const ctx = createPathfindContext(city.graph);
    const a = city.graph.nodes[0]!;
    const b = city.graph.nodes[city.graph.nodes.length - 1]!;

    const aToB = findPath(ctx, city.graph, a.id, b.id);
    const bToA = findPath(ctx, city.graph, b.id, a.id);

    expect(aToB).not.toBeNull();
    expect(bToA).not.toBeNull();
    expect(bToA!.totalLengthM).toBeCloseTo(aToB!.totalLengthM, 6);
    expect(bToA!.edgeIds.length).toBe(aToB!.edgeIds.length);
  });

  it('reuses the same context across many searches and still gets consistent answers', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const ctx = createPathfindContext(city.graph);
    const a = city.graph.nodes[0]!;
    const b = city.graph.nodes[10]!;

    const first = findPath(ctx, city.graph, a.id, b.id);
    // Run a handful of unrelated searches against the shared context in between.
    for (let i = 1; i < 5; i++) {
      findPath(ctx, city.graph, city.graph.nodes[i]!.id, city.graph.nodes[i + 5]!.id);
    }
    const second = findPath(ctx, city.graph, a.id, b.id);

    expect(second).not.toBeNull();
    expect(second!.totalLengthM).toBeCloseTo(first!.totalLengthM, 6);
  });

  it('returns null, not a throw, for an unroutable pair across disconnected components', () => {
    const disconnected = buildTwoIslandGraph();
    const ctx = createPathfindContext(disconnected);

    expect(() => findPath(ctx, disconnected, 0, 2)).not.toThrow();
    expect(findPath(ctx, disconnected, 0, 2)).toBeNull();
  });

  it('returns null for a node id that does not exist in the graph', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const ctx = createPathfindContext(city.graph);

    expect(findPath(ctx, city.graph, city.graph.nodes[0]!.id, -9999)).toBeNull();
  });

  it('returns a zero-length path when start and end are the same node', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const ctx = createPathfindContext(city.graph);
    const node = city.graph.nodes[3]!;

    const result = findPath(ctx, city.graph, node.id, node.id);

    expect(result).toEqual({ edgeIds: [], totalLengthM: 0, totalTimeS: 0 });
  });
});

/** Two two-node islands (0–1 and 2–3), no edge between them — a minimal fixture for the
 * unroutable case that doesn't rely on Riverton (which is always fully connected). */
function buildTwoIslandGraph(): StreetGraph {
  const nodes: RoadNode[] = [
    { id: 0, pos: [-89.4, 40.7] },
    { id: 1, pos: [-89.399, 40.7] },
    { id: 2, pos: [-89.3, 40.8] },
    { id: 3, pos: [-89.299, 40.8] },
  ];
  const edges: RoadEdge[] = [
    { id: 0, from: 0, to: 1, roadClass: 'residential', lengthM: 100 },
    { id: 1, from: 2, to: 3, roadClass: 'residential', lengthM: 100 },
  ];
  const adjacency = new Map<number, readonly number[]>([
    [0, [0]],
    [1, [0]],
    [2, [1]],
    [3, [1]],
  ]);
  return { nodes, edges, adjacency };
}
