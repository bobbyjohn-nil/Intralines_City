import { describe, expect, it } from 'vitest';
import { buildLegWaypoints, lerpLngLat, sharedNodeId } from './routeGeometry';
import type { RoadEdge, RoadNode } from '../game/types';
import type { RouteLeg, Stop, StopId } from '../game/lines/types';

// A minimal "L" street: A(0,0) --E1--> B(10,0) --E2--> C(10,10). Degrees stand in for lng/lat —
// these helpers are pure arithmetic on `[lng, lat]` tuples, never a live `Viewport` or scene.
const nodeA: RoadNode = { id: 1, pos: [0, 0] };
const nodeB: RoadNode = { id: 2, pos: [10, 0] };
const nodeC: RoadNode = { id: 3, pos: [10, 10] };
const nodeIndex = new Map<number, RoadNode>([
  [nodeA.id, nodeA],
  [nodeB.id, nodeB],
  [nodeC.id, nodeC],
]);

const edge1: RoadEdge = { id: 1, from: nodeA.id, to: nodeB.id, roadClass: 'residential', lengthM: 10 };
const edge2: RoadEdge = { id: 2, from: nodeB.id, to: nodeC.id, roadClass: 'residential', lengthM: 10 };
const edgeIndex = new Map<number, RoadEdge>([
  [edge1.id, edge1],
  [edge2.id, edge2],
]);

function makeStop(id: number, edgeId: number, edgeT: number, position: readonly [number, number]): Stop {
  return {
    id: id as StopId,
    name: `Stop ${id}`,
    position,
    roadClass: 'residential',
    edgeId,
    edgeT,
    orphaned: false,
    movedM: null,
  };
}

describe('sharedNodeId', () => {
  it('finds the node two consecutive edges share, regardless of which ends they store it as', () => {
    expect(sharedNodeId(edge1, edge2)).toBe(nodeB.id);
    expect(sharedNodeId(edge2, edge1)).toBe(nodeB.id);
  });

  it('returns undefined for edges that share no node', () => {
    const farEdge: RoadEdge = { id: 99, from: 100, to: 101, roadClass: 'residential', lengthM: 5 };
    expect(sharedNodeId(edge1, farEdge)).toBeUndefined();
  });
});

describe('lerpLngLat', () => {
  it('returns `from` at t=0 and `to` at t=1', () => {
    expect(lerpLngLat(nodeA.pos, nodeB.pos, 0)).toEqual([0, 0]);
    expect(lerpLngLat(nodeA.pos, nodeB.pos, 1)).toEqual([10, 0]);
  });

  it('interpolates linearly in between', () => {
    const [lng, lat] = lerpLngLat(nodeA.pos, nodeB.pos, 0.25);
    expect(lng).toBeCloseTo(2.5, 9);
    expect(lat).toBeCloseTo(0, 9);
  });
});

describe('buildLegWaypoints', () => {
  const TOLERANCE = 9;

  it('a single-edge leg begins and ends exactly at its two stops, not the edge\'s nodes', () => {
    const s0 = makeStop(0, edge1.id, 0.2, [2, 0]);
    const s1 = makeStop(1, edge1.id, 0.8, [8, 0]);
    const leg: RouteLeg = { fromStopId: s0.id, toStopId: s1.id, edgeIds: [edge1.id], lengthM: 6 };

    const out: Array<readonly [number, number]> = [];
    buildLegWaypoints(leg, s0, s1, edgeIndex, nodeIndex, out);

    expect(out.length).toBe(2);
    expect(out[0]![0]).toBeCloseTo(s0.position[0], TOLERANCE);
    expect(out[0]![1]).toBeCloseTo(s0.position[1], TOLERANCE);
    expect(out[out.length - 1]![0]).toBeCloseTo(s1.position[0], TOLERANCE);
    expect(out[out.length - 1]![1]).toBeCloseTo(s1.position[1], TOLERANCE);
    expect(out[0]).not.toEqual(nodeA.pos);
    expect(out[out.length - 1]).not.toEqual(nodeB.pos);
  });

  it('a multi-edge leg is clipped at both ends and passes through the shared node in between', () => {
    const s0 = makeStop(0, edge1.id, 0.8, [8, 0]);
    const s1 = makeStop(1, edge2.id, 0.5, [10, 5]);
    const leg: RouteLeg = { fromStopId: s0.id, toStopId: s1.id, edgeIds: [edge1.id, edge2.id], lengthM: 7 };

    const out: Array<readonly [number, number]> = [];
    buildLegWaypoints(leg, s0, s1, edgeIndex, nodeIndex, out);

    expect(out.length).toBe(3);
    expect(out[0]).toEqual([8, 0]);
    expect(out[1]).toEqual(nodeB.pos);
    expect(out[2]).toEqual([10, 5]);
  });

  it(
    'the whole-line polyline begins/ends exactly at the terminus stops and never doubles back ' +
      'over a shared edge at a mid-edge intermediate stop',
    () => {
      const s0 = makeStop(0, edge1.id, 0, [0, 0]);
      const s1 = makeStop(1, edge1.id, 0.8, [8, 0]);
      const s2 = makeStop(2, edge2.id, 0.5, [10, 5]);
      const leg1: RouteLeg = { fromStopId: s0.id, toStopId: s1.id, edgeIds: [edge1.id], lengthM: 8 };
      const leg2: RouteLeg = { fromStopId: s1.id, toStopId: s2.id, edgeIds: [edge1.id, edge2.id], lengthM: 7 };

      const polyline: Array<readonly [number, number]> = [];
      buildLegWaypoints(leg1, s0, s1, edgeIndex, nodeIndex, polyline);
      buildLegWaypoints(leg2, s1, s2, edgeIndex, nodeIndex, polyline);

      const first = polyline[0]!;
      const last = polyline[polyline.length - 1]!;
      expect(first[0]).toBeCloseTo(s0.position[0], TOLERANCE);
      expect(first[1]).toBeCloseTo(s0.position[1], TOLERANCE);
      expect(last[0]).toBeCloseTo(s2.position[0], TOLERANCE);
      expect(last[1]).toBeCloseTo(s2.position[1], TOLERANCE);

      const s1Index = polyline.findIndex((p) => p[0] === s1.position[0] && p[1] === s1.position[1]);
      expect(s1Index).toBeGreaterThanOrEqual(0);
      for (let i = s1Index; i < polyline.length; i++) {
        expect(polyline[i]![0]).toBeGreaterThanOrEqual(s1.position[0] - 1e-9);
      }
      for (let i = s1Index + 1; i < polyline.length; i++) {
        expect(polyline[i]).not.toEqual(nodeA.pos);
      }
    },
  );

  it('degrades to the edge\'s own node instead of throwing when the expected stop is missing', () => {
    const leg: RouteLeg = { fromStopId: 0 as StopId, toStopId: 1 as StopId, edgeIds: [edge1.id], lengthM: 10 };
    const out: Array<readonly [number, number]> = [];
    expect(() => buildLegWaypoints(leg, undefined, undefined, edgeIndex, nodeIndex, out)).not.toThrow();
    expect(out).toEqual([nodeA.pos, nodeB.pos]);
  });
});
