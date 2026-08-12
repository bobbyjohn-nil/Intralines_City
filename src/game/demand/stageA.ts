/**
 * Stage A — city statics (demand-model.md §1, A1–A5). Computed once per city load and cached by
 * the caller; must never run inside the ~250 ms debounce, because A5's gravity O–D is a Z²
 * exponential and "depends on nothing the player can change — keeping it out of the debounce is
 * what makes the 250 ms budget hold."
 *
 * A1 (`zonePop`/`zoneJobs`/`zoneTourismJobs`/centroid) is Riverton's own output — consumed, never
 * regenerated, per this slice's scope. `zoneTourismJobs` isn't read here: visitors are cut from
 * the first slice (demand-model.md's "Cut line").
 */

import type { City } from '../types';
import type { CityDemandStatics, DemandBuffers } from './types';
import { makeProjection, projectToMeters } from './geo';
import { BETA_M, CAR_PARKING_PENALTY_MIN, CAR_TRAFFIC_MULTIPLIER, WORKFORCE_RATE } from './constants';
import { ROAD_SPEED_KMH } from '../constants';

/**
 * Writes A1–A5 into `buffers` in place and returns Stage A's small non-buffer handle. `buffers`
 * must have been created with `zoneCapacity === city.zones.length` — zone count is fixed for a
 * city's lifetime, so this is a caller bug (a stale buffer from a different city), not a runtime
 * possibility to degrade gracefully from; it fails loud.
 *
 * `cityCarSpeedKmh` has to be passed explicitly: `City` (src/game/types.ts) carries no per-city
 * car-speed field yet (see this file's caller in `demand.test.ts` and `RIVERTON_CAR_SPEED_KMH` in
 * `constants.ts`), so there is nothing to read it from today.
 */
export function computeCityStatics(buffers: DemandBuffers, city: City, cityCarSpeedKmh: number): CityDemandStatics {
  const z = city.zones.length;
  if (z !== buffers.zoneCapacity) {
    throw new Error(
      `computeCityStatics: city has ${z} zones but buffers were sized for ${buffers.zoneCapacity} — ` +
        'create a fresh DemandBuffers for this city (zone count is fixed for a city\'s lifetime).',
    );
  }
  if (cityCarSpeedKmh <= 0) {
    throw new Error(`computeCityStatics: cityCarSpeedKmh must be positive, got ${cityCarSpeedKmh}`);
  }

  // A1's centroid, projected. Any fixed point works as the tangent-plane origin; zone 0's
  // centroid is simply always present when z > 0 and keeps every coordinate small.
  const originZone = city.zones[0];
  const origin = originZone !== undefined
    ? originZone.centroid
    : ([
        (city.bounds.west + city.bounds.east) / 2,
        (city.bounds.south + city.bounds.north) / 2,
      ] as const);
  const projection = makeProjection(origin);

  for (let i = 0; i < z; i++) {
    const zone = city.zones[i]!;
    const { xM, yM } = projectToMeters(projection, zone.centroid);
    buffers.zoneXM[i] = xM;
    buffers.zoneYM[i] = yM;
    buffers.zoneProd[i] = zone.residents * WORKFORCE_RATE; // A4
  }

  // A2 (zoneDistM) + A3 (carMin) + the unnormalised gravity weight w[i][j], all in one O(Z²)
  // pass; A5's normalisation (od[i][j] = prod[i] * w[i][j] / sum_k w[i][k]) is a second O(Z²)
  // pass reusing `odCommute` as scratch for w before overwriting it with the real trip counts —
  // no extra buffer needed.
  for (let i = 0; i < z; i++) {
    let sumW = 0;
    const rowStart = i * z;
    for (let j = 0; j < z; j++) {
      const idx = rowStart + j;
      const dx = buffers.zoneXM[i]! - buffers.zoneXM[j]!;
      const dy = buffers.zoneYM[i]! - buffers.zoneYM[j]!;
      const distM = Math.hypot(dx, dy);
      buffers.zoneDistM[idx] = distM;
      buffers.carMinutes[idx] =
        ((distM / 1000 / cityCarSpeedKmh) * 60) * CAR_TRAFFIC_MULTIPLIER + CAR_PARKING_PENALTY_MIN;

      const jobs = city.zones[j]!.jobs;
      const w = jobs * Math.exp(-distM / BETA_M);
      buffers.odCommute[idx] = w; // scratch — normalised below
      sumW += w;
    }
    for (let j = 0; j < z; j++) {
      const idx = rowStart + j;
      buffers.odCommute[idx] = sumW > 0 ? (buffers.zoneProd[i]! * buffers.odCommute[idx]!) / sumW : 0;
    }
  }

  // Edge id -> free-flow minutes, at ROAD_SPEED_KMH (src/game/constants.ts — never re-quoted).
  // Static per city; built once so Stage B's per-line cumulative-minutes pass (B2) never has to
  // walk the street graph itself.
  const edgeTimeMinById = new Map<number, number>();
  for (const edge of city.graph.edges) {
    const speedKmh = ROAD_SPEED_KMH[edge.roadClass];
    edgeTimeMinById.set(edge.id, (edge.lengthM / 1000 / speedKmh) * 60);
  }

  return { zoneCount: z, cityCarSpeedKmh, projection, edgeTimeMinById };
}
