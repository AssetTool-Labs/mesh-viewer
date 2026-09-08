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
  return partialSkinBlocker(target);
}

function isDescendantOf(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/**
 * A skinned mesh usually keeps its skeleton beside it rather than under it
 * (glTF puts the joints and the mesh as siblings of one armature node). The
 * glTF writer looks every joint up in the exported node set and emits `null`
 * for any it cannot find, which makes the file invalid, and the other writers
 * drop the skin altogether. Refuse the partial subtree and name the ancestor
 * that holds the whole rig instead.
 */
function partialSkinBlocker(target: THREE.Object3D): string | null {
  let orphanMesh: THREE.SkinnedMesh | null = null;
  const outside: THREE.Bone[] = [];
  target.traverse((o) => {
    const skinned = o as THREE.SkinnedMesh;
    if (!skinned.isSkinnedMesh || !skinned.skeleton) return;
    for (const bone of skinned.skeleton.bones) {
      if (!isDescendantOf(bone, target)) {
        orphanMesh ??= skinned;
        outside.push(bone);
      }
    }
  });
  if (!orphanMesh || outside.length === 0) return null;
  let ancestor: THREE.Object3D | null = target.parent;
  while (ancestor && !outside.every((b) => isDescendantOf(b, ancestor as THREE.Object3D))) ancestor = ancestor.parent;
  const meshName = (orphanMesh as THREE.SkinnedMesh).name || 'A skinned mesh';
  const pick = ancestor && ancestor.name ? `"${ancestor.name}"` : "the file's top-level row";
  return `"${meshName}" is skinned by bones outside the selection. Select ${pick} to export it with its skeleton.`;
}

/**
 * Copies of `clips` whose tracks address nodes by uuid instead of by name.
 * The glTF writer resolves each track with `PropertyBinding.findNode` from the
 * exported root, and names are only unique within one file: two imports of the
 * same rig both have a "Hips", and every clip would drive the first one.
 * `findNode` also matches uuids, so resolving each track inside its own entry
 * first makes the binding unambiguous. Tracks that do not resolve are left
 * alone (the writer warns and skips them). The live clips are not touched.
 */
export function retargetClips(clips: THREE.AnimationClip[], root: THREE.Object3D): THREE.AnimationClip[] {
  return clips.map((clip) => {
    const copy = clip.clone();
    for (const track of copy.tracks) {
      const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
      if (!nodeName) continue;
      const node = THREE.PropertyBinding.findNode(root, nodeName) as THREE.Object3D | null;
      if (!node || node.uuid === nodeName) continue;
      // The node name sits right after the optional directory prefix and is
      // followed by ".property" or ".object[...]". A directory may contain the
      // same text, so skip matches that are not at a segment start.
      let idx = track.name.indexOf(nodeName + '.');
      while (idx > 0 && !'/:'.includes(track.name[idx - 1])) idx = track.name.indexOf(nodeName + '.', idx + 1);
      if (idx < 0) continue;
      track.name = node.uuid + track.name.slice(idx + nodeName.length);
    }
    return copy;
  });
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
      return await exportGltf(target, format === 'glb', animations);
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
  animations: THREE.AnimationClip[],
): Promise<Uint8Array> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  // GPU-only textures (KTX2 / Basis) cannot be read back directly; the exporter
  // blits them through a renderer when given texture utils. It gets a throwaway
  // one (created and disposed inside `decompress`), not the viewer's: the blit
  // calls `renderer.setSize(textureW, textureH)` with the style update on, which
  // would leave the viewer canvas pinned to the texture's size.
  const { decompress } = await import('three/examples/jsm/utils/WebGLTextureUtils.js');
  const exporter = new GLTFExporter();
  exporter.setTextureUtils({
    decompress: (texture: THREE.Texture, maxTextureSize?: number) =>
      Promise.resolve(decompress(texture, maxTextureSize)),
  });
  const result = await exporter.parseAsync(target, { binary, animations, onlyVisible: true });
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  return new TextEncoder().encode(JSON.stringify(result));
}
