import { describe, expect, it } from 'vitest';
import { generateRiverton, RIVERTON_SEED } from './generateRiverton';

describe('generateRiverton', () => {
  it('is deterministic: the same seed produces a byte-identical city', () => {
    const a = generateRiverton(RIVERTON_SEED);
    const b = generateRiverton(RIVERTON_SEED);
    expect(a).toEqual(b);
  });

  it('produces a different city for a different seed', () => {
    const a = generateRiverton(RIVERTON_SEED);
    const b = generateRiverton(RIVERTON_SEED + 1);
    expect(a).not.toEqual(b);
  });

  it('produces a fully connected street graph', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const { nodes, edges, adjacency } = city.graph;
    expect(nodes.length).toBeGreaterThan(0);

    const edgeById = new Map(edges.map((e) => [e.id, e]));
    const visited = new Set<number>([nodes[0]!.id]);
    const stack: number[] = [nodes[0]!.id];

    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const edgeId of adjacency.get(current) ?? []) {
        const edge = edgeById.get(edgeId);
        if (!edge) continue;
        const other = edge.from === current ? edge.to : edge.from;
        if (!visited.has(other)) {
          visited.add(other);
          stack.push(other);
        }
      }
    }

    expect(visited.size).toBe(nodes.length);
  });

  it('gives every edge a positive length', () => {
    const city = generateRiverton(RIVERTON_SEED);
    for (const edge of city.graph.edges) {
      expect(edge.lengthM).toBeGreaterThan(0);
    }
  });

  it('has every edge endpoint present in the node list', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const nodeIds = new Set(city.graph.nodes.map((n) => n.id));
    for (const edge of city.graph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });

  it('gives every node an entry in the adjacency map', () => {
    const city = generateRiverton(RIVERTON_SEED);
    for (const node of city.graph.nodes) {
      expect(city.graph.adjacency.has(node.id)).toBe(true);
    }
  });

  it('uses a mix of road classes, mostly residential', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const counts = new Map<string, number>();
    for (const edge of city.graph.edges) {
      counts.set(edge.roadClass, (counts.get(edge.roadClass) ?? 0) + 1);
    }
    expect(counts.get('primary')).toBeGreaterThan(0);
    expect((counts.get('secondary') ?? 0) + (counts.get('tertiary') ?? 0)).toBeGreaterThan(0);
    expect(counts.get('residential')).toBeGreaterThan(0);
    const residentialShare = (counts.get('residential') ?? 0) / city.graph.edges.length;
    expect(residentialShare).toBeGreaterThan(0.4);
  });

  it('includes a river and at least two parks', () => {
    const city = generateRiverton(RIVERTON_SEED);
    expect(city.scenery.water.length).toBeGreaterThanOrEqual(1);
    expect(city.scenery.parks.length).toBeGreaterThanOrEqual(2);
    expect(city.scenery.parks.length).toBeLessThanOrEqual(4);
    for (const poly of [...city.scenery.water, ...city.scenery.parks]) {
      expect(poly.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('reports the seed it was generated from', () => {
    const city = generateRiverton(RIVERTON_SEED);
    expect(city.seed).toBe(RIVERTON_SEED);
  });
});
