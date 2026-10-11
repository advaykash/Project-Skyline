/**
 * The Skyline 3D scene.
 *
 * FRAME: the scene is Earth-fixed (see src/orbital/constants.ts). The Earth mesh
 * never rotates; satellites and orbit paths are transformed from ECEF by the
 * single documented permutation. The sun direction drives the real terminator.
 *
 * RESOURCE DISCIPLINE:
 *   • One draw call for the entire marker catalogue (THREE.Points).
 *   • Positions arrive from the propagation worker and are written in place.
 *   • The selected object is propagated on the main thread once per frame so its
 *     highlight, label and own marker vertex track smoothly without dragging the
 *     whole catalogue up to frame rate.
 *   • Orbit and ground-track lines are pooled buffers redrawn with
 *     `setDrawRange`; no geometry or material is ever created or disposed while
 *     the simulation is running.
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
import { sunDirectionScene } from '../orbital/frames';
import {
  CATEGORY_COLORS,
  createSatellitePoints,
  isPlaceholderPosition,
  paintCategory,
  writePosition,
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

/** Base vertical field of view, in degrees, for landscape viewports. */
const BASE_FOV_DEG = 42;
/** Ceiling for the portrait widening below — beyond this the globe shrinks away. */
const MAX_PORTRAIT_FOV_DEG = 96;
/** Default camera distance from the Earth's centre, in scene units. */
const DEFAULT_CAMERA_DISTANCE = 3.75;
/** Orbit-path buffer capacity: 260 samples per period, plus headroom. */
const ORBIT_PATH_CAPACITY = 320;
/** Ground-track buffer capacity per segment: 220 samples per period, plus headroom. */
const GROUND_TRACK_CAPACITY = 240;
/** Pooled ground-track lines: one per antimeridian split of a one-period window. */
const GROUND_TRACK_SEGMENTS = 4;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Used as the cross-product reference when the Sun is near the scene's up axis. */
const WORLD_UP_ALT = new THREE.Vector3(0, 0, 1);

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

  /** Pooled line buffers: written in place, never reallocated after startup. */
  private orbitLine!: THREE.Line;
  private groundLines: THREE.Line[] = [];

  /** True once the corresponding texture slot actually loaded. */
  private nightTextureLoaded = false;
  private cloudTextureLoaded = false;

  private readonly options: GlobeOptions;
  private worker: Worker | null = null;
  private workerReady = false;
  private workerFailures = 0;
  private tickTimer: number | null = null;
  private tickId = 0;
  private pendingTickId = 0;
  /** Id of the most recent catalogue load; older worker answers are ignored. */
  private pendingCatalogId = 0;
  /** Highest tick id applied to the markers; older answers are ignored. */
  private appliedTickId = 0;
  private lastTickRequestedAt = 0;
  private lastOrbitRebuildMs = 0;
  private lastOrbitRebuildTime = 0;

  private records: GpRecord[] = [];
  private selectedRecord: GpRecord | null = null;
  private selectedSatrec: ReturnType<typeof buildSatrec> | null = null;
  private selectedNoradId: number | null = null;
  /** Index of the selection inside the marker buffer, for the per-frame update. */
  private selectedIndex: number | null = null;
  private layers: LayerVisibility | null = null;
  private followSelection = false;
  /** Set when a focus is requested before the selection has been installed. */
  private pendingFocus = false;

  private pointerNdc = new THREE.Vector2(0, 0);
  private hoverFrame = 0;
  private disposed = false;
  private contextLost = false;
  private frameHandle = 0;
  private readonly scratch = new THREE.Vector3();
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

    this.camera = new THREE.PerspectiveCamera(BASE_FOV_DEG, 1, 0.05, 400);
    // Open on the terminator: the day/night boundary runs across the disc, so
    // both the lit and the night side of the real terminator are visible at once.
    this.camera.position.copy(this.terminatorCameraPosition());

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
    this.buildOrbitPools();
  }

  /**
   * Pre-allocate the orbit-path and ground-track buffers once.
   *
   * They live in the scene for the whole session and are redrawn with
   * `setDrawRange`, so a rebuild — which happens on every selection change and
   * periodically while the simulation runs — never allocates a geometry, a
   * material or a GPU buffer.
   */
  private buildOrbitPools(): void {
    this.orbitLine = this.createPooledLine(ORBIT_PATH_CAPACITY, 0x56a5ff, 0.82, 5);
    this.scene.add(this.orbitLine);
    this.groundLines = [];
    for (let i = 0; i < GROUND_TRACK_SEGMENTS; i += 1) {
      const line = this.createPooledLine(GROUND_TRACK_CAPACITY, 0xffd479, 0.7, 6);
      this.scene.add(line);
      this.groundLines.push(line);
    }
  }

  private createPooledLine(
    capacity: number,
    color: number,
    opacity: number,
    renderOrder: number,
  ): THREE.Line {
    const geometry = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, 0);
    // Never frustum-culled: the pooled buffer always starts at the origin.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 20);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = renderOrder;
    line.visible = false;
    return line;
  }

  /** Copy `count` vertices into a pooled line and draw exactly that range. */
  private writePooledLine(line: THREE.Line, positions: Float32Array, count: number): number {
    const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const written = Math.max(0, Math.min(count, attribute.count));
    (attribute.array as Float32Array).set(positions.subarray(0, written * 3));
    attribute.needsUpdate = true;
    line.geometry.setDrawRange(0, written);
    return written;
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
      this.nightTextureLoaded = Boolean(textures.night);
      if (textures.night) {
        textures.night.colorSpace = THREE.SRGBColorSpace;
        this.materials.surface.uniforms.nightMap.value = textures.night;
        this.materials.surface.uniforms.hasNight.value = 1;
      }
      if (textures.specular) {
        this.materials.surface.uniforms.specularMap.value = textures.specular;
        this.materials.surface.uniforms.hasSpecular.value = 1;
      }
      this.cloudTextureLoaded = Boolean(textures.clouds);
      if (textures.clouds) {
        this.materials.clouds.uniforms.cloudMap.value = textures.clouds;
      }
      this.earthClouds.visible = this.cloudTextureLoaded && (this.layers?.clouds ?? true);
      if (this.layers) this.setLayers(this.layers);
    } catch (error) {
      // Textures are enhancement only; the scene works without them.
      console.warn('[Skyline] Earth textures failed to load; using the fallback surface.', error);
    }
  }

  private attachEvents(): void {
    const canvas = this.options.canvas;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    window.addEventListener('resize', this.onResize);
    this.onResize();
    claimPump('globe-engine');
    this.frameHandle = requestAnimationFrame(this.animate);
  }

  /**
   * A lost context is recoverable, but only if the default action is prevented:
   * otherwise the browser never fires `webglcontextrestored` and the canvas
   * stays dead. Rendering pauses; the clock, the worker and the interface carry
   * on so the application never looks frozen while the GPU recovers.
   */
  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    console.warn('[Skyline] WebGL context lost — rendering paused until the browser restores it.');
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    console.info('[Skyline] WebGL context restored — resuming rendering.');
    // The restored context starts with a fresh default framebuffer, so the
    // drawing-buffer size and projection have to be re-derived.
    this.onResize();
    this.requestTick();
  };

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
    this.pendingCatalogId = ++this.tickId;
    this.worker.postMessage({ type: 'catalog', id: this.pendingCatalogId, records });

    this.rebuildOrbitGeometry(true);
  }

  private onWorkerMessage = (event: MessageEvent): void => {
    const message = event.data as
      | { type: 'ready'; id: number; count: number; failures: unknown[] }
      | { type: 'positions'; id: number; timeMs: number; positions: Float32Array; durationMs: number }
      | { type: 'error'; message: string };

    if (message.type === 'ready') {
      // A catalogue switch terminates the old worker, but its already-posted
      // answer may still be in flight: only the awaited load unlocks ticks.
      if (message.id !== this.pendingCatalogId) return;
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
      // Ticks can queue behind a slow catalogue pass; answers arrive in order,
      // and only ever move the markers forward — an older answer can never
      // overwrite newer state.
      if (message.id <= this.appliedTickId) return;
      if (message.positions.length !== this.satCount * 3) return;
      this.appliedTickId = message.id;
      writePositions(this.satGeometry, message.positions);
      this.options.callbacks.onWorkerStatus({
        ready: true,
        failures: this.workerFailures,
        lastTickMs: message.durationMs,
      });
      return;
    }
    if (message.type === 'error') {
      console.error('[Skyline] propagation worker error:', message.message);
    }
  };

  private onWorkerError = (event: ErrorEvent): void => {
    console.error('[Skyline] propagation worker failed:', event.message);
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
    const index = noradId === null ? -1 : this.records.findIndex((r) => Number(r.NORAD_CAT_ID) === noradId);
    this.selectedRecord = index >= 0 ? this.records[index] : null;
    this.selectedIndex = index >= 0 ? index : null;
    this.selectedSatrec = null;
    if (this.selectedRecord) {
      try {
        this.selectedSatrec = buildSatrec(this.selectedRecord);
      } catch (error) {
        console.error('[Skyline] cannot build a propagator for the selection:', error);
        this.selectedSatrec = null;
      }
    }
    // A focus requested in the same interaction that set the selection — a
    // click on the globe or a result row — is honoured now that the propagation
    // state for the new object actually exists.
    if (this.pendingFocus) this.focusSelected();
    this.selectionMarker.visible = Boolean(this.selectedSatrec);
    this.rebuildOrbitGeometry(true);
  }

  setLayers(layers: LayerVisibility): void {
    this.layers = layers;
    this.earthClouds.visible = layers.clouds && this.cloudTextureLoaded;
    this.earthAtmosphere.visible = layers.atmosphere;
    // Set the uniform from the texture's *loaded* state, never by reading back
    // the value this method overwrote — reading back made "night lights off"
    // permanent, because the second toggle saw hasNight === 0 and kept it.
    (this.materials.surface.uniforms.hasNight as { value: number }).value =
      layers.nightLights && this.nightTextureLoaded ? 1 : 0;
    this.orbitLine.visible = layers.orbits;
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

    if (!this.selectedSatrec || !this.selectedRecord) {
      // Nothing selected: collapse the pooled ranges rather than freeing them.
      this.hidePooledLines();
      return;
    }

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
      this.writePooledLine(this.orbitLine, path.positions, path.count);
      this.orbitLine.visible = this.layers?.orbits ?? true;
    } else {
      this.orbitLine.geometry.setDrawRange(0, 0);
      this.orbitLine.visible = false;
    }

    const track = computeGroundTrack(
      this.selectedSatrec,
      this.selectedNoradId ?? 0,
      simTime,
      this.selectedRecord.MEAN_MOTION,
      1,
      220,
    );
    const segments = track ? track.segments.filter((segment) => segment.count >= 2) : [];
    this.growGroundTrackPool(segments.length);
    for (let i = 0; i < this.groundLines.length; i += 1) {
      const line = this.groundLines[i];
      const segment = segments[i];
      if (!segment) {
        line.geometry.setDrawRange(0, 0);
        line.visible = false;
        continue;
      }
      this.writePooledLine(line, segment.positions, segment.count);
      line.visible = this.layers?.groundTracks ?? true;
    }

    void derived;
  }

  private hidePooledLines(): void {
    this.orbitLine.geometry.setDrawRange(0, 0);
    this.orbitLine.visible = false;
    for (const line of this.groundLines) {
      line.geometry.setDrawRange(0, 0);
      line.visible = false;
    }
  }

  /**
   * Add ground-track lines only when an orbit genuinely needs more antimeridian
   * segments than the pool holds. Steady-state rendering never reaches this.
   */
  private growGroundTrackPool(needed: number): void {
    while (this.groundLines.length < needed) {
      const line = this.createPooledLine(GROUND_TRACK_CAPACITY, 0xffd479, 0.7, 6);
      this.scene.add(line);
      this.groundLines.push(line);
    }
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
      // Failed propagations sit at the (0,0,0) placeholder and are not targets.
      if (isPlaceholderPosition(x, y, z)) continue;
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

  /**
   * Fly the camera in towards the selected object.
   *
   * The camera moves onto the Earth-centre-to-satellite ray, a little beyond the
   * object, while the orbit target stays at (0,0,0). Looking at the origin keeps
   * the globe centred and the object on the view axis, instead of swinging the
   * whole scene sideways around a target that has drifted off-centre.
   */
  focusSelected(): void {
    if (!this.selectedSatrec || this.selectedNoradId === null) {
      // The interface sets the selection one commit after it asks for the
      // focus; remember the request instead of focusing the previous object.
      this.pendingFocus = true;
      return;
    }
    this.pendingFocus = false;
    const state = this.currentState();
    if (!state || state.error !== null) return;
    if (isPlaceholderPosition(state.scene.x, state.scene.y, state.scene.z)) return;
    const target = new THREE.Vector3(state.scene.x, state.scene.y, state.scene.z);
    const direction = target.clone().normalize();
    const distance = Math.max(1.45, target.length() + 0.32);
    const desired = direction.multiplyScalar(distance);
    this.controls.target.set(0, 0, 0);
    this.animateCamera(desired, new THREE.Vector3(0, 0, 0), 650);
  }

  resetCamera(): void {
    this.followSelection = false;
    this.controls.target.set(0, 0, 0);
    this.animateCamera(this.terminatorCameraPosition(), new THREE.Vector3(0, 0, 0), 700);
  }

  /**
   * A camera position in the terminator plane: perpendicular to the Sun
   * direction, so the day/night boundary runs across the middle of the disc and
   * both sides of it are visible, with a little elevation so the boundary reads
   * as a line rather than as the rim of the globe.
   */
  private terminatorCameraPosition(): THREE.Vector3 {
    const sun = sunDirectionScene(new Date(getTimeMs()));
    const sunDir = new THREE.Vector3(sun.x, sun.y, sun.z).normalize();
    // Pick a reference axis that is never parallel to the Sun, so the cross
    // product below stays well conditioned at any date.
    const reference = Math.abs(sunDir.dot(WORLD_UP)) > 0.985 ? WORLD_UP_ALT : WORLD_UP;
    const across = new THREE.Vector3().crossVectors(sunDir, reference).normalize();
    const elevation = 0.21; // ≈12°
    return across
      .multiplyScalar(Math.cos(elevation))
      .addScaledVector(WORLD_UP, Math.sin(elevation))
      .normalize()
      .multiplyScalar(DEFAULT_CAMERA_DISTANCE);
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
    const aspect = width / height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = aspect;
    // A portrait viewport would otherwise clip the globe to a strip: hold the
    // horizontal field of view constant and widen the vertical one instead.
    this.camera.fov =
      aspect >= 1
        ? BASE_FOV_DEG
        : Math.min(
            (2 * Math.atan(Math.tan((BASE_FOV_DEG * Math.PI) / 360) / Math.max(aspect, 0.35)) * 180) /
              Math.PI,
            MAX_PORTRAIT_FOV_DEG,
          );
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
        const position = this.scratch.set(state.scene.x, state.scene.y, state.scene.z);
        this.selectionMarker.visible = true;
        this.selectionMarker.position.copy(position);
        this.selectionRing.quaternion.copy(this.camera.quaternion);
        this.selectionDot.quaternion.copy(this.camera.quaternion);

        // Keep the selection's own marker vertex in step with the highlight.
        // The catalogue tick from the worker can be up to ~2 s behind frame
        // rate; without this the ring leads its own dot.
        if (this.selectedIndex !== null) {
          writePosition(this.satGeometry, this.selectedIndex, position.x, position.y, position.z);
        }

        if (this.followSelection && !this.cameraTween) {
          // Follow from the camera only: the orbit target stays at the Earth's
          // centre so the globe never drifts out of frame while following.
          this.controls.target.set(0, 0, 0);
          if (!isPlaceholderPosition(position.x, position.y, position.z)) {
            const distance = this.camera.position.length();
            const desired = position.clone().normalize().multiplyScalar(distance);
            this.camera.position.lerp(desired, 0.12);
          }
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

    // While the context is lost there is nothing to draw into; keep computing
    // clock and positions so the interface resumes exactly where it should.
    if (!this.contextLost) {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }

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
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
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
