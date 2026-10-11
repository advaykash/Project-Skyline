/**
 * The OrbitWatch 3D scene.
 *
 * FRAME: the scene is Earth-fixed (see src/orbital/constants.ts). The Earth mesh
 * never rotates; satellites and orbit paths are transformed from ECEF by the
 * single documented permutation. The sun direction drives the real terminator.
 *
 * RESOURCE DISCIPLINE:
 *   • One draw call for the entire marker catalogue (THREE.Points).
 *   • Positions arrive from the propagation worker and are written in place.
 *   • The selected object is propagated on the main thread once per frame so its
 *     highlight and label track smoothly without dragging the whole catalogue
 *     up to frame rate.
 *   • Geometries, materials, textures and the worker are disposed explicitly.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildSatrec, propagateState, type GpRecord } from '../orbital/elements';
import type { SatelliteState } from '../orbital/types';
import { computeGroundTrack, computeOrbitPath } from '../orbital/orbit-path';
import { deriveElements } from '../orbital/derived';
import { toCatalogObject } from '../orbital/elements';
import { createEarthMaterials, updateSunUniforms, type EarthTextures } from './earth';
import { createStarfield } from './stars';
import {
  CATEGORY_COLORS,
  createSatellitePoints,
  paintCategory,
  writePositions,
} from './satellitePoints';
import { advance as advanceClock, claimPump, getTimeMs, releasePump } from '../state/clock';
import type { LayerVisibility } from '../state/store';

export interface GlobeCallbacks {
  onPick(noradId: number | null): void;
  onHover(noradId: number | null): void;
  onWebGLError(message: string): void;
  onWorkerStatus(status: { ready: boolean; failures: number; lastTickMs: number | null }): void;
}

export interface GlobeOptions {
  canvas: HTMLCanvasElement;
  labelLayer: HTMLElement;
  callbacks: GlobeCallbacks;
  textures?: Promise<EarthTextures>;
}

const CATEGORY_BY_GROUP: Record<string, string> = {
  stations: 'crewed',
  visual: 'visual',
  active: 'catalog',
  starlink: 'constellation',
  weather: 'earth-observation',
  science: 'science',
  'fengyun-1c-debris': 'debris',
  'cosmos-2251-debris': 'debris',
  'iridium-33-debris': 'debris',
  'gps-ops': 'navigation',
  geo: 'catalog',
  oneweb: 'constellation',
  'last-30-days': 'catalog',
};

export function categoryForGroup(group: string): string {
  return CATEGORY_BY_GROUP[group] ?? 'catalog';
}

export class GlobeEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;

  private readonly earthGroup = new THREE.Group();
  private earthSurface!: THREE.Mesh;
  private earthClouds!: THREE.Mesh;
  private earthAtmosphere!: THREE.Mesh;
  private materials!: ReturnType<typeof createEarthMaterials>;
  private stars!: THREE.Points;

  private satPoints: THREE.Points;
  private satGeometry: THREE.BufferGeometry;
  private satMaterial: THREE.ShaderMaterial;
  private satCount = 0;

  private selectionMarker!: THREE.Group;
  private selectionRing!: THREE.Mesh;
  private selectionDot!: THREE.Mesh;

  private orbitLine: THREE.Line | null = null;
  private groundLines: THREE.Line[] = [];

  private readonly options: GlobeOptions;
  private worker: Worker | null = null;
  private workerReady = false;
  private workerFailures = 0;
  private tickTimer: number | null = null;
  private tickId = 0;
  private pendingTickId = 0;
  private lastTickRequestedAt = 0;
  private lastOrbitRebuildMs = 0;
  private lastOrbitRebuildTime = 0;

  private records: GpRecord[] = [];
  private selectedRecord: GpRecord | null = null;
  private selectedSatrec: ReturnType<typeof buildSatrec> | null = null;
  private selectedNoradId: number | null = null;
  private layers: LayerVisibility | null = null;
  private followSelection = false;

  private pointerNdc = new THREE.Vector2(0, 0);
  private hoverFrame = 0;
  private disposed = false;
  private frameHandle = 0;
  private readonly labelEl: HTMLDivElement;

  constructor(options: GlobeOptions) {
    this.options = options;

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x06090f, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
    this.camera.position.set(2.45, 1.15, 2.6);

    this.controls = new OrbitControls(this.camera, options.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.42;
    this.controls.zoomSpeed = 0.75;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.32;
    this.controls.maxDistance = 14;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI - 0.12;

    const initial = createSatellitePoints(64);
    this.satPoints = initial.points;
    this.satGeometry = initial.geometry;
    this.satMaterial = initial.material;

    this.labelEl = document.createElement('div');
    this.labelEl.className = 'sat-label';
    this.labelEl.style.display = 'none';
    options.labelLayer.appendChild(this.labelEl);

    this.buildStaticScene();
    this.attachEvents();
  }

  /* ---------------------------------------------------------------- setup */

  private buildStaticScene(): void {
    this.scene.add(this.earthGroup);
    const textures: EarthTextures = { day: null, night: null, specular: null, clouds: null };
    this.materials = createEarthMaterials(textures);

    this.earthSurface = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), this.materials.surface);
    this.earthClouds = new THREE.Mesh(new THREE.SphereGeometry(1.0025, 96, 48), this.materials.clouds);
    this.earthAtmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.028, 96, 48), this.materials.atmosphere);
    this.earthClouds.name = 'clouds';
    this.earthAtmosphere.name = 'atmosphere';
    this.earthGroup.add(this.earthSurface, this.earthClouds, this.earthAtmosphere);

    this.stars = createStarfield();
    this.scene.add(this.stars);

    this.scene.add(this.satPoints);

    this.buildSelectionMarker();
  }

  private buildSelectionMarker(): void {
    this.selectionMarker = new THREE.Group();
    const ringGeometry = new THREE.RingGeometry(0.026, 0.034, 48);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x56a5ff,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const dotGeometry = new THREE.CircleGeometry(0.011, 24);
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: 0xbfe0ff,
      transparent: true,
      opacity: 1,
      depthTest: false,
    });
    this.selectionRing = new THREE.Mesh(ringGeometry, ringMaterial);
    this.selectionDot = new THREE.Mesh(dotGeometry, dotMaterial);
    this.selectionMarker.add(this.selectionRing, this.selectionDot);
    this.selectionMarker.visible = false;
    this.selectionMarker.renderOrder = 10;
    this.scene.add(this.selectionMarker);
  }

  /** Load the bundled textures; every slot degrades gracefully on failure. */
  async loadTextures(load: () => Promise<EarthTextures>): Promise<void> {
    try {
      const textures = await load();
      if (textures.day) {
        textures.day.colorSpace = THREE.SRGBColorSpace;
        this.materials.surface.uniforms.dayMap.value = textures.day;
        this.materials.surface.uniforms.hasDay.value = 1;
      }
      if (textures.night) {
        textures.night.colorSpace = THREE.SRGBColorSpace;
        this.materials.surface.uniforms.nightMap.value = textures.night;
        this.materials.surface.uniforms.hasNight.value = 1;
      }
      if (textures.specular) {
        this.materials.surface.uniforms.specularMap.value = textures.specular;
        this.materials.surface.uniforms.hasSpecular.value = 1;
      }
      if (textures.clouds) {
        this.materials.clouds.uniforms.cloudMap.value = textures.clouds;
        this.earthClouds.visible = true;
      } else {
        this.earthClouds.visible = false;
      }
      if (this.layers) this.setLayers(this.layers);
    } catch (error) {
      // Textures are enhancement only; the scene works without them.
      console.warn('[OrbitWatch] Earth textures failed to load; using the fallback surface.', error);
    }
  }

  private attachEvents(): void {
    const canvas = this.options.canvas;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('resize', this.onResize);
    this.onResize();
    claimPump('globe-engine');
    this.frameHandle = requestAnimationFrame(this.animate);
  }

  /* --------------------------------------------------------------- catalog */

  /**
   * Install a catalogue. Rebuilds the point buffer (once per group change) and
   * hands the records to the propagation worker.
   */
  setCatalog(records: GpRecord[], group: string): void {
    this.records = records;
    this.satCount = records.length;

    // Rebuild buffers at the new capacity (not per frame).
    this.scene.remove(this.satPoints);
    this.satGeometry.dispose();
    this.satMaterial.dispose();
    const created = createSatellitePoints(Math.max(records.length, 1));
    this.satPoints = created.points;
    this.satGeometry = created.geometry;
    this.satMaterial = created.material;
    this.scene.add(this.satPoints);
    // Carry the shader uniforms on the geometry so paintCategory can retune
    // the marker look per catalogue density.
    this.satGeometry.userData.shaderUniforms = this.satMaterial.uniforms;
    paintCategory(this.satGeometry, records.length, categoryForGroup(group));

    this.disposeWorker();
    this.workerReady = false;
    this.workerFailures = 0;
    this.worker = new Worker(new URL('../workers/propagator.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener('message', this.onWorkerMessage);
    this.worker.addEventListener('error', this.onWorkerError);
    this.worker.postMessage({ type: 'catalog', id: ++this.tickId, records });

    this.rebuildOrbitGeometry(true);
  }

  private onWorkerMessage = (event: MessageEvent): void => {
    const message = event.data as
      | { type: 'ready'; count: number; failures: unknown[] }
      | { type: 'positions'; timeMs: number; positions: Float32Array; durationMs: number }
      | { type: 'error'; message: string };

    if (message.type === 'ready') {
      this.workerReady = true;
      this.workerFailures = message.failures.length;
      this.options.callbacks.onWorkerStatus({
        ready: true,
        failures: message.failures.length,
        lastTickMs: null,
      });
      this.requestTick();
      return;
    }
    if (message.type === 'positions') {
      if (message.positions.length !== this.satCount * 3) return;
      writePositions(this.satGeometry, message.positions);
      this.options.callbacks.onWorkerStatus({
        ready: true,
        failures: this.workerFailures,
        lastTickMs: message.durationMs,
      });
      return;
    }
    if (message.type === 'error') {
      console.error('[OrbitWatch] propagation worker error:', message.message);
    }
  };

  private onWorkerError = (event: ErrorEvent): void => {
    console.error('[OrbitWatch] propagation worker failed:', event.message);
    this.options.callbacks.onWorkerStatus({ ready: false, failures: 0, lastTickMs: null });
  };

  /** Propagation cadence: fast for small catalogues, economical for large ones. */
  private tickIntervalMs(): number {
    const n = this.satCount;
    if (n <= 400) return 250;
    if (n <= 2500) return 600;
    if (n <= 8000) return 1200;
    return 1800;
  }

  private requestTick(): void {
    if (!this.worker || !this.workerReady) return;
    const now = performance.now();
    if (now - this.lastTickRequestedAt < this.tickIntervalMs()) {
      this.scheduleTick();
      return;
    }
    this.lastTickRequestedAt = now;
    this.pendingTickId = ++this.tickId;
    this.worker.postMessage({ type: 'tick', id: this.pendingTickId, timeMs: getTimeMs() });
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (this.tickTimer !== null) window.clearTimeout(this.tickTimer);
    this.tickTimer = window.setTimeout(() => {
      this.tickTimer = null;
      this.requestTick();
    }, this.tickIntervalMs());
  }

  private disposeWorker(): void {
    if (this.tickTimer !== null) window.clearTimeout(this.tickTimer);
    this.tickTimer = null;
    if (this.worker) {
      this.worker.removeEventListener('message', this.onWorkerMessage);
      this.worker.removeEventListener('error', this.onWorkerError);
      this.worker.terminate();
      this.worker = null;
    }
    this.workerReady = false;
  }

  /* ----------------------------------------------------------- selection */

  setSelected(noradId: number | null): void {
    this.selectedNoradId = noradId;
    this.selectedRecord = noradId === null ? null : (this.records.find((r) => Number(r.NORAD_CAT_ID) === noradId) ?? null);
    this.selectedSatrec = null;
    if (this.selectedRecord) {
      try {
        this.selectedSatrec = buildSatrec(this.selectedRecord);
      } catch (error) {
        console.error('[OrbitWatch] cannot build a propagator for the selection:', error);
        this.selectedSatrec = null;
      }
    }
    this.selectionMarker.visible = Boolean(this.selectedSatrec);
    this.rebuildOrbitGeometry(true);
  }

  setLayers(layers: LayerVisibility): void {
    this.layers = layers;
    this.earthClouds.visible = layers.clouds && Boolean(this.materials.clouds.uniforms.cloudMap.value);
    this.earthAtmosphere.visible = layers.atmosphere;
    (this.materials.surface.uniforms.hasNight as { value: number }).value = layers.nightLights
      ? this.materials.surface.uniforms.hasNight.value
      : 0;
    if (this.orbitLine) this.orbitLine.visible = layers.orbits;
    for (const line of this.groundLines) line.visible = layers.groundTracks;
    this.labelEl.style.display = layers.labels && this.selectedNoradId !== null ? 'block' : 'none';
  }

  setFollow(follow: boolean): void {
    this.followSelection = follow;
    if (!follow) return;
  }

  /* -------------------------------------------------------- orbit visuals */

  private rebuildOrbitGeometry(force = false): void {
    const now = performance.now();
    const simTime = getTimeMs();
    // Wall-clock throttle first: at 7200x the simulation time jumps by minutes
    // every frame, and rebuilding path geometry every frame would dominate the
    // main thread. At most one rebuild per 3 s, never more.
    if (!force && now - this.lastOrbitRebuildMs < 3_000) return;
    if (
      !force &&
      now - this.lastOrbitRebuildMs < 20_000 &&
      Math.abs(simTime - this.lastOrbitRebuildTime) < 60_000
    ) {
      return;
    }
    this.lastOrbitRebuildMs = now;
    this.lastOrbitRebuildTime = simTime;

    if (this.orbitLine) {
      this.scene.remove(this.orbitLine);
      this.orbitLine.geometry.dispose();
      (this.orbitLine.material as THREE.Material).dispose();
      this.orbitLine = null;
    }
    for (const line of this.groundLines) {
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.groundLines = [];

    if (!this.selectedSatrec || !this.selectedRecord) return;

    const object = toCatalogObject(this.selectedRecord, 0, simTime);
    const derived = deriveElements(object);

    const path = computeOrbitPath(
      this.selectedSatrec,
      this.selectedNoradId ?? 0,
      simTime,
      this.selectedRecord.MEAN_MOTION,
      260,
    );
    if (path && path.count > 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(path.positions, 3));
      const material = new THREE.LineBasicMaterial({
        color: 0x56a5ff,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      });
      this.orbitLine = new THREE.Line(geometry, material);
      this.orbitLine.frustumCulled = false;
      this.orbitLine.renderOrder = 5;
      this.orbitLine.visible = this.layers?.orbits ?? true;
      this.scene.add(this.orbitLine);
    }

    const track = computeGroundTrack(
      this.selectedSatrec,
      this.selectedNoradId ?? 0,
      simTime,
      this.selectedRecord.MEAN_MOTION,
      1,
      220,
    );
    if (track) {
      for (const segment of track.segments) {
        if (segment.count < 2) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(segment.positions, 3));
        const material = new THREE.LineBasicMaterial({
          color: 0xffd479,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
        });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        line.renderOrder = 6;
        line.visible = this.layers?.groundTracks ?? true;
        this.scene.add(line);
        this.groundLines.push(line);
      }
    }

    void derived;
  }

  /* ------------------------------------------------------------- picking */

  /** Project every marker and find the closest to the pointer, in pixels. */
  private pickAt(ndcX: number, ndcY: number, thresholdPx?: number): number | null {
    if (this.satCount === 0) return null;
    // Dense catalogues need a tighter radius, or everything within a finger's
    // width becomes a hit target.
    const radius = thresholdPx ?? (this.satCount > 8000 ? 7 : this.satCount > 2500 ? 10 : 14);
    const positions = this.satGeometry.getAttribute('position') as THREE.BufferAttribute;
    const array = positions.array as Float32Array;
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    const vector = new THREE.Vector3();
    let best: number | null = null;
    let bestDistanceSq = radius * radius;

    for (let i = 0; i < this.satCount; i += 1) {
      const x = array[i * 3];
      const y = array[i * 3 + 1];
      const z = array[i * 3 + 2];
      if (!Number.isFinite(x)) continue;
      vector.set(x, y, z).project(this.camera);
      if (vector.z > 1) continue; // behind the camera
      const sx = (vector.x * 0.5 + 0.5) * width;
      const sy = (-vector.y * 0.5 + 0.5) * height;
      const dx = sx - ((ndcX + 1) * 0.5) * width;
      const dy = sy - ((1 - ndcY) * 0.5) * height;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = i;
      }
    }
    return best === null ? null : Number(this.records[best]?.NORAD_CAT_ID) || null;
  }

  private onPointerMove = (event: PointerEvent): void => {
    const rect = this.options.canvas.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const noradId = this.pickAt(this.pointerNdc.x, this.pointerNdc.y);
      this.options.callbacks.onHover(noradId);
    });
  };

  private onPointerLeave = (): void => {
    this.options.callbacks.onHover(null);
  };

  private onClick = (event: MouseEvent): void => {
    const rect = this.options.canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const noradId = this.pickAt(ndcX, ndcY);
    this.options.callbacks.onPick(noradId);
  };

  private onDoubleClick = (): void => {
    this.focusSelected();
  };

  /* -------------------------------------------------------------- camera */

  focusSelected(): void {
    if (!this.selectedSatrec) return;
    const state = this.currentState();
    if (!state) return;
    const target = new THREE.Vector3(state.scene.x, state.scene.y, state.scene.z);
    const direction = target.clone().normalize();
    const distance = Math.max(1.45, target.length() + 0.32);
    const desired = direction.multiplyScalar(distance);
    this.animateCamera(desired, target, 650);
  }

  resetCamera(): void {
    this.followSelection = false;
    this.animateCamera(new THREE.Vector3(2.45, 1.15, 2.6), new THREE.Vector3(0, 0, 0), 700);
  }

  private cameraTween: {
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    start: number;
    duration: number;
  } | null = null;

  private animateCamera(toPos: THREE.Vector3, toTarget: THREE.Vector3, durationMs: number): void {
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cameraTween = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
      start: performance.now(),
      duration: reduced ? 1 : durationMs,
    };
  }

  private currentState(): SatelliteState | null {
    if (!this.selectedSatrec || this.selectedNoradId === null) return null;
    return propagateState(this.selectedSatrec, this.selectedNoradId, new Date(getTimeMs()));
  }

  /* --------------------------------------------------------------- loop */

  private onResize = (): void => {
    const parent = this.options.canvas.parentElement;
    const width = Math.max(parent?.clientWidth ?? window.innerWidth, 1);
    const height = Math.max(parent?.clientHeight ?? window.innerHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.satMaterial.uniforms.viewportHeight.value = height * this.renderer.getPixelRatio();
  };

  private animate = (wallMs: number): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.animate);

    advanceClock(wallMs, 'globe-engine');
    const simTime = getTimeMs();
    const simDate = new Date(simTime);

    updateSunUniforms(this.materials, simDate);

    // Camera tweening (ease-out cubic).
    if (this.cameraTween) {
      const t = Math.min((performance.now() - this.cameraTween.start) / this.cameraTween.duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.cameraTween.fromPos, this.cameraTween.toPos, eased);
      this.controls.target.lerpVectors(this.cameraTween.fromTarget, this.cameraTween.toTarget, eased);
      if (t >= 1) this.cameraTween = null;
    }

    // Selected-object highlight, label and camera follow — one SGP4 call/frame.
    if (this.selectedSatrec && this.selectedNoradId !== null) {
      const state = this.currentState();
      if (state && state.error === null) {
        const position = new THREE.Vector3(state.scene.x, state.scene.y, state.scene.z);
        this.selectionMarker.visible = true;
        this.selectionMarker.position.copy(position);
        this.selectionRing.quaternion.copy(this.camera.quaternion);
        this.selectionDot.quaternion.copy(this.camera.quaternion);

        if (this.followSelection && !this.cameraTween) {
          const delta = position.clone().sub(this.controls.target);
          this.controls.target.add(delta.multiplyScalar(0.12));
          this.camera.position.add(delta);
        }

        if (this.layers?.labels ?? true) {
          const projected = position.clone().project(this.camera);
          const width = this.renderer.domElement.clientWidth;
          const height = this.renderer.domElement.clientHeight;
          const x = (projected.x * 0.5 + 0.5) * width;
          const y = (-projected.y * 0.5 + 0.5) * height;
          const visible = projected.z < 1 && x > -80 && x < width + 80 && y > -40 && y < height + 40;
          this.labelEl.style.display = visible ? 'block' : 'none';
          if (visible) {
            this.labelEl.style.left = `${x}px`;
            this.labelEl.style.top = `${y}px`;
            const name = this.selectedRecord?.OBJECT_NAME ?? `NORAD ${this.selectedNoradId}`;
            this.labelEl.textContent = `${String(name).trim()} · ${state.geodetic.altitudeKm.toFixed(0)} km`;
          }
        }
      } else {
        this.selectionMarker.visible = false;
        this.labelEl.style.display = 'none';
      }

      // Keep the drawn orbit coherent with the current time. The rebuild call
      // is internally throttled to at most one per few seconds.
      this.rebuildOrbitGeometry();
    } else {
      this.selectionMarker.visible = false;
      this.labelEl.style.display = 'none';
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    // Periodic catalogue propagation request (worker cadence).
    this.requestTick();
  };

  /* ------------------------------------------------------------- dispose */

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    releasePump('globe-engine');
    this.disposeWorker();
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);

    const canvas = this.options.canvas;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('click', this.onClick);
    canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('resize', this.onResize);

    this.labelEl.remove();
    this.controls.dispose();

    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
  }
}

export { CATEGORY_COLORS };
