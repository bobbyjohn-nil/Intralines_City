import { describe, expect, it } from 'vitest';
import { generateRiverton, RIVERTON_SEED } from '../city/generateRiverton';
import type { LngLat, RoadEdge, RoadNode, StreetGraph } from '../types';
import { STOP_PLACEMENT_COST_USD } from '../constants';
import {
  addStop,
  canCreate,
  cancelDraft,
  startDraft,
  summarizeDraft,
  undoLastStop,
} from './draft';
import { snapToRoad } from './snapToRoad';

const city = generateRiverton(RIVERTON_SEED);

/** Midpoint of an edge's two endpoints — a deterministic click guaranteed to snap to that edge. */
function midpointOf(graph: StreetGraph, edge: RoadEdge): LngLat {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const from = nodeById.get(edge.from)!;
  const to = nodeById.get(edge.to)!;
  return [(from.pos[0] + to.pos[0]) / 2, (from.pos[1] + to.pos[1]) / 2];
}

/** A single motorway edge — Riverton never generates anything faster than primary (55 km/h,
 * exactly at the limit), so a case that actually exceeds `STOP_MAX_ROAD_SPEED_KMH` needs its
 * own fixture. */
function buildMotorwayOnlyGraph(): StreetGraph {
  const nodes: RoadNode[] = [
    { id: 0, pos: [-89.5, 40.9] },
    { id: 1, pos: [-89.499, 40.9] },
  ];
  const edges: RoadEdge[] = [{ id: 0, from: 0, to: 1, roadClass: 'motorway', lengthM: 90 }];
  const adjacency = new Map<number, readonly number[]>([
    [0, [0]],
    [1, [0]],
  ]);
  return { nodes, edges, adjacency };
}

/** Two disconnected residential islands, each with one eligible edge — for the "leg can't be
 * routed" refusal, distinct from the "click doesn't snap at all" refusal. */
function buildTwoIslandGraph(): StreetGraph {
  const nodes: RoadNode[] = [
    { id: 0, pos: [-89.6, 41.0] },
    { id: 1, pos: [-89.599, 41.0] },
    { id: 2, pos: [-89.4, 41.2] },
    { id: 3, pos: [-89.399, 41.2] },
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

describe('snapToRoad', () => {
  it('snaps to the nearest eligible edge under normal conditions', () => {
    const edge = city.graph.edges[0]!;
    const click = midpointOf(city.graph, edge);

    const result = snapToRoad(click, city.graph);

    expect(result).not.toBeNull();
    expect(result!.distanceM).toBeLessThan(5);
  });

  it('refuses a click on a road faster than STOP_MAX_ROAD_SPEED_KMH', () => {
    const motorwayGraph = buildMotorwayOnlyGraph();
    const click = midpointOf(motorwayGraph, motorwayGraph.edges[0]!);

    expect(snapToRoad(click, motorwayGraph)).toBeNull();
  });

  it('refuses a click nowhere near any eligible street', () => {
    const farAway: LngLat = [city.bounds.west - 5, city.bounds.south - 5];
    expect(snapToRoad(farAway, city.graph)).toBeNull();
  });
});

describe('draft', () => {
  it('cannot be created with a single stop', () => {
    let state = startDraft(city.graph);
    const first = addStop(state, midpointOf(city.graph, city.graph.edges[0]!));
    expect(first.ok).toBe(true);
    state = first.ok ? first.state : state;

    expect(state.stops.length).toBe(1);
    expect(canCreate(state)).toBe(false);
  });

  it('can be created once it has two or more routable stops', () => {
    let state = startDraft(city.graph);
    const clicks = [
      midpointOf(city.graph, city.graph.edges[0]!),
      midpointOf(city.graph, city.graph.edges[1]!),
    ];
    for (const click of clicks) {
      const result = addStop(state, click);
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    }

    expect(canCreate(state)).toBe(true);
    expect(state.legs.length).toBe(1);
  });

  it('refuses a click that does not snap to any eligible street, with a reason', () => {
    const state = startDraft(city.graph);
    const farAway: LngLat = [city.bounds.west - 5, city.bounds.south - 5];

    const result = addStop(state, farAway);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toEqual(expect.any(String));
  });

  it('refuses a leg that cannot be routed, with a reason, instead of dropping it silently', () => {
    const islands = buildTwoIslandGraph();
    let state = startDraft(islands);
    const onFirstIsland = midpointOf(islands, islands.edges[0]!);
    const onSecondIsland = midpointOf(islands, islands.edges[1]!);

    const first = addStop(state, onFirstIsland);
    expect(first.ok).toBe(true);
    state = first.ok ? first.state : state;

    const second = addStop(state, onSecondIsland);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason.length).toBeGreaterThan(0);
    // The refused stop must not have been silently appended.
    expect(state.stops.length).toBe(1);
  });

  it('cancel drops every stop and leg', () => {
    let state = startDraft(city.graph);
    for (const edge of [city.graph.edges[0]!, city.graph.edges[1]!]) {
      const result = addStop(state, midpointOf(city.graph, edge));
      if (result.ok) state = result.state;
    }
    expect(state.stops.length).toBeGreaterThan(0);

    state = cancelDraft(state);

    expect(state.stops).toEqual([]);
    expect(state.legs).toEqual([]);
  });

  it('undo restores the previous totals exactly', () => {
    let state = startDraft(city.graph);
    const edges = [city.graph.edges[0]!, city.graph.edges[1]!, city.graph.edges[2]!];

    const afterOne = addStop(state, midpointOf(city.graph, edges[0]!));
    expect(afterOne.ok).toBe(true);
    state = afterOne.ok ? afterOne.state : state;
    const summaryAfterOne = summarizeDraft(state);

    const afterTwo = addStop(state, midpointOf(city.graph, edges[1]!));
    expect(afterTwo.ok).toBe(true);
    state = afterTwo.ok ? afterTwo.state : state;

    const afterThree = addStop(state, midpointOf(city.graph, edges[2]!));
    expect(afterThree.ok).toBe(true);
    state = afterThree.ok ? afterThree.state : state;

    // Undo back down to one stop and compare against the snapshot taken right after that stop.
    state = undoLastStop(state);
    state = undoLastStop(state);

    expect(state.stops).toEqual([summaryAfterOne.stops[0]]);
    expect(summarizeDraft(state)).toEqual(summaryAfterOne);
  });

  it('undo on an empty draft is a no-op', () => {
    const state = startDraft(city.graph);
    expect(undoLastStop(state)).toEqual(state);
  });

  it('tracks running stop count, length, round-trip estimate and placement cost', () => {
    let state = startDraft(city.graph);
    const edges = [city.graph.edges[0]!, city.graph.edges[1]!];
    for (const edge of edges) {
      const result = addStop(state, midpointOf(city.graph, edge));
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    }

    const draft = summarizeDraft(state);

    expect(draft.stopCount).toBe(2);
    expect(draft.totalLengthM).toBeGreaterThan(0);
    expect(draft.estimatedRoundTripMinutes).toBeGreaterThan(0);
    expect(draft.placementCostUsd).toBe(2 * STOP_PLACEMENT_COST_USD);
  });
});
