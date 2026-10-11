/**
 * Procedural starfield — generated once at startup so the scene never depends
 * on a remote texture. Magnitude and colour follow a plausible stellar
 * distribution (mostly faint, mostly white-blue with a warm minority).
 */
import * as THREE from 'three';

export function createStarfield(count = 2600, radius = 90): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    // Uniform direction on the sphere.
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    positions[i * 3] = radius * s * Math.cos(theta);
    positions[i * 3 + 1] = radius * u;
    positions[i * 3 + 2] = radius * s * Math.sin(theta);

    // Brightness follows a steep magnitude distribution: many faint, few bright.
    const brightness = 0.25 + Math.pow(Math.random(), 3) * 0.75;
    const warm = Math.random();
    if (warm > 0.88) {
      colors[i * 3] = brightness;
      colors[i * 3 + 1] = brightness * 0.82;
      colors[i * 3 + 2] = brightness * 0.62;
    } else if (warm > 0.6) {
      colors[i * 3] = brightness * 0.78;
      colors[i * 3 + 1] = brightness * 0.86;
      colors[i * 3 + 2] = brightness;
    } else {
      colors[i * 3] = brightness;
      colors[i * 3 + 1] = brightness;
      colors[i * 3 + 2] = brightness;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  stars.name = 'starfield';
  return stars;
}
