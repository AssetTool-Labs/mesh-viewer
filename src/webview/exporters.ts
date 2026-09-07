import * as THREE from 'three';
import type { ExportFormat } from '../types';

/**
 * Formats three.js can write. Everything else the viewer opens (FBX, DAE, 3DS,
 * 3MF, VRML, STEP, LWO, VOX, PCD, XYZ, KMZ, splats) has no exporter, so those
 * sources fall back to GLB, the only format that keeps materials, textures,
 * skinning, and animation.
 */
const WRITABLE: ExportFormat[] = [
  { label: 'glTF Binary', ext: 'glb' },
  { label: 'glTF (embedded)', ext: 'gltf' },
  { label: 'Wavefront OBJ', ext: 'obj' },
  { label: 'STL (binary)', ext: 'stl' },
  { label: 'PLY (binary)', ext: 'ply' },
  { label: 'USDZ', ext: 'usdz' },
];

/** Dialog filters: the source format first when it is writable, otherwise GLB first. */
export function exportFormatsFor(sourceExt: string | undefined): ExportFormat[] {
  const ext = (sourceExt ?? '').toLowerCase();
  const first = WRITABLE.find((f) => f.ext === ext) ?? WRITABLE[0];
  return [first, ...WRITABLE.filter((f) => f !== first)];
}

/** Human-readable reason a subtree cannot be exported, or null when it can. */
export function exportBlocker(target: THREE.Object3D): string | null {
  let splat = false;
  target.traverse((o) => {
    if (o.userData.isSplat === true) splat = true;
  });
  if (splat) return 'Gaussian splats cannot be exported — Spark owns their data, and no writer exists.';
  return null;
}

/**
 * Serialize `target` (and its subtree) in the format named by `ext`.
 *
 * The node's ancestors are baked into it so every edit above it survives, but
 * the viewer-only transform on `contentRoot` (up-axis display rotation, grid
 * seating) is excluded: what comes out is the node relative to the file's own
 * frame. The glTF writer reads each node's local matrix, so for it the target's
 * local TRS is swapped for its contentRoot-relative TRS; the OBJ / STL / PLY /
 * USDZ writers read world matrices, so for them contentRoot is zeroed instead.
 * Both are restored in `finally`; the caller pauses rendering meanwhile.
 */
export async function exportObject(
  target: THREE.Object3D,
  ext: string,
  contentRoot: THREE.Object3D,
  renderer: THREE.WebGLRenderer,
  animations: THREE.AnimationClip[],
): Promise<Uint8Array> {
  const blocker = exportBlocker(target);
  if (blocker) throw new Error(blocker);
  const format = ext.toLowerCase();
  if (!WRITABLE.some((f) => f.ext === format)) throw new Error(`No writer for .${format} files.`);

  contentRoot.updateMatrixWorld(true);
  const relative = new THREE.Matrix4().copy(contentRoot.matrixWorld).invert().multiply(target.matrixWorld);

  if (format === 'glb' || format === 'gltf') {
    const saved = { p: target.position.clone(), q: target.quaternion.clone(), s: target.scale.clone() };
    relative.decompose(target.position, target.quaternion, target.scale);
    target.updateMatrix();
    try {
      return await exportGltf(target, format === 'glb', renderer, animations);
    } finally {
      target.position.copy(saved.p);
      target.quaternion.copy(saved.q);
      target.scale.copy(saved.s);
      target.updateMatrix();
      contentRoot.updateMatrixWorld(true);
    }
  }

  const saved = { p: contentRoot.position.clone(), q: contentRoot.quaternion.clone(), s: contentRoot.scale.clone() };
  contentRoot.position.set(0, 0, 0);
  contentRoot.quaternion.identity();
  contentRoot.scale.set(1, 1, 1);
  contentRoot.updateMatrixWorld(true);
  try {
    switch (format) {
      case 'obj': {
        const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
        return new TextEncoder().encode(new OBJExporter().parse(target));
      }
      case 'stl': {
        const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
        const view = new STLExporter().parse(target, { binary: true });
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      }
      case 'ply': {
        const { PLYExporter } = await import('three/examples/jsm/exporters/PLYExporter.js');
        const buffer = new PLYExporter().parse(target, () => {}, { binary: true });
        if (!buffer) throw new Error('The selection has no mesh geometry to write as PLY.');
        return new Uint8Array(buffer);
      }
      default: {
        const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js');
        return await new USDZExporter().parseAsync(target);
      }
    }
  } finally {
    contentRoot.position.copy(saved.p);
    contentRoot.quaternion.copy(saved.q);
    contentRoot.scale.copy(saved.s);
    contentRoot.updateMatrixWorld(true);
  }
}

async function exportGltf(
  target: THREE.Object3D,
  binary: boolean,
  renderer: THREE.WebGLRenderer,
  animations: THREE.AnimationClip[],
): Promise<Uint8Array> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  // GPU-only textures (KTX2 / Basis) cannot be read back directly; the exporter
  // blits them through the renderer when given texture utils.
  const { decompress } = await import('three/examples/jsm/utils/WebGLTextureUtils.js');
  const exporter = new GLTFExporter();
  exporter.setTextureUtils({
    decompress: (texture: THREE.Texture, maxTextureSize?: number) =>
      Promise.resolve(decompress(texture, maxTextureSize, renderer)),
  });
  const result = await exporter.parseAsync(target, { binary, animations, onlyVisible: true });
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  return new TextEncoder().encode(JSON.stringify(result));
}
