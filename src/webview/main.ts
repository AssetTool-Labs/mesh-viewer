import * as THREE from 'three';
import type {
  AddFileErrorMessage,
  AddFileMessage,
  CameraLinkMode,
  FilePayload,
  InitMessage,
  InitViewSettings,
  OrbitDelta,
  ViewSettings,
} from '../types';
import { loadAsset, type LoadedAsset } from './loaders';
import { hasRenderableGeometry } from './renderables';
import { decodeText } from './textEncoding';
import {
  Viewer,
  computeStats,
  collectMaterials,
  contentBounds,
  isFiniteBox,
  type AssetEntry,
  type ShadingMode,
  type EnvironmentMode,
  type WeightMode,
  type MapChannel,
  type InspectMode,
  INSPECT_LABELS,
  type MorphMeshInfo,
  type HudInfo,
} from './viewer';
import { UVView, type AreaTool, type UVBacking, type UVElementContext } from './uvView';
import { elementSelection, type ElementMode } from './elementSelection';
import { idsInRegion, pickFromIntersection, pointInPolygon } from './elementTopology';
import { TimelinePanel, type TimelineClip } from './timeline';

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
const poseHint = $('poseHint');
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
const mapToggles = $('mapToggles');
const mapTogglesHeader = $<HTMLButtonElement>('mapTogglesHeader');
const mapToggleInputs: { el: HTMLInputElement; channel: MapChannel }[] = [
  { el: $<HTMLInputElement>('mapBaseColor'), channel: 'baseColor' },
  { el: $<HTMLInputElement>('mapNormal'), channel: 'normal' },
  { el: $<HTMLInputElement>('mapMetalness'), channel: 'metalness' },
  { el: $<HTMLInputElement>('mapRoughness'), channel: 'roughness' },
  { el: $<HTMLInputElement>('mapAo'), channel: 'ao' },
  { el: $<HTMLInputElement>('mapEmissive'), channel: 'emissive' },
];
const toggleGrid = $<HTMLInputElement>('toggleGrid');
const toggleAxes = $<HTMLInputElement>('toggleAxes');
const toggleBounds = $<HTMLInputElement>('toggleBounds');
const toggleSkeleton = $<HTMLInputElement>('toggleSkeleton');
const toggleWeights = $<HTMLInputElement>('toggleWeights');
const weightModeRow = $('weightModeRow');
const weightModeSelect = $<HTMLSelectElement>('weightModeSelect');
const weightBoneRow = $('weightBoneRow');
const weightBoneSelect = $<HTMLSelectElement>('weightBoneSelect');
const weightLegend = $('weightLegend');
const toggleXray = $<HTMLInputElement>('toggleXray');
const toggleFlatShading = $<HTMLInputElement>('toggleFlatShading');
const shadingHud = $('shadingHud');
const shadingModeBtns = Array.from(shadingHud.querySelectorAll<HTMLButtonElement>('[data-mode]'));
const shadingXrayBtn = $<HTMLButtonElement>('shadingXray');
const shadingFlatBtn = $<HTMLButtonElement>('shadingFlat');
const shadingCollapseBtn = $<HTMLButtonElement>('shadingCollapse');
const shadingLinkBtn = $<HTMLButtonElement>('shadingLink');
const shadingSnapshotBtn = $<HTMLButtonElement>('shadingSnapshot');
const shadingMeasureBtn = $<HTMLButtonElement>('shadingMeasure');
const scaleBar = $('scaleBar');
const scaleBarLabel = $('scaleBarLabel');
const measureLabel = $('measureLabel');
const shadingLinkSep = $('shadingLinkSep');
const toggleWireframeOverlay = $<HTMLInputElement>('toggleWireframeOverlay');
const splatUprightRow = $('splatUprightRow');
const toggleSplatUpright = $<HTMLInputElement>('toggleSplatUpright');
const toggleAutoRotate = $<HTMLInputElement>('toggleAutoRotate');
const bgColor = $<HTMLInputElement>('bgColor');
const envSelect = $<HTMLSelectElement>('envSelect');
const upAxisSelect = $<HTMLSelectElement>('upAxisSelect');
const hudUpAxisBtn = $<HTMLButtonElement>('hudUpAxis');
const resetCameraBtn = $<HTMLButtonElement>('resetCamera');
const resetPoseBtn = $<HTMLButtonElement>('resetPose');
const frameSelectionBtn = $<HTMLButtonElement>('frameSelection');
const sidebarToggle = $<HTMLButtonElement>('sidebarToggle');
const importMeshBtn = $<HTMLButtonElement>('importMeshBtn');
const blendshapesTab = $<HTMLButtonElement>('blendshapesTab');
const blendshapeList = $('blendshapeList');
const bsResetBtn = $<HTMLButtonElement>('bsReset');
const bsCombine = $<HTMLInputElement>('bsCombine');
const bsCombineRow = $('bsCombineRow');
const app = $('app');
const textureView = $('textureView');
const textureSummary = $('textureSummary');
const textureSelect = $<HTMLSelectElement>('textureSelect');
const toggleShowUV = $<HTMLInputElement>('toggleShowUV');
const texModal = $('texModal');
const texModalBody = $('texModalBody');
const texModalCaption = $('texModalCaption');
const texIsolateBtn = $<HTMLButtonElement>('texIsolate');
const viewStateChip = $('viewStateChip');
const viewStateChipLabel = $('viewStateChipLabel');
const viewStateChipClose = $<HTMLButtonElement>('viewStateChipClose');
const elemModeSeg = $('elemModeSeg');
const elemModeBtns = Array.from(elemModeSeg.querySelectorAll<HTMLButtonElement>('[data-elem]'));
const elemToolSeg = $('elemToolSeg');
const elemToolBtns = Array.from(elemToolSeg.querySelectorAll<HTMLButtonElement>('[data-tool]'));
const elemStatus = $('elemStatus');
const elemFrameBtn = $<HTMLButtonElement>('elemFrame');
const areaSvg = $('areaSvg') as unknown as SVGSVGElement;

// Enlarged texture preview: clone the (up-to-1024px) card canvas into a modal,
// compositing the UV overlay on top when it's currently shown.
function openTextureModal(img: HTMLCanvasElement, uv: HTMLCanvasElement | null, caption: string): void {
  const big = document.createElement('canvas');
  big.width = img.width;
  big.height = img.height;
  const ctx = big.getContext('2d');
  ctx?.drawImage(img, 0, 0);
  if (ctx && uv && !uv.classList.contains('hidden')) ctx.drawImage(uv, 0, 0);
  texModalBody.replaceChildren(big);
  texModalCaption.textContent = caption;
  texModal.classList.remove('hidden');
}
function closeTextureModal(): void {
  texModal.classList.add('hidden');
  texModalBody.replaceChildren();
}
texModal.addEventListener('click', closeTextureModal);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !texModal.classList.contains('hidden')) closeTextureModal();
});

importMeshBtn.addEventListener('click', () => requestPickAndImport());

// ---- Blender-style timeline / dope sheet (bottom dock) ----
// The panel is a read-only visualization: it scrubs/steps/plays through the
// viewer's animation mixer but never modifies keyframes.
const timeline = new TimelinePanel({
  getTime: () => viewer.animationTime,
  isPlaying: () => viewer.isAnimationPlaying,
  seekSeconds: (t) => {
    if (!ensureActiveAnim()) return;
    viewer.seekAnimation(t);
    syncSidebarTime();
  },
  togglePlay: () => toggleAnimPlayback(),
  setSpeed: (s) => {
    viewer.setAnimationSpeed(s);
    animSpeed.value = String(Math.round(s * 100));
    animSpeedLabel.textContent = `${s.toFixed(2)}×`;
  },
  setLoop: (loop) => viewer.setClipLooping(loop),
  selectClip: (i) => {
    const row = animRows[i];
    if (row) selectAnim(row, viewer.isAnimationPlaying);
  },
});

/** Make sure some action is active (paused) so seeks/steps have a target.
 *  Returns false when the scene has no animations at all. */
function ensureActiveAnim(): boolean {
  if (activeAnimRow) return true;
  const idx = timeline.activeClipIndex;
  const row = animRows[idx >= 0 ? idx : 0];
  if (!row) return false;
  selectAnim(row, false);
  return true;
}

/** Activate a clip, either playing or paused on its current/first frame. */
function selectAnim(row: AnimRow, play: boolean): void {
  const clip = row.entry.asset.animations[row.index];
  const action = row.entry.actions[row.index];
  if (!clip || !action) return;
  animDuration.textContent = `/ ${clip.duration.toFixed(2)}s`;
  if (play) viewer.playAction(action);
  else viewer.selectActionPaused(action);
  activeAnimRow = row;
  refreshAnimationActiveRow();
  const idx = animRows.indexOf(row);
  if (idx >= 0 && idx !== timeline.activeClipIndex) timeline.setActiveClip(idx);
  timeline.setPlaying(viewer.isAnimationPlaying);
  syncSidebarTime();
  timeline.refresh();
}

function toggleAnimPlayback(): void {
  if (!animRows.length) return;
  if (!activeAnimRow && !ensureActiveAnim()) return;
  if (viewer.isAnimationPlaying) {
    viewer.pauseAnimation();
  } else {
    // A finished non-looping clip restarts from frame 0, like Blender.
    const dur = viewer.activeClipDuration;
    if (!viewer.clipLooping && dur > 0 && viewer.animationTime >= dur - 1e-4) {
      viewer.seekAnimation(0);
    }
    viewer.resumeAnimation();
  }
  timeline.setPlaying(viewer.isAnimationPlaying);
  timeline.refresh();
}

/** Push the viewer's current animation time into the sidebar scrub UI. */
function syncSidebarTime(): void {
  const dur = viewer.activeClipDuration;
  const t = viewer.animationTime;
  if (dur > 0) animScrub.value = String(Math.round((t / dur) * 1000));
  animCurrent.textContent = `${t.toFixed(2)}s`;
}

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
/** One pan/zoom UV viewport, re-parented into whichever texture card is
 *  mounted, so zoom state survives texture switches and panel rebuilds. */
const uvView = new UVView();
let showUV = false;

// ---- Element selection (one selection, two views) ----
// The UV canvas and the 3D viewport render and mutate the same state; ids are
// seam-aware (see elementTopology), so a seam vertex lights all its UV copies.
function setElementMode(mode: ElementMode): void {
  elementSelection.setMode(mode);
  for (const b of elemModeBtns) b.classList.toggle('active', b.dataset.elem === mode);
  if (mode !== 'off') syncElementMesh();
}
for (const b of elemModeBtns) {
  b.addEventListener('click', () => setElementMode(b.dataset.elem as ElementMode));
}

let elemTool: AreaTool = 'box';
for (const b of elemToolBtns) {
  b.addEventListener('click', () => {
    elemTool = b.dataset.tool as AreaTool;
    for (const o of elemToolBtns) o.classList.toggle('active', o === b);
    rebuildElementContext();
  });
}

/** The selection follows the mesh whose UVs the texture card is showing. */
function syncElementMesh(): void {
  const entry = textureEntries[activeTextureIdx];
  const usage = entry ? pickUsageForUV(entry) : null;
  elementSelection.setMesh(usage?.mesh ?? null);
}

const ELEM_NOUN: Record<string, [string, string]> = {
  vertex: ['vertex', 'vertices'],
  edge: ['edge', 'edges'],
  face: ['face', 'faces'],
};

function rebuildElementContext(): void {
  const st = elementSelection;
  let ctx: UVElementContext | null = null;
  if (st.mode !== 'off' && st.mesh && st.topo) {
    ctx = {
      mode: st.mode,
      tool: elemTool,
      topo: st.topo,
      geometry: st.mesh.geometry as THREE.BufferGeometry,
      selected: st.selected,
      hovered: st.hovered,
      onHover: (id) => elementSelection.hover(id),
      onClick: (id, extend) => elementSelection.click(id, extend),
      onArea: (ids, extend) => elementSelection.applyArea(ids, extend),
      onLinked: (id, extend) => elementSelection.selectLinked(id, 'uv', extend),
    };
  }
  uvView.setElementContext(ctx);
}

elementSelection.onChange(() => {
  const st = elementSelection;
  // 3D side.
  viewer.updateElementOverlay(st.mesh, st.topo, st.mode, st.selected, st.hovered);
  // UV side.
  rebuildElementContext();
  elemFrameBtn.disabled =
    st.mode === 'off' || !st.mesh || (st.selected.size === 0 && st.hovered === null);
  // Status line under the toolbar.
  if (st.mode === 'off') {
    elemStatus.hidden = true;
  } else {
    elemStatus.hidden = false;
    if (!st.mesh || !st.topo) {
      elemStatus.textContent = 'No mesh with UVs to select on.';
    } else {
      const [one, many] = ELEM_NOUN[st.mode];
      const n = st.selected.size;
      elemStatus.textContent =
        `${n} ${n === 1 ? one : many} selected` +
        (st.hovered !== null ? ' · hovering' : '') +
        ' — drag to area-select, Shift extends, double-click = linked, A = all/none, Esc clears';
    }
  }
});

// Keys 1/2/3 switch element kind while selection is active; Esc clears.
document.addEventListener('keydown', (ev) => {
  const target = ev.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (elementSelection.mode === 'off') return;
  if (ev.code === 'Digit1') setElementMode('vertex');
  else if (ev.code === 'Digit2') setElementMode('edge');
  else if (ev.code === 'Digit3') setElementMode('face');
  else if (ev.code === 'KeyA') elementSelection.selectAllToggle();
  else if (ev.code === 'KeyF') frameElementViews();
  else if (ev.code === 'KeyB') armAreaSelect();
  else if (ev.code === 'Escape' && texModal.classList.contains('hidden')) {
    // An in-flight box/lasso eats the Esc; a second Esc clears the selection.
    if (uvView.cancelArea() || cancelAreaSelect3D()) return;
    elementSelection.clear();
  }
});

// ---- Tabs ----
function selectTab(which: string): void {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === which));
  document.querySelectorAll('.tab-panel').forEach((p) => {
    const el = p as HTMLElement;
    el.classList.toggle('active', el.dataset.tab === which);
  });
}
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => { if (tab.dataset.tab) selectTab(tab.dataset.tab); });
});

// ---- View settings ----
// Each control both applies its change live and reports the full settings
// snapshot to the host, which remembers it for future viewers (see
// pushViewSettings). Programmatic sync in applyViewSettings assigns
// .value/.checked directly, which does NOT dispatch 'change', so it never
// echoes back to the host.
shadingSelect.addEventListener('change', () => {
  // Picking any shading mode (dropdown or HUD strip) ends an Inspect view.
  setInspect(null);
  viewer.setShading(shadingSelect.value as ShadingMode);
  syncShadingHud();
  pushViewSettings();
});
for (const { el, channel } of mapToggleInputs) {
  el.addEventListener('change', () => viewer.setMapEnabled(channel, el.checked));
}
mapTogglesHeader.addEventListener('click', () => {
  const collapsed = mapToggles.classList.toggle('collapsed');
  mapTogglesHeader.setAttribute('aria-expanded', String(!collapsed));
});
toggleXray.addEventListener('change', () => { viewer.setXray(toggleXray.checked); syncShadingHud(); pushViewSettings(); });
toggleFlatShading.addEventListener('change', () => { viewer.setFlatShading(toggleFlatShading.checked); syncShadingHud(); pushViewSettings(); });

// ---- Shading HUD (Blender-style strip next to the view gizmo) ----
// HUD buttons route through the sidebar controls (select/checkboxes) and their
// change handlers so behavior stays single-sourced, like hudUpAxis below.
for (const btn of shadingModeBtns) {
  btn.addEventListener('click', () => {
    shadingSelect.value = btn.dataset.mode!;
    shadingSelect.dispatchEvent(new Event('change'));
  });
}
shadingXrayBtn.addEventListener('click', () => {
  toggleXray.checked = !toggleXray.checked;
  toggleXray.dispatchEvent(new Event('change'));
});
shadingFlatBtn.addEventListener('click', () => {
  toggleFlatShading.checked = !toggleFlatShading.checked;
  toggleFlatShading.dispatchEvent(new Event('change'));
});

// Collapse the strip rightward, leaving just the chevron beside the gizmo.
// Left out of the meshless disable pass below on purpose: the shading buttons
// grey out on splat-only scenes, but getting the strip out of the way should
// still work there.
shadingCollapseBtn.addEventListener('click', () => {
  const collapsed = shadingHud.classList.toggle('collapsed');
  shadingCollapseBtn.textContent = collapsed ? '‹' : '›';
  shadingCollapseBtn.dataset.tip = collapsed
    ? 'Show the shading controls'
    : 'Hide the shading controls';
});

/** Reflect the sidebar shading controls in the HUD strip. Points mode lives
 *  only in the dropdown, so no HUD button lights up for it. */
function syncShadingHud(): void {
  for (const btn of shadingModeBtns) {
    btn.classList.toggle('active', btn.dataset.mode === shadingSelect.value);
  }
  shadingXrayBtn.classList.toggle('active', toggleXray.checked);
  shadingFlatBtn.classList.toggle('active', toggleFlatShading.checked);
  // Map toggles only affect the asset's materials, so show them only there.
  const shaded = shadingSelect.value === 'material' || shadingSelect.value === 'rendered';
  mapToggles.style.display = shaded ? '' : 'none';
  updateViewStateChip();
}
syncShadingHud();

/** Session-local Inspect channel shown on the model (entered from the
 *  Textures tab). Like the skin-weight display it overrides the shading
 *  dropdown without touching it, so the chip below is what makes it visible. */
let inspectMode: InspectMode | null = null;
function setInspect(mode: InspectMode | null): void {
  if (inspectMode === mode) return;
  inspectMode = mode;
  viewer.setInspectMode(mode);
  updateViewStateChip();
  syncTexIsolateButton();
}

/** Viewport chip naming the active special view — skin weights or an Inspect
 *  channel — so the shading controls never silently disagree with what is
 *  drawn. Weights win when both are on, matching the precedence in
 *  Viewer.applyShadingToObject. */
function updateViewStateChip(): void {
  let text = '';
  if (toggleWeights.checked) {
    const label = weightModeSelect.selectedOptions[0]?.textContent ?? weightModeSelect.value;
    text = `Skin weights: ${label}`;
  } else if (inspectMode) {
    text = `Inspect: ${INSPECT_LABELS[inspectMode]}`;
  }
  viewStateChip.hidden = text === '';
  viewStateChipLabel.textContent = text;
}
// Weights exit through their checkbox (single-sourced with its handler);
// Inspect has no sidebar control of its own, so the chip clears it directly.
viewStateChipClose.addEventListener('click', () => {
  if (toggleWeights.checked) {
    toggleWeights.checked = false;
    toggleWeights.dispatchEvent(new Event('change'));
  } else {
    setInspect(null);
  }
});

// Export the current view as a PNG; the host shows a Save dialog and writes it.
function saveSnapshot(transparent = false): void {
  const base = (primaryFile?.name ?? 'snapshot').replace(/\.[^.]+$/, '');
  const suffix = transparent ? '-transparent' : '';
  vscode.postMessage({
    type: 'savePng',
    dataUrl: viewer.capturePNG({ transparent }),
    suggestedName: `${base}${suffix}.png`,
  });
}
shadingSnapshotBtn.addEventListener('click', (ev) => saveSnapshot(ev.altKey));

// ---- Camera linking (sync orbit across open viewers) ----
// The toggle only appears when 2+ viewers are open (the host reports the count).
// Flipping it links/unlinks every viewer at once. Two modes:
//   • aligned (default, plain click): all viewers share one pose and converge.
//   • offset  (Alt/Option-click): each viewer keeps its own framing and only the
//     incremental orbit motion is mirrored.
// Relaying goes through the host, which excludes the sender so there's no echo.
let viewerCount = 1;
let cameraLinkEnabled = false;
let linkMode: CameraLinkMode = 'aligned';
let cameraSyncQueued = false;
// Baseline for offset-mode deltas: the pose as of the last synced state.
let lastOrbitPose: ReturnType<typeof viewer.getOrbitPose> | null = null;

function updateLinkUi(): void {
  const show = viewerCount >= 2;
  shadingLinkBtn.hidden = !show;
  shadingLinkSep.hidden = !show;
  shadingLinkBtn.classList.toggle('active', cameraLinkEnabled);
  shadingLinkBtn.classList.toggle('link-offset', cameraLinkEnabled && linkMode === 'offset');
  shadingLinkBtn.dataset.tip = cameraLinkEnabled
    ? (linkMode === 'offset'
        ? 'Cameras linked (offset) — click to unlink'
        : 'Cameras linked — click to unlink')
    : 'Link cameras — move all open viewers together. Alt-click: offset mode (keep each view\u2019s framing)';
}

/** Difference between two orbit poses, or null if the move is negligible. */
function orbitDelta(
  prev: ReturnType<typeof viewer.getOrbitPose>,
  cur: ReturnType<typeof viewer.getOrbitPose>,
): OrbitDelta | null {
  // Wrap azimuth into (-π, π] so crossing the ±π seam doesn't spin the follower.
  let dTheta = cur.theta - prev.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  const dPhi = cur.phi - prev.phi;
  const rRatio = prev.radius > 1e-9 ? cur.radius / prev.radius : 1;
  const dTarget: [number, number, number] = [
    cur.target[0] - prev.target[0],
    cur.target[1] - prev.target[1],
    cur.target[2] - prev.target[2],
  ];
  const moved =
    Math.abs(dTheta) > 1e-5 ||
    Math.abs(dPhi) > 1e-5 ||
    Math.abs(rRatio - 1) > 1e-5 ||
    Math.hypot(dTarget[0], dTarget[1], dTarget[2]) > 1e-6;
  return moved ? { dTheta, dPhi, rRatio, dTarget, driverRadius: cur.radius } : null;
}

/** Coalesce the flurry of orbit 'change' events into one message per frame. */
function scheduleCameraSync(): void {
  if (cameraSyncQueued) return;
  cameraSyncQueued = true;
  requestAnimationFrame(() => {
    cameraSyncQueued = false;
    if (!cameraLinkEnabled) return;
    if (linkMode === 'aligned') {
      vscode.postMessage({ type: 'cameraSync', state: viewer.getCameraState() });
    } else {
      const cur = viewer.getOrbitPose();
      if (lastOrbitPose) {
        const delta = orbitDelta(lastOrbitPose, cur);
        if (delta) vscode.postMessage({ type: 'cameraOrbitDelta', delta });
      }
      lastOrbitPose = cur;
    }
  });
}

viewer.onCameraChange = () => {
  if (cameraLinkEnabled) scheduleCameraSync();
};

function setCameraLink(enabled: boolean, mode: CameraLinkMode): void {
  cameraLinkEnabled = enabled;
  linkMode = mode;
  // Offset mode measures motion from the moment of linking.
  lastOrbitPose = enabled && mode === 'offset' ? viewer.getOrbitPose() : null;
  updateLinkUi();
}

shadingLinkBtn.addEventListener('click', (ev) => {
  if (cameraLinkEnabled) {
    setCameraLink(false, linkMode);
  } else {
    setCameraLink(true, ev.altKey ? 'offset' : 'aligned');
  }
  vscode.postMessage({ type: 'cameraLinkChanged', enabled: cameraLinkEnabled, mode: linkMode });
  // Aligned mode snaps the others onto this view the moment they link.
  if (cameraLinkEnabled && linkMode === 'aligned') {
    vscode.postMessage({ type: 'cameraSync', state: viewer.getCameraState() });
  }
});

// Hover explanation under the strip. A styled element instead of title=""
// tooltips: it appears instantly and right-aligned so it never clips at the
// viewport edge. data-tip is read on every hover since hudUpAxis rewrites its
// tip text on each axis change.
const shadingTip = $('shadingTip');
for (const btn of shadingHud.querySelectorAll<HTMLButtonElement>('button')) {
  btn.addEventListener('mouseenter', () => {
    const tip = btn.dataset.tip;
    if (!tip) return;
    shadingTip.textContent = tip;
    shadingTip.hidden = false;
  });
  btn.addEventListener('mouseleave', () => {
    shadingTip.hidden = true;
  });
}
toggleGrid.addEventListener('change', () => { viewer.setGridVisible(toggleGrid.checked); pushViewSettings(); });
toggleAxes.addEventListener('change', () => { viewer.setAxesVisible(toggleAxes.checked); pushViewSettings(); });
toggleBounds.addEventListener('change', () => { viewer.setBoundsVisible(toggleBounds.checked); pushViewSettings(); });
toggleSkeleton.addEventListener('change', () => { viewer.setSkeletonVisible(toggleSkeleton.checked); pushViewSettings(); });
resetPoseBtn.addEventListener('click', () => resetPose());
bsCombine.addEventListener('change', populateBlendshapes);
bsResetBtn.addEventListener('click', () => {
  viewer.resetMorphs();
  for (const s of bsSliders) { s.input.value = '0'; s.val.textContent = '0.00'; }
});
// "Show skin weights" drives on/off; the mode + bone rows below it appear only
// while it's checked. Toggling off keeps the dropdown values so re-checking
// returns to the last mode/bone within the session. Weight display is session-
// local and is not included in pushViewSettings.
toggleWeights.addEventListener('change', () => {
  const on = toggleWeights.checked;
  weightModeRow.style.display = on ? '' : 'none';
  if (on) {
    applyWeightMode();
  } else {
    viewer.setWeightMode('off');
    weightBoneRow.style.display = 'none';
    weightLegend.style.display = 'none';
  }
  updateViewStateChip();
});
weightModeSelect.addEventListener('change', applyWeightMode);
weightBoneSelect.addEventListener('change', () => viewer.setWeightBone(Number(weightBoneSelect.value)));

/** Push the selected weight mode into the viewer, reveal the bone picker for
 *  'isolate' only, and refresh the color legend. Assumes the "Show skin
 *  weights" box is checked. */
function applyWeightMode(): void {
  const mode = weightModeSelect.value as WeightMode;
  viewer.setWeightMode(mode);
  weightBoneRow.style.display = mode === 'isolate' ? '' : 'none';
  if (mode === 'isolate') populateWeightBones();
  renderWeightLegend(mode);
  updateViewStateChip();
}

/** Swap the legend under the mode dropdown to explain the current mode's colors.
 *  Swatch colors are the sRGB equivalents of the shader's linear output so they
 *  match what's drawn in the viewport. */
function renderWeightLegend(mode: WeightMode): void {
  const chip = (color: string, label: string): string =>
    `<span class="wl-item"><span class="wl-chip" style="background:${color}"></span>${label}</span>`;
  let html = '';
  if (mode === 'all') {
    html = '<span class="wl-caption">Each color = a different bone. Switch to Isolate to identify one.</span>';
  } else if (mode === 'isolate') {
    html =
      '<span class="wl-caption">Influence of selected bone</span>' +
      '<div class="wl-bar" style="background:linear-gradient(to right,#0000ff,#00ffff,#00ff00,#ffff00,#ff0000)"></div>' +
      '<div class="wl-scale"><span>0.0</span><span>0.25</span><span>0.5</span><span>0.75</span><span>1.0</span></div>';
  } else if (mode === 'count') {
    html =
      '<span class="wl-caption">Influences per vertex</span>' +
      '<div class="wl-swatches">' +
      chip('#597cff', '1') + chip('#00ffff', '2') + chip('#00ff00', '3') + chip('#ffff00', '4') +
      '</div>';
  } else if (mode === 'normalize') {
    html =
      '<span class="wl-caption">Vertex weight sum vs 1.0</span>' +
      '<div class="wl-swatches">' +
      chip('#00ffff', 'under (&lt;1)') + chip('#6c6c6c', 'ok (=1)') + chip('#ff00ff', 'over (&gt;1)') +
      '</div>';
  }
  weightLegend.innerHTML = html;
  weightLegend.style.display = html ? '' : 'none';
}
toggleWireframeOverlay.addEventListener('change', () => { viewer.setWireframeOverlayVisible(toggleWireframeOverlay.checked); pushViewSettings(); });
// Splat orientation is session-local, like the weight controls: it describes
// the file being viewed rather than a viewport preference worth remembering.
toggleSplatUpright.addEventListener('change', () => {
  viewer.setSplatsUpright(toggleSplatUpright.checked);
  viewer.frameAll();
});
toggleAutoRotate.addEventListener('change', () => { viewer.setAutoRotate(toggleAutoRotate.checked); pushViewSettings(); });
// 'input' fires continuously as the color picker is dragged (live preview);
// 'change' fires once when it closes, so we only persist then.
bgColor.addEventListener('input', () => viewer.setBackground(bgColor.value));
bgColor.addEventListener('change', () => pushViewSettings());
envSelect.addEventListener('change', () => { viewer.applyEnvironment(envSelect.value as EnvironmentMode); pushViewSettings(); });
/** Keep the viewport up-axis button showing the current axis. */
function syncUpAxisButton(): void {
  const axis = upAxisSelect.value as 'y' | 'z';
  hudUpAxisBtn.textContent = axis === 'z' ? 'Z↑' : 'Y↑';
  hudUpAxisBtn.dataset.tip =
    axis === 'z' ? 'Up axis: Z — click to switch to Y up' : 'Up axis: Y — click to switch to Z up';
}
syncUpAxisButton();
upAxisSelect.addEventListener('change', () => {
  viewer.setUpAxis(upAxisSelect.value as 'y' | 'z');
  syncUpAxisButton();
  viewer.frameAll();
  pushViewSettings();
});
hudUpAxisBtn.addEventListener('click', () => {
  upAxisSelect.value = upAxisSelect.value === 'z' ? 'y' : 'z';
  // Route through the select's change handler so behavior stays identical.
  upAxisSelect.dispatchEvent(new Event('change'));
});
resetCameraBtn.addEventListener('click', () => viewer.frameAll());
frameSelectionBtn.addEventListener('click', () => {
  if (selectedObject) viewer.frameObject(selectedObject);
  else viewer.frameAll();
});
sidebarToggle.addEventListener('click', () => app.classList.toggle('sidebar-collapsed'));

// Drag the panel edge to resize the sidebar. Width lives in --sidebar-width so
// the toggle button, collapse offset, and this handle all move together; the
// 3D canvas and the UV viewport resize themselves via their ResizeObservers.
const sidebarResizer = $('sidebarResizer');
sidebarResizer.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  sidebarResizer.setPointerCapture(ev.pointerId);
  sidebarResizer.classList.add('dragging');
  const move = (m: PointerEvent): void => {
    const max = Math.max(280, Math.round(window.innerWidth * 0.6));
    const w = Math.min(Math.max(Math.round(m.clientX), 220), max);
    document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
  };
  const up = (): void => {
    sidebarResizer.classList.remove('dragging');
    sidebarResizer.removeEventListener('pointermove', move);
    sidebarResizer.removeEventListener('pointerup', up);
    sidebarResizer.removeEventListener('pointercancel', up);
  };
  sidebarResizer.addEventListener('pointermove', move);
  sidebarResizer.addEventListener('pointerup', up);
  sidebarResizer.addEventListener('pointercancel', up);
});

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
  const target = ev.target as HTMLElement | null;
  const typing = !!(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));
  if (typing) return;

  if ((ev.ctrlKey || ev.metaKey) && (ev.code === 'KeyZ' || ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault();
    if (ev.shiftKey) viewer.redoPose();
    else viewer.undoPose();
    syncBoneRotationFields();
    refreshPoseHint();
    return;
  }
  if (ev.ctrlKey || ev.metaKey) return;

  if (viewer.isRotateModalActive()) {
    if (ev.code === 'Escape' || ev.key === 'Escape') {
      ev.preventDefault();
      viewer.cancelRotateModal();
      refreshPoseHint();
      return;
    }
    if (ev.code === 'Enter') {
      ev.preventDefault();
      viewer.confirmRotateModal();
      refreshPoseHint();
      return;
    }
    if (ev.code === 'KeyR' || ev.key === 'r' || ev.key === 'R') {
      ev.preventDefault();
      viewer.startRotateModal(lastPointerX, lastPointerY);
      refreshPoseHint();
      return;
    }
    if (ev.code === 'KeyX') { ev.preventDefault(); viewer.setRotateModalAxis('x'); refreshPoseHint(); return; }
    if (ev.code === 'KeyY') { ev.preventDefault(); viewer.setRotateModalAxis('y'); refreshPoseHint(); return; }
    if (ev.code === 'KeyZ') { ev.preventDefault(); viewer.setRotateModalAxis('z'); refreshPoseHint(); return; }
    return;
  }

  if (ev.code === 'KeyR' || ev.key === 'r' || ev.key === 'R') {
    if (!viewer.getPoseBone()) return;
    ev.preventDefault();
    viewer.startRotateModal(lastPointerX, lastPointerY);
    refreshPoseHint();
    return;
  }

  if (ev.code !== 'KeyH' && ev.key !== 'h' && ev.key !== 'H') return;
  ev.preventDefault();
  setFilteredVisibility(ev.shiftKey || ev.altKey);
});

let lastPointerX = 0;
let lastPointerY = 0;
canvas.addEventListener('pointermove', (ev) => {
  lastPointerX = ev.clientX;
  lastPointerY = ev.clientY;
});

function refreshPoseHint(): void {
  if (!viewer.isRotateModalActive()) {
    poseHint.hidden = true;
    return;
  }
  const axis = viewer.rotateModalAxis ?? 'view';
  const axisLabel = axis === 'view' ? 'view' : axis === 'trackball' ? 'trackball' : axis.toUpperCase();
  const extra = axis === 'trackball' ? 'R view' : 'R trackball';
  poseHint.hidden = false;
  poseHint.textContent = `Rotate (${axisLabel})  ${extra}  X/Y/Z axis  LMB/Enter confirm  Esc cancel`;
}

// ---- Animation transport ----
animPlay.addEventListener('click', () => {
  if (!activeAnimRow) {
    if (animRows.length) selectAnim(animRows[0], true);
    return;
  }
  if (!viewer.isAnimationPlaying) toggleAnimPlayback();
});
animPause.addEventListener('click', () => {
  viewer.pauseAnimation();
  timeline.setPlaying(false);
  timeline.refresh();
});
animStop.addEventListener('click', () => {
  viewer.stopAnimation();
  activeAnimRow = null;
  refreshAnimationActiveRow();
  animScrub.value = '0';
  animCurrent.textContent = '0.00s';
  timeline.setPlaying(false);
  timeline.refresh();
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
  timeline.refresh();
});

animSpeed.addEventListener('input', () => {
  const s = Number(animSpeed.value) / 100;
  animSpeedLabel.textContent = `${s.toFixed(2)}×`;
  viewer.setAnimationSpeed(s);
  timeline.setSpeedDisplay(s);
});

// ---- HUD ----
viewer.setHudCallback((info: HudInfo) => {
  hudStats.textContent =
    `${info.fps} fps\n` +
    `tris ${info.triangles.toLocaleString()}\n` +
    `calls ${info.drawCalls}\n` +
    `geom ${info.geometries}  tex ${info.textures}`;
  updateScaleBar();
  updateMeasureLabel();
});

// ---- Measurement (scale bar + ruler) ----
shadingMeasureBtn.addEventListener('click', () => setMeasureMode(!viewer.measuring));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && viewer.measuring) setMeasureMode(false);
});

function setMeasureMode(on: boolean): void {
  viewer.setMeasureMode(on);
  shadingMeasureBtn.classList.toggle('active', on);
  canvas.style.cursor = on ? 'crosshair' : '';
  if (!on) measureLabel.hidden = true;
}

function measureAt(ev: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
  );
  viewer.addMeasurePointAt(ndc);
}

function updateScaleBar(): void {
  if (!viewer.entries.length) { scaleBar.hidden = true; return; }
  const upp = viewer.worldUnitsPerPixel();
  if (!isFinite(upp) || upp <= 0) { scaleBar.hidden = true; return; }
  const raw = upp * 90; // aim for a ~90px bar
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
  scaleBar.style.width = `${Math.round(nice / upp)}px`;
  scaleBarLabel.textContent = formatLength(nice) + lengthUnit();
  scaleBar.hidden = false;
}

function updateMeasureLabel(): void {
  const m = viewer.getMeasurement();
  if (!m) { measureLabel.hidden = true; return; }
  measureLabel.textContent = formatLength(m.distance) + lengthUnit();
  measureLabel.style.left = `${m.x}px`;
  measureLabel.style.top = `${m.y}px`;
  measureLabel.hidden = false;
}

/** glTF/GLB coordinates are metres per spec; other formats are unitless. */
function lengthUnit(): string {
  const e = primaryFile?.ext?.toLowerCase();
  return e === 'glb' || e === 'gltf' ? ' m' : '';
}

/** Format a world length with adaptive precision; the unit (if any) is appended by the caller. */
function formatLength(v: number): string {
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 100) s = v.toFixed(0);
  else if (abs >= 10) s = v.toFixed(1);
  else if (abs >= 1) s = v.toFixed(2);
  else s = v.toPrecision(2);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

viewer.setAnimationCallback((time, duration) => {
  if (scrubLocked || duration <= 0) return;
  animScrub.value = String(Math.round((time / duration) * 1000));
  animCurrent.textContent = `${time.toFixed(2)}s`;
  syncBlendshapeSliders();
  timeline.refresh();
});

viewer.setAnimationFinishedCallback(() => {
  timeline.setPlaying(false);
  timeline.refresh();
});

viewer.onPoseEdit = () => {
  timeline.setPlaying(false);
  syncBoneRotationFields();
  refreshPoseHint();
};

// ---- Picking ----
// We must distinguish a "click" from a camera "drag" (OrbitControls eats the
// same left button to rotate). If we picked on every pointerdown, every drag
// would deselect or select the wrong thing. We record the press position +
// time and only run a raycast on pointerup when the pointer hardly moved.
const PICK_MOVE_PX = 5;
const PICK_MAX_MS = 400;
let pressStart: { x: number; y: number; t: number; button: number } | null = null;
/** Set when pointerdown hits the pose gizmo so the matching pointerup does not pick. */
let skipNextPick = false;

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return; // left button only; middle/right are pan/orbit
  skipNextPick = viewer.isPoseGizmoBusy();
  pressStart = { x: ev.clientX, y: ev.clientY, t: performance.now(), button: ev.button };
});

canvas.addEventListener('pointerup', (ev) => {
  const start = pressStart;
  pressStart = null;
  if (skipNextPick) {
    skipNextPick = false;
    return;
  }
  if (!start || ev.button !== start.button) return;
  const dx = ev.clientX - start.x;
  const dy = ev.clientY - start.y;
  if (Math.hypot(dx, dy) > PICK_MOVE_PX) return; // it was a drag-orbit
  if (performance.now() - start.t > PICK_MAX_MS) return; // long-press, not a click
  if (viewer.measuring) measureAt(ev);
  else pickAt(ev);
});

canvas.addEventListener('pointercancel', () => {
  pressStart = null;
});

/** First raycast hit on a visible mesh (skips helpers/hidden branches). */
function firstVisibleMeshHit(ray: THREE.Raycaster): THREE.Intersection | null {
  const hits = ray.intersectObject(viewer.contentRoot, true);
  return (
    hits.find((h) => {
      if (!(h.object as THREE.Mesh).isMesh) return false;
      for (let o: THREE.Object3D | null = h.object; o; o = o.parent) {
        if (o.visible === false) return false;
      }
      return true;
    }) ?? null
  );
}

/**
 * Point the selection at the mesh that was hit. If it is not the active mesh,
 * switch the Textures tab to an entry that this mesh's material uses so the UV
 * view matches; a mesh no texture entry knows about is not selectable.
 */
function retargetElementMesh(mesh: THREE.Mesh): boolean {
  if (elementSelection.mesh === mesh) return true;
  // Match by mesh, not by mesh.material: solid/normals/Inspect/weights swap in
  // transient materials that no texture entry knows about, and clicks in those
  // states must still land.
  const idx = textureEntries.findIndex((e) => e.usages.some((u) => u.mesh === mesh));
  if (idx < 0) return false;
  if (idx !== activeTextureIdx) {
    activeTextureIdx = idx;
    textureSelect.value = String(idx);
    renderActiveTexture();
  }
  elementSelection.setMesh(mesh);
  return true;
}

// ---- F: localize the highlight in the other view ----

/** World-space bounds of the selected (else hovered) elements. */
function selectionBox3D(): THREE.Box3 | null {
  const st = elementSelection;
  if (st.mode === 'off' || !st.mesh || !st.topo) return null;
  const ids = st.selected.size ? st.selected : st.hovered !== null ? [st.hovered] : null;
  if (!ids) return null;
  const pos = (st.mesh.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let any = false;
  const add = (i: number): void => {
    v.fromBufferAttribute(pos, i).applyMatrix4(st.mesh!.matrixWorld);
    box.expandByPoint(v);
    any = true;
  };
  for (const id of ids) {
    if (st.mode === 'face') {
      if (id < 0 || id >= st.topo.triCount) continue;
      add(st.topo.tris[id * 3]);
      add(st.topo.tris[id * 3 + 1]);
      add(st.topo.tris[id * 3 + 2]);
    } else if (st.mode === 'vertex') {
      add(id);
    } else {
      const copies = st.topo.edgeCopies.get(id);
      if (copies) {
        add(copies[0]);
        add(copies[1]);
      }
    }
  }
  return any ? box : null;
}

/**
 * F over the UV view localizes the 3D camera on the highlight; F over the 3D
 * viewport localizes the UV view; F anywhere else (or the toolbar button)
 * does both.
 */
function frameElementViews(): void {
  const overUV = uvView.root.matches(':hover');
  const over3D = canvas.matches(':hover');
  if (!overUV || !over3D) {
    if (!over3D) {
      const box = selectionBox3D();
      if (box) viewer.frameElementBox(box);
    }
    if (!overUV) uvView.frameElements();
  }
}
elemFrameBtn.addEventListener('click', () => {
  const box = selectionBox3D();
  if (box) viewer.frameElementBox(box);
  uvView.frameElements();
});

// ---- 3D box/lasso element selection ----
// Shift+left-drag area-selects (extending); `B` arms the next plain drag as a
// replacing area select. X-ray semantics: everything projecting inside the
// region is taken, back faces and occluded parts included — no occlusion test.
let area3D: { pts: Array<{ x: number; y: number }>; extend: boolean; pointerId: number } | null = null;
let areaArmed = false;

function armAreaSelect(): void {
  if (elementSelection.mode === 'off' || !elementSelection.mesh) return;
  areaArmed = true;
  canvas.style.cursor = 'crosshair';
}

function cancelAreaSelect3D(): boolean {
  const had = area3D !== null || areaArmed;
  area3D = null;
  areaArmed = false;
  canvas.style.cursor = '';
  areaSvg.classList.remove('active');
  areaSvg.replaceChildren();
  viewer.controls.enabled = true;
  return had;
}

function drawAreaBand(): void {
  if (!area3D || area3D.pts.length < 2) return;
  areaSvg.classList.add('active');
  const ns = 'http://www.w3.org/2000/svg';
  let el: SVGElement;
  if (elemTool === 'box') {
    const [a, b] = [area3D.pts[0], area3D.pts[area3D.pts.length - 1]];
    el = document.createElementNS(ns, 'rect');
    el.setAttribute('x', String(Math.min(a.x, b.x)));
    el.setAttribute('y', String(Math.min(a.y, b.y)));
    el.setAttribute('width', String(Math.abs(b.x - a.x)));
    el.setAttribute('height', String(Math.abs(b.y - a.y)));
  } else {
    el = document.createElementNS(ns, 'polygon');
    el.setAttribute('points', area3D.pts.map((p) => `${p.x},${p.y}`).join(' '));
  }
  el.setAttribute('class', 'band');
  areaSvg.replaceChildren(el);
}

canvas.addEventListener(
  'pointerdown',
  (ev) => {
    if (ev.button !== 0 || elementSelection.mode === 'off' || !elementSelection.mesh) return;
    if (!ev.shiftKey && !areaArmed) return;
    // From here the drag belongs to the selection, not the camera.
    viewer.controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    const rect = canvas.getBoundingClientRect();
    area3D = {
      pts: [{ x: ev.clientX - rect.left, y: ev.clientY - rect.top }],
      extend: ev.shiftKey,
      pointerId: ev.pointerId,
    };
  },
  true,
);
canvas.addEventListener('pointermove', (ev) => {
  if (!area3D || ev.pointerId !== area3D.pointerId) return;
  const rect = canvas.getBoundingClientRect();
  const pt = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  if (elemTool === 'lasso') area3D.pts.push(pt);
  else area3D.pts[1] = pt;
  drawAreaBand();
});
canvas.addEventListener(
  'pointerup',
  (ev) => {
    if (!area3D || ev.pointerId !== area3D.pointerId) return;
    const marquee = area3D;
    const moved =
      marquee.pts.length > 1 &&
      Math.abs(marquee.pts[marquee.pts.length - 1].x - marquee.pts[0].x) +
        Math.abs(marquee.pts[marquee.pts.length - 1].y - marquee.pts[0].y) >
        4;
    cancelAreaSelect3D();
    if (moved) {
      finishAreaSelect3D(marquee);
      // The click-pick pointerup handler must not also fire for this gesture.
      skipNextPick = true;
    }
  },
  true,
);

function finishAreaSelect3D(marquee: { pts: Array<{ x: number; y: number }>; extend: boolean }): void {
  const mesh = elementSelection.mesh;
  const topo = elementSelection.topo;
  const mode = elementSelection.mode;
  if (!mesh || !topo || mode === 'off') return;
  const rect = canvas.getBoundingClientRect();
  // Batched local → screen projection of every buffer vertex.
  const mvp = new THREE.Matrix4()
    .multiplyMatrices(viewer.camera.projectionMatrix, viewer.camera.matrixWorldInverse)
    .multiply(mesh.matrixWorld);
  const posAttr = (mesh.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
  const n = posAttr.count;
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const okv = new Uint8Array(n);
  const v = new THREE.Vector4();
  const e = mvp.elements;
  for (let i = 0; i < n; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    v.set(
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
      e[3] * x + e[7] * y + e[11] * z + e[15],
    );
    if (v.w <= 0) continue; // behind the camera
    okv[i] = 1;
    sx[i] = ((v.x / v.w) * 0.5 + 0.5) * rect.width;
    sy[i] = (0.5 - (v.y / v.w) * 0.5) * rect.height;
  }
  let inside: (x: number, y: number) => boolean;
  if (elemTool === 'box') {
    const [a, b] = [marquee.pts[0], marquee.pts[marquee.pts.length - 1]];
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    inside = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  } else {
    inside = (x, y) => pointInPolygon(x, y, marquee.pts);
  }
  const insideVert = (i: number): boolean => okv[i] === 1 && inside(sx[i], sy[i]);
  const insideTri = (t: number): boolean => {
    const a = topo.tris[t * 3];
    const b = topo.tris[t * 3 + 1];
    const c = topo.tris[t * 3 + 2];
    if (!okv[a] || !okv[b] || !okv[c]) return false;
    return inside((sx[a] + sx[b] + sx[c]) / 3, (sy[a] + sy[b] + sy[c]) / 3);
  };
  elementSelection.applyArea(idsInRegion(topo, mode, insideVert, insideTri), marquee.extend);
}

// Double-click in the viewport selects the 3D connected component.
canvas.addEventListener('dblclick', (ev) => {
  if (elementSelection.mode === 'off' || !elementSelection.mesh || !elementSelection.topo) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, viewer.camera);
  const hit = firstVisibleMeshHit(ray);
  if (!hit || hit.object !== elementSelection.mesh) return;
  const id = pickFromIntersection(hit, elementSelection.mode, elementSelection.topo);
  if (id !== null) elementSelection.selectLinked(id, '3d', ev.shiftKey);
});

/** Hover mirroring for the 3D side, coalesced to one raycast per frame. */
let hoverRaf = 0;
canvas.addEventListener('pointermove', (ev) => {
  if (elementSelection.mode === 'off' || !elementSelection.mesh) return;
  if (ev.buttons !== 0) return; // dragging the camera
  if (hoverRaf) return;
  const cx = ev.clientX;
  const cy = ev.clientY;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    if (elementSelection.mode === 'off') return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((cx - rect.left) / rect.width) * 2 - 1,
      -(((cy - rect.top) / rect.height) * 2 - 1),
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, viewer.camera);
    const hit = firstVisibleMeshHit(ray);
    if (!hit || hit.object !== elementSelection.mesh || !elementSelection.topo) {
      elementSelection.hover(null);
      return;
    }
    elementSelection.hover(pickFromIntersection(hit, elementSelection.mode, elementSelection.topo));
  });
});
canvas.addEventListener('pointerleave', () => {
  if (elementSelection.mode !== 'off') elementSelection.hover(null);
});

function pickAt(ev: PointerEvent): void {
  if (!viewer.entries.length) return;
  if (viewer.isPoseGizmoBusy()) return;
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

  // Element mode takes over viewport clicks entirely: clicks pick elements on
  // the active mesh (or switch the active mesh), not scene objects.
  if (elementSelection.mode !== 'off') {
    const hit = firstVisibleMeshHit(ray);
    if (!hit) {
      elementSelection.click(null, ev.shiftKey);
      return;
    }
    if (!retargetElementMesh(hit.object as THREE.Mesh)) return;
    const topo = elementSelection.topo;
    if (!topo) return;
    elementSelection.click(pickFromIntersection(hit, elementSelection.mode, topo), ev.shiftKey);
    return;
  }

  const joint = viewer.pickSkeletonJoint(ray);
  if (joint) {
    selectObject(joint);
    return;
  }

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
    const bytes = await file.arrayBuffer();
    data = isText ? decodeText(bytes) : bytes;
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
  if (!showEmptyGeometryWarning(asset, file.name)) {
    showToast({ title: 'Imported', body: `${file.name} (${formatBytes(file.size)})`, kind: 'success' });
  }
}

function showEmptyGeometryWarning(asset: LoadedAsset, fileName: string): boolean {
  if (hasRenderableGeometry(asset.root)) return false;
  showToast({
    title: 'No renderable geometry',
    body: `${fileName} loaded successfully but contains no mesh, points, lines, or splats.`,
    kind: 'error',
  });
  return true;
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
  } else if (msg.type === 'command' && msg.command === 'saveSnapshot') {
    saveSnapshot();
  } else if (msg.type === 'command' && msg.command === 'saveSnapshotTransparent') {
    saveSnapshot(true);
  } else if (msg.type === 'viewerCount') {
    viewerCount = Number(msg.count) || 1;
    // Nobody left to sync with — drop the link so it can't silently stay on.
    if (viewerCount < 2 && cameraLinkEnabled) cameraLinkEnabled = false;
    updateLinkUi();
  } else if (msg.type === 'cameraLink') {
    setCameraLink(Boolean(msg.enabled), msg.mode === 'offset' ? 'offset' : 'aligned');
  } else if (msg.type === 'cameraSync') {
    if (cameraLinkEnabled && linkMode === 'aligned') viewer.applyCameraState(msg.state);
  } else if (msg.type === 'cameraOrbitDelta') {
    if (cameraLinkEnabled && linkMode === 'offset') {
      viewer.applyOrbitDelta(msg.delta);
      // Re-baseline so this viewer's own next move is measured from here.
      lastOrbitPose = viewer.getOrbitPose();
    }
  }
});

async function fetchPayload(msg: FilePayload): Promise<ArrayBuffer | string> {
  const resp = await fetch(msg.fileUri);
  if (!resp.ok) throw new Error(`Failed to fetch ${msg.fileName}: ${resp.status} ${resp.statusText}`);
  const bytes = await resp.arrayBuffer();
  return msg.isText ? decodeText(bytes) : bytes;
}

vscode.postMessage({ type: 'ready' });

async function handleInit(msg: InitMessage): Promise<void> {
  applyViewSettings(msg.settings);
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
  refreshTexturesWhenReady(asset);
  hideOverlay();
  showEmptyGeometryWarning(asset, msg.fileName);
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
  refreshTexturesWhenReady(asset);
  consumePendingImport(msg.requestId);
  if (!showEmptyGeometryWarning(asset, msg.fileName)) {
    showToast({
      title: 'Imported',
      body: `${msg.fileName} (${formatBytes(msg.fileSizeBytes)})`,
      kind: 'success',
    });
  }
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

function applyViewSettings(settings: InitViewSettings): void {
  // Settings remembered by pre-HUD versions used 'smooth'/'flat' as shading
  // modes; both map onto 'material', with 'flat' setting the new flat toggle.
  const legacy = settings.shading as string;
  const shading = (legacy === 'smooth' || legacy === 'flat' ? 'material' : legacy) as ShadingMode;
  const flatShading = settings.flatShading ?? legacy === 'flat';
  const xray = settings.xray ?? false;

  viewer.setBackground(settings.backgroundColor);
  viewer.setGridVisible(settings.showGrid);
  viewer.setAxesVisible(settings.showAxes);
  viewer.setViewGizmoVisible(settings.showViewGizmo ?? true);
  viewer.setAutoRotate(settings.autoRotate);
  viewer.setShading(shading);
  viewer.setFlatShading(flatShading);
  viewer.setXray(xray);
  viewer.applyEnvironment(settings.environment);
  viewer.setUpAxis(settings.upAxis ?? 'y');
  viewer.setBoundsVisible(settings.showBounds);
  viewer.setSkeletonVisible(settings.showSkeleton);
  viewer.setWireframeOverlayVisible(settings.showWireframeOverlay);

  // Assigning .value/.checked directly does not dispatch a 'change' event, so
  // this sync does not re-trigger pushViewSettings.
  toggleGrid.checked = settings.showGrid;
  toggleAxes.checked = settings.showAxes;
  toggleAutoRotate.checked = settings.autoRotate;
  toggleBounds.checked = settings.showBounds;
  toggleSkeleton.checked = settings.showSkeleton;
  toggleWireframeOverlay.checked = settings.showWireframeOverlay;
  shadingSelect.value = shading;
  toggleXray.checked = xray;
  toggleFlatShading.checked = flatShading;
  syncShadingHud();
  envSelect.value = settings.environment;
  upAxisSelect.value = settings.upAxis ?? 'y';
  syncUpAxisButton();
  bgColor.value = normalizeHexColor(settings.backgroundColor);

  // Re-frame when content is already loaded (e.g. remembered Z-up on a later open).
  viewer.frameAll();
}

/** Report the current control state to the host so it can remember it for
 *  viewers opened later. */
function pushViewSettings(): void {
  const settings: ViewSettings = {
    backgroundColor: bgColor.value,
    showGrid: toggleGrid.checked,
    showAxes: toggleAxes.checked,
    autoRotate: toggleAutoRotate.checked,
    shading: shadingSelect.value as ViewSettings['shading'],
    xray: toggleXray.checked,
    flatShading: toggleFlatShading.checked,
    environment: envSelect.value as ViewSettings['environment'],
    upAxis: upAxisSelect.value as ViewSettings['upAxis'],
    showBounds: toggleBounds.checked,
    showSkeleton: toggleSkeleton.checked,
    showWireframeOverlay: toggleWireframeOverlay.checked,
  };
  vscode.postMessage({ type: 'viewSettingsChanged', settings });
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

/**
 * FBX/OBJ/Collada parse() returns while sidecar textures are still decoding,
 * so the Textures tab built right after load has no images to preview. Rebuild
 * it (and the Info panel's texture stats) once the loads settle.
 */
function refreshTexturesWhenReady(asset: LoadedAsset): void {
  void asset.resourcesReady?.then(() => {
    populateTextures();
    populateInfo();
  });
}

function rebuildAllPanels(): void {
  buildHierarchy();
  populateTextures();
  populateInfo();
  populateAnimations();
  populateBlendshapes();
  refreshSubtitle();
  if (toggleWeights.checked && weightModeSelect.value === 'isolate') populateWeightBones();
  splatUprightRow.style.display = viewer.hasSplats ? '' : 'none';
  toggleSplatUpright.checked = viewer.splatsAreUpright;
  // Shading modes are a no-op on splats (Spark draws them), so grey out the
  // HUD when the scene has content but no regular meshes.
  const meshless = viewer.entries.length > 0 && !viewer.hasMeshes;
  for (const btn of [...shadingModeBtns, shadingXrayBtn, shadingFlatBtn]) {
    btn.disabled = meshless;
  }
  refreshResetPoseButton();
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
  // Selecting a bone is the start of posing — show the overlay so the joint
  // and rotate gizmo have something to sit on.
  if ((obj as THREE.Bone).isBone && !toggleSkeleton.checked) {
    toggleSkeleton.checked = true;
    viewer.setSkeletonVisible(true);
    pushViewSettings();
  }
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
  // 5) If isolating a bone's weights, clicking a bone retargets the display and
  //    keeps the bone dropdown in sync.
  if (toggleWeights.checked && weightModeSelect.value === 'isolate' && (obj as THREE.Bone).isBone) {
    const idx = viewer.boneIndexOf(obj);
    if (idx !== null) {
      viewer.setWeightBone(idx);
      weightBoneSelect.value = String(idx);
    }
  }
}

/** Fill the isolate-mode bone dropdown from the loaded skeleton. */
function populateWeightBones(): void {
  const bones = viewer.getSkinnedBones();
  weightBoneSelect.innerHTML = '';
  for (const b of bones) {
    const opt = document.createElement('option');
    opt.value = String(b.index);
    opt.textContent = b.name;
    weightBoneSelect.append(opt);
  }
  const current = Number(weightBoneSelect.value);
  if (Number.isFinite(current)) viewer.setWeightBone(current);
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
  if ((obj as THREE.Bone).isBone) {
    appendBoneRotationFields(obj as THREE.Bone);
  } else {
    const rotEuler = obj.rotation;
    kv('Rotation', `${fmtDeg(rotEuler.x)}°, ${fmtDeg(rotEuler.y)}°, ${fmtDeg(rotEuler.z)}°`);
  }
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
    const morphCount = mesh.morphTargetInfluences?.length ?? 0;
    if (morphCount) kv('Blendshapes', String(morphCount));
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

function resetPose(): void {
  if (!viewer.hasBindPose) return;
  viewer.resetBindPose();
  timeline.setPlaying(viewer.isAnimationPlaying);
  syncBoneRotationFields();
}

function refreshResetPoseButton(): void {
  resetPoseBtn.disabled = !viewer.hasBindPose;
}

function appendBoneRotationFields(bone: THREE.Bone): void {
  const target = viewer.getPoseBone() ?? bone;
  const key = document.createElement('div');
  key.className = 'kv-key';
  key.textContent = `Rotation (${target.rotation.order})`;
  const val = document.createElement('div');
  val.className = 'kv-val kv-rot';
  let started = false;
  for (const axis of ['x', 'y', 'z'] as const) {
    const lab = document.createElement('label');
    lab.textContent = axis.toUpperCase();
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.id = `poseRot${axis.toUpperCase()}`;
    input.value = fmtDeg(target.rotation[axis]);
    input.addEventListener('focus', () => { started = false; });
    input.addEventListener('input', () => {
      if (!started) {
        viewer.beginPoseNumericEdit();
        started = true;
      }
      const x = Number(($<HTMLInputElement>('poseRotX')).value);
      const y = Number(($<HTMLInputElement>('poseRotY')).value);
      const z = Number(($<HTMLInputElement>('poseRotZ')).value);
      if (![x, y, z].every(Number.isFinite)) return;
      viewer.setBoneRotationDegrees(target, x, y, z);
    });
    lab.append(input);
    val.append(lab);
  }
  selectionDetails.append(key, val);
  const action = document.createElement('div');
  action.className = 'kv-action';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Reset Pose';
  btn.disabled = !viewer.hasBindPose;
  btn.addEventListener('click', () => resetPose());
  action.append(btn);
  selectionDetails.append(action);
}

function syncBoneRotationFields(): void {
  const bone = viewer.getPoseBone();
  if (!bone) return;
  const x = document.getElementById('poseRotX') as HTMLInputElement | null;
  const y = document.getElementById('poseRotY') as HTMLInputElement | null;
  const z = document.getElementById('poseRotZ') as HTMLInputElement | null;
  if (!x || !y || !z) return;
  if (document.activeElement === x || document.activeElement === y || document.activeElement === z) {
    return;
  }
  x.value = fmtDeg(bone.rotation.x);
  y.value = fmtDeg(bone.rotation.y);
  z.value = fmtDeg(bone.rotation.z);
}

function fmt(n: number): string {
  if (Math.abs(n) < 1e-4 && n !== 0) return n.toExponential(2);
  return Number(n.toFixed(4)).toString();
}
function fmtDeg(rad: number): string {
  return Number(((rad * 180) / Math.PI).toFixed(2)).toString();
}

function iconFor(obj: THREE.Object3D): string {
  if (obj.userData.isSplat) return '✳';
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
  if (stats.splats) appendKV(sceneTotals, 'Splats', stats.splats.toLocaleString());
  if (stats.points) appendKV(sceneTotals, 'Point objects', stats.points.toLocaleString());
  if (stats.lines) appendKV(sceneTotals, 'Line segments', Math.round(stats.lines).toLocaleString());
  let totalAnims = 0;
  for (const e of viewer.entries) totalAnims += e.asset.animations.length;
  appendKV(sceneTotals, 'Animations', String(totalAnims));

  geomTotals.innerHTML = '';
  appendKV(geomTotals, 'Vertices', Math.round(stats.vertices).toLocaleString());
  appendKV(geomTotals, 'Triangles', Math.round(stats.triangles).toLocaleString());
  const box = contentBounds(viewer.contentRoot);
  if (!box.isEmpty() && !isFiniteBox(box)) {
    // Inf/NaN vertex positions. Without this the row reads "NaN × NaN × NaN" and
    // the viewport is blank with no explanation; the viewer has fallen back to a
    // default view by this point.
    appendKV(geomTotals, 'Bounds', 'not finite — NaN/Infinity vertex data');
    showToast({
      title: 'Non-finite geometry',
      body: `${primaryFile?.name ?? 'This file'} has NaN or Infinity vertex positions; the view is approximate.`,
      kind: 'error',
    });
  } else if (!box.isEmpty()) {
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

// ---- Blendshapes (morph targets) ----
// One slider per morph target (or per shared name when "combine by name" is on).
// Each slider is registered so animation playback can push live influence values
// back into the UI without the user having to touch it.
interface BsSlider {
  input: HTMLInputElement;
  val: HTMLElement;
  /** (mesh uuid, target index) pairs this slider drives — one, or many when merged by name. */
  targets: { uuid: string; index: number }[];
}
const bsSliders: BsSlider[] = [];
/** The slider under active pointer drag, so live-sync doesn't fight the user. */
let bsDragging: BsSlider | null = null;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function populateBlendshapes(): void {
  const meshes = viewer.getMorphMeshes();
  blendshapesTab.style.display = meshes.length ? '' : 'none';
  // If the panel vanished while it was the active tab, fall back to Hierarchy.
  if (!meshes.length && blendshapesTab.classList.contains('active')) selectTab('hierarchy');
  blendshapeList.innerHTML = '';
  bsSliders.length = 0;
  bsDragging = null;
  if (!meshes.length) {
    bsCombineRow.style.display = 'none';
    blendshapeList.innerHTML = '<div class="kv-empty">No blendshapes in this scene.</div>';
    return;
  }
  // "Combine by name" only makes sense across multiple morph meshes (e.g. a
  // multi-submesh ARKit face rig sharing shape names like "jawOpen").
  bsCombineRow.style.display = meshes.length > 1 ? '' : 'none';
  if (meshes.length > 1 && bsCombine.checked) buildCombinedBlendshapes(meshes);
  else buildPerMeshBlendshapes(meshes);
}

function buildPerMeshBlendshapes(meshes: MorphMeshInfo[]): void {
  for (const mesh of meshes) {
    if (meshes.length > 1) {
      const title = document.createElement('div');
      title.className = 'section-title bs-mesh-title';
      title.textContent = mesh.meshName;
      blendshapeList.appendChild(title);
    }
    for (const t of mesh.targets) makeBsRow(t.name, [{ uuid: mesh.uuid, index: t.index }]);
  }
}

function buildCombinedBlendshapes(meshes: MorphMeshInfo[]): void {
  const byName = new Map<string, { uuid: string; index: number }[]>();
  const order: string[] = [];
  for (const mesh of meshes) {
    for (const t of mesh.targets) {
      let list = byName.get(t.name);
      if (!list) { list = []; byName.set(t.name, list); order.push(t.name); }
      list.push({ uuid: mesh.uuid, index: t.index });
    }
  }
  for (const name of order) makeBsRow(name, byName.get(name)!);
}

function makeBsRow(label: string, targets: { uuid: string; index: number }[]): void {
  const row = document.createElement('div');
  row.className = 'bs-row';
  const name = document.createElement('div');
  name.className = 'bs-name';
  name.textContent = label;
  name.title = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  const init = viewer.getMorphInfluence(targets[0].uuid, targets[0].index);
  input.value = String(Math.round(clamp01(init) * 100));
  const val = document.createElement('div');
  val.className = 'bs-val';
  val.textContent = init.toFixed(2);
  const slider: BsSlider = { input, val, targets };
  input.addEventListener('pointerdown', () => { bsDragging = slider; });
  const endDrag = (): void => { if (bsDragging === slider) bsDragging = null; };
  input.addEventListener('pointerup', endDrag);
  input.addEventListener('pointercancel', endDrag);
  input.addEventListener('input', () => {
    const v = Number(input.value) / 100;
    for (const t of targets) viewer.setMorphInfluence(t.uuid, t.index, v);
    val.textContent = v.toFixed(2);
  });
  row.append(name, input, val);
  blendshapeList.appendChild(row);
  bsSliders.push(slider);
}

/** Push current (possibly animation-driven) influences back into the sliders. */
function syncBlendshapeSliders(): void {
  if (!bsSliders.length || blendshapesTab.style.display === 'none') return;
  for (const s of bsSliders) {
    if (s === bsDragging) continue;
    const v = viewer.getMorphInfluence(s.targets[0].uuid, s.targets[0].index);
    const iv = String(Math.round(clamp01(v) * 100));
    if (s.input.value !== iv) { s.input.value = iv; s.val.textContent = v.toFixed(2); }
  }
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
    timeline.setClips([], 0);
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
      // Selecting a clip keeps the current play state (Blender-style): if
      // something is playing, the new clip plays; otherwise it's shown paused
      // on its first frame, ready for frame-by-frame stepping.
      row.addEventListener('click', () => selectAnim(animRow, viewer.isAnimationPlaying));
      animationList.appendChild(row);
      animRows.push(animRow);
    });
  }
  refreshAnimationActiveRow();

  // Feed the bottom timeline / dope sheet.
  const clips: TimelineClip[] = animRows.map((r) => {
    const clip = r.entry.asset.animations[r.index];
    const name = clip.name || `clip ${r.index}`;
    return {
      entry: r.entry,
      index: r.index,
      label: viewer.entries.length > 1 ? `${r.entry.label} · ${name}` : name,
      clip,
    };
  });
  // animRows was rebuilt, so match the active row by value, not identity.
  const activeIdx = activeAnimRow
    ? animRows.findIndex((r) => r.entry === activeAnimRow!.entry && r.index === activeAnimRow!.index)
    : 0;
  timeline.setClips(clips, Math.max(0, activeIdx));

  // Activate the first clip paused so the timeline is immediately scrubbable.
  if (!activeAnimRow && animRows.length) selectAnim(animRows[0], false);
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
    texIsolateBtn.disabled = true;
    setElementMode('off');
    elementSelection.setMesh(null);
    for (const b of elemModeBtns) b.disabled = b.dataset.elem !== 'off';
    textureView.innerHTML = '<div class="kv-empty">No textures in this scene.</div>';
    return;
  }
  textureSelect.disabled = false;
  toggleShowUV.disabled = false;
  for (const b of elemModeBtns) b.disabled = false;

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
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'tex-card-expand';
  expandBtn.textContent = '⤢';
  expandBtn.title = 'Enlarge';
  head.append(name, roleBadge, expandBtn);
  card.appendChild(head);

  const preview = document.createElement('div');
  preview.className = 'tex-card-preview';

  const backing = buildTextureBacking(entry.texture);
  if (!backing) {
    preview.classList.add('empty');
    preview.textContent = previewPlaceholderLabel(entry.texture);
    expandBtn.disabled = true;
  } else {
    uvView.setTexture(backing, entry.texture.flipY !== false, entry.key);
    preview.appendChild(uvView.root);
    // The modal keeps its own fixed-size render (image + composited overlay);
    // it is a snapshot for close reading, not a second zoomable view.
    expandBtn.addEventListener('click', () => {
      const img = document.createElement('canvas');
      if (!drawTextureToCanvas(entry.texture, img)) return;
      let uv: HTMLCanvasElement | null = null;
      const usage = showUV ? pickUsageForUV(entry) : null;
      if (usage) {
        uv = document.createElement('canvas');
        uv.width = img.width;
        uv.height = img.height;
        drawUVOverlay(usage.mesh.geometry as THREE.BufferGeometry, entry.texture, uv);
      }
      openTextureModal(img, uv, roleBadge.textContent ? `${nameText} · ${roleBadge.textContent}` : nameText);
    });
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

  syncTexIsolateButton();
  refreshUVOverlay();
  if (elementSelection.mode !== 'off') syncElementMesh();
}

/** Material slot → Inspect mode, for the Textures tab's "Isolate on model". */
const SLOT_TO_INSPECT: Record<string, InspectMode> = {
  map: 'baseColor',
  normalMap: 'normalMap',
  metalnessMap: 'metalness',
  roughnessMap: 'roughness',
  aoMap: 'ao',
  emissiveMap: 'emissive',
};

function inspectModeForEntry(entry: TextureEntry): InspectMode | null {
  for (const u of entry.usages) {
    const mode = SLOT_TO_INSPECT[u.slot];
    if (mode) return mode;
  }
  return null;
}

/** Enable the button for textures in a standard PBR slot, and flip its label
 *  when the model is already isolating this texture's channel. */
function syncTexIsolateButton(): void {
  const entry = textureEntries[activeTextureIdx];
  const mode = entry ? inspectModeForEntry(entry) : null;
  const active = mode !== null && mode === inspectMode;
  texIsolateBtn.disabled = !mode;
  texIsolateBtn.textContent = active ? 'Stop isolating' : 'Isolate on model';
  texIsolateBtn.classList.toggle('active', active);
  texIsolateBtn.title = mode
    ? active
      ? 'Return the model to its normal shading'
      : `Show the ${INSPECT_LABELS[mode]} channel unlit on the model`
    : 'Only the standard PBR slots (base color, normal, metalness, roughness, AO, emissive) can be isolated';
}

texIsolateBtn.addEventListener('click', () => {
  const entry = textureEntries[activeTextureIdx];
  const mode = entry ? inspectModeForEntry(entry) : null;
  if (!mode) return;
  setInspect(mode === inspectMode ? null : mode);
});

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

/** GPU read-back cap for the zoomable view. CPU-drawable images are handed
 *  over at native size with no copy; compressed/GPU-only ones are read back
 *  once, and 2048² keeps that under a few hundred ms and ~16 MB. */
const UV_BACKING_MAX_GPU = 2048;

/** Source image for the zoomable UV view: the texture's own image when the
 *  canvas can draw it directly, else a one-off GPU read-back. */
function buildTextureBacking(tex: THREE.Texture): UVBacking | null {
  const img = tex.image;
  const dims = imageDims(img);
  const drawable =
    img instanceof HTMLImageElement ||
    img instanceof HTMLCanvasElement ||
    (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap);
  if (dims && drawable) return { source: img as CanvasImageSource, width: dims.w, height: dims.h };
  const rendered = viewer.renderTextureToCanvas(tex, UV_BACKING_MAX_GPU);
  return rendered ? { source: rendered, width: rendered.width, height: rendered.height } : null;
}

/** Fill the canvas with the texture's image, trying a CPU drawImage first and
 *  falling back to a GPU read-back for compressed (KTX2) / GPU-only textures.
 *  Used by the enlarge modal; the card itself draws through UVView. */
function drawTextureToCanvas(tex: THREE.Texture, canvas: HTMLCanvasElement): boolean {
  if (drawTextureCPU(tex, canvas)) return true;
  const rendered = viewer.renderTextureToCanvas(tex, TEXTURE_CANVAS_MAX);
  if (!rendered) return false;
  canvas.width = rendered.width;
  canvas.height = rendered.height;
  canvas.getContext('2d')?.drawImage(rendered, 0, 0);
  return true;
}

/**
 * Render the texture's source image into the canvas's internal pixel buffer at
 * up to TEXTURE_CANVAS_MAX on the longest side. Display size is governed by
 * CSS (`object-fit: contain` inside the stack), so we never touch
 * canvas.style here — that's what makes the UV overlay stay aligned when the
 * user resizes the panel.
 */
function drawTextureCPU(tex: THREE.Texture, canvas: HTMLCanvasElement): boolean {
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

/** Point the zoomable view at the UVs of the mesh that should be overlaid
 *  (or at nothing when the overlay is off). */
function refreshUVOverlay(): void {
  const entry = textureEntries[activeTextureIdx];
  const usage = entry && showUV ? pickUsageForUV(entry) : null;
  uvView.setWireframe(usage ? (usage.mesh.geometry as THREE.BufferGeometry) : null);
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

/** Fixed-buffer UV overlay for the enlarge modal (the card's live overlay is
 *  drawn by UVView with the same UV → texel rules). */
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
    // UVs may live outside [0, 1] and rely on wrapping at sample time (e.g.
    // DamagedHelmet's V spans [1, 2]). Translate the whole triangle by the
    // integer part of its first vertex so it lands on the visible tile;
    // shifting per-triangle (not per-vertex) keeps seam-crossing triangles
    // intact.
    const du = Math.floor(uvAttr.getX(a));
    const dv = Math.floor(uvAttr.getY(a));
    const ax = ux(uvAttr.getX(a) - du), ay = uy(uvAttr.getY(a) - dv);
    const bx = ux(uvAttr.getX(b) - du), by = uy(uvAttr.getY(b) - dv);
    const cx = ux(uvAttr.getX(c) - du), cy = uy(uvAttr.getY(c) - dv);
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
