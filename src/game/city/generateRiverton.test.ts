import { describe, expect, it } from 'vitest';
import { generateRiverton, RIVERTON_SEED } from './generateRiverton';
import { isDepotEligibleZone, medianZoneDensityPerHa } from './zones';
import type { LngLat, Polygon, Zone } from '../types';

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

/** Shoelace polygon area, in whatever units the ring's coordinates are already in (used below
 * directly on lng/lat — see the zone-overlap test for why that's still an exact comparison). */
function shoelaceArea(ring: Polygon): number {
  let area2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    area2 += x0 * y1 - x1 * y0;
  }
  return Math.abs(area2) / 2;
}

/** Great-circle distance, metres. Local copy, per this file's own convention (see the header
 * comment) of checking the generator's output from the outside rather than sharing internals. */
function haversineMeters(a: LngLat, b: LngLat): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A park's on-the-ground diameter: the greatest great-circle distance between any two of its
 * vertices. Cheap at PARK_SIDES=9 vertices and exact enough to tell a landmark park from a pocket
 * park without importing the generator's own tier constants. */
function polygonDiameterM(poly: Polygon): number {
  let maxD = 0;
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      const d = haversineMeters(poly[i]!, poly[j]!);
      if (d > maxD) maxD = d;
    }
  }
  return maxD;
}

/** Standard ray-casting point-in-polygon test, used below to confirm a big park's footprint has
 * had its interior streets actually removed rather than just being drawn over the top of them. */
function pointInPolygon(point: LngLat, poly: Polygon): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
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

    // The now-full-width diagonal slices through enough grid edges that its shorter fragments
    // pull the population *mean* down measurably — that's expected, not a regression. The
    // median is what a "plain, untouched grid block" actually measures, since fragments are a
    // minority; cluster the tightness check around that instead of the (fragment-skewed) mean.
    const sorted = [...lengths].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    // Almost every residential edge is a plain, untouched grid block; only the handful the
    // diagonal avenue slices through deviate from the block size.
    const withinFivePercent = lengths.filter((v) => Math.abs(v - median) < median * 0.05);
    expect(withinFivePercent.length / lengths.length).toBeGreaterThan(0.9);

    const variance = withinFivePercent.reduce((sum, v) => sum + (v - median) ** 2, 0) / withinFivePercent.length;
    expect(Math.sqrt(variance)).toBeLessThan(median * 0.01);
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

  /** Shared by the diagonal-avenue tests below — the same off-axis-primary-edge filter the
   * original "cuts a diagonal avenue" test used, so a chain of these edges is the avenue. */
  function findDiagonalEdges(city: ReturnType<typeof generateRiverton>): { edge: (typeof city.graph.edges)[number] }[] {
    const nodeById = new Map(city.graph.nodes.map((n) => [n.id, n]));
    return city.graph.edges
      .filter((edge) => {
        if (edge.roadClass !== 'primary') return false;
        const from = nodeById.get(edge.from)!;
        const to = nodeById.get(edge.to)!;
        const dx = Math.abs(to.pos[0] - from.pos[0]);
        const dy = Math.abs(to.pos[1] - from.pos[1]);
        if (dx < 1e-12 || dy < 1e-12) return false; // axis-aligned street
        const ratio = dx / dy;
        return ratio > 0.05 && ratio < 20; // meaningfully off-axis, not just float noise
      })
      .map((edge) => ({ edge }));
  }

  it('cuts a diagonal avenue across the grid, not just axis-aligned streets', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const diagonalEdges = findDiagonalEdges(city);
    expect(diagonalEdges.length).toBeGreaterThan(0);
  });

  it('spans most of the city, not a fifth of it, so it reads as a real avenue', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const nodeById = new Map(city.graph.nodes.map((n) => [n.id, n]));
    const diagonalEdges = findDiagonalEdges(city);

    const lngs = diagonalEdges.flatMap(({ edge }) => [nodeById.get(edge.from)!.pos[0], nodeById.get(edge.to)!.pos[0]]);
    const spanDeg = Math.max(...lngs) - Math.min(...lngs);
    const cityWidthDeg = city.bounds.east - city.bounds.west;

    // Previously ~10 of 43 grid columns (well under a quarter of the city's width); the avenue
    // now runs the grid's full east-west extent, so it should cover most of the city's width.
    expect(spanDeg / cityWidthDeg).toBeGreaterThan(0.8);
  });

  it('terminates the diagonal avenue at the city edge, not dangling mid-block', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const nodeById = new Map(city.graph.nodes.map((n) => [n.id, n]));
    const diagonalEdges = findDiagonalEdges(city);

    // The avenue is a single chain: within just its own edges, the two ends are the only nodes
    // with degree 1 (every interior node has two neighbours along the chain).
    const degree = new Map<number, number>();
    for (const { edge } of diagonalEdges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    const endpointIds = [...degree.entries()].filter(([, d]) => d === 1).map(([id]) => id);
    expect(endpointIds.length).toBe(2);

    // A real terminus sits on the city's boundary column — the same longitude as the grid's
    // outermost nodes — rather than at an arbitrary interior intersection with nothing past it.
    const allLngs = city.graph.nodes.map((n) => n.pos[0]);
    const minLng = Math.min(...allLngs);
    const maxLng = Math.max(...allLngs);
    const epsilon = 1e-9;

    for (const id of endpointIds) {
      const lng = nodeById.get(id)!.pos[0];
      const atWestEdge = Math.abs(lng - minLng) < epsilon;
      const atEastEdge = Math.abs(lng - maxLng) < epsilon;
      expect(atWestEdge || atEastEdge).toBe(true);
    }
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

  // A park should be recognisable as a park at the default view (a 140m block renders as ~9.4px
  // there), so parks now span blocks rather than fitting inside one: a single landmark park
  // (~3 blocks, 420m, on the order of a real city's central park), a single medium park (~2
  // blocks, 280m), and every remaining park a pocket that still fills most of one block (140m) —
  // a mix, not identically-sized blobs. `drawParks` places the landmark first, then the medium,
  // then the pockets, so `city.scenery.parks` preserves that order.
  it('places a landmark park, a medium park, and pocket parks — a mix, not identical blobs', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const diameters = city.scenery.parks.map(polygonDiameterM);
    expect(diameters.length).toBeGreaterThanOrEqual(3);

    const [landmark, medium, ...pockets] = diameters;

    // Landmark: a 420m-square footprint, ±15% per-vertex jitter — worst-case diameter range.
    expect(landmark!).toBeGreaterThan(230);
    expect(landmark!).toBeLessThan(400);

    // Medium: a 280m-square footprint.
    expect(medium!).toBeGreaterThan(125);
    expect(medium!).toBeLessThan(255);

    // Pockets: a 140m-square footprint (a normal city block) — visibly bigger than the old
    // single-tier park (76-100m diameter) but well short of the medium tier.
    expect(pockets.length).toBeGreaterThan(0);
    for (const d of pockets) {
      expect(d).toBeGreaterThan(65);
      expect(d).toBeLessThan(125);
    }

    // The tiers read as a real size hierarchy, not overlapping noise.
    expect(landmark!).toBeGreaterThan(medium!);
    for (const d of pockets) expect(medium!).toBeGreaterThan(d);
  });

  it('keeps every park inside city.bounds', () => {
    const city = generateRiverton(RIVERTON_SEED);
    for (const park of city.scenery.parks) {
      for (const [lng, lat] of park) {
        expect(lng).toBeGreaterThanOrEqual(city.bounds.west);
        expect(lng).toBeLessThanOrEqual(city.bounds.east);
        expect(lat).toBeGreaterThanOrEqual(city.bounds.south);
        expect(lat).toBeLessThanOrEqual(city.bounds.north);
      }
    }
  });

  // A landmark/medium park's footprint is bigger than a single block, so it necessarily swallows
  // some interior street grid. The generator's chosen behaviour: that interior grid is actually
  // removed (nodes and edges alike), leaving only the streets framing the park's outer edge — not
  // just a park polygon painted over streets that are still there underneath. This is what keeps
  // "places 3-5 parks that never overlap street geometry" above true for the bigger tiers too.
  it('removes the interior street grid under the landmark and medium parks (the grid detours around them, it is not drawn over)', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const [landmark, medium] = city.scenery.parks;
    expect(landmark).toBeDefined();
    expect(medium).toBeDefined();

    for (const park of [landmark!, medium!]) {
      for (const node of city.graph.nodes) {
        expect(pointInPolygon(node.pos, park)).toBe(false);
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

// ── Zones ────────────────────────────────────────────────────────────────────
// demand-model.md §5 (Riverton Stage A) and depots-and-timetables.md §1 (Zoning B fallback) are
// the two consumers a zone table has to satisfy. `isDepotEligibleZone`/`medianZoneDensityPerHa`
// are imported from `./zones` rather than reimplemented — the same shared predicate depot siting
// itself will use once that module lands.

describe('generateRiverton: zones', () => {
  it('emits exactly Z = 96 zones (demand-model.md §5)', () => {
    const city = generateRiverton(RIVERTON_SEED);
    expect(city.zones.length).toBe(96);
  });

  it('every zone is a well-formed polygon with a positive area', () => {
    const city = generateRiverton(RIVERTON_SEED);
    for (const zone of city.zones) {
      expect(zone.polygon.length).toBeGreaterThanOrEqual(3);
      expect(zone.areaHa).toBeGreaterThan(0);
      expect(zone.residents).toBeGreaterThan(0);
      expect(zone.jobs).toBeGreaterThan(0);
      expect(zone.tourismJobs).toBeGreaterThanOrEqual(0);
    }
  });

  it('total residents is close to demand-model.md §5\'s "population 42,000"', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const totalResidents = city.zones.reduce((sum, z) => sum + z.residents, 0);
    // Per-zone rounding and the population floor mean this can't be exact; within 10% is a
    // meaningful regression guard without being brittle to a rounding-strategy tweak.
    expect(totalResidents).toBeGreaterThan(42_000 * 0.9);
    expect(totalResidents).toBeLessThan(42_000 * 1.1);
  });

  it('total jobs is close to total residents ("normalised so Σjobs = Σprod", demand-model.md §5)', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const totalResidents = city.zones.reduce((sum, z) => sum + z.residents, 0);
    const totalJobs = city.zones.reduce((sum, z) => sum + z.jobs, 0);
    // Normalisation happens before the deliberate industrial-district overrides are applied (see
    // generateRiverton.ts's buildZones), so a small, bounded gap from those few zones is expected;
    // 10% comfortably bounds it while still catching a real normalisation regression.
    expect(totalJobs).toBeGreaterThan(totalResidents * 0.9);
    expect(totalJobs).toBeLessThan(totalResidents * 1.1);
  });

  it('tourism jobs are confined to the 4 zones nearest the core, 12% of those zones\' jobs', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const zonesWithTourism = city.zones.filter((z) => z.tourismJobs > 0);
    expect(zonesWithTourism.length).toBe(4);
    for (const zone of zonesWithTourism) {
      expect(zone.tourismJobs).toBeCloseTo(0.12 * zone.jobs, 0);
    }
  });

  it('zones never overlap: total zone area exactly matches their combined bounding box (a true partition, no double-covered ground)', () => {
    // A Voronoi diagram's cells share exact boundary edges by construction, so a ray-cast
    // point-in-polygon check on shared vertices is inherently ambiguous (floating-point boundary
    // cases, not a real bug). Area conservation sidesteps that: if any pair of zones overlapped,
    // the sum of their individual areas would exceed the area of the ground they can possibly
    // cover; if there were gaps, it would fall short. `metersToLngLat` is a fixed affine map (one
    // constant scale per axis, not a per-point projection), so shoelace areas computed directly in
    // lng/lat are exactly proportional to their metric equivalents — the ratio below is exact.
    const city = generateRiverton(RIVERTON_SEED);
    const totalZoneArea = city.zones.reduce((sum, z) => sum + shoelaceArea(z.polygon), 0);

    const allVertices = city.zones.flatMap((z) => z.polygon);
    const lngs = allVertices.map(([lng]) => lng);
    const lats = allVertices.map(([, lat]) => lat);
    const boundingBoxArea = (Math.max(...lngs) - Math.min(...lngs)) * (Math.max(...lats) - Math.min(...lats));

    expect(totalZoneArea / boundingBoxArea).toBeGreaterThan(0.9999);
    expect(totalZoneArea / boundingBoxArea).toBeLessThan(1.0001);
  });

  it('every zone stays inside city.bounds', () => {
    const city = generateRiverton(RIVERTON_SEED);
    for (const zone of city.zones) {
      for (const [lng, lat] of zone.polygon) {
        expect(lng).toBeGreaterThanOrEqual(city.bounds.west);
        expect(lng).toBeLessThanOrEqual(city.bounds.east);
        expect(lat).toBeGreaterThanOrEqual(city.bounds.south);
        expect(lat).toBeLessThanOrEqual(city.bounds.north);
      }
    }
  });

  it('reads job-heavy near the core and resident-heavy further out — "a radial line worth drawing"', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const center: LngLat = [(city.bounds.west + city.bounds.east) / 2, (city.bounds.south + city.bounds.north) / 2];

    // Exclude the deliberate industrial-district overrides (residents < 100 — see buildZones):
    // those are a documented, deliberate exception to the radial shape, not part of it.
    const byDistance = city.zones
      .filter((z) => z.residents >= 100)
      .map((z) => ({ zone: z, r: haversineMeters(z.centroid, center) }))
      .sort((a, b) => a.r - b.r);

    const n = byDistance.length;
    const core = byDistance.slice(0, Math.round(n * 0.15));
    // A band clear of both the core and the far corners (where a Voronoi lattice's largest, most
    // irregular cells sit) — the commuter belt the spec's "edge" describes.
    const ring = byDistance.slice(Math.round(n * 0.2), Math.round(n * 0.65));
    expect(core.length).toBeGreaterThan(0);
    expect(ring.length).toBeGreaterThan(0);

    const avgRatio = (entries: typeof core): number =>
      entries.reduce((sum, e) => sum + e.zone.jobs / e.zone.residents, 0) / entries.length;

    const coreRatio = avgRatio(core);
    const ringRatio = avgRatio(ring);
    expect(coreRatio).toBeGreaterThan(1); // core: jobs > residents on average
    expect(ringRatio).toBeLessThan(1); // ring: residents > jobs on average
    expect(coreRatio).toBeGreaterThan(ringRatio);
  });

  it('has at least 3 deliberate industrial districts: jobs 4-8x residents, mutually >= 400m apart, each with street access within 400m', () => {
    const city = generateRiverton(RIVERTON_SEED);

    // "jobs 4-8x residents" per depots-and-timetables.md §1's description of the deliberate
    // districts — distinct from (and much stronger than) Zoning B's bare eligible() ratio test
    // below, which only requires jobs > residents.
    const industrialCandidates = city.zones.filter((z) => z.jobs >= 4 * z.residents && z.jobs <= 8 * z.residents);
    expect(industrialCandidates.length).toBeGreaterThanOrEqual(3);

    // Also below the density bottom tercile (spec's other half of the same bullet).
    const densities = city.zones.map((z) => (z.residents + z.jobs) / z.areaHa).sort((a, b) => a - b);
    const tercileBoundary = densities[Math.floor(densities.length / 3)]!;
    const inBottomTercile = industrialCandidates.filter((z) => (z.residents + z.jobs) / z.areaHa < tercileBoundary);
    expect(inBottomTercile.length).toBeGreaterThanOrEqual(3);

    // Mutually >= 400m apart, greedily, in id order — mirrors generateRiverton.ts's own
    // assertDepotSitingViable so the test independently confirms what the generation-time
    // assertion already guards.
    const spaced: Zone[] = [];
    for (const zone of inBottomTercile) {
      if (spaced.every((s) => haversineMeters(s.centroid, zone.centroid) >= 400)) spaced.push(zone);
    }
    expect(spaced.length).toBeGreaterThanOrEqual(3);

    // Each has a routable road node within 400m of its centroid.
    for (const zone of spaced.slice(0, 3)) {
      const hasAccess = city.graph.nodes.some((n) => haversineMeters(n.pos, zone.centroid) <= 400);
      expect(hasAccess).toBe(true);
    }
  });

  it('satisfies depots-and-timetables.md §1\'s Zoning B eligibility (the shared predicate): at least 3 zones pass eligible()', () => {
    const city = generateRiverton(RIVERTON_SEED);
    const median = medianZoneDensityPerHa(city.zones);
    const eligible = city.zones.filter((z) => isDepotEligibleZone(z, median));
    expect(eligible.length).toBeGreaterThanOrEqual(3);
  });

  it('generation is deterministic across two runs: zones are byte-identical for the same seed', () => {
    const a = generateRiverton(RIVERTON_SEED);
    const b = generateRiverton(RIVERTON_SEED);
    expect(a.zones).toEqual(b.zones);
  });

  it('produces different zones for a different seed (the lattice jitter actually varies)', () => {
    const a = generateRiverton(RIVERTON_SEED);
    const b = generateRiverton(RIVERTON_SEED + 1);
    expect(a.zones).not.toEqual(b.zones);
  });
});
