/**
 * Satellite marker rendering.
 *
 * One THREE.Points buffer holds the whole catalogue (instanced by construction),
 * so a 16,000-object catalogue is a single draw call. Positions come from the
 * propagation worker as a transferred Float32Array; the engine updates the
 * buffer attribute in place and never rebuilds geometry per frame.
 *
 * A record that failed to propagate keeps the `(0, 0, 0)` placeholder — an
 * impossible scene position (the Earth's centre, which no real orbit occupies).
 * The vertex shader clips anything with `dot(position, position) < 0.25`, so the
 * slot is never rasterised, no NaN ever reaches the GPU, and the engine reports
 * the failure through the interface instead of drawing a substitute position.
 */
import * as THREE from 'three';

export interface CategoryPalette {
  [category: string]: number;
}

/** Matches the CSS category tokens exactly, so the legend and the globe agree. */
export const CATEGORY_COLORS: CategoryPalette = {
  crewed: 0x7cc7ff,
  constellation: 0x8fe3b0,
  debris: 0xf0a878,
  navigation: 0xc7b1ff,
  science: 0x7fe0e6,
  visual: 0xffe08a,
  'earth-observation': 0x7fc4ff,
  catalog: 0x9fb6d0,
};

/**
 * Squared scene radius below which a vertex is treated as the "no position"
 * placeholder. The Earth's mean radius is 1 scene unit, so no genuine fix can
 * fall inside it; `(0,0,0)` (and any NaN, which compares false) is discarded.
 */
export const MARKER_PLACEHOLDER_RADIUS_SQ = 0.25;

const VERT = /* glsl */ `
  attribute float pointSize;
  attribute vec3 color;
  uniform float viewportHeight;
  uniform float maxSize;
  varying vec3 vColor;

  void main() {
    vColor = color;
    // Failed propagations sit at (0,0,0) — the Earth's centre. Clip those slots
    // (dot(position, position) < 0.25) by parking them outside the clip volume
    // with a collapsed point size, rather than shipping NaN to the rasteriser.
    if (dot(position, position) < 0.25) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float scale = viewportHeight * 0.5 / max(-mvPosition.z, 0.001);
    gl_PointSize = clamp(pointSize * scale, 1.15, maxSize);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAG = /* glsl */ `
  uniform float glow;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    // glow interpolates between a crisp dot (0, dense catalogues) and a soft
    // halo (1, sparse catalogues) so 16k markers never cover the Earth.
    float edge = mix(smoothstep(0.25, 0.16, r2), smoothstep(0.25, 0.02, r2), glow);
    float core = mix(smoothstep(0.14, 0.0, r2) * 0.25, smoothstep(0.10, 0.0, r2), glow);
    gl_FragColor = vec4(vColor * (0.6 + 0.7 * core), edge * mix(0.85, 0.95, glow));
  }
`;

export function createSatellitePoints(capacity: number): {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
} {
  const geometry = new THREE.BufferGeometry();
  // Zero-filled: an unpropagated slot is the (0,0,0) placeholder, which the
  // vertex shader clips. Never NaN — NaN leaves the rasteriser with undefined
  // behaviour and poisons picking maths.
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity).fill(2.2);

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('pointSize', new THREE.BufferAttribute(sizes, 1));
  // A fixed bounding sphere keeps placeholder positions from breaking frustum
  // culling; the marker object is also drawn with `frustumCulled = false`.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 20);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      viewportHeight: { value: 900 },
      glow: { value: 1 },
      maxSize: { value: 13 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.name = 'satellites';
  return { points, geometry, material };
}

/**
 * Per-object colour/size paint for one category. Markers shrink as a catalogue
 * grows so a 16k-object group reads as texture instead of covering the Earth,
 * while a 22-object group keeps comfortable, clickable markers.
 */
export function paintCategory(geometry: THREE.BufferGeometry, count: number, category: string): THREE.Color {
  const color = new THREE.Color(CATEGORY_COLORS[category] ?? CATEGORY_COLORS.catalog);
  const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
  const sizes = geometry.getAttribute('pointSize') as THREE.BufferAttribute;
  const sizeScale = count > 8000 ? 0.34 : count > 2500 ? 0.44 : count > 600 ? 0.62 : 1;
  const glow = count > 2500 ? 0.15 : count > 600 ? 0.5 : 1;
  // The vertex shader clamps to `maxSize`; dense catalogues must lower the
  // clamp itself or every marker saturates at the sparse-catalogue ceiling.
  const maxSize = count > 8000 ? 6.5 : count > 2500 ? 8 : count > 600 ? 10 : 13;
  for (let i = 0; i < count; i += 1) {
    colors.setXYZ(i, color.r, color.g, color.b);
    // Small deterministic size jitter so dense clusters read as texture rather
    // than as a flat sheet — derived from the index, so it never changes on
    // update (no shimmering).
    const jitter = (2.15 + ((i * 2654435761) % 100) / 200) * sizeScale;
    sizes.setX(i, jitter);
  }
  colors.needsUpdate = true;
  sizes.needsUpdate = true;
  const uniforms = (geometry.userData.shaderUniforms ?? null) as {
    glow?: { value: number };
    maxSize?: { value: number };
  } | null;
  if (uniforms?.glow) uniforms.glow.value = glow;
  if (uniforms?.maxSize) uniforms.maxSize.value = maxSize;
  return color;
}

/** Overwrite the position buffer from a worker transfer. */
export function writePositions(geometry: THREE.BufferGeometry, positions: Float32Array): void {
  const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
  (attribute.array as Float32Array).set(positions.subarray(0, attribute.array.length));
  attribute.needsUpdate = true;
}

/**
 * True when a marker slot holds the `(0,0,0)` placeholder of a failed
 * propagation (or a stale NaN from an earlier build) and must be ignored.
 */
export function isPlaceholderPosition(x: number, y: number, z: number): boolean {
  // Written as a negated comparison so NaN — which fails every comparison —
  // counts as a placeholder too.
  return !(x * x + y * y + z * z >= MARKER_PLACEHOLDER_RADIUS_SQ);
}

/**
 * Write a single marker position in place. Used once per frame for the selected
 * object, whose state is propagated on the main thread so its highlight tracks
 * smoothly even when the whole-catalogue worker tick is far slower.
 */
export function writePosition(
  geometry: THREE.BufferGeometry,
  index: number,
  x: number,
  y: number,
  z: number,
): void {
  const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
  const array = attribute.array as Float32Array;
  const offset = index * 3;
  if (index < 0 || offset + 2 >= array.length) return;
  array[offset] = x;
  array[offset + 1] = y;
  array[offset + 2] = z;
  // Re-upload just this vertex where partial buffer updates are supported, so a
  // 16k-object catalogue does not re-upload 192 kB every frame.
  if (typeof attribute.addUpdateRange === 'function') attribute.addUpdateRange(offset, 3);
  attribute.needsUpdate = true;
}
