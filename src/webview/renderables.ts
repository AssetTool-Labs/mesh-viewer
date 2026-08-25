import * as THREE from 'three';

export function hasRenderableGeometry(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((object) => {
    if (found) return;
    if (object.userData.isSplat === true) {
      const count = (object as unknown as { numSplats?: number }).numSplats;
      found = count === undefined || count > 0;
      return;
    }

    const candidate = object as THREE.Mesh | THREE.Points | THREE.Line;
    const geometry = candidate.geometry;
    const positions = geometry?.getAttribute('position');
    if (!geometry || !positions) return;
    const drawCount = geometry.index?.count ?? positions.count;
    if ((candidate as THREE.Mesh).isMesh) found = drawCount >= 3;
    else if ((candidate as THREE.Points).isPoints) found = drawCount > 0;
    else if ((candidate as THREE.Line).isLine) found = drawCount >= 2;
  });
  return found;
}