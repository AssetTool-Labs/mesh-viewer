// Format dispatcher. Returns a loaded `THREE.Group` (scene root) plus optional metadata.
//
// Loaders are imported lazily so a single bundle stays small and so we don't
// pay parse cost for formats the user never opens.

import * as THREE from 'three';
import { LoadingManager } from 'three';

export interface LoadedAsset {
  /** The root group containing everything loaded from the file. */
  root: THREE.Object3D;
  /** Animations that ship with the asset, if any. */
  animations: THREE.AnimationClip[];
  /** Lights baked into the asset (e.g. GLTF KHR_lights_punctual). */
  lights: THREE.Light[];
  /** Cameras defined in the asset. */
  cameras: THREE.Camera[];
  /** Format-specific extras to display in the Info panel. */
  metadata: Record<string, string>;
}

/**
 * Build a LoadingManager that resolves sidecar file references (textures, .bin,
 * .mtl) to webview-accessible URIs the browser can fetch directly.
 */
function makeManagerForAux(auxFileUris: Record<string, string>): {
  manager: LoadingManager;
  baseUrl: string;
} {
  const map = new Map<string, string>();
  for (const [name, uri] of Object.entries(auxFileUris ?? {})) {
    map.set(name.toLowerCase(), uri);
    map.set(`./${name.toLowerCase()}`, uri);
  }
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    try {
      const u = decodeURIComponent(url).replace(/\\/g, '/');
      const tail = u.split('/').pop() ?? u;
      const hit = map.get(tail.toLowerCase()) ?? map.get(u.toLowerCase());
      return hit ?? url;
    } catch {
      return url;
    }
  });
  return { manager, baseUrl: '' };
}

function emptyAsset(root: THREE.Object3D): LoadedAsset {
  return { root, animations: [], lights: [], cameras: [], metadata: {} };
}

function gatherLightsAndCameras(root: THREE.Object3D): { lights: THREE.Light[]; cameras: THREE.Camera[] } {
  const lights: THREE.Light[] = [];
  const cameras: THREE.Camera[] = [];
  root.traverse((o) => {
    if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
    if ((o as THREE.Camera).isCamera) cameras.push(o as THREE.Camera);
  });
  return { lights, cameras };
}

export async function loadAsset(
  ext: string,
  data: ArrayBuffer | string,
  fileName: string,
  auxFileUris: Record<string, string> = {},
): Promise<LoadedAsset> {
  const lower = ext.toLowerCase();

  switch (lower) {
    case 'gltf':
    case 'glb':
      return loadGLTF(lower, data, auxFileUris);
    case 'obj':
      return loadOBJ(data as string, auxFileUris);
    case 'fbx':
      return loadFBX(data as ArrayBuffer);
    case 'stl':
      return loadSTL(data as ArrayBuffer, fileName);
    case 'ply':
      return loadPLY(data as ArrayBuffer);
    case 'dae':
      return loadCollada(data as string, auxFileUris);
    case '3ds':
      return load3DS(data as ArrayBuffer);
    case '3mf':
      return load3MF(data as ArrayBuffer);
    case 'wrl':
    case 'vrml':
      return loadVRML(data as string);
    case 'usd':
    case 'usda':
    case 'usdc':
    case 'usdz':
      return loadUSD(data);
    case 'vox':
      return loadVOX(data as ArrayBuffer);
    case 'pcd':
      return loadPCD(data as ArrayBuffer);
    case 'xyz':
      return loadXYZ(data as string);
    case 'lwo':
      return loadLWO(data as ArrayBuffer);
    case 'kmz':
      return loadKMZ(data as ArrayBuffer);
    default:
      throw new Error(`Unsupported file extension: .${ext}`);
  }
}

// ---------- GLTF / GLB ----------

async function loadGLTF(
  ext: string,
  data: ArrayBuffer | string,
  auxFileUris: Record<string, string>,
): Promise<LoadedAsset> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const aux = makeManagerForAux(auxFileUris);
  const loader = new GLTFLoader(aux.manager);

  const buffer: ArrayBuffer | string = ext === 'glb' ? (data as ArrayBuffer) : (data as string);

  return new Promise((resolve, reject) => {
    loader.parse(
      buffer,
      aux.baseUrl,
      (gltf) => {
        const meta: Record<string, string> = {};
        const asset = (gltf as unknown as { asset?: Record<string, unknown> }).asset;
        if (asset) {
          if (asset.version) meta['glTF Version'] = String(asset.version);
          if (asset.generator) meta['Generator'] = String(asset.generator);
          if (asset.copyright) meta['Copyright'] = String(asset.copyright);
        }
        if (gltf.scenes && gltf.scenes.length > 1) {
          meta['Scenes'] = String(gltf.scenes.length);
        }
        const { lights, cameras } = gatherLightsAndCameras(gltf.scene);
        resolve({
          root: gltf.scene,
          animations: gltf.animations ?? [],
          lights,
          cameras: gltf.cameras?.length ? gltf.cameras : cameras,
          metadata: meta,
        });
      },
      (err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// ---------- OBJ ----------

async function loadOBJ(data: string, auxFileUris: Record<string, string>): Promise<LoadedAsset> {
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');

  const mtlEntry = Object.entries(auxFileUris).find(([n]) => n.toLowerCase().endsWith('.mtl'));
  let materials: { preload: () => void; getAsArray?: () => unknown } | undefined;
  let mtlFileName: string | undefined;
  if (mtlEntry) {
    try {
      const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
      const aux = makeManagerForAux(auxFileUris);
      const mtlLoader = new MTLLoader(aux.manager);
      const mtlResp = await fetch(mtlEntry[1]);
      const mtlText = await mtlResp.text();
      materials = mtlLoader.parse(mtlText, '');
      materials.preload();
      mtlFileName = mtlEntry[0];
    } catch (err) {
      console.warn('[3DViewer] MTL parse failed:', err);
    }
  }

  const loader = new OBJLoader();
  if (materials) (loader as unknown as { setMaterials(m: unknown): void }).setMaterials(materials);
  const root = loader.parse(data);
  const asset = emptyAsset(root);
  if (mtlFileName) asset.metadata['Material library'] = mtlFileName;
  return asset;
}

// ---------- FBX ----------

async function loadFBX(buf: ArrayBuffer): Promise<LoadedAsset> {
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const loader = new FBXLoader();
  const root = loader.parse(buf, '');
  const { lights, cameras } = gatherLightsAndCameras(root);
  return {
    root,
    animations: (root as unknown as { animations?: THREE.AnimationClip[] }).animations ?? [],
    lights,
    cameras,
    metadata: {},
  };
}

// ---------- STL ----------

async function loadSTL(buf: ArrayBuffer, fileName: string): Promise<LoadedAsset> {
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
  const loader = new STLLoader();
  const geometry = loader.parse(buf);
  const material = new THREE.MeshStandardMaterial({
    color: 0xb5b5b5,
    roughness: 0.7,
    metalness: 0.05,
  });
  if (geometry.hasAttribute('color')) {
    material.vertexColors = true;
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = fileName.replace(/\.[^.]+$/, '');
  const root = new THREE.Group();
  root.name = 'STL';
  root.add(mesh);
  return emptyAsset(root);
}

// ---------- PLY ----------

async function loadPLY(buf: ArrayBuffer): Promise<LoadedAsset> {
  const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
  const loader = new PLYLoader();
  const geometry = loader.parse(buf);
  geometry.computeVertexNormals?.();
  const hasFaces = geometry.index != null && geometry.index.count > 0;
  const root = new THREE.Group();
  root.name = 'PLY';
  if (hasFaces) {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: geometry.hasAttribute('color'),
      color: geometry.hasAttribute('color') ? 0xffffff : 0xb5b5b5,
      roughness: 0.7,
    });
    root.add(new THREE.Mesh(geometry, material));
  } else {
    const material = new THREE.PointsMaterial({
      size: 0.005,
      vertexColors: geometry.hasAttribute('color'),
      color: geometry.hasAttribute('color') ? 0xffffff : 0xb5b5b5,
      sizeAttenuation: true,
    });
    root.add(new THREE.Points(geometry, material));
  }
  return emptyAsset(root);
}

// ---------- Collada ----------

async function loadCollada(text: string, auxFileUris: Record<string, string>): Promise<LoadedAsset> {
  const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
  const aux = makeManagerForAux(auxFileUris);
  const loader = new ColladaLoader(aux.manager);
  const result = loader.parse(text, '');
  if (!result || !result.scene) throw new Error('Collada file did not contain a parsable scene.');
  const root: THREE.Object3D = result.scene;
  const { lights, cameras } = gatherLightsAndCameras(root);
  // ColladaLoader.parse() returns clips on result.animations, NOT
  // result.scene.animations (Scene/Group has no animations field).
  return {
    root,
    animations: (result as { animations?: THREE.AnimationClip[] }).animations ?? [],
    lights,
    cameras,
    metadata: {},
  };
}

// ---------- 3DS ----------

async function load3DS(buf: ArrayBuffer): Promise<LoadedAsset> {
  const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js');
  const loader = new TDSLoader();
  const root = loader.parse(buf, '');
  return emptyAsset(root);
}

// ---------- 3MF ----------

async function load3MF(buf: ArrayBuffer): Promise<LoadedAsset> {
  const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
  const loader = new ThreeMFLoader();
  const root = loader.parse(buf);
  return emptyAsset(root);
}

// ---------- VRML / WRL ----------

async function loadVRML(text: string): Promise<LoadedAsset> {
  const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js');
  const loader = new VRMLLoader();
  const root = loader.parse(text, '');
  return emptyAsset(root);
}

// ---------- USD / USDA / USDC / USDZ ----------

async function loadUSD(data: ArrayBuffer | string): Promise<LoadedAsset> {
  const { USDLoader } = await import('three/examples/jsm/loaders/USDLoader.js');
  const loader = new USDLoader();
  const buf: ArrayBuffer = typeof data === 'string'
    ? new TextEncoder().encode(data).buffer as ArrayBuffer
    : data;
  const root = loader.parse(buf);
  const { lights, cameras } = gatherLightsAndCameras(root);
  return {
    root,
    animations: (root as unknown as { animations?: THREE.AnimationClip[] }).animations ?? [],
    lights,
    cameras,
    metadata: {},
  };
}

// ---------- VOX ----------

async function loadVOX(buf: ArrayBuffer): Promise<LoadedAsset> {
  const { VOXLoader, VOXMesh } = await import('three/examples/jsm/loaders/VOXLoader.js');
  const loader = new VOXLoader();
  // VOXLoader.parse returns a list of chunks. Different three.js versions wrap
  // them either in `{ chunks }` or as a bare array, so handle both shapes.
  const parsed = loader.parse(buf) as unknown;
  const chunks = Array.isArray(parsed)
    ? (parsed as unknown[])
    : ((parsed as { chunks?: unknown[] }).chunks ?? []);
  const root = new THREE.Group();
  root.name = 'VOX';
  for (const chunk of chunks) {
    root.add(new VOXMesh(chunk as ConstructorParameters<typeof VOXMesh>[0]));
  }
  return emptyAsset(root);
}

// ---------- PCD ----------

async function loadPCD(buf: ArrayBuffer): Promise<LoadedAsset> {
  const { PCDLoader } = await import('three/examples/jsm/loaders/PCDLoader.js');
  const loader = new PCDLoader();
  const points = loader.parse(buf);
  const root = new THREE.Group();
  root.name = 'PCD';
  root.add(points);
  return emptyAsset(root);
}

// ---------- XYZ ----------

async function loadXYZ(data: string): Promise<LoadedAsset> {
  const { XYZLoader } = await import('three/examples/jsm/loaders/XYZLoader.js');
  const loader = new XYZLoader();
  const geometry = (loader as unknown as { parse(t: string): THREE.BufferGeometry }).parse(data);
  const material = new THREE.PointsMaterial({
    size: 0.01,
    vertexColors: geometry.hasAttribute('color'),
    color: geometry.hasAttribute('color') ? 0xffffff : 0xb5b5b5,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  const root = new THREE.Group();
  root.name = 'XYZ';
  root.add(points);
  return emptyAsset(root);
}

// ---------- LWO ----------

async function loadLWO(buf: ArrayBuffer): Promise<LoadedAsset> {
  const { LWOLoader } = await import('three/examples/jsm/loaders/LWOLoader.js');
  const loader = new LWOLoader();
  const result = loader.parse(buf, '', '');
  const root = new THREE.Group();
  root.name = 'LWO';
  for (const m of result.meshes) root.add(m);
  return emptyAsset(root);
}

// ---------- KMZ ----------

async function loadKMZ(buf: ArrayBuffer): Promise<LoadedAsset> {
  const { KMZLoader } = await import('three/examples/jsm/loaders/KMZLoader.js');
  const loader = new KMZLoader();
  const result = loader.parse(buf);
  const root = result.scene;
  return emptyAsset(root);
}
