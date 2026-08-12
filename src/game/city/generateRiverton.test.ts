import { describe, expect, it } from 'vitest';
import { generateRiverton, RIVERTON_SEED } from './generateRiverton';
import type { LngLat, Polygon } from '../types';

// ── Shared geometry helpers ──────────────────────────────────────────────────
// Self-contained (deliberately not importing from `lines/geo.ts` or similar) — these tests are
// meant to check the generator's own output from the outside, the way a downstream consumer
// would, not to share implementation with the thing they're verifying.

/** True if segment p1-p2 properly crosses segment p3-p4. */
function segmentsCross(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat): boolean {
  const cross = (a: LngLat, b: LngLat, c: LngLat): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  const straddles1 = (d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0);
  const straddles2 = (d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0);
  return straddles1 && straddles2;
}

/** Number of times segment p1-p2 crosses the boundary of a closed ring. A segment that cleanly
 * cuts through a thin polygon (like the river) crosses its boundary exactly twice: once in,
 * once out. */
function crossingCount(p1: LngLat, p2: LngLat, ring: Polygon): number {
  let hits = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    if (segmentsCross(p1, p2, a, b)) hits++;
  }
  return hits;
}

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

  it('includes a river and 3-5 parks', () => {
    const city = generateRiverton(RIVERTON_SEED);
    expect(city.scenery.water.length).toBeGreaterThanOrEqual(1);
    expect(city.scenery.parks.length).toBeGreaterThanOrEqual(3);
    expect(city.scenery.parks.length).toBeLessThanOrEqual(5);
    for (const poly of [...city.scenery.water, ...city.scenery.parks]) {
      expect(poly.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('reports the seed it was generated from', () => {
    const city = generateRiverton(RIVERTON_SEED);
    expect(city.seed).toBe(RIVERTON_SEED);
  });

  // ── Layout structure ────────────────────────────────────────────────────

  it('has uniform block spacing: residential (plain grid) edges cluster tightly around one length', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const lengths = city.graph.edges.filter((e) => e.roadClass === 'residential').map((e) => e.lengthM);
    expect(lengths.length).toBeGreaterThan(0);

    const mean = lengths.reduce((sum, v) => sum + v, 0) / lengths.length;
    // A normal city block, per the spec's 120-160m target.
    expect(mean).toBeGreaterThan(100);
    expect(mean).toBeLessThan(180);

    // Almost every residential edge is a plain, untouched grid block; only the handful the
    // diagonal avenue slices through deviate from the block size.
    const withinFivePercent = lengths.filter((v) => Math.abs(v - mean) < mean * 0.05);
    expect(withinFivePercent.length / lengths.length).toBeGreaterThan(0.9);

    const variance = withinFivePercent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / withinFivePercent.length;
    expect(Math.sqrt(variance)).toBeLessThan(mean * 0.01);
  });

  it('connects the two riverbanks only at a handful of explicit bridges', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const ring = city.scenery.water[0]!;
    const nodeById = new Map(city.graph.nodes.map((n) => [n.id, n]));

    let bridgeCount = 0;
    for (const edge of city.graph.edges) {
      const from = nodeById.get(edge.from)!;
      const to = nodeById.get(edge.to)!;
      // A bridge cleanly cuts across the (thin, elongated) river polygon: it crosses the
      // ring's boundary twice — once entering, once leaving. An embankment road running
      // alongside the bank doesn't cross the ring at all.
      if (crossingCount(from.pos, to.pos, ring) >= 2) bridgeCount++;
    }

    expect(bridgeCount).toBeGreaterThanOrEqual(3);
    expect(bridgeCount).toBeLessThanOrEqual(5);
  });

  it('keeps both riverbanks reachable from each other', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const ring = city.scenery.water[0]!;
    const ringLats = ring.map(([, lat]) => lat);
    const riverMinLat = Math.min(...ringLats);
    const riverMaxLat = Math.max(...ringLats);

    const southNode = city.graph.nodes.find((n) => n.pos[1] < riverMinLat - 0.001);
    const northNode = city.graph.nodes.find((n) => n.pos[1] > riverMaxLat + 0.001);
    expect(southNode).toBeDefined();
    expect(northNode).toBeDefined();

    const edgeById = new Map(city.graph.edges.map((e) => [e.id, e]));
    const visited = new Set<number>([southNode!.id]);
    const stack: number[] = [southNode!.id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const edgeId of city.graph.adjacency.get(current) ?? []) {
        const edge = edgeById.get(edgeId);
        if (!edge) continue;
        const other = edge.from === current ? edge.to : edge.from;
        if (!visited.has(other)) {
          visited.add(other);
          stack.push(other);
        }
      }
    }

    expect(visited.has(northNode!.id)).toBe(true);
  });

  it('cuts a diagonal avenue across the grid, not just axis-aligned streets', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const nodeById = new Map(city.graph.nodes.map((n) => [n.id, n]));

    const diagonalEdges = city.graph.edges.filter((edge) => {
      if (edge.roadClass !== 'primary') return false;
      const from = nodeById.get(edge.from)!;
      const to = nodeById.get(edge.to)!;
      const dx = Math.abs(to.pos[0] - from.pos[0]);
      const dy = Math.abs(to.pos[1] - from.pos[1]);
      if (dx < 1e-12 || dy < 1e-12) return false; // axis-aligned street
      const ratio = dx / dy;
      return ratio > 0.05 && ratio < 20; // meaningfully off-axis, not just float noise
    });

    expect(diagonalEdges.length).toBeGreaterThan(0);
  });

  it('places 3-5 parks that never overlap street geometry', () => {
    const city = generateRiverton(RIVERTON_SEED);
    expect(city.scenery.parks.length).toBeGreaterThanOrEqual(3);
    expect(city.scenery.parks.length).toBeLessThanOrEqual(5);

    const nodeById = new Map(city.graph.nodes.map((n) => [n.id, n]));
    for (const park of city.scenery.parks) {
      for (const edge of city.graph.edges) {
        const from = nodeById.get(edge.from)!.pos;
        const to = nodeById.get(edge.to)!.pos;
        expect(crossingCount(from, to, park)).toBe(0);
      }
    }
  });

  it('places at least one park on the riverbank', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const ring = city.scenery.water[0]!;
    const ringLats = ring.map(([, lat]) => lat);
    const riverMinLat = Math.min(...ringLats);
    const riverMaxLat = Math.max(...ringLats);
    // "On the riverbank" — its centroid sits close to the water, not off in some other corner
    // of the city. Generous enough to tolerate the river's meander, tight enough to mean
    // something: within roughly two blocks of the nearest bank.
    const bandDeg = 0.01;

    const hasRiverside = city.scenery.parks.some((park) => {
      const centroidLat = park.reduce((sum, [, lat]) => sum + lat, 0) / park.length;
      return centroidLat > riverMinLat - bandDeg && centroidLat < riverMaxLat + bandDeg;
    });

    expect(hasRiverside).toBe(true);
  });

  it('stays roughly 6km across', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const widthDeg = city.bounds.east - city.bounds.west;
    const midLatRad = ((city.bounds.north + city.bounds.south) / 2) * (Math.PI / 180);
    const widthKm = (widthDeg * 111.32 * Math.cos(midLatRad));
    expect(widthKm).toBeGreaterThan(4);
    expect(widthKm).toBeLessThan(9);
  });
});
