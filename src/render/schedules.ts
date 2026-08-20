/**
 * The render-facing shape that pairs a built `RouteSchedule` with the line it belongs to (for
 * coloring) and how many buses run it. `App.tsx` builds one of these per line; the WebGL scene
 * (`three/scene.ts`) is the only consumer.
 */

import type { RouteSchedule } from '../game/buses/schedule';

export interface LineBusSchedule {
  readonly lineId: number;
  readonly schedule: RouteSchedule;
  readonly busCount: number;
}
