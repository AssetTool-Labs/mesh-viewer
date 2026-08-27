// Format dispatcher. Returns a loaded `THREE.Group` (scene root) plus optional metadata.
//
// Loaders are imported lazily so a single bundle stays small and so we don't
// pay parse cost for formats the user never opens.

import * as THREE from 'three';
import { LoadingManager } from 'three';

/**
 * The viewer's WebGLRenderer, shared so KTX2Loader.detectSupport() can query the
 * GPU's supported compressed-texture formats. Set once when the viewer boots.
 */
let sharedRenderer: THREE.WebGLRenderer | null = null;
export function setViewerRenderer(renderer: THREE.WebGLRenderer): void {
  sharedRenderer = renderer;
}

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
  /**
   * Resolves once background resource loads (sidecar textures) settle. Loaders
   * whose parse() returns before textures finish decoding (FBX, OBJ, Collada)
   * set this so the UI can refresh texture previews when images arrive.
   */
  resourcesReady?: Promise<void>;
}

/**
 * Build a LoadingManager that resolves sidecar file references (textures, .bin,
 * .mtl) to webview-accessible URIs the browser can fetch directly.
 */
async function makeManagerForAux(auxFileUris: Record<string, string>): Promise<{
  manager: LoadingManager;
  baseUrl: string;
  /** Resolves when every load started through this manager has settled
   *  (or immediately if the parse never started one). Call after parse(). */
  whenReady: () => Promise<void>;
}> {
  // Aux names are paths relative to the model's directory (e.g.
  // "textures/diffuse.png"). Index by full relative path, and by bare
  // filename as a fallback for references whose directory prefix doesn't
  // match on this machine (e.g. absolute paths baked in by DCC tools).
  const byPath = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const [name, uri] of Object.entries(auxFileUris ?? {})) {
    const norm = name.replace(/\\/g, '/').toLowerCase();
    byPath.set(norm, uri);
    const base = norm.split('/').pop() ?? norm;
    if (!byName.has(base)) byName.set(base, uri);
  }
  const manager = new LoadingManager();

  // The browser cannot decode Targa, so three's FBX/Collada/MTL loaders skip
  // .tga textures outright ("TGA loader not found, skipping …") unless a handler
  // is registered for them. Wired only when the asset actually ships one, so an
  // ordinary load doesn't pay for the import. The manager is handed to the
  // loader so its fetch goes through the URL modifier below and counts towards
  // whenReady(), which is what refreshes the texture panel.
  if (Object.keys(auxFileUris ?? {}).some((name) => name.toLowerCase().endsWith('.tga'))) {
    try {
      const { TGALoader } = await import('three/examples/jsm/loaders/TGALoader.js');
      manager.addHandler(/\.tga$/i, new TGALoader(manager));
    } catch (err) {
      console.warn('[3DViewer] Failed to initialize TGALoader:', err);
    }
  }

  manager.setURLModifier((url) => {
    try {
      const u = decodeURIComponent(url)
        .replace(/\\/g, '/')
        .toLowerCase()
        .replace(/^\.\//, '');
      const tail = u.split('/').pop() ?? u;
      return byPath.get(u) ?? byName.get(tail) ?? url;
    } catch {
      return url;
    }
  });
  // Track whether any load actually started: LoadingManager.onLoad never
  // fires when nothing was queued, so whenReady() must resolve immediately
  // in that case.
  let sawLoads = false;
  manager.onStart = () => {
    sawLoads = true;
  };
  const allLoaded = new Promise<void>((resolve) => {
    manager.onLoad = () => resolve();
  });
  return { manager, baseUrl: '', whenReady: () => (sawLoads ? allLoaded : Promise.resolve()) };
}

/**
 * ASCII tag of `length` bytes at `offset`, for magic-number and IFF sniffing.
 * Built byte by byte rather than through TextDecoder so no encoding label is
 * involved — these tags are always plain ASCII.
 */
function tagAt(buf: ArrayBuffer, offset: number, length: number): string {
  if (buf.byteLength < offset + length) return '';
  let out = '';
  for (const byte of new Uint8Array(buf, offset, length)) out += String.fromCharCode(byte);
  return out;
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

/**
 * An error whose message is already written for a user to read. `loadAsset`
 * passes these through untouched instead of framing them as a parse failure.
 */
export class ViewerError extends Error {}

/** The three.js loader that owns each extension, named in failure messages. */
const LOADER_NAMES: Record<string, string> = {
  gltf: 'GLTFLoader',
  glb: 'GLTFLoader',
  obj: 'OBJLoader',
  fbx: 'FBXLoader',
  stl: 'STLLoader',
  ply: 'PLYLoader',
  dae: 'ColladaLoader',
  '3ds': 'TDSLoader',
  '3mf': '3MFLoader',
  wrl: 'VRMLLoader',
  vrml: 'VRMLLoader',
  usd: 'USDLoader',
  usda: 'USDLoader',
  usdc: 'USDLoader',
  usdz: 'USDLoader',
  vox: 'VOXLoader',
  pcd: 'PCDLoader',
  xyz: 'XYZLoader',
  lwo: 'LWOLoader',
  kmz: 'KMZLoader',
  spz: 'the Spark splat loader',
  splat: 'the Spark splat loader',
  ksplat: 'the Spark splat loader',
  sog: 'the Spark splat loader',
};

export async function loadAsset(
  ext: string,
  data: ArrayBuffer | string,
  fileName: string,
  auxFileUris: Record<string, string> = {},
): Promise<LoadedAsset> {
  const lower = ext.toLowerCase();

  // Every loader fails somewhere deep on an empty payload — usually a RangeError
  // about buffer bounds, which tells the user nothing. Name the real problem.
  const usableBytes = typeof data === 'string' ? data.trim().length : data.byteLength;
  if (usableBytes === 0) {
    throw new Error(`${fileName} is empty or truncated — there is no data to load.`);
  }

  try {
    return await dispatch(lower, data, fileName, auxFileUris);
  } catch (err) {
    if (err instanceof ViewerError) throw err;
    // three.js loaders throw straight out of their parse routines on malformed
    // input, so the bare message ("Cannot read properties of undefined (reading
    // 'a')") would otherwise be the whole of what the error overlay shows. Keep
    // the original — with its stack — in the console for debugging.
    const original = err instanceof Error ? err : new Error(String(err));
    const loader = LOADER_NAMES[lower] ?? `The .${lower} loader`;
    console.error(`[3DViewer] ${loader} failed on ${fileName}:`, original);
    throw new ViewerError(
      `${loader} could not parse ${fileName} — it may be malformed or use a ` +
        `variant of the format that is not supported. (${original.message})`,
    );
  }
}

async function dispatch(
  lower: string,
  data: ArrayBuffer | string,
  fileName: string,
  auxFileUris: Record<string, string>,
): Promise<LoadedAsset> {
  switch (lower) {
    case 'gltf':
    case 'glb':
      return loadGLTF(lower, data, auxFileUris);
    case 'obj':
      return loadOBJ(data as string, auxFileUris);
    case 'fbx':
      return loadFBX(data as ArrayBuffer, auxFileUris);
    case 'stl':
      return loadSTL(data as ArrayBuffer, fileName);
    case 'ply':
      // .ply is claimed by both worlds: a triangle mesh / point cloud and the
      // original 3DGS export format. Only the header tells them apart.
      return isGaussianSplatPLY(data as ArrayBuffer)
        ? loadSplat(data as ArrayBuffer, fileName, 'PLY')
        : loadPLY(data as ArrayBuffer);
    case 'spz':
      return loadSplat(data as ArrayBuffer, fileName, 'SPZ');
    case 'splat':
      return loadSplat(data as ArrayBuffer, fileName, 'SPLAT');
    case 'ksplat':
      return loadSplat(data as ArrayBuffer, fileName, 'KSPLAT');
    case 'sog':
      return loadSplat(data as ArrayBuffer, fileName, 'PCSOGSZIP');
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
      throw new ViewerError(`Unsupported file extension: .${lower}`);
  }
}

// ---------- GLTF / GLB ----------

/** Cheap check for KHR_texture_basisu (KTX2) without a full parse: read the glb
 *  JSON chunk (or the raw .gltf text) and look for the extension name. */
function gltfUsesKtx2(ext: string, data: ArrayBuffer | string): boolean {
  try {
    let json: string;
    if (ext === 'glb') {
      const view = new DataView(data as ArrayBuffer);
      const jsonLen = view.getUint32(12, true);
      json = new TextDecoder().decode(new Uint8Array(data as ArrayBuffer, 20, jsonLen));
    } else {
      json = data as string;
    }
    return json.includes('KHR_texture_basisu');
  } catch {
    return false;
  }
}

function validateGltfScene(ext: string, data: ArrayBuffer | string): void {
  let document: { scene?: unknown; scenes?: unknown };
  try {
    let json: string;
    if (ext === 'glb') {
      const view = new DataView(data as ArrayBuffer);
      const jsonLen = view.getUint32(12, true);
      json = new TextDecoder().decode(new Uint8Array(data as ArrayBuffer, 20, jsonLen));
    } else {
      json = data as string;
    }
    document = JSON.parse(json) as { scene?: unknown; scenes?: unknown };
  } catch {
    return;
  }

  const scene = document.scene;
  if (scene === undefined) return;
  const sceneIndex = Number.isInteger(scene) ? scene as number : -1;
  if (!Array.isArray(document.scenes) || sceneIndex < 0 || sceneIndex >= document.scenes.length) {
    throw new ViewerError(`glTF declares default scene ${String(scene)} but does not define it.`);
  }
}

/**
 * Apply KHR_node_visibility, which three's GLTFLoader does not implement — nodes
 * an asset marks hidden would otherwise render.
 *
 * The flag is read back out of `userData.gltfExtensions`, where GLTFLoader parks
 * node extensions it doesn't recognise, rather than out of the source JSON. That
 * matters for nodes reused by several parents: GLTFLoader hands out clones of
 * those, and `Object3D.clone()` deep-copies userData, so every instance carries
 * the flag while the JSON node index only maps to the original.
 *
 * Setting `visible = false` is the whole of the behaviour: three already skips
 * descendants of a hidden object, and drops hidden lights from the render, which
 * is what the extension specifies.
 */
function applyNodeVisibility(root: THREE.Object3D): number {
  let hidden = 0;
  root.traverse((o) => {
    const extensions = o.userData?.gltfExtensions as
      | { KHR_node_visibility?: { visible?: boolean } }
      | undefined;
    if (extensions?.KHR_node_visibility?.visible === false) {
      o.visible = false;
      hidden++;
    }
  });
  return hidden;
}

const SPEC_GLOSS = 'KHR_materials_pbrSpecularGlossiness';

interface SpecGlossDef {
  diffuseFactor?: [number, number, number, number];
  specularFactor?: [number, number, number];
  glossinessFactor?: number;
  diffuseTexture?: { index: number; texCoord?: number };
  specularGlossinessTexture?: { index: number; texCoord?: number };
}

/**
 * Approximate KHR_materials_pbrSpecularGlossiness as a metallic-roughness
 * material.
 *
 * three removed its built-in support for the extension, so GLTFLoader ignores it
 * and the material falls back to the glTF defaults for a missing
 * pbrMetallicRoughness block — metalness 1, roughness 1 — which renders
 * spec-gloss assets as dark, flat metal.
 *
 * This is a conversion, not the original shading model:
 *  - roughness comes straight from `1 - glossinessFactor`.
 *  - metalness is estimated by measuring the specular colour against 0.04, the
 *    reflectance of a dielectric; the base colour is then blended towards the
 *    specular colour as metalness rises, since a metal's tint lives in its
 *    reflectance rather than its diffuse term.
 *  - a specularGlossinessTexture's *per-pixel* specular and gloss are not
 *    unpacked: three's roughnessMap/metalnessMap sample G and B while spec-gloss
 *    packs specular in RGB and gloss in A, so the layouts do not overlap and the
 *    image would have to be repacked pixel by pixel. Those materials instead get
 *    a neutral dielectric. Falling back to the *factors* there would be actively
 *    wrong — they default to white specular and full gloss, which the texture is
 *    meant to modulate, so the material would come out as a chrome mirror.
 */
function specGlossPlugin(
  parser: { json: { materials?: { extensions?: Record<string, unknown> }[] } },
  onApplied: (approximatedTexture: boolean) => void,
) {
  const defFor = (index: number): SpecGlossDef | undefined =>
    parser.json.materials?.[index]?.extensions?.[SPEC_GLOSS] as SpecGlossDef | undefined;

  return {
    name: SPEC_GLOSS,
    getMaterialType: (index: number) => (defFor(index) ? THREE.MeshStandardMaterial : null),
    extendMaterialParams: (index: number, params: Record<string, unknown>) => {
      const sg = defFor(index);
      if (!sg) return null;
      onApplied(sg.specularGlossinessTexture !== undefined);

      const diffuse = sg.diffuseFactor ?? [1, 1, 1, 1];
      const specular = sg.specularFactor ?? [1, 1, 1];
      const glossiness = sg.glossinessFactor ?? 1;

      if (sg.specularGlossinessTexture) {
        // Per-pixel specular/gloss we cannot honour — see the note above on why
        // the factors are not a usable stand-in here.
        params.color = new THREE.Color(diffuse[0], diffuse[1], diffuse[2]);
        params.metalness = 0;
        params.roughness = 0.5;
      } else {
        const specularStrength = Math.max(specular[0], specular[1], specular[2]);
        const metalness = Math.min(1, Math.max(0, (specularStrength - 0.04) / 0.96));
        const color = new THREE.Color(diffuse[0], diffuse[1], diffuse[2]);
        color.lerp(new THREE.Color(specular[0], specular[1], specular[2]), metalness);
        params.color = color;
        params.metalness = metalness;
        params.roughness = 1 - glossiness;
      }
      params.opacity = diffuse[3];

      const pending: Promise<unknown>[] = [];
      if (sg.diffuseTexture) {
        pending.push(
          (parser as unknown as {
            assignTexture(
              p: Record<string, unknown>,
              name: string,
              def: { index: number; texCoord?: number },
              colorSpace?: string,
            ): Promise<unknown>;
          }).assignTexture(params, 'map', sg.diffuseTexture, THREE.SRGBColorSpace),
        );
      }
      return Promise.all(pending);
    },
  };
}

/**
 * The `asset.version` of a pre-2.0 glTF, or null when the file is 2.0 (or its
 * version can't be read). GLTFLoader does reject these, but with
 * "Unsupported asset." / "Legacy binary file detected" — accurate, yet it never
 * says what to do next. A .glb carries the container version at offset 4; a
 * .gltf carries it in `asset.version`.
 */
function legacyGltfVersion(ext: string, data: ArrayBuffer | string): string | null {
  if (ext === 'glb') {
    const buf = data as ArrayBuffer;
    if (buf.byteLength < 12 || tagAt(buf, 0, 4) !== 'glTF') return null;
    const container = new DataView(buf).getUint32(4, true);
    return container < 2 ? '1.0' : null;
  }
  try {
    const version = (JSON.parse(data as string) as { asset?: { version?: string } }).asset?.version;
    return version && !version.startsWith('2') ? version : null;
  } catch {
    return null;
  }
}

async function loadGLTF(
  ext: string,
  data: ArrayBuffer | string,
  auxFileUris: Record<string, string>,
): Promise<LoadedAsset> {
  // Version first: glTF 1.0 stores `scenes` as a name-keyed object, so the 2.0
  // scene validation below would fire on it with a misleading "declares default
  // scene defaultScene but does not define it" instead of naming the real problem.
  const legacy = legacyGltfVersion(ext, data);
  if (legacy) {
    throw new ViewerError(
      `This is a glTF ${legacy} file. Only glTF 2.0 is supported — re-export the asset ` +
        'as glTF 2.0, or convert it with gltf-pipeline.',
    );
  }
  validateGltfScene(ext, data);
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const aux = await makeManagerForAux(auxFileUris);
  const loader = new GLTFLoader(aux.manager);

  let specGlossCount = 0;
  let specGlossTextures = 0;
  loader.register((parser) =>
    specGlossPlugin(parser as never, (approximatedTexture) => {
      specGlossCount++;
      if (approximatedTexture) specGlossTextures++;
    }),
  );

  // Wire up DRACO decompression so DRACO-compressed .glb/.gltf files load.
  // The decoder (wasm + wrapper) is bundled with the extension and its
  // webview-accessible path is injected into the page as a global.
  const dracoPath = (globalThis as { __dracoDecoderPath?: string }).__dracoDecoderPath;
  if (dracoPath) {
    try {
      const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
      const dracoLoader = new DRACOLoader(aux.manager);
      dracoLoader.setDecoderPath(dracoPath);
      loader.setDRACOLoader(dracoLoader);
    } catch (err) {
      console.warn('[3DViewer] Failed to initialize DRACOLoader:', err);
    }
  }

  // Wire up meshopt decompression so EXT_meshopt_compression files load. Unlike
  // DRACO, three ships this decoder as one self-contained module with the wasm
  // embedded, so it bundles into the webview and needs no sidecar file. Leave
  // its worker pool off: starting one needs a blob: URL that the webview CSP
  // forbids, and the decoder already falls back to decoding on this thread.
  try {
    const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
    loader.setMeshoptDecoder(MeshoptDecoder);
  } catch (err) {
    console.warn('[3DViewer] Failed to initialize MeshoptDecoder:', err);
  }

  // Wire up KTX2 / Basis Universal so KHR_texture_basisu textures load. The
  // transcoder (wasm + js) is bundled like DRACO and its webview path injected
  // as a global; detectSupport() needs the live renderer to pick a GPU format.
  // The Basis transcoder's embind glue needs 'unsafe-eval' (see the CSP note in
  // viewerProvider.ts). Only wired when the asset actually references the
  // extension, so normal glTF never constructs it — and so we can arm a
  // watchdog on the load below.
  const usesKtx2 = gltfUsesKtx2(ext, data);
  let disposeKtx2: (() => void) | undefined;
  const ktx2Path = (globalThis as { __ktx2TranscoderPath?: string }).__ktx2TranscoderPath;
  if (usesKtx2 && ktx2Path && sharedRenderer) {
    try {
      const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
      const ktx2Loader = new KTX2Loader(aux.manager);
      ktx2Loader.setTranscoderPath(ktx2Path);
      ktx2Loader.detectSupport(sharedRenderer);
      loader.setKTX2Loader(ktx2Loader);
      disposeKtx2 = () => {
        if (ktx2Loader.transcoderPending) ktx2Loader.dispose();
        disposeKtx2 = undefined;
      };
    } catch (err) {
      console.warn('[3DViewer] Failed to initialize KTX2Loader:', err);
    }
  } else if (usesKtx2 && !sharedRenderer) {
    console.warn('[3DViewer] KTX2 asset opened before the renderer was ready; textures may be missing.');
  }

  const buffer: ArrayBuffer | string = ext === 'glb' ? (data as ArrayBuffer) : (data as string);

  return new Promise((resolve, reject) => {
    // KTX2 transcoding runs in a Worker whose failures three's WorkerPool does
    // not surface (it listens for 'message' only), so a stalled transcode would
    // otherwise leave the parse pending forever and spin the UI. This watchdog
    // is a safety net; the generous timeout avoids tripping a slow-but-valid
    // transcode of many/large textures.
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (watchdog) clearTimeout(watchdog);
      disposeKtx2?.();
    };
    const rejectOnce = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const resolveOnce = (asset: LoadedAsset): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(asset);
    };
    if (usesKtx2) {
      watchdog = setTimeout(() => rejectOnce(new ViewerError(
        'KTX2 texture transcoding did not complete in time — see the webview console for details.',
      )), 30000);
    }
    try {
      loader.parse(
        buffer,
        aux.baseUrl,
        (gltf) => {
          if (settled) return;
          try {
            if (!gltf.scene) throw new ViewerError('glTF does not define a default scene.');
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
            // Reported so a node missing from the viewport is explainable rather
            // than just absent; the outliner can still toggle it back on.
            const hidden = applyNodeVisibility(gltf.scene);
            if (hidden) meta['Hidden nodes'] = String(hidden);
            // Surfaced rather than silent: the conversion is close but not the
            // original shading model, so the shading is worth not trusting blindly.
            if (specGlossCount) {
              meta['Spec-gloss materials'] = specGlossTextures
                ? `${specGlossCount} (approximated; ${specGlossTextures} textured → neutral)`
                : `${specGlossCount} (approximated)`;
            }
            const { lights, cameras } = gatherLightsAndCameras(gltf.scene);
            resolveOnce({
              root: gltf.scene,
              animations: gltf.animations ?? [],
              lights,
              cameras: gltf.cameras?.length ? gltf.cameras : cameras,
              metadata: meta,
            });
          } catch (err) {
            rejectOnce(err);
          }
        },
        rejectOnce,
      );
    } catch (err) {
      rejectOnce(err);
    }
  });
}

// ---------- OBJ ----------

async function loadOBJ(data: string, auxFileUris: Record<string, string>): Promise<LoadedAsset> {
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');

  const mtlEntry = Object.entries(auxFileUris).find(([n]) => n.toLowerCase().endsWith('.mtl'));
  let materials: { preload: () => void; getAsArray?: () => unknown } | undefined;
  let mtlFileName: string | undefined;
  let resourcesReady: Promise<void> | undefined;
  if (mtlEntry) {
    try {
      const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
      const aux = await makeManagerForAux(auxFileUris);
      const mtlLoader = new MTLLoader(aux.manager);
      const mtlResp = await fetch(mtlEntry[1]);
      const mtlText = await mtlResp.text();
      materials = mtlLoader.parse(mtlText, '');
      materials.preload();
      resourcesReady = aux.whenReady();
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
  asset.resourcesReady = resourcesReady;
  return asset;
}

// ---------- FBX ----------

async function loadFBX(buf: ArrayBuffer, auxFileUris: Record<string, string>): Promise<LoadedAsset> {
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const aux = await makeManagerForAux(auxFileUris);
  const loader = new FBXLoader(aux.manager);
  const root = loader.parse(buf, aux.baseUrl);
  const { lights, cameras } = gatherLightsAndCameras(root);
  return {
    root,
    animations: (root as unknown as { animations?: THREE.AnimationClip[] }).animations ?? [],
    lights,
    cameras,
    metadata: {},
    resourcesReady: aux.whenReady(),
  };
}

// ---------- STL ----------

async function loadSTL(buf: ArrayBuffer, fileName: string): Promise<LoadedAsset> {
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
  const loader = new STLLoader();
  const geometry = loader.parse(buf);
  const normals = geometry.getAttribute('normal');
  let hasUsableNormal = false;
  if (normals) {
    for (let i = 0; i < normals.count; i++) {
      const lengthSq = normals.getX(i) ** 2 + normals.getY(i) ** 2 + normals.getZ(i) ** 2;
      if (Number.isFinite(lengthSq) && lengthSq > 1e-12) {
        hasUsableNormal = true;
        break;
      }
    }
  }
  if (!hasUsableNormal) geometry.computeVertexNormals();
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

// ---------- Gaussian splats (Spark) ----------

/**
 * Whether a .ply carries Gaussian splats rather than a triangle mesh or plain
 * point cloud. Two layouts occur in the wild and neither overlaps with anything
 * a mesh exporter writes:
 *  - the original 3DGS export, which names the spherical-harmonic DC term `f_dc_*`
 *  - the PlayCanvas-compressed variant, which quantizes into a `chunk` element
 * Per-splat `scale_*` / `rot_*` are deliberately not required, since Spark
 * substitutes defaults when an export omits them.
 *
 * Only the leading ASCII header is inspected; it stays plain text even when the
 * payload that follows is binary.
 */
function isGaussianSplatPLY(buf: ArrayBuffer): boolean {
  const probe = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096));
  const header = new TextDecoder('utf-8', { fatal: false }).decode(probe);
  const end = header.indexOf('end_header');
  const text = end >= 0 ? header.slice(0, end) : header;
  return text.includes('f_dc_0') || /^element\s+chunk\s/m.test(text);
}

/**
 * Splats render through Spark's own pipeline rather than as three.js geometry,
 * so the returned root is a `SplatMesh` instead of a Group of meshes. It is
 * tagged `userData.isSplat` because Spark exposes no public type guard, and the
 * viewer needs to recognise it to dispose it, count it, and orient it.
 */
/**
 * Drop a SOG bundle's higher-order spherical harmonics so the rest of it loads.
 *
 * The bundled Spark rejects any SOG carrying an `shN` block outright — the whole
 * file fails with "Failed to parse meta.json for SOGS" and nothing renders. That
 * is confirmed in both directions: removing `shN` from a failing bundle makes it
 * load, and grafting `shN` onto a working one makes it fail. Notably it is *not*
 * the `"version": 2` the symptom is usually attributed to; both the working and
 * failing samples are version 2.
 *
 * `shN` only carries view-dependent colour detail, so dropping it costs a little
 * specular variation and keeps the splats — much better than showing an error.
 * Returns null when there is nothing to strip, so ordinary bundles are passed
 * through untouched and pay nothing.
 */
async function stripSogHigherOrderSH(
  buf: ArrayBuffer,
): Promise<{ bytes: ArrayBuffer; droppedFiles: number } | null> {
  try {
    const { unzipSync, zipSync } = await import('three/examples/jsm/libs/fflate.module.js');
    const entries = unzipSync(new Uint8Array(buf));
    const rawMeta = entries['meta.json'];
    if (!rawMeta) return null;
    const meta = JSON.parse(new TextDecoder().decode(rawMeta)) as {
      shN?: { files?: string[] };
    };
    if (!meta.shN) return null;

    const shFiles = new Set(meta.shN.files ?? []);
    delete meta.shN;
    const kept: Record<string, Uint8Array> = {};
    for (const [name, bytes] of Object.entries(entries)) {
      if (name !== 'meta.json' && !shFiles.has(name) && !name.startsWith('shN')) {
        kept[name] = bytes;
      }
    }
    kept['meta.json'] = new TextEncoder().encode(JSON.stringify(meta));
    // level 0: the payload is already-compressed .webp, so deflating again would
    // cost time for nothing.
    const rebuilt = zipSync(kept, { level: 0 });
    return {
      bytes: rebuilt.buffer.slice(
        rebuilt.byteOffset,
        rebuilt.byteOffset + rebuilt.byteLength,
      ) as ArrayBuffer,
      droppedFiles: shFiles.size,
    };
  } catch (err) {
    // Not a readable zip, or an unexpected meta shape — let Spark report it.
    console.warn('[3DViewer] Could not inspect SOG bundle for higher-order SH:', err);
    return null;
  }
}

async function loadSplat(
  buf: ArrayBuffer,
  fileName: string,
  fileTypeKey: 'PLY' | 'SPZ' | 'SPLAT' | 'KSPLAT' | 'PCSOGSZIP',
): Promise<LoadedAsset> {
  // SPZ v4 dropped the gzip wrapper and ships the NGSP magic raw. Spark gunzips
  // unconditionally, so it fails with "Invalid gzip header" — and its header
  // parser rejects version > 3 regardless. Keying on the raw magic cannot
  // misfire on a supported file: v1-v3 are gzip-wrapped, so they begin 1f 8b.
  if (fileTypeKey === 'SPZ' && tagAt(buf, 0, 4) === 'NGSP') {
    const version = new DataView(buf).getUint32(4, true);
    if (version > 3) {
      throw new ViewerError(
        `This is an SPZ v${version} file. The bundled Spark splat decoder reads ` +
          'SPZ v1-v3 (gzip-wrapped) only.',
      );
    }
  }

  let droppedSH = false;
  if (fileTypeKey === 'PCSOGSZIP') {
    const stripped = await stripSogHigherOrderSH(buf);
    if (stripped) {
      console.warn(
        `[3DViewer] ${fileName} carries higher-order spherical harmonics (shN), which the ` +
          `bundled Spark decoder cannot read; dropped ${stripped.droppedFiles} shN file(s) so the splats load.`,
      );
      buf = stripped.bytes;
      droppedSH = true;
    }
  }
  const { SplatMesh, SplatFileType } = await import('@sparkjsdev/spark');
  const mesh = new SplatMesh({
    fileBytes: buf,
    fileType: SplatFileType[fileTypeKey],
    fileName,
  });
  // getBoundingBox() throws until the splats are decoded, and the viewer frames
  // the camera as soon as this resolves.
  await mesh.initialized;
  mesh.name = fileName.replace(/\.[^.]+$/, '');
  mesh.userData.isSplat = true;

  // A SplatMesh holds no three.js geometry, so Box3.setFromObject() would report
  // it as empty and camera framing, the bounds helper, and grid alignment would
  // all ignore it. Hanging a geometry off it whose bounding box matches the
  // splat extent lets the standard traversals see it.
  const bounds = new THREE.BufferGeometry();
  bounds.boundingBox = mesh.getBoundingBox();
  bounds.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(boxCorners(bounds.boundingBox), 3),
  );
  (mesh as unknown as { geometry: THREE.BufferGeometry }).geometry = bounds;

  const asset = emptyAsset(mesh);
  asset.metadata['Splats'] = mesh.numSplats.toLocaleString();
  asset.metadata['Splat format'] = `.${fileTypeKey.toLowerCase()}`;
  // Said out loud, because the view-dependent colour is genuinely less accurate
  // than the file describes.
  if (droppedSH) asset.metadata['Spherical harmonics'] = 'higher-order (shN) dropped';
  return asset;
}

function boxCorners(box: THREE.Box3): number[] {
  const out: number[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) out.push(x, y, z);
    }
  }
  return out;
}

// ---------- Collada ----------

async function loadCollada(text: string, auxFileUris: Record<string, string>): Promise<LoadedAsset> {
  const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
  const aux = await makeManagerForAux(auxFileUris);
  const loader = new ColladaLoader(aux.manager);
  const result = loader.parse(text, '');
  if (!result || !result.scene) throw new ViewerError('Collada file did not contain a parsable scene.');
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
    resourcesReady: aux.whenReady(),
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
  // LightWave 5 files declare the LWOB form type. three's LWOLoader reads LWO2
  // and LWO3 only and dies on LWOB with "Cannot read properties of undefined
  // (reading 'materials')". Upstream has deprecated the loader entirely
  // (mrdoob/three.js#33621), so LWOB is never going to start working — name it.
  if (tagAt(buf, 0, 4) === 'FORM' && tagAt(buf, 8, 4) === 'LWOB') {
    throw new ViewerError(
      'This is a LightWave 5 (LWOB) file, which is not supported — only the newer ' +
        'LWO2 and LWO3 layouts are. Re-save it from a current LightWave, or convert it to OBJ or FBX.',
    );
  }
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
