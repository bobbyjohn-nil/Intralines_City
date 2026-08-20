/**
 * The WebGL scene assembler — builds every unlit data layer once per city, exposes update
 * functions the `MapCanvas` redraw loop calls only when the thing they touch actually changed
 * (never a per-frame rebuild), and wires the id-buffer registry every rendered contrast assertion
 * reads from. This is the module that turns `studio/docs/design/renderer-3d.md` into an actual
 * `THREE.Scene` — see that spec for why each layer is unlit/lit/screen-space.
 */

import * as THREE from 'three';
import type { City, LngLat } from '../../game/types';
import type { Draft, Line, LineId, Stop, StopId } from '../../game/lines/types';
import { getRenderCache } from '../cityIndex';
import { getLinePolyline } from '../routeGeometry';
import { getBusBodyColor, getBusStripeColor, getLineColor } from '../lineColors';
import { type PaperPalette } from '../paperPalette';
import { getTimeOfDayTint } from '../timeOfDay';
import { stopRadiusPx } from '../markerSizing';
import type { Viewport } from '../projection';
import { localOriginFromBounds, toLocalXZ, type LocalOrigin } from './localProjection';
import { buildPolygonLayerMesh } from './polygonLayer';
import {
  buildRoadLayer,
  buildRouteRibbon,
  buildRubberBand,
  updateLineResolution,
  updateRoadWidths,
  updateRouteWidth,
  updateRubberBand,
  type RoadLayer,
  type RouteRibbon,
  type RubberBand,
} from './lineLayers';
import { buildMaskLayer, updateMaskBoundaryScale, type MaskLayer } from './maskLayer';
import { buildNightTintLayer, setNightTint, type NightTintLayer } from './nightTint';
import { createStopMarkerLayer, setStopRadiusPx, type StopMarkerLayer } from './stopMarkers';
import { createLightingRig, updateKeyLightForClock, type LightingRig } from './lighting';
import { createCamera, updateCameraRig } from './cameraRig';
import { applyBusScale, busWorldScaleMultiplier, createBusInstance, placeBus, projectedLengthPx, type BusInstance } from './busLayer';
import { IdPassRegistry, colorSwapTag, createIdRenderTarget, hideDuringPassTag, opaqueColorSwapTag } from './idPass';
import { hexToUnitRgb, idColorToUnitRgb, rgbStringToUnitRgb } from './colorSpace';
import { BUS_LENGTH_M, MASK_ALPHA, ROAD_COLOR_MIX, ROAD_DRAW_ORDER, WATER_ALPHA, PARK_ALPHA, PARK_COLOR_MIX_T } from '../style';
import { mixHex } from '../paperPalette';
import type { LineBusSchedule } from '../schedules';
import { busPositionAt, createBusPositionScratch } from '../../game/buses/position';
import {
  CAMERA_FOV_DEG,
  ID_COLOR_BUS,
  ID_COLOR_MASK,
  ID_COLOR_ROAD_BASE,
  ID_COLOR_ROAD_STEP,
  ID_COLOR_ROUTE_BASE,
  ID_COLOR_ROUTE_STEP,
  ID_COLOR_STOP,
  ID_COLOR_PARK,
  ID_COLOR_WATER,
  Y_GROUND,
  Y_STOP,
} from './constants';

export interface CityScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly origin: LocalOrigin;
  readonly idRegistry: IdPassRegistry;
  readonly idTarget: THREE.WebGLRenderTarget;
  readonly lighting: LightingRig;
  readonly roadLayer: RoadLayer;
  readonly maskLayer: MaskLayer;
  readonly nightTint: NightTintLayer;
  readonly stopMarkers: StopMarkerLayer;
  readonly rubberBand: RubberBand;
  readonly routeGroup: THREE.Group;
  readonly busGroup: THREE.Group;
  readonly city: City;
  routeRibbons: Map<LineId, { legs: unknown; ribbon: RouteRibbon }>;
  busPool: BusInstance[];
  lastZoom: number | null;
  lastDpr: number;
  readonly ids: {
    readonly bus: THREE.Color;
    readonly stop: THREE.Color;
    readonly mask: THREE.Color;
    readonly water: THREE.Color;
    readonly park: THREE.Color;
    readonly roadByClass: Map<string, THREE.Color>;
    routeByLine: Map<LineId, THREE.Color>;
    nextRouteIdIndex: number;
  };
}

/** Builds the whole scene for `city` once — call again only when `city` itself changes (a fresh
 * game, not a zoom/pan/overlay update). */
export function buildCityScene(city: City, palette: PaperPalette, aspect: number): CityScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(palette.paper);

  const origin = localOriginFromBounds(city.bounds);
  const cache = getRenderCache(city);

  // ── Lighting (lit geometry only — buses today) ──────────────────────────
  const lighting = createLightingRig(palette.paper, palette.muted);
  scene.add(lighting.hemisphere, lighting.key, lighting.key.target);

  // ── Ground (unlit, flat) ─────────────────────────────────────────────────
  const groundHalf = 1_000_000;
  const groundGeometry = new THREE.PlaneGeometry(groundHalf, groundHalf);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundMaterial = new THREE.MeshBasicMaterial({ color: palette.paper });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.position.y = Y_GROUND;
  scene.add(ground);

  // ── Water / parks (unlit, flat) ──────────────────────────────────────────
  const waterMesh = buildPolygonLayerMesh(city.scenery.water, origin, 0.02, palette.blue, WATER_ALPHA);
  if (waterMesh) scene.add(waterMesh);
  const parkColor = mixHex(palette.amber, palette.muted, PARK_COLOR_MIX_T);
  const parkMesh = buildPolygonLayerMesh(city.scenery.parks, origin, 0.04, parkColor, PARK_ALPHA);
  if (parkMesh) scene.add(parkMesh);

  // ── Roads (unlit, flat, screen-space-floored width) ──────────────────────
  const roadLayer = buildRoadLayer(cache.roadBuckets, cache.nodeIndex, origin, (roadClass) =>
    mixHex(palette.ink, palette.muted, ROAD_COLOR_MIX[roadClass]),
  );
  scene.add(roadLayer.group);

  // ── Night tint ────────────────────────────────────────────────────────────
  const nightTint = buildNightTintLayer(city.bounds, origin);
  scene.add(nightTint.mesh);

  // ── Routes (built lazily per line — see `updateLinesAndStops`) ───────────
  const routeGroup = new THREE.Group();
  scene.add(routeGroup);
  const rubberBand = buildRubberBand(mixHex(palette.blue, palette.blue, 0));
  scene.add(rubberBand.line);

  // ── Stops (screen-space, unlit, depth test off) ──────────────────────────
  const stopMarkers = createStopMarkerLayer(palette.panel, palette.ink);
  stopMarkers.points.position.y = Y_STOP;
  scene.add(stopMarkers.points);

  // ── Buses (lit; pool grown as needed, never rebuilt per frame) ───────────
  const busGroup = new THREE.Group();
  scene.add(busGroup);

  // ── Mask (screen-space, unlit, depth test off, drawn last) ───────────────
  const maskLayer = buildMaskLayer(city.bounds, origin, palette.muted, palette.ink);
  scene.add(maskLayer.group);

  // ── Camera ────────────────────────────────────────────────────────────────
  const camera = createCamera(aspect);

  // ── Id-buffer registry ────────────────────────────────────────────────────
  const idRegistry = new IdPassRegistry();
  const idTarget = createIdRenderTarget(1, 1);

  idRegistry.register(hideDuringPassTag(nightTint.mesh));

  const waterIdColor = new THREE.Color(ID_COLOR_WATER);
  if (waterMesh) idRegistry.register(opaqueColorSwapTag(waterMesh.material as THREE.MeshBasicMaterial, waterIdColor));
  const parkIdColor = new THREE.Color(ID_COLOR_PARK);
  if (parkMesh) idRegistry.register(opaqueColorSwapTag(parkMesh.material as THREE.MeshBasicMaterial, parkIdColor));

  const roadByClass = new Map<string, THREE.Color>();
  ROAD_DRAW_ORDER.forEach((roadClass, index) => {
    const idColor = new THREE.Color(ID_COLOR_ROAD_BASE + index * ID_COLOR_ROAD_STEP);
    roadByClass.set(roadClass, idColor);
    const entry = roadLayer.byClass.get(roadClass);
    if (entry) idRegistry.register(colorSwapTag(entry.material, idColor));
  });

  const maskIdColor = new THREE.Color(ID_COLOR_MASK);
  idRegistry.register(colorSwapTag(maskLayer.boundaryMaterial, maskIdColor));
  idRegistry.register({
    idColor: maskIdColor,
    apply() {
      const [idR, idG, idB] = idColorToUnitRgb(maskIdColor);
      maskLayer.quadMaterial.uniforms.uMaskColor!.value.set(idR, idG, idB);
      // Forced opaque for the id pass — the void-share gate needs a reliable "is this pixel void"
      // classification, not a color blended against whatever the beauty pass drew underneath at
      // `MASK_ALPHA`.
      maskLayer.quadMaterial.uniforms.uMaskAlpha!.value = 1;
    },
    restore() {
      const [muR, muG, muB] = hexToUnitRgb(palette.muted);
      maskLayer.quadMaterial.uniforms.uMaskColor!.value.set(muR, muG, muB);
      maskLayer.quadMaterial.uniforms.uMaskAlpha!.value = MASK_ALPHA;
    },
  });

  const stopIdColor = new THREE.Color(ID_COLOR_STOP);
  idRegistry.register({
    idColor: stopIdColor,
    apply() {
      // The stop layer is a raw shader (`colorSpace.ts`'s rule: unconverted sRGB fractions, not
      // `THREE.Color`'s linear `.r/.g/.b`) — `idColorToUnitRgb` recovers the original byte value.
      const [idR, idG, idB] = idColorToUnitRgb(stopIdColor);
      stopMarkers.material.uniforms.uFillColor!.value.set(idR, idG, idB);
      stopMarkers.material.uniforms.uOutlineColor!.value.set(idR, idG, idB);
    },
    restore() {
      const [fr, fg, fb] = hexToUnitRgb(palette.panel);
      const [or_, og, ob] = hexToUnitRgb(palette.ink);
      stopMarkers.material.uniforms.uFillColor!.value.set(fr, fg, fb);
      stopMarkers.material.uniforms.uOutlineColor!.value.set(or_, og, ob);
    },
  });

  const busIdColor = new THREE.Color(ID_COLOR_BUS);

  return {
    scene,
    camera,
    origin,
    idRegistry,
    idTarget,
    lighting,
    roadLayer,
    maskLayer,
    nightTint,
    stopMarkers,
    rubberBand,
    routeGroup,
    busGroup,
    city,
    routeRibbons: new Map(),
    busPool: [],
    lastZoom: null,
    lastDpr: 1,
    ids: {
      bus: busIdColor,
      stop: stopIdColor,
      mask: maskIdColor,
      water: waterIdColor,
      park: parkIdColor,
      roadByClass,
      routeByLine: new Map(),
      nextRouteIdIndex: 0,
    },
  };
}

/** Called once per redraw. Cheap scalar updates only (camera rig, and — gated on an actual zoom
 * change — road/route/mask-boundary widths and stop radius); never a geometry rebuild. */
export function updateViewportDependent(
  cityScene: CityScene,
  viewport: Viewport,
  dpr: number,
  pitchDeg?: number,
  yawDeg?: number,
): void {
  updateCameraRig(cityScene.camera, viewport, cityScene.origin, pitchDeg, yawDeg);

  const zoomChanged = cityScene.lastZoom === null || Math.abs(cityScene.lastZoom - viewport.zoom) > 1e-9;
  const dprChanged = cityScene.lastDpr !== dpr;
  if (zoomChanged) {
    const pxPerM = viewport.scale();
    updateRoadWidths(cityScene.roadLayer, pxPerM);
    updateMaskBoundaryScale(cityScene.maskLayer, pxPerM);
    for (const { ribbon } of cityScene.routeRibbons.values()) {
      updateRouteWidth(ribbon, pxPerM);
    }
    cityScene.lastZoom = viewport.zoom;
  }
  if (zoomChanged || dprChanged) {
    setStopRadiusPx(cityScene.stopMarkers, stopRadiusPx(viewport.zoom), dpr);
    cityScene.lastDpr = dpr;
  }
}

/** Widths on every `LineMaterial` this scene owns depend on the renderer's pixel resolution
 * (`resolution` uniform, `LineMaterial`'s own requirement) — called on resize/DPR change. */
export function updateLineResolutionsForResize(cityScene: CityScene, widthPx: number, heightPx: number): void {
  const materials: import('three/examples/jsm/lines/LineMaterial.js').LineMaterial[] = [];
  for (const { material } of cityScene.roadLayer.byClass.values()) materials.push(material);
  for (const { ribbon } of cityScene.routeRibbons.values()) materials.push(ribbon.material);
  materials.push(cityScene.maskLayer.boundaryMaterial, cityScene.rubberBand.material);
  updateLineResolution(materials, widthPx, heightPx);
}

export function updateNightTint(cityScene: CityScene, minuteOfDay: number, palette: PaperPalette): void {
  const tint = getTimeOfDayTint(minuteOfDay, palette);
  const [r, g, b] = rgbStringToUnitRgb(tint.color);
  setNightTint(cityScene.nightTint, [r, g, b], tint.alpha);
}

export function updateKeyLightClock(cityScene: CityScene, minuteOfDay: number): void {
  updateKeyLightForClock(cityScene.lighting.key, minuteOfDay, cityScene.camera.position.clone().setY(0));
}

// ── Lines / stops / draft ────────────────────────────────────────────────────

export function updateLinesAndStops(
  cityScene: CityScene,
  lines: readonly Line[] | undefined,
  stopsById: ReadonlyMap<StopId, Stop> | undefined,
  draft: Draft | undefined,
  hoverLngLat: LngLat | undefined,
  palette: PaperPalette,
  pxPerM: number,
): void {
  const cache = getRenderCache(cityScene.city);
  const seenLineIds = new Set<LineId>();

  if (lines && stopsById) {
    for (const line of lines) {
      seenLineIds.add(line.id);
      let entry = cityScene.routeRibbons.get(line.id);
      if (!entry || entry.legs !== line.legs) {
        if (entry) {
          cityScene.routeGroup.remove(entry.ribbon.line);
          entry.ribbon.line.geometry.dispose();
        }
        const polyline = getLinePolyline(line.legs, stopsById, cache);
        const color = getLineColor(palette, line.id);
        const ribbon = buildRouteRibbon(polyline, cityScene.origin, color);
        if (ribbon) {
          updateRouteWidth(ribbon, pxPerM);
          cityScene.routeGroup.add(ribbon.line);
          entry = { legs: line.legs, ribbon };
          cityScene.routeRibbons.set(line.id, entry);

          let idColor = cityScene.ids.routeByLine.get(line.id);
          if (!idColor) {
            idColor = new THREE.Color(ID_COLOR_ROUTE_BASE + cityScene.ids.nextRouteIdIndex * ID_COLOR_ROUTE_STEP);
            cityScene.ids.nextRouteIdIndex += 1;
            cityScene.ids.routeByLine.set(line.id, idColor);
            cityScene.idRegistry.register(colorSwapTag(ribbon.material, idColor));
          }
        } else {
          cityScene.routeRibbons.delete(line.id);
        }
      }
    }
  }

  // Drop ribbons for lines that no longer exist.
  for (const [lineId, entry] of cityScene.routeRibbons) {
    if (!seenLineIds.has(lineId)) {
      cityScene.routeGroup.remove(entry.ribbon.line);
      entry.ribbon.line.geometry.dispose();
      cityScene.routeRibbons.delete(lineId);
    }
  }

  // Draft preview.
  if (draft && draft.legs.length > 0 && lines) {
    const draftLineId = lines.length;
    const draftColor = getLineColor(palette, draftLineId);
    const polyline = getLinePolyline(draft.legs, draft.stops, cache);
    // Draft geometry changes every added stop — rebuild is cheap (a handful of points) and only
    // happens on an actual draft edit, matching the Canvas renderer's own per-edit rebuild.
    let draftEntry = cityScene.routeRibbons.get(-1 as LineId);
    if (draftEntry) {
      cityScene.routeGroup.remove(draftEntry.ribbon.line);
      draftEntry.ribbon.line.geometry.dispose();
    }
    const ribbon = buildRouteRibbon(polyline, cityScene.origin, draftColor);
    if (ribbon) {
      updateRouteWidth(ribbon, pxPerM);
      cityScene.routeGroup.add(ribbon.line);
      cityScene.routeRibbons.set(-1 as LineId, { legs: draft.legs, ribbon });
    }
  } else {
    const draftEntry = cityScene.routeRibbons.get(-1 as LineId);
    if (draftEntry) {
      cityScene.routeGroup.remove(draftEntry.ribbon.line);
      draftEntry.ribbon.line.geometry.dispose();
      cityScene.routeRibbons.delete(-1 as LineId);
    }
  }

  if (draft && draft.stops.length > 0 && hoverLngLat) {
    const lastStop = draft.stops[draft.stops.length - 1]!;
    const draftLineId = lines?.length ?? 0;
    updateRubberBand(cityScene.rubberBand, lastStop.position, hoverLngLat, cityScene.origin, pxPerM, getLineColor(palette, draftLineId));
  } else {
    cityScene.rubberBand.line.visible = false;
  }

  // Stop marker positions: every line's stops plus the draft's own.
  const positions: number[] = [];
  const seenStopIds = new Set<StopId>();
  if (lines && stopsById) {
    for (const line of lines) {
      for (const stopId of line.stopIds) {
        if (seenStopIds.has(stopId)) continue;
        const stop = stopsById.get(stopId);
        if (!stop) continue;
        seenStopIds.add(stopId);
        const [x, z] = toLocalXZ(cityScene.origin, stop.position);
        positions.push(x, 0, z);
      }
    }
  }
  if (draft) {
    for (const stop of draft.stops) {
      const [x, z] = toLocalXZ(cityScene.origin, stop.position);
      positions.push(x, 0, z);
    }
  }
  cityScene.stopMarkers.setPositions(new Float32Array(positions));
}

// ── Buses ────────────────────────────────────────────────────────────────────

const busPositionScratch = createBusPositionScratch();

/** Places every bus for `totalMinutes` from a pool of reused `BusInstance`s (grown, never
 * rebuilt-and-discarded, matching GAME.md's no-per-frame-allocation rule) — pure readout of
 * `busPositionAt`, the renderer asks, never integrates. */
export function updateBuses(
  cityScene: CityScene,
  schedules: readonly LineBusSchedule[],
  totalMinutes: number,
  viewportHeightPx: number,
  palette: PaperPalette,
): void {
  let poolIndex = 0;
  const ensureInstance = (): BusInstance => {
    let instance = cityScene.busPool[poolIndex];
    if (!instance) {
      instance = createBusInstance(getBusBodyColor(palette), getBusStripeColor(palette, 0), palette.ink);
      cityScene.busGroup.add(instance.group);
      cityScene.busPool.push(instance);
      cityScene.idRegistry.register(busIdTag(instance, cityScene.ids.bus, palette.ink));
    }
    poolIndex += 1;
    return instance;
  };

  for (const entry of schedules) {
    if (entry.busCount <= 0) continue;
    const stripeColor = getBusStripeColor(palette, entry.lineId);
    for (let busIndex = 0; busIndex < entry.busCount; busIndex++) {
      const pos = busPositionAt(entry.schedule, busIndex, entry.busCount, totalMinutes, busPositionScratch);
      const instance = ensureInstance();
      if (!pos) {
        instance.group.visible = false;
        continue;
      }
      instance.group.visible = true;
      (instance.stripe.material as THREE.MeshLambertMaterial).color.set(stripeColor);
      const [x, z] = toLocalXZ(cityScene.origin, pos.lngLat);
      placeBus(instance, x, z, pos.bearing);

      const distance = cityScene.camera.position.distanceTo(new THREE.Vector3(x, 0, z));
      const projectedPx = projectedLengthPx(BUS_LENGTH_M, distance, CAMERA_FOV_DEG, viewportHeightPx);
      applyBusScale(instance, busWorldScaleMultiplier(projectedPx));
    }
  }

  for (; poolIndex < cityScene.busPool.length; poolIndex++) {
    cityScene.busPool[poolIndex]!.group.visible = false;
  }
}

/**
 * The outline mesh is already a flat, unlit `MeshBasicMaterial` scaled slightly larger than the
 * body — reused as the id proxy (instead of allocating a fourth mesh) rather than
 * `proxyTag`'s "separate hidden proxy" idiom, because this proxy is *already visible* in the
 * beauty pass (it's the vehicle's outline). So the id tag both hides body/stripe (so they don't
 * shade the id buffer with lit color) *and* swaps the outline's own color to the id color for the
 * duration of the pass, restoring `--ink` after. The id pass's footprint is the outline's own
 * silhouette — slightly larger than the body's, matching "segment the whole vehicle" rather than
 * undercounting by the outline's own margin.
 */
function busIdTag(instance: BusInstance, idColor: THREE.Color, inkHex: string): import('./idPass').IdTag {
  const outlineMaterial = instance.outline.material as THREE.MeshBasicMaterial;
  return {
    idColor,
    apply() {
      instance.body.visible = false;
      instance.stripe.visible = false;
      outlineMaterial.color.copy(idColor);
    },
    restore() {
      instance.body.visible = true;
      instance.stripe.visible = true;
      outlineMaterial.color.set(inkHex);
    },
  };
}
