/**
 * Earth texture loading.
 *
 * The textures are bundled locally in `public/textures/` (NASA Blue Marble /
 * Black Marble derivatives distributed with the three.js example assets — see
 * docs/CREDITS.md). Loading is best-effort per slot: a single missing file never
 * prevents the scene from starting.
 */
import * as THREE from 'three';
import type { EarthTextures } from './earth';

function loadTexture(url: string, loader: THREE.TextureLoader): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    loader.load(
      url,
      (texture) => resolve(texture),
      undefined,
      () => {
        console.warn(`[Skyline] texture unavailable: ${url}`);
        resolve(null);
      },
    );
  });
}

export async function loadEarthTextures(): Promise<EarthTextures> {
  const loader = new THREE.TextureLoader();
  const [day, night, specular, clouds] = await Promise.all([
    loadTexture('/textures/earth-day.jpg', loader),
    loadTexture('/textures/earth-night.jpg', loader),
    loadTexture('/textures/earth-specular.jpg', loader),
    loadTexture('/textures/earth-clouds.png', loader),
  ]);
  return { day, night, specular, clouds };
}
