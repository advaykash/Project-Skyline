/**
 * Earth rendering: day/night surface with a real terminator, specular oceans,
 * night lights, a soft cloud layer and an atmospheric rim.
 *
 * Textures are bundled locally (NASA Blue Marble / Black Marble derivatives
 * distributed with the three.js examples; see docs/CREDITS.md). Every texture
 * slot degrades gracefully: if a file fails to load the material binds a 1×1
 * DataTexture fallback and the shader falls back to a plausible solid surface
 * instead of sampling an unbound unit, rendering black or breaking.
 */
import * as THREE from 'three';
import { sunDirectionScene } from '../orbital/frames';

export interface EarthTextures {
  day: THREE.Texture | null;
  night: THREE.Texture | null;
  specular: THREE.Texture | null;
  clouds: THREE.Texture | null;
}

const EARTH_SURFACE_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosW = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const EARTH_SURFACE_FRAG = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D specularMap;
  uniform vec3 sunDirection;
  uniform float hasDay;
  uniform float hasNight;
  uniform float hasSpecular;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 sunDir = normalize(sunDirection);
    float sunDot = dot(n, sunDir);

    vec3 viewDir = normalize(cameraPosition - vPosW);

    // Day texture, with a gentle diffuse falloff towards the terminator.
    vec3 dayColor = mix(vec3(0.055, 0.085, 0.135), texture2D(dayMap, vUv).rgb, hasDay);
    float diffuse = 0.16 + 0.84 * clamp(sunDot, 0.0, 1.0);
    vec3 lit = dayColor * diffuse;

    // Night lights appear only where the surface is actually dark.
    vec3 lights = texture2D(nightMap, vUv).rgb * hasNight;
    float nightAmount = smoothstep(0.08, -0.22, sunDot);
    lit += lights * nightAmount * vec3(1.0, 0.86, 0.62);

    // Ocean specular: the specular map is white over water, dark over land.
    // Every pow() base is clamped away from zero: pow(0, n) and denormal bases
    // produce flicker (and, for a negative base, NaN) on some mobile GPUs.
    float specMask = texture2D(specularMap, vUv).r * hasSpecular;
    vec3 halfV = normalize(sunDir + viewDir);
    float spec = pow(clamp(dot(n, halfV), 0.0001, 1.0), 48.0) * specMask;
    lit += vec3(0.55, 0.62, 0.72) * spec * clamp(sunDot * 4.0, 0.0, 1.0);

    // Atmospheric haze along the limb, warmed near the terminator.
    float fresnel = pow(clamp(1.0 - max(dot(n, viewDir), 0.0), 0.0001, 1.0), 2.6);
    float litAmount = smoothstep(-0.25, 0.35, sunDot);
    lit += fresnel * litAmount * vec3(0.16, 0.24, 0.38);
    float twilight = smoothstep(-0.32, 0.02, sunDot) * (1.0 - smoothstep(0.02, 0.42, sunDot));
    lit += fresnel * twilight * vec3(0.34, 0.17, 0.07);

    gl_FragColor = vec4(lit, 1.0);
  }
`;

const CLOUD_FRAG = /* glsl */ `
  uniform sampler2D cloudMap;
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec3 vNormalW;

  void main() {
    vec4 cloud = texture2D(cloudMap, vUv);
    vec3 n = normalize(vNormalW);
    float sunDot = dot(n, normalize(sunDirection));
    float lit = smoothstep(-0.18, 0.30, sunDot);
    gl_FragColor = vec4(cloud.rgb * (0.22 + 0.78 * lit), cloud.a * 0.82 * lit);
  }
`;

const CLOUD_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMO_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosW = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const ATMO_FRAG = /* glsl */ `
  uniform vec3 sunDirection;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 viewDir = normalize(cameraPosition - vPosW);
    float rim = pow(clamp(1.0 - abs(dot(n, viewDir)), 0.0001, 1.0), 3.2);
    float sunDot = dot(n, normalize(sunDirection));
    float lit = smoothstep(-0.35, 0.55, sunDot);
    float twilight = smoothstep(-0.30, 0.05, sunDot) * (1.0 - smoothstep(0.05, 0.5, sunDot));
    vec3 color = rim * (lit * vec3(0.22, 0.42, 0.85) + twilight * vec3(0.85, 0.38, 0.16) * 0.8);
    gl_FragColor = vec4(color, rim * (0.28 + 0.72 * lit));
  }
`;

/**
 * 1×1 fallback for a texture slot whose real asset did not load.
 *
 * Binding a real — if tiny — texture keeps every `sampler2D` satisfied, instead
 * of leaving a null uniform that some drivers sample undefined. The `has*`
 * uniforms still decide whether the sample contributes anything, and the cloud
 * slot is transparent, so an unloaded layer draws nothing.
 */
function createPixelTexture(r: number, g: number, b: number, a: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

export function createEarthMaterials(textures: EarthTextures): {
  surface: THREE.ShaderMaterial;
  clouds: THREE.ShaderMaterial;
  atmosphere: THREE.ShaderMaterial;
} {
  // Slots that failed to load get a 1×1 fallback rather than a null sampler.
  const dayFallback = createPixelTexture(20, 28, 40, 255);
  const nightFallback = createPixelTexture(0, 0, 0, 255);
  const specularFallback = createPixelTexture(0, 0, 0, 255);
  const cloudFallback = createPixelTexture(0, 0, 0, 0);

  const surface = new THREE.ShaderMaterial({
    vertexShader: EARTH_SURFACE_VERT,
    fragmentShader: EARTH_SURFACE_FRAG,
    uniforms: {
      dayMap: { value: textures.day ?? dayFallback },
      nightMap: { value: textures.night ?? nightFallback },
      specularMap: { value: textures.specular ?? specularFallback },
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      hasDay: { value: textures.day ? 1 : 0 },
      hasNight: { value: textures.night ? 1 : 0 },
      hasSpecular: { value: textures.specular ? 1 : 0 },
    },
  });

  const clouds = new THREE.ShaderMaterial({
    vertexShader: CLOUD_VERT,
    fragmentShader: CLOUD_FRAG,
    uniforms: {
      cloudMap: { value: textures.clouds ?? cloudFallback },
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    },
    transparent: true,
    depthWrite: false,
  });

  const atmosphere = new THREE.ShaderMaterial({
    vertexShader: ATMO_VERT,
    fragmentShader: ATMO_FRAG,
    uniforms: {
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });

  return { surface, clouds, atmosphere };
}

/** Update sun-facing uniforms for one frame. */
export function updateSunUniforms(
  materials: { surface: THREE.ShaderMaterial; clouds: THREE.ShaderMaterial; atmosphere: THREE.ShaderMaterial },
  date: Date,
): void {
  const sun = sunDirectionScene(date);
  const vector = new THREE.Vector3(sun.x, sun.y, sun.z);
  materials.surface.uniforms.sunDirection.value.copy(vector);
  materials.clouds.uniforms.sunDirection.value.copy(vector);
  materials.atmosphere.uniforms.sunDirection.value.copy(vector);
}
