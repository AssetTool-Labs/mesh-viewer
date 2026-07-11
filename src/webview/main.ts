import * as THREE from 'three';
import type {
  AddFileErrorMessage,
  AddFileMessage,
  FilePayload,
  InitMessage,
  ViewerConfig,
} from '../types';
import { loadAsset, type LoadedAsset } from './loaders';
import {
  Viewer,
  computeStats,
  collectMaterials,
  type AssetEntry,
  type ShadingMode,
  type EnvironmentMode,
  type HudInfo,
} from './viewer';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();

interface NodeView {
  object: THREE.Object3D;
  row: HTMLDivElement;
  childrenContainer: HTMLDivElement;
  toggle: HTMLSpanElement;
  eye: HTMLButtonElement;
  expanded: boolean;
}

interface AnimRow {
  entry: AssetEntry;
  index: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('canvas');
const viewport = $('viewport');
const viewer = new Viewer(canvas);

const treeContainer = $<HTMLDivElement>('treeContainer');
const treeFilter = $<HTMLInputElement>('treeFilter');
const selectionDetails = $('selectionDetails');
const overlay = $('overlay');
const overlayMessage = $('overlayMessage');
const errorOverlay = $('errorOverlay');
const errorMessage = $('errorMessage');
const dropOverlay = $('dropOverlay');
const toastStack = $('toastStack');
const fileNameEl = $('fileName');
const fileSubtitleEl = $('fileSubtitle');
const fileInfo = $('fileInfo');
const sceneTotals = $('sceneTotals');
const geomTotals = $('geomTotals');
const materialList = $('materialList');
const extraList = $('extraList');
const hudStats = $('hudStats');
const animationList = $('animationList');
const animPlay = $<HTMLButtonElement>('animPlay');
const animPause = $<HTMLButtonElement>('animPause');
const animStop = $<HTMLButtonElement>('animStop');
const animScrub = $<HTMLInputElement>('animScrub');
const animCurrent = $('animCurrent');
const animDuration = $('animDuration');
const animSpeed = $<HTMLInputElement>('animSpeed');
const animSpeedLabel = $('animSpeedLabel');

const shadingSelect = $<HTMLSelectElement>('shadingSelect');
const toggleGrid = $<HTMLInputElement>('toggleGrid');
const toggleAxes = $<HTMLInputElement>('toggleAxes');
const toggleBounds = $<HTMLInputElement>('toggleBounds');
const toggleSkeleton = $<HTMLInputElement>('toggleSkeleton');
const toggleWireframeOverlay = $<HTMLInputElement>('toggleWireframeOverlay');
const toggleAutoRotate = $<HTMLInputElement>('toggleAutoRotate');
const bgColor = $<HTMLInputElement>('bgColor');
const envSelect = $<HTMLSelectElement>('envSelect');
const resetCameraBtn = $<HTMLButtonElement>('resetCamera');
const frameSelectionBtn = $<HTMLButtonElement>('frameSelection');
const sidebarToggle = $<HTMLButtonElement>('sidebarToggle');
const importMeshBtn = $<HTMLButtonElement>('importMeshBtn');
const app = $('app');
const textureView = $('textureView');
const textureSummary = $('textureSummary');
const textureSelect = $<HTMLSelectElement>('textureSelect');
const toggleShowUV = $<HTMLInputElement>('toggleShowUV');

importMeshBtn.addEventListener('click', () => requestPickAndImport());

function requestPickAndImport(): void {
  const requestId = `pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // We don't know yet how many files the user will pick, so the toast is sticky
  // and gets dismissed on the first add/error reply (count 1 placeholder).
  const toastEl = showToast({ title: 'Choose mesh files…', sticky: true });
  pendingImports.set(requestId, { count: 1, toastEl, openEnded: true });
  vscode.postMessage({ type: 'pickAndImport', requestId });
}

const nodeViews = new Map<string, NodeView>();
const objectToUuid = new WeakMap<THREE.Object3D, string>();
let selectedObject: THREE.Object3D | null = null;
let primaryFile: { name: string; ext: string; size: number } | null = null;
let totalParseMs = 0;
let activeAnimRow: AnimRow | null = null;
let scrubLocked = false;
const pendingImports = new Map<
  string,
  {
    count: number;
    toastEl?: HTMLDivElement;
    /** True for `pickAndImport` where we don't know the file count up-front. */
    openEnded?: boolean;
  }
>();
let sceneTotalSize = 0;
let auxFileCount = 0;
const animRows: AnimRow[] = [];

// ---- Texture panel state ----
/** All texture usages discovered during the last `populateTextures()` build. */
interface TextureUsage {
  /** Material slot name (e.g. "map", "normalMap"). */
  slot: string;
  material: THREE.Material;
  /** Any mesh whose geometry uses this material; we keep one as a UV source. */
  mesh: THREE.Mesh;
}
interface TextureEntry {
  texture: THREE.Texture;
  usages: TextureUsage[];
  /** Pretty label shown in the dropdown. */
  label: string;
  /** Stable key used to remember the user's selection across rebuilds. */
  key: string;
}
let textureEntries: TextureEntry[] = [];
let activeTextureIdx = 0;
/** Live references to the canvases of the currently-mounted card, so the UV
 *  toggle / selection change can repaint without rebuilding the whole card. */
let activeImgCanvas: HTMLCanvasElement | null = null;
let activeUVCanvas: HTMLCanvasElement | null = null;
let showUV = false;

// ---- Tabs ----
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const which = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      const el = p as HTMLElement;
      el.classList.toggle('active', el.dataset.tab === which);
    });
  });
});

// ---- View settings ----
shadingSelect.addEventListener('change', () => viewer.setShading(shadingSelect.value as ShadingMode));
toggleGrid.addEventListener('change', () => viewer.setGridVisible(toggleGrid.checked));
toggleAxes.addEventListener('change', () => viewer.setAxesVisible(toggleAxes.checked));
toggleBounds.addEventListener('change', () => viewer.setBoundsVisible(toggleBounds.checked));
toggleSkeleton.addEventListener('change', () => viewer.setSkeletonVisible(toggleSkeleton.checked));
toggleWireframeOverlay.addEventListener('change', () => viewer.setWireframeOverlayVisible(toggleWireframeOverlay.checked));
toggleAutoRotate.addEventListener('change', () => viewer.setAutoRotate(toggleAutoRotate.checked));
bgColor.addEventListener('input', () => viewer.setBackground(bgColor.value));
envSelect.addEventListener('change', () => viewer.applyEnvironment(envSelect.value as EnvironmentMode));
resetCameraBtn.addEventListener('click', () => viewer.frameAll());
frameSelectionBtn.addEventListener('click', () => {
  if (selectedObject) viewer.frameObject(selectedObject);
  else viewer.frameAll();
});
sidebarToggle.addEventListener('click', () => app.classList.toggle('sidebar-collapsed'));

toggleShowUV.addEventListener('change', () => {
  showUV = toggleShowUV.checked;
  refreshUVOverlay();
});

textureSelect.addEventListener('change', () => {
  const idx = Number(textureSelect.value);
  if (Number.isFinite(idx) && idx >= 0 && idx < textureEntries.length) {
    activeTextureIdx = idx;
    renderActiveTexture();
  }
});

// ---- Tree filter ----
/** Returns true when a node matches the current filter query (empty query
 *  matches everything). Shared by the filter input and the bulk hide/show
 *  actions so they always target exactly the same set of rows. */
function nodeMatchesFilter(obj: THREE.Object3D): boolean {
  const q = treeFilter.value.trim().toLowerCase();
  return !q || obj.name.toLowerCase().includes(q) || obj.type.toLowerCase().includes(q);
}

treeFilter.addEventListener('input', () => {
  const q = treeFilter.value.trim().toLowerCase();
  for (const view of nodeViews.values()) {
    const matches = nodeMatchesFilter(view.object);
    view.row.classList.toggle('dim', !matches);
    if (matches && q) {
      let parent = view.object.parent;
      while (parent) {
        const id = objectToUuid.get(parent);
        if (id) {
          const pv = nodeViews.get(id);
          if (pv && !pv.expanded) toggleNode(pv, true);
        }
        parent = parent.parent;
      }
    }
  }
  refreshToggleButton();
});

$<HTMLButtonElement>('treeExpandAll').addEventListener('click', () => {
  for (const v of nodeViews.values()) toggleNode(v, true);
});
$<HTMLButtonElement>('treeCollapseAll').addEventListener('click', () => {
  for (const v of nodeViews.values()) toggleNode(v, false);
});

// ---- Bulk hide/show of filtered results ----
// One toggle button + Blender-style shortcuts act on every node matching the
// current filter at once, instead of toggling eye icons one by one. When the
// filter is empty this acts on the whole hierarchy.
const toggleVisBtn = $<HTMLButtonElement>('treeToggleVisibility');

function matchingViews(): NodeView[] {
  const out: NodeView[] = [];
  for (const v of nodeViews.values()) if (nodeMatchesFilter(v.object)) out.push(v);
  return out;
}

/** Keep the toggle button in sync with the filtered set: it shows a filled dot
 *  (◉, matching the tree eyes) while the set is visible and a hollow dot (○)
 *  once it is hidden. The tooltip spells out the action a click will perform. */
function refreshToggleButton(): void {
  const anyVisible = matchingViews().some((v) => v.object.visible);
  toggleVisBtn.textContent = anyVisible ? '◉' : '○';
  toggleVisBtn.classList.toggle('off', !anyVisible);
  toggleVisBtn.title = anyVisible
    ? 'Hide filtered results (H)'
    : 'Show filtered results (Alt+H / Shift+H)';
}

function setFilteredVisibility(visible: boolean): void {
  let changed = 0;
  for (const view of nodeViews.values()) {
    if (!nodeMatchesFilter(view.object)) continue;
    if (view.object.visible !== visible) changed++;
    setObjectVisibility(view.object, visible);
  }
  const q = treeFilter.value.trim();
  const scope = q ? `matching “${q}”` : 'all nodes';
  showToast({ title: `${visible ? 'Showed' : 'Hid'} ${changed} ${changed === 1 ? 'node' : 'nodes'}`, body: scope });
  refreshToggleButton();
}

// Click toggles: hide the filtered set if any of it is visible, otherwise reveal it.
toggleVisBtn.addEventListener('click', () => {
  const anyVisible = matchingViews().some((v) => v.object.visible);
  setFilteredVisibility(!anyVisible);
});

// Blender-style keyboard shortcuts: H hides the filtered set, Alt+H (or Shift+H)
// reveals it. We key off ev.code so Alt+H works on macOS, where Option+H would
// otherwise produce a "˙" character instead of "h". Ignored while typing in an
// input/textarea so the filter box keeps accepting the letter "h".
document.addEventListener('keydown', (ev) => {
  if (ev.code !== 'KeyH' && ev.key !== 'h' && ev.key !== 'H') return;
  if (ev.ctrlKey || ev.metaKey) return;
  const target = ev.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  ev.preventDefault();
  setFilteredVisibility(ev.shiftKey || ev.altKey);
});

// ---- Animation transport ----
animPlay.addEventListener('click', () => {
  if (!activeAnimRow) {
    if (animRows.length) startAnim(animRows[0]);
    return;
  }
  viewer.resumeAnimation();
});
animPause.addEventListener('click', () => viewer.pauseAnimation());
animStop.addEventListener('click', () => {
  viewer.stopAnimation();
  activeAnimRow = null;
  refreshAnimationActiveRow();
  animScrub.value = '0';
  animCurrent.textContent = '0.00s';
});

animScrub.addEventListener('input', () => {
  scrubLocked = true;
});
animScrub.addEventListener('change', () => {
  if (!activeAnimRow) {
    scrubLocked = false;
    return;
  }
  const clip = activeAnimRow.entry.asset.animations[activeAnimRow.index];
  if (!clip) {
    scrubLocked = false;
    return;
  }
  const t = (Number(animScrub.value) / 1000) * clip.duration;
  viewer.seekAnimation(t);
  animCurrent.textContent = `${t.toFixed(2)}s`;
  scrubLocked = false;
});

animSpeed.addEventListener('input', () => {
  const s = Number(animSpeed.value) / 100;
  animSpeedLabel.textContent = `${s.toFixed(2)}×`;
  viewer.setAnimationSpeed(s);
});

// ---- HUD ----
viewer.setHudCallback((info: HudInfo) => {
  hudStats.textContent =
    `${info.fps} fps\n` +
    `tris ${info.triangles.toLocaleString()}\n` +
    `calls ${info.drawCalls}\n` +
    `geom ${info.geometries}  tex ${info.textures}`;
});

viewer.setAnimationCallback((time, duration) => {
  if (scrubLocked || duration <= 0) return;
  animScrub.value = String(Math.round((time / duration) * 1000));
  animCurrent.textContent = `${time.toFixed(2)}s`;
});

// ---- Picking ----
// We must distinguish a "click" from a camera "drag" (OrbitControls eats the
// same left button to rotate). If we picked on every pointerdown, every drag
// would deselect or select the wrong thing. We record the press position +
// time and only run a raycast on pointerup when the pointer hardly moved.
const PICK_MOVE_PX = 5;
const PICK_MAX_MS = 400;
let pressStart: { x: number; y: number; t: number; button: number } | null = null;

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return; // left button only; middle/right are pan/orbit
  pressStart = { x: ev.clientX, y: ev.clientY, t: performance.now(), button: ev.button };
});

canvas.addEventListener('pointerup', (ev) => {
  const start = pressStart;
  pressStart = null;
  if (!start || ev.button !== start.button) return;
  const dx = ev.clientX - start.x;
  const dy = ev.clientY - start.y;
  if (Math.hypot(dx, dy) > PICK_MOVE_PX) return; // it was a drag-orbit
  if (performance.now() - start.t > PICK_MAX_MS) return; // long-press, not a click
  pickAt(ev);
});

canvas.addEventListener('pointercancel', () => {
  pressStart = null;
});

function pickAt(ev: PointerEvent): void {
  if (!viewer.entries.length) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, viewer.camera);
  // Adaptive thresholds so point clouds / line objects are pickable regardless
  // of scene scale. Tied to the camera-to-target distance so it stays usable
  // whether the user is zoomed into a 1cm object or framing a 100m one.
  const dist = viewer.camera.position.distanceTo(viewer.controls.target);
  const r = Math.max(dist * 0.005, 1e-4);
  ray.params.Points = { threshold: r };
  ray.params.Line = { threshold: r };

  const hits = ray.intersectObject(viewer.contentRoot, true);
  // Skip hits on invisible nodes (their ancestors may be toggled off via the eye)
  // and on the floor grid (which isn't a child of contentRoot anyway).
  const hit = hits.find((h) => {
    for (let o: THREE.Object3D | null = h.object; o; o = o.parent) {
      if (o.visible === false) return false;
    }
    return true;
  });
  if (!hit) {
    deselect();
    return;
  }
  selectObject(hit.object);
}

function deselect(): void {
  selectedObject = null;
  for (const v of nodeViews.values()) v.row.classList.remove('selected');
  viewer.setSelected(null);
  selectionDetails.innerHTML = '<div class="kv-empty">Select a node to inspect it.</div>';
  if (showUV) refreshUVOverlay();
}

// ---- Drag and drop ----

let dragDepth = 0;
function isFileDrag(ev: DragEvent): boolean {
  if (!ev.dataTransfer) return false;
  const types = ev.dataTransfer.types;
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === 'Files' || t === 'text/uri-list') return true;
  }
  return false;
}

viewport.addEventListener('dragenter', (ev) => {
  if (!isFileDrag(ev as DragEvent)) return;
  ev.preventDefault();
  dragDepth++;
  dropOverlay.classList.remove('hidden');
});
viewport.addEventListener('dragover', (ev) => {
  if (!isFileDrag(ev as DragEvent)) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
});
viewport.addEventListener('dragleave', (ev) => {
  if (!isFileDrag(ev as DragEvent)) return;
  ev.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add('hidden');
});
viewport.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  if (!ev.dataTransfer) return;

  // Native OS file drop wins if it's there: we already have the bytes.
  const nativeFiles = Array.from(ev.dataTransfer.files);
  if (nativeFiles.length) {
    for (const file of nativeFiles) await importNativeFile(file);
    return;
  }

  // VS Code Explorer drop: a newline-separated uri list.
  const uriList = ev.dataTransfer.getData('text/uri-list') || ev.dataTransfer.getData('text/plain');
  if (uriList) {
    const uris = uriList
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (uris.length) requestImportUris(uris);
  }
});

async function importNativeFile(file: File): Promise<void> {
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) {
    showToast({ title: 'Unsupported file', body: file.name, kind: 'error' });
    return;
  }
  const ext = file.name.slice(dot + 1).toLowerCase();
  const isText = TEXT_EXTENSIONS.has(ext);
  let data: ArrayBuffer | string;
  try {
    data = isText ? await file.text() : await file.arrayBuffer();
  } catch (err) {
    showToast({ title: 'Read failed', body: `${file.name}: ${(err as Error).message}`, kind: 'error' });
    return;
  }
  const t0 = performance.now();
  let asset: LoadedAsset;
  try {
    asset = await loadAsset(ext, data, file.name, {});
  } catch (err) {
    showToast({ title: 'Parse failed', body: `${file.name}: ${(err as Error).message}`, kind: 'error' });
    return;
  }
  totalParseMs += performance.now() - t0;
  sceneTotalSize += file.size;
  viewer.addAsset(asset, file.name);
  rebuildAllPanels();
  showToast({ title: 'Imported', body: `${file.name} (${formatBytes(file.size)})`, kind: 'success' });
}

function requestImportUris(uris: string[]): void {
  const requestId = `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const toastEl = showToast({
    title: `Importing ${uris.length} file${uris.length === 1 ? '' : 's'}…`,
    body: uris.map(uriBasename).join('\n'),
    sticky: true,
  });
  pendingImports.set(requestId, { count: uris.length, toastEl });
  vscode.postMessage({ type: 'loadUris', requestId, uris });
}

function uriBasename(uri: string): string {
  try {
    const u = decodeURIComponent(uri);
    const stripped = u.replace(/[?#].*$/, '');
    const idx = stripped.lastIndexOf('/');
    return idx >= 0 ? stripped.slice(idx + 1) : stripped;
  } catch {
    return uri;
  }
}

const TEXT_EXTENSIONS = new Set(['obj', 'gltf', 'dae', 'wrl', 'vrml', 'usda', 'xyz']);


// ---- Message handling ----

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    handleInit(msg as InitMessage).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
      vscode.postMessage({ type: 'error', message });
    });
  } else if (msg.type === 'addFile') {
    handleAddFile(msg as AddFileMessage).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      showToast({ title: 'Import failed', body: message, kind: 'error' });
    });
  } else if (msg.type === 'addFileError') {
    handleAddFileError(msg as AddFileErrorMessage);
  } else if (msg.type === 'loadError') {
    showError(String(msg.message));
  } else if (msg.type === 'command' && msg.command === 'resetCamera') {
    viewer.frameAll();
  }
});

async function fetchPayload(msg: FilePayload): Promise<ArrayBuffer | string> {
  const resp = await fetch(msg.fileUri);
  if (!resp.ok) throw new Error(`Failed to fetch ${msg.fileName}: ${resp.status} ${resp.statusText}`);
  return msg.isText ? resp.text() : resp.arrayBuffer();
}

vscode.postMessage({ type: 'ready' });

async function handleInit(msg: InitMessage): Promise<void> {
  applyConfig(msg.config);
  primaryFile = { name: msg.fileName, ext: msg.fileExtension, size: msg.fileSizeBytes };
  fileNameEl.textContent = msg.fileName;
  fileSubtitleEl.textContent = `${msg.fileExtension.toUpperCase()} · ${formatBytes(msg.fileSizeBytes)}`;
  document.title = `${msg.fileName} — 3D Mesh Viewer`;
  showOverlay(`Loading .${msg.fileExtension}…`);
  const t0 = performance.now();
  let asset: LoadedAsset;
  try {
    const data = await fetchPayload(msg);
    asset = await loadAsset(msg.fileExtension, data, msg.fileName, msg.auxFileUris);
  } catch (err) {
    hideOverlay();
    const message = err instanceof Error ? err.message : String(err);
    showError(message);
    return;
  }
  totalParseMs = performance.now() - t0;
  sceneTotalSize = msg.fileSizeBytes;
  auxFileCount = msg.auxFileUris ? Object.keys(msg.auxFileUris).length : 0;
  viewer.loadAsset(asset, msg.fileName);
  rebuildAllPanels();
  hideOverlay();
}

async function handleAddFile(msg: AddFileMessage): Promise<void> {
  const t0 = performance.now();
  let asset: LoadedAsset;
  try {
    const data = await fetchPayload(msg);
    asset = await loadAsset(msg.fileExtension, data, msg.fileName, msg.auxFileUris);
  } catch (err) {
    consumePendingImport(msg.requestId);
    showToast({
      title: 'Parse failed',
      body: `${msg.fileName}: ${(err as Error).message}`,
      kind: 'error',
    });
    return;
  }
  totalParseMs += performance.now() - t0;
  sceneTotalSize += msg.fileSizeBytes;
  auxFileCount += msg.auxFileUris ? Object.keys(msg.auxFileUris).length : 0;
  viewer.addAsset(asset, msg.fileName);
  rebuildAllPanels();
  consumePendingImport(msg.requestId);
  showToast({
    title: 'Imported',
    body: `${msg.fileName} (${formatBytes(msg.fileSizeBytes)})`,
    kind: 'success',
  });
}

function handleAddFileError(msg: AddFileErrorMessage): void {
  // `__cancelled__` is the sentinel the host sends when the user dismissed the
  // open-file dialog. Suppress the noisy red toast in that case.
  if (msg.message === '__cancelled__') {
    finishPendingImport(msg.requestId);
    return;
  }
  consumePendingImport(msg.requestId);
  showToast({ title: 'Import failed', body: `${msg.fileName}: ${msg.message}`, kind: 'error' });
}

function consumePendingImport(requestId: string | undefined): void {
  if (!requestId) return;
  const pending = pendingImports.get(requestId);
  if (!pending) return;
  if (pending.openEnded) {
    // First reply replaces the "choose files" toast.
    pending.toastEl?.remove();
    pending.toastEl = undefined;
    pending.openEnded = false;
    return;
  }
  pending.count--;
  if (pending.count <= 0) {
    pendingImports.delete(requestId);
    pending.toastEl?.remove();
  }
}

function finishPendingImport(requestId: string | undefined): void {
  if (!requestId) return;
  const pending = pendingImports.get(requestId);
  if (!pending) return;
  pendingImports.delete(requestId);
  pending.toastEl?.remove();
}

function applyConfig(config: ViewerConfig): void {
  viewer.setBackground(config.backgroundColor);
  viewer.setGridVisible(config.showGrid);
  viewer.setAxesVisible(config.showAxes);
  viewer.setAutoRotate(config.autoRotate);
  viewer.setShading(config.shading);
  viewer.applyEnvironment(config.environment);

  toggleGrid.checked = config.showGrid;
  toggleAxes.checked = config.showAxes;
  toggleAutoRotate.checked = config.autoRotate;
  shadingSelect.value = config.shading;
  envSelect.value = config.environment;
  bgColor.value = normalizeHexColor(config.backgroundColor);
}

function normalizeHexColor(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  try {
    const col = new THREE.Color(c);
    return `#${col.getHexString()}`;
  } catch {
    return '#1e1e1e';
  }
}

function showOverlay(message: string): void {
  overlay.classList.remove('hidden');
  overlayMessage.textContent = message;
}
function hideOverlay(): void {
  overlay.classList.add('hidden');
}
function showError(message: string): void {
  hideOverlay();
  errorOverlay.classList.remove('hidden');
  errorMessage.textContent = message;
}

interface ToastOpts {
  title: string;
  body?: string;
  kind?: 'success' | 'error' | 'info';
  sticky?: boolean;
}

function showToast(opts: ToastOpts): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `toast ${opts.kind ?? 'info'}`;
  const t = document.createElement('div');
  t.className = 'toast-title';
  t.textContent = opts.title;
  el.appendChild(t);
  if (opts.body) {
    const b = document.createElement('div');
    b.className = 'toast-msg';
    b.textContent = opts.body;
    el.appendChild(b);
  }
  toastStack.appendChild(el);
  if (!opts.sticky) {
    setTimeout(() => el.remove(), opts.kind === 'error' ? 6000 : 3500);
  }
  return el;
}

// ---- Refresh all panels from current viewer state ----

function rebuildAllPanels(): void {
  buildHierarchy();
  populateTextures();
  populateInfo();
  populateAnimations();
  refreshSubtitle();
}

function refreshSubtitle(): void {
  if (!primaryFile) return;
  const extras = viewer.entries.length - 1;
  fileSubtitleEl.textContent =
    `${primaryFile.ext.toUpperCase()} · ${formatBytes(sceneTotalSize)}` +
    (extras > 0 ? ` · +${extras} imported` : '');
}

// ---- Hierarchy tree ----

function buildHierarchy(): void {
  // Drop any current selection visuals before throwing the tree away, otherwise
  // edges/box helpers can stay parented to a node we no longer reference.
  viewer.setSelected(null);
  treeContainer.innerHTML = '';
  nodeViews.clear();
  selectedObject = null;
  selectionDetails.innerHTML = '<div class="kv-empty">Select a node to inspect it.</div>';
  for (const entry of viewer.entries) {
    buildNode(entry.wrapper, treeContainer, 0);
  }
  refreshToggleButton();
}

function buildNode(obj: THREE.Object3D, parentContainer: HTMLElement, depth: number): void {
  const id = obj.uuid;
  objectToUuid.set(obj, id);

  const row = document.createElement('div');
  row.className = 'tree-node';
  row.dataset.id = id;

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  toggle.textContent = obj.children.length ? '▸' : '·';
  if (!obj.children.length) toggle.classList.add('placeholder');

  const eye = document.createElement('button');
  eye.className = 'tree-eye';
  eye.title = 'Toggle visibility';
  eye.textContent = obj.visible ? '◉' : '○';
  if (!obj.visible) eye.classList.add('off');

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = iconFor(obj);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = displayName(obj);
  label.title = `${obj.type}${obj.name ? ` — ${obj.name}` : ''}`;

  row.append(toggle, eye, icon, label);
  parentContainer.appendChild(row);

  const childrenContainer = document.createElement('div');
  childrenContainer.className = 'tree-children collapsed';
  parentContainer.appendChild(childrenContainer);

  const view: NodeView = { object: obj, row, childrenContainer, toggle, eye, expanded: false };
  nodeViews.set(id, view);

  if (depth < 2 && obj.children.length) toggleNode(view, true);

  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleNode(view);
  });
  eye.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setObjectVisibility(obj, !obj.visible);
    refreshVisibilityIcon(view);
    refreshToggleButton();
  });
  row.addEventListener('click', () => selectObject(obj));
  row.addEventListener('dblclick', () => viewer.frameObject(obj));

  for (const child of obj.children) buildNode(child, childrenContainer, depth + 1);
}

function toggleNode(view: NodeView, force?: boolean): void {
  const next = force ?? !view.expanded;
  view.expanded = next;
  view.childrenContainer.classList.toggle('collapsed', !next);
  if (view.object.children.length) view.toggle.textContent = next ? '▾' : '▸';
}

function refreshVisibilityIcon(view: NodeView): void {
  const v = view.object.visible;
  view.eye.textContent = v ? '◉' : '○';
  view.eye.classList.toggle('off', !v);
  view.row.classList.toggle('hidden-node', !v);
}

function setObjectVisibility(obj: THREE.Object3D, visible: boolean): void {
  obj.visible = visible;
  obj.traverse((o) => {
    const id = objectToUuid.get(o);
    if (!id) return;
    const v = nodeViews.get(id);
    if (v) refreshVisibilityIcon(v);
  });
}

function selectObject(obj: THREE.Object3D): void {
  selectedObject = obj;
  // 1) Highlight the matching row in the in-extension scene explorer.
  for (const v of nodeViews.values()) v.row.classList.toggle('selected', v.object === obj);
  let parent = obj.parent;
  while (parent) {
    const pid = objectToUuid.get(parent);
    if (pid) {
      const pv = nodeViews.get(pid);
      if (pv && !pv.expanded) toggleNode(pv, true);
    }
    parent = parent.parent;
  }
  const id = objectToUuid.get(obj);
  if (id) nodeViews.get(id)?.row.scrollIntoView({ block: 'nearest' });
  // 2) Draw a wireframe + bounding-box highlight around the mesh in the 3D viewport.
  viewer.setSelected(obj);
  // 3) Update the inspector pane with details about the selection.
  renderSelectionDetails(obj);
  // 4) If the user is viewing the Texture tab with UV overlay on, prefer the
  //    selected mesh's UVs (so they can inspect that exact mesh's unwrap).
  if (showUV) refreshUVOverlay();
}

function renderSelectionDetails(obj: THREE.Object3D): void {
  selectionDetails.innerHTML = '';
  const kv = (k: string, v: string): void => {
    const a = document.createElement('div');
    a.className = 'kv-key';
    a.textContent = k;
    const b = document.createElement('div');
    b.className = 'kv-val';
    b.textContent = v;
    selectionDetails.append(a, b);
  };

  kv('Name', obj.name || '(unnamed)');
  kv('Type', obj.type);
  kv('UUID', obj.uuid);
  kv('Visible', obj.visible ? 'yes' : 'no');
  const pos = obj.position;
  kv('Position', `${fmt(pos.x)}, ${fmt(pos.y)}, ${fmt(pos.z)}`);
  const rotEuler = obj.rotation;
  kv('Rotation', `${fmtDeg(rotEuler.x)}°, ${fmtDeg(rotEuler.y)}°, ${fmtDeg(rotEuler.z)}°`);
  const scale = obj.scale;
  kv('Scale', `${fmt(scale.x)}, ${fmt(scale.y)}, ${fmt(scale.z)}`);
  kv('Children', String(obj.children.length));

  const mesh = obj as THREE.Mesh;
  if (mesh.isMesh && mesh.geometry) {
    const g = mesh.geometry as THREE.BufferGeometry;
    const posAttr = g.getAttribute('position');
    const verts = posAttr ? posAttr.count : 0;
    const idx = g.index;
    const tris = idx ? idx.count / 3 : verts / 3;
    kv('Vertices', verts.toLocaleString());
    kv('Triangles', Math.round(tris).toLocaleString());
    if (idx) kv('Indices', idx.count.toLocaleString());
    const attrs = Object.keys(g.attributes);
    if (attrs.length) kv('Attributes', attrs.join(', '));
    const groups = g.groups;
    if (groups && groups.length > 1) kv('Material groups', String(groups.length));
    g.computeBoundingBox?.();
    if (g.boundingBox) {
      const size = new THREE.Vector3();
      g.boundingBox.getSize(size);
      kv('Bounds', `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`);
    }
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      kv('Materials', mats.map((m) => m.type + (m.name ? ` "${m.name}"` : '')).join(', '));
    }
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      const skinned = mesh as THREE.SkinnedMesh;
      kv('Bones', String(skinned.skeleton?.bones.length ?? 0));
    }
  } else if ((obj as THREE.Points).isPoints) {
    const g = (obj as THREE.Points).geometry as THREE.BufferGeometry;
    const posAttr = g.getAttribute('position');
    kv('Points', posAttr ? posAttr.count.toLocaleString() : '0');
    const attrs = Object.keys(g.attributes);
    if (attrs.length) kv('Attributes', attrs.join(', '));
  } else if ((obj as THREE.LineSegments).isLineSegments) {
    const g = (obj as THREE.LineSegments).geometry as THREE.BufferGeometry;
    const posAttr = g.getAttribute('position');
    const verts = posAttr ? posAttr.count : 0;
    kv('Vertices', verts.toLocaleString());
    kv('Segments', Math.round(verts / 2).toLocaleString());
  } else if ((obj as THREE.Light).isLight) {
    const light = obj as THREE.Light;
    kv('Color', `#${light.color.getHexString()}`);
    kv('Intensity', fmt(light.intensity));
  } else if ((obj as THREE.Camera).isCamera) {
    const cam = obj as THREE.PerspectiveCamera;
    if ('fov' in cam) kv('FOV', `${fmt(cam.fov)}°`);
    if ('near' in cam) kv('Near / Far', `${fmt(cam.near)} / ${fmt(cam.far)}`);
  }
}

function fmt(n: number): string {
  if (Math.abs(n) < 1e-4 && n !== 0) return n.toExponential(2);
  return Number(n.toFixed(4)).toString();
}
function fmtDeg(rad: number): string {
  return Number(((rad * 180) / Math.PI).toFixed(2)).toString();
}

function iconFor(obj: THREE.Object3D): string {
  if ((obj as THREE.SkinnedMesh).isSkinnedMesh) return '⛓';
  if ((obj as THREE.Mesh).isMesh) return '◫';
  if ((obj as THREE.Points).isPoints) return '⋯';
  if ((obj as THREE.LineSegments).isLineSegments) return '╱';
  if ((obj as THREE.Bone).isBone) return '⦿';
  if ((obj as THREE.Light).isLight) return '☀';
  if ((obj as THREE.Camera).isCamera) return '◈';
  if ((obj as THREE.Group).isGroup) return '▣';
  return '·';
}

function displayName(obj: THREE.Object3D): string {
  if (obj.name) return obj.name;
  return `<${obj.type}>`;
}

// ---- Info panel ----

function populateInfo(): void {
  fileInfo.innerHTML = '';
  if (primaryFile) {
    appendKV(fileInfo, 'Primary', primaryFile.name);
    appendKV(fileInfo, 'Format', `.${primaryFile.ext.toUpperCase()}`);
  }
  appendKV(fileInfo, 'Total size', formatBytes(sceneTotalSize));
  appendKV(fileInfo, 'Parse time', `${totalParseMs.toFixed(0)} ms`);
  if (auxFileCount) appendKV(fileInfo, 'Companion files', String(auxFileCount));
  if (viewer.entries.length > 1) {
    appendKV(fileInfo, 'Imports', String(viewer.entries.length - 1));
  }

  // Per-asset metadata + per-asset entries.
  for (let i = 0; i < viewer.entries.length; i++) {
    const e = viewer.entries[i];
    const tag = i === 0 ? 'Loaded' : 'Imported';
    appendKV(fileInfo, tag, e.label);
    for (const [k, v] of Object.entries(e.asset.metadata)) {
      appendKV(fileInfo, `  ${k}`, v);
    }
  }

  const stats = computeStats(viewer.contentRoot);
  let nodeCount = 0;
  viewer.contentRoot.traverse(() => nodeCount++);

  sceneTotals.innerHTML = '';
  appendKV(sceneTotals, 'Nodes', nodeCount.toLocaleString());
  appendKV(sceneTotals, 'Meshes', stats.meshes.toLocaleString());
  if (stats.points) appendKV(sceneTotals, 'Point objects', stats.points.toLocaleString());
  if (stats.lines) appendKV(sceneTotals, 'Line segments', Math.round(stats.lines).toLocaleString());
  let totalAnims = 0;
  for (const e of viewer.entries) totalAnims += e.asset.animations.length;
  appendKV(sceneTotals, 'Animations', String(totalAnims));

  geomTotals.innerHTML = '';
  appendKV(geomTotals, 'Vertices', Math.round(stats.vertices).toLocaleString());
  appendKV(geomTotals, 'Triangles', Math.round(stats.triangles).toLocaleString());
  const box = new THREE.Box3().setFromObject(viewer.contentRoot);
  if (!box.isEmpty()) {
    const size = new THREE.Vector3();
    box.getSize(size);
    appendKV(geomTotals, 'Bounds', `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`);
    const center = new THREE.Vector3();
    box.getCenter(center);
    appendKV(geomTotals, 'Center', `${fmt(center.x)}, ${fmt(center.y)}, ${fmt(center.z)}`);
  }

  const mats = collectMaterials(viewer.contentRoot);
  materialList.innerHTML = '';
  if (!mats.length) {
    materialList.innerHTML = '<div class="kv-empty">No materials.</div>';
  } else {
    appendKV(materialList, 'Unique', String(mats.length));
    const types = new Map<string, number>();
    for (const m of mats) types.set(m.type, (types.get(m.type) ?? 0) + 1);
    for (const [t, n] of types) appendKV(materialList, t, String(n));
    const textures = new Set<THREE.Texture>();
    for (const m of mats) collectTextures(m, textures);
    appendKV(materialList, 'Textures', String(textures.size));
  }

  extraList.innerHTML = '';
  let cameraCount = 0;
  let lightCount = 0;
  const lightTypes = new Map<string, number>();
  for (const e of viewer.entries) {
    cameraCount += e.asset.cameras.length;
    lightCount += e.asset.lights.length;
    for (const l of e.asset.lights) lightTypes.set(l.type, (lightTypes.get(l.type) ?? 0) + 1);
  }
  appendKV(extraList, 'Cameras', String(cameraCount));
  appendKV(extraList, 'Lights', String(lightCount));
  for (const [t, n] of lightTypes) appendKV(extraList, '  ' + t, String(n));
}

function collectTextures(mat: THREE.Material, out: Set<THREE.Texture>): void {
  for (const key of Object.keys(mat)) {
    const v = (mat as unknown as Record<string, unknown>)[key];
    if (v && typeof v === 'object' && (v as { isTexture?: boolean }).isTexture) {
      out.add(v as THREE.Texture);
    }
  }
}

function appendKV(container: HTMLElement, k: string, v: string): void {
  const a = document.createElement('div');
  a.className = 'kv-key';
  a.textContent = k;
  const b = document.createElement('div');
  b.className = 'kv-val';
  b.textContent = v;
  container.append(a, b);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 2)} ${units[i]}`;
}

// ---- Animations ----

function populateAnimations(): void {
  animationList.innerHTML = '';
  animRows.length = 0;
  let totalAnims = 0;
  for (const e of viewer.entries) totalAnims += e.asset.animations.length;
  if (!totalAnims) {
    animationList.innerHTML = '<div class="kv-empty">No animations in this file.</div>';
    setAnimEnabled(false);
    animDuration.textContent = '/ 0.00s';
    animScrub.value = '0';
    activeAnimRow = null;
    return;
  }
  setAnimEnabled(true);

  for (const entry of viewer.entries) {
    if (!entry.asset.animations.length) continue;
    if (viewer.entries.length > 1) {
      const header = document.createElement('div');
      header.className = 'section-title';
      header.style.padding = '4px 6px 2px';
      header.textContent = entry.label;
      animationList.appendChild(header);
    }
    entry.asset.animations.forEach((clip, i) => {
      const row = document.createElement('div');
      row.className = 'anim-row';
      row.dataset.index = String(animRows.length);

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = clip.name || `clip ${i}`;
      name.title = clip.name || `clip ${i}`;

      const dur = document.createElement('div');
      dur.className = 'duration';
      dur.textContent = `${clip.duration.toFixed(2)}s`;

      row.append(name, dur);
      const animRow: AnimRow = { entry, index: i };
      row.addEventListener('click', () => startAnim(animRow));
      animationList.appendChild(row);
      animRows.push(animRow);
    });
  }
  refreshAnimationActiveRow();
}

function startAnim(row: AnimRow): void {
  const clip = row.entry.asset.animations[row.index];
  const action = row.entry.actions[row.index];
  if (!clip || !action) return;
  animDuration.textContent = `/ ${clip.duration.toFixed(2)}s`;
  viewer.playAction(action);
  activeAnimRow = row;
  refreshAnimationActiveRow();
}

function setAnimEnabled(enabled: boolean): void {
  animPlay.disabled = !enabled;
  animPause.disabled = !enabled;
  animStop.disabled = !enabled;
  animScrub.disabled = !enabled;
}

function refreshAnimationActiveRow(): void {
  animationList
    .querySelectorAll<HTMLDivElement>('.anim-row')
    .forEach((row, i) => row.classList.toggle('active', activeAnimRow?.index === animRows[i]?.index && activeAnimRow?.entry === animRows[i]?.entry));
}

// ============================================================================
// Texture panel
// ============================================================================

/** Cap on the internal canvas buffer's longest side. The displayed size is
 *  controlled by CSS (object-fit: contain inside the panel), so the buffer
 *  only needs to be large enough that we don't lose detail when the panel is
 *  wide; 1024 looks crisp without burning memory on 4K textures. */
const TEXTURE_CANVAS_MAX = 1024;

/** Human-friendly labels for the well-known material texture slots. Anything
 *  not in this map falls back to the raw property name. */
const TEXTURE_ROLE_LABELS: Record<string, string> = {
  map: 'Base Color',
  normalMap: 'Normal',
  roughnessMap: 'Roughness',
  metalnessMap: 'Metalness',
  aoMap: 'AO',
  emissiveMap: 'Emissive',
  bumpMap: 'Bump',
  displacementMap: 'Displacement',
  alphaMap: 'Alpha',
  envMap: 'Environment',
  lightMap: 'Lightmap',
  matcap: 'Matcap',
  gradientMap: 'Gradient',
  clearcoatMap: 'Clearcoat',
  clearcoatNormalMap: 'Clearcoat Normal',
  clearcoatRoughnessMap: 'Clearcoat Roughness',
  sheenColorMap: 'Sheen Color',
  sheenRoughnessMap: 'Sheen Roughness',
  transmissionMap: 'Transmission',
  thicknessMap: 'Thickness',
  specularIntensityMap: 'Specular Intensity',
  specularColorMap: 'Specular Color',
  iridescenceMap: 'Iridescence',
  iridescenceThicknessMap: 'Iridescence Thickness',
  anisotropyMap: 'Anisotropy',
};

function populateTextures(): void {
  // Remember which texture the user was looking at so we can restore the
  // dropdown selection if it's still around after the rebuild.
  const prevKey = textureEntries[activeTextureIdx]?.key;

  textureEntries = [];
  activeImgCanvas = null;
  activeUVCanvas = null;
  textureView.innerHTML = '';
  textureSelect.innerHTML = '';

  // Walk the scene once, grouping (texture -> [usages]) so we keep a stable
  // reference to a mesh + material per texture for the UV overlay.
  const byTexture = new Map<THREE.Texture, TextureUsage[]>();
  viewer.contentRoot.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      for (const key of Object.keys(mat)) {
        const v = (mat as unknown as Record<string, unknown>)[key];
        if (!v || typeof v !== 'object') continue;
        if (!(v as { isTexture?: boolean }).isTexture) continue;
        const tex = v as THREE.Texture;
        let list = byTexture.get(tex);
        if (!list) {
          list = [];
          byTexture.set(tex, list);
        }
        list.push({ slot: key, material: mat, mesh });
      }
    }
  });

  if (byTexture.size === 0) {
    textureSummary.textContent = '';
    textureSelect.disabled = true;
    toggleShowUV.disabled = true;
    textureView.innerHTML = '<div class="kv-empty">No textures in this scene.</div>';
    return;
  }
  textureSelect.disabled = false;
  toggleShowUV.disabled = false;

  // Sort: base color first, then normal/roughness/metalness, then the rest.
  const slotPriority = (slot: string): number => {
    const order = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
    const i = order.indexOf(slot);
    return i < 0 ? order.length + 1 : i;
  };
  const sorted = Array.from(byTexture.entries()).sort((a, b) => {
    const pa = Math.min(...a[1].map((u) => slotPriority(u.slot)));
    const pb = Math.min(...b[1].map((u) => slotPriority(u.slot)));
    return pa - pb;
  });

  textureEntries = sorted.map(([tex, usages]) => {
    const name = displayTextureName(tex, usages);
    const roles = Array.from(new Set(usages.map((u) => TEXTURE_ROLE_LABELS[u.slot] ?? u.slot)));
    return {
      texture: tex,
      usages,
      label: `${roles.join(' / ')} — ${name}`,
      key: `${tex.uuid}|${usages.map((u) => u.slot).join(',')}`,
    };
  });

  for (let i = 0; i < textureEntries.length; i++) {
    const e = textureEntries[i];
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = e.label;
    opt.title = e.label;
    textureSelect.appendChild(opt);
  }

  // Restore previous selection where possible, otherwise default to the first.
  const restoredIdx = prevKey ? textureEntries.findIndex((e) => e.key === prevKey) : -1;
  activeTextureIdx = restoredIdx >= 0 ? restoredIdx : 0;
  textureSelect.value = String(activeTextureIdx);

  const plural = textureEntries.length === 1 ? '' : 's';
  textureSummary.textContent = `${textureEntries.length} texture${plural} · select to inspect`;

  renderActiveTexture();
}

/** Build and mount the card for `textureEntries[activeTextureIdx]`. */
function renderActiveTexture(): void {
  textureView.innerHTML = '';
  activeImgCanvas = null;
  activeUVCanvas = null;
  const entry = textureEntries[activeTextureIdx];
  if (!entry) return;

  const card = document.createElement('div');
  card.className = 'tex-card';

  const head = document.createElement('div');
  head.className = 'tex-card-head';
  const name = document.createElement('div');
  name.className = 'tex-card-name';
  const nameText = displayTextureName(entry.texture, entry.usages);
  name.textContent = nameText;
  name.title = nameText;
  const roleBadge = document.createElement('div');
  roleBadge.className = 'tex-card-role';
  const uniqueRoles = Array.from(new Set(entry.usages.map((u) => TEXTURE_ROLE_LABELS[u.slot] ?? u.slot)));
  roleBadge.textContent = uniqueRoles.join(' · ');
  head.append(name, roleBadge);
  card.appendChild(head);

  const preview = document.createElement('div');
  preview.className = 'tex-card-preview';

  const imgCanvas = document.createElement('canvas');
  imgCanvas.className = 'tex-img';
  const ok = drawTextureToCanvas(entry.texture, imgCanvas);
  if (!ok) {
    preview.classList.add('empty');
    preview.textContent = previewPlaceholderLabel(entry.texture);
  } else {
    const stack = document.createElement('div');
    stack.className = 'tex-canvas-stack';
    const uvCanvas = document.createElement('canvas');
    uvCanvas.className = 'tex-uv';
    // Critical for alignment: both canvases share the *same* internal buffer
    // size. CSS scales them identically via object-fit: contain, so UV strokes
    // drawn in the canvas's own pixel coords end up on top of the right
    // texels at any rendered display size.
    uvCanvas.width = imgCanvas.width;
    uvCanvas.height = imgCanvas.height;
    stack.append(imgCanvas, uvCanvas);
    preview.appendChild(stack);
    activeImgCanvas = imgCanvas;
    activeUVCanvas = uvCanvas;
  }
  card.appendChild(preview);

  const meta = document.createElement('div');
  meta.className = 'tex-card-meta';
  appendTexMeta(meta, 'Type', entry.texture.type === THREE.UnsignedByteType ? 'uint8' : 'hdr/float');
  const dims = imageDims(entry.texture.image);
  if (dims) {
    appendTexMeta(meta, 'Size', `${dims.w} × ${dims.h}`);
  } else if ((entry.texture as THREE.CompressedTexture).mipmaps?.[0]) {
    const mip = (entry.texture as THREE.CompressedTexture).mipmaps[0];
    appendTexMeta(meta, 'Size', `${mip.width} × ${mip.height} (compressed)`);
  }
  appendTexMeta(meta, 'Wrap', `${wrapName(entry.texture.wrapS)} / ${wrapName(entry.texture.wrapT)}`);
  appendTexMeta(meta, 'Filter', `${filterName(entry.texture.minFilter)} / ${filterName(entry.texture.magFilter)}`);
  appendTexMeta(meta, 'Encoding', entry.texture.colorSpace || 'NoColorSpace');
  appendTexMeta(meta, 'flipY', entry.texture.flipY ? 'yes' : 'no');
  appendTexMeta(meta, 'Used by', entry.usages.map((u) => `${u.material.name || u.material.type}.${u.slot}`).join(', '));
  card.appendChild(meta);

  textureView.appendChild(card);

  refreshUVOverlay();
}

function displayTextureName(tex: THREE.Texture, usages: TextureUsage[]): string {
  if (tex.name) return tex.name;
  const src = imageSrc(tex.image);
  if (src) {
    const path = src.replace(/[?#].*$/, '');
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
  }
  return `(${usages[0].slot})`;
}

/** Three.js types `Texture.image` as `unknown`, so we narrow it here. */
function imageDims(img: unknown): { w: number; h: number } | null {
  if (!img || typeof img !== 'object') return null;
  const o = img as { width?: unknown; height?: unknown };
  if (typeof o.width === 'number' && typeof o.height === 'number' && o.width > 0 && o.height > 0) {
    return { w: o.width, h: o.height };
  }
  return null;
}

function imageSrc(img: unknown): string {
  if (!img || typeof img !== 'object') return '';
  const o = img as { src?: unknown };
  return typeof o.src === 'string' ? o.src : '';
}

function appendTexMeta(host: HTMLElement, k: string, v: string): void {
  const a = document.createElement('div');
  a.className = 'k';
  a.textContent = k;
  const b = document.createElement('div');
  b.className = 'v';
  b.textContent = v;
  host.append(a, b);
}

function previewPlaceholderLabel(tex: THREE.Texture): string {
  if ((tex as THREE.CompressedTexture).isCompressedTexture) return 'Compressed texture — no 2D preview available.';
  if ((tex as THREE.CubeTexture).isCubeTexture) return 'Cubemap — no flat preview available.';
  if ((tex as THREE.DataTexture).isDataTexture) return 'Procedural data texture.';
  if (!tex.image) return 'Texture not yet decoded.';
  return 'Preview unavailable.';
}

function wrapName(w: THREE.Wrapping): string {
  if (w === THREE.RepeatWrapping) return 'repeat';
  if (w === THREE.MirroredRepeatWrapping) return 'mirror';
  return 'clamp';
}
function filterName(f: THREE.TextureFilter | THREE.MagnificationTextureFilter | THREE.MinificationTextureFilter): string {
  switch (f) {
    case THREE.NearestFilter: return 'nearest';
    case THREE.LinearFilter: return 'linear';
    case THREE.NearestMipmapNearestFilter: return 'nearest-mip-nearest';
    case THREE.NearestMipmapLinearFilter: return 'nearest-mip-linear';
    case THREE.LinearMipmapNearestFilter: return 'linear-mip-nearest';
    case THREE.LinearMipmapLinearFilter: return 'linear-mip-linear';
    default: return String(f);
  }
}

/**
 * Render the texture's source image into the canvas's internal pixel buffer at
 * up to TEXTURE_CANVAS_MAX on the longest side. Display size is governed by
 * CSS (`object-fit: contain` inside the stack), so we never touch
 * canvas.style here — that's what makes the UV overlay stay aligned when the
 * user resizes the panel.
 */
function drawTextureToCanvas(tex: THREE.Texture, canvas: HTMLCanvasElement): boolean {
  const img = tex.image;
  if (!img) return false;
  const dims = imageDims(img);
  if (!dims) return false;
  const { w: srcW, h: srcH } = dims;

  const aspect = srcW / srcH;
  let bw = srcW;
  let bh = srcH;
  if (bw > TEXTURE_CANVAS_MAX || bh > TEXTURE_CANVAS_MAX) {
    if (aspect >= 1) { bw = TEXTURE_CANVAS_MAX; bh = TEXTURE_CANVAS_MAX / aspect; }
    else            { bh = TEXTURE_CANVAS_MAX; bw = TEXTURE_CANVAS_MAX * aspect; }
  }
  bw = Math.max(1, Math.round(bw));
  bh = Math.max(1, Math.round(bh));
  canvas.width = bw;
  canvas.height = bh;

  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  try {
    // Only HTMLImageElement / HTMLCanvasElement / ImageBitmap are valid CanvasImageSource.
    const drawable =
      img instanceof HTMLImageElement ||
      img instanceof HTMLCanvasElement ||
      (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap);
    if (!drawable) return false;
    ctx.drawImage(img as CanvasImageSource, 0, 0, bw, bh);
    return true;
  } catch {
    return false;
  }
}

/** Re-draw the UV overlay on the currently-mounted card. */
function refreshUVOverlay(): void {
  if (!activeUVCanvas) return;
  const ctx = activeUVCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, activeUVCanvas.width, activeUVCanvas.height);
  if (!showUV) {
    activeUVCanvas.classList.add('hidden');
    return;
  }
  activeUVCanvas.classList.remove('hidden');
  const entry = textureEntries[activeTextureIdx];
  if (!entry) return;
  const usage = pickUsageForUV(entry);
  if (!usage) return;
  drawUVOverlay(usage.mesh.geometry as THREE.BufferGeometry, entry.texture, activeUVCanvas);
}

/**
 * If the current selection is a mesh that uses this texture, prefer its UVs.
 * Otherwise fall back to the first usage we recorded.
 */
function pickUsageForUV(entry: TextureEntry): TextureUsage | null {
  if (selectedObject) {
    const sel = selectedObject as THREE.Mesh;
    if (sel.isMesh && sel.material) {
      const mats = Array.isArray(sel.material) ? sel.material : [sel.material];
      const slot = entry.usages.find((u) => mats.includes(u.material));
      if (slot) return { slot: slot.slot, material: slot.material, mesh: sel };
    }
  }
  return entry.usages[0] ?? null;
}

function drawUVOverlay(
  geom: THREE.BufferGeometry,
  tex: THREE.Texture,
  canvas: HTMLCanvasElement,
): void {
  const uvAttr = geom.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uvAttr) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  // Convert UV to pixel space. With flipY=true (TextureLoader default for
  // PNG/JPG), the texture is sampled vertically inverted, so UV (0, 0) shows
  // up at the BOTTOM-LEFT of the displayed image. With flipY=false (GLTF), UV
  // (0, 0) is at TOP-LEFT.
  const flipped = tex.flipY !== false;
  const ux = (u: number) => u * w;
  const uy = (v: number) => (flipped ? (1 - v) * h : v * h);

  ctx.strokeStyle = 'rgba(76, 195, 247, 0.85)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();

  const idx = geom.getIndex();
  const stroke = (a: number, b: number, c: number): void => {
    const ax = ux(uvAttr.getX(a)), ay = uy(uvAttr.getY(a));
    const bx = ux(uvAttr.getX(b)), by = uy(uvAttr.getY(b));
    const cx = ux(uvAttr.getX(c)), cy = uy(uvAttr.getY(c));
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy); ctx.lineTo(ax, ay);
  };
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) stroke(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
  } else {
    for (let i = 0; i + 2 < uvAttr.count; i += 3) stroke(i, i + 1, i + 2);
  }
  ctx.stroke();
}
