import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { SparkRenderer } from '@sparkjsdev/spark';
import type { CameraState, OrbitDelta } from '../types';
import { setViewerRenderer, type LoadedAsset } from './loaders';
import { createWeightMaterial, applyWeightUniforms, type WeightMaterialEntry, type WeightMode } from './weightMaterial';
export type { WeightMode } from './weightMaterial';

export type ShadingMode = 'solid' | 'material' | 'rendered' | 'wireframe' | 'points' | 'normals';
export type EnvironmentMode = 'studio' | 'neutral' | 'none';

/** Orbit camera pose in spherical terms about the target (offset-mode linking). */
export interface OrbitPose {
  theta: number;
  phi: number;
  radius: number;
  target: [number, number, number];
}

export interface ObjectStats {
  meshes: number;
  vertices: number;
  triangles: number;
  points: number;
  lines: number;
  splats: number;
}

/** Objects tagged by the splat loader; see `loadSplat` in loaders.ts. */
function isSplat(o: THREE.Object3D): boolean {
  return o.userData.isSplat === true;
}

/**
 * Mixamo / many FBX rigs put a same-named leaf Bone under the real joint
 * (the leaf is what `skeleton.bones` holds for skinning). Rotating that leaf
 * does not move the next limb — those children hang off the parent. Pose the
 * parent when we see that pattern so FK works.
 */
function resolvePoseBone(bone: THREE.Bone): THREE.Bone {
  const parent = bone.parent;
  if (parent && (parent as THREE.Bone).isBone && parent.name === bone.name) {
    return parent as THREE.Bone;
  }
  return bone;
}

interface MaterialBackup {
  material: THREE.Material | THREE.Material[];
  flatShading?: boolean;
}

/** Local TRS of one bone at load time (bind / rest pose). */
interface BindPose {
  bone: THREE.Bone;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/** One imported asset under `contentRoot`. The first entry is the file the editor
 *  was opened on; subsequent entries come from drag-and-drop. */
export interface AssetEntry {
  /** Display label (file name). */
  label: string;
  /** A wrapper Group named after the file. The asset's actual root is its only child. */
  wrapper: THREE.Group;
  /** Asset metadata as returned by the loader. */
  asset: LoadedAsset;
  /** Animation actions, parallel to `asset.animations`. */
  actions: THREE.AnimationAction[];
}

/**
 * Wraps a Three.js scene + renderer + controls and exposes high-level operations
 * the UI layer needs (load asset, swap shading, toggle visibility, frame, etc.).
 */
export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  /** Fired when the user moves the orbit camera; used to drive linked viewers. */
  onCameraChange: (() => void) | null = null;
  /** Fired after a pose edit (gizmo drag or inspector) so the UI can pause the timeline. */
  onPoseEdit: (() => void) | null = null;
  /** Guards against re-emitting `onCameraChange` while applying a remote pose. */
  private suppressCameraChange = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly clock = new THREE.Clock();

  // Frame-rate cap. setAnimationLoop fires at the display refresh rate (120Hz on
  // ProMotion, 144Hz on many externals); rendering that fast just burns GPU and
  // battery for a mostly-static mesh viewer. We gate the render to ~60fps. The
  // 1ms tolerance keeps a plain 60Hz panel from just missing the 16.67ms budget
  // and halving to 30fps. Scheduling uses the loop's own timestamp (below);
  // clock.getDelta() still measures real render-to-render time so animation
  // playback stays real-time regardless of how many refreshes we skip.
  private static readonly FRAME_BUDGET_MS = 1000 / 60;
  private static readonly FRAME_TOLERANCE_MS = 1;
  private lastFrameTime = 0;
  private readonly pmremGenerator: THREE.PMREMGenerator;
  private envTexture: THREE.Texture | null = null;

  private gridHelper: THREE.GridHelper | null = null;
  private axesHelper: THREE.AxesHelper | null = null;
  /** Corner orientation widget (Blender-style) — tracks the camera, shows the world frame. */
  private readonly viewHelper: ViewHelper;
  private boundsHelper: THREE.Box3Helper | null = null;
  private skeletonHelpers: THREE.SkeletonHelper[] = [];
  private jointMarkers: THREE.Object3D[] = [];
  private skeletonBones: THREE.Bone[] = [];
  private jointInstances: THREE.InstancedMesh | null = null;
  private boneLinks: { mesh: THREE.Mesh; bone: THREE.Bone; parent: THREE.Object3D }[] = [];
  /** Shared bone-cylinder materials; the highlight one marks the isolated bone. */
  private skeletonBoneMat: THREE.MeshBasicMaterial | null = null;
  private highlightBoneMat: THREE.MeshBasicMaterial | null = null;
  private static readonly JOINT_COLOR = 0x00eeff;
  /** White selected joint against dimmed neighbors — contrast is the cue, since
   *  it survives dense clusters where a larger sphere would just occlude them.
   *  The modest size bump is only a secondary hint. */
  private static readonly JOINT_HIGHLIGHT = 0xffffff;
  private static readonly HIGHLIGHT_SCALE = 1.5;
  /** The bone whose joint is currently enlarged/tinted, or null. */
  private highlightBone: THREE.Bone | null = null;
  private wireframeOverlays: THREE.Object3D[] = [];
  private showBounds = false;
  private showSkeleton = false;
  private showWireframeOverlay = false;
  private showViewGizmo = true;
  private upAxis: 'y' | 'z' = 'y';
  private weightMode: WeightMode = 'off';
  private weightBoneIndex = 0;
  /** Debug materials created per SkinnedMesh while weight display is active. */
  private weightMats: { mesh: THREE.SkinnedMesh; entry: WeightMaterialEntry }[] = [];
  private hemiLight: THREE.HemisphereLight | null = null;
  private dirLight: THREE.DirectionalLight | null = null;

  /** Draws every SplatMesh in the scene. Created on the first splat import so
   *  mesh-only sessions don't pay for its GPU buffers and sorting worker. */
  private sparkRenderer: SparkRenderer | null = null;
  private splatsUpright = true;

  /** Post-processing pipeline that draws a Blender-style silhouette around
   *  selected objects without adding anything to the scene graph. */
  private readonly composer: EffectComposer;
  private readonly outlinePass: OutlinePass;
  private selectedObj: THREE.Object3D | null = null;
  private static readonly SELECTION_COLOR_VISIBLE = 0xff9a3c;
  private static readonly SELECTION_COLOR_HIDDEN = 0x8a4a1a;

  /** Persistent group all loaded assets are added to. */
  readonly contentRoot = new THREE.Group();
  readonly entries: AssetEntry[] = [];
  private mixer: THREE.AnimationMixer | null = null;
  private readonly poseControls: TransformControls;
  private bindPoses: BindPose[] = [];
  /** The bone TransformControls / R-rotate actually edit (may be a Mixamo parent). */
  private poseBone: THREE.Bone | null = null;
  private poseUndo: BindPose[][] = [];
  private poseRedo: BindPose[][] = [];
  private rotateModal: {
    startQuat: THREE.Quaternion;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    pivotX: number;
    pivotY: number;
    startAngle: number;
    axis: 'view' | 'trackball' | 'x' | 'y' | 'z';
  } | null = null;
  private activeAction: THREE.AnimationAction | null = null;
  private currentClip: THREE.AnimationClip | null = null;
  private animationSpeed = 1;
  private animationPaused = false;
  private animationLooping = true;
  private animationCallback: ((time: number, duration: number) => void) | null = null;
  private animationFinishedCallback: (() => void) | null = null;

  private originalMaterials = new WeakMap<THREE.Object3D, MaterialBackup>();
  private shadingMode: ShadingMode = 'material';
  private flatShadingOn = false;
  private xrayOn = false;
  /** Blend/depth state saved per material while x-ray is active. */
  private xraySaved = new Map<
    THREE.Material,
    { transparent: boolean; opacity: number; depthWrite: boolean }
  >();
  /** The user's Environment selection; the mode actually applied can differ
   *  per shading mode (see effectiveEnvironment). */
  private environmentMode: EnvironmentMode = 'studio';
  private appliedEnvMode: EnvironmentMode | null = null;
  private fpsSamples: number[] = [];
  private hudCallback: ((info: HudInfo) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // Share the renderer so the GLTF loader can init KTX2Loader.detectSupport().
    setViewerRenderer(this.renderer);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
    this.camera.position.set(3, 2.5, 5);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('change', () => {
      if (!this.suppressCameraChange) this.onCameraChange?.();
    });

    // Rotate-only local gizmo for posing a selected bone. The helper lives on
    // the scene (not contentRoot) so framing / bounds ignore it. Orbit is
    // disabled while the gizmo is dragged so the two left-button tools don't
    // fight. objectChange pauses the mixer — otherwise the next tick overwrites
    // the bone.
    this.poseControls = new TransformControls(this.camera, canvas);
    this.poseControls.mode = 'rotate';
    this.poseControls.space = 'local';
    this.poseControls.detach();
    this.scene.add(this.poseControls.getHelper());
    this.poseControls.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (e.value) this.pushPoseUndo();
    });
    this.poseControls.addEventListener('objectChange', () => {
      this.pauseForPose();
    });
    canvas.addEventListener('pointermove', this.handleRotateModalMove);
    canvas.addEventListener('pointerdown', this.handleRotateModalPointer);
    canvas.addEventListener('contextmenu', this.handleRotateModalContextMenu);

    this.viewHelper = new ViewHelper(this.camera, canvas);
    this.viewHelper.location.top = 8;
    this.viewHelper.location.right = 8;
    this.viewHelper.setLabels('X', 'Y', 'Z');
    this.viewHelper.setLabelStyle('20px sans-serif', '#ffffff', 12);
    canvas.addEventListener('pointerdown', this.handleViewHelperPointer);

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    this.contentRoot.name = 'Content';
    this.scene.add(this.contentRoot);

    // ---- Postprocessing pipeline (RenderPass -> OutlinePass -> OutputPass) ----
    // OutlinePass renders the silhouette of `selectedObjects` over the scene,
    // which gives the Blender-style highlight the user wants. OutputPass at the
    // tail handles tone mapping + sRGB conversion since the composer's
    // intermediate targets are linear.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const initSize = new THREE.Vector2();
    this.renderer.getSize(initSize);
    this.outlinePass = new OutlinePass(initSize, this.scene, this.camera);
    this.outlinePass.visibleEdgeColor.setHex(Viewer.SELECTION_COLOR_VISIBLE);
    this.outlinePass.hiddenEdgeColor.setHex(Viewer.SELECTION_COLOR_HIDDEN);
    this.outlinePass.edgeStrength = 4.0;
    this.outlinePass.edgeGlow = 0.4;
    this.outlinePass.edgeThickness = 1.8;
    this.outlinePass.pulsePeriod = 0;
    this.composer.addPass(this.outlinePass);

    this.composer.addPass(new OutputPass());

    this.installLights();
    this.applyEnvironment('studio');

    this.handleResize();
    window.addEventListener('resize', this.handleResize);

    // Watch the canvas itself so we react to layout-driven size changes too
    // (e.g. sidebar collapse animation, panel splits). Without this, only
    // window resize triggers the renderer update and CSS just stretches the
    // existing drawing buffer mid-animation.
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.canvas);

    this.renderer.setAnimationLoop(this.tick);
  }

  private resizeObserver: ResizeObserver | null = null;

  setHudCallback(cb: (info: HudInfo) => void): void {
    this.hudCallback = cb;
  }

  setAnimationCallback(cb: (time: number, duration: number) => void): void {
    this.animationCallback = cb;
  }

  /** Fired when a non-looping clip reaches its end. */
  setAnimationFinishedCallback(cb: () => void): void {
    this.animationFinishedCallback = cb;
  }

  setBackground(color: string): void {
    this.scene.background = new THREE.Color(color);
  }

  setGridVisible(v: boolean): void {
    if (v && !this.gridHelper) {
      this.gridHelper = new THREE.GridHelper(20, 20, 0x666666, 0x333333);
      (this.gridHelper.material as THREE.Material).transparent = true;
      (this.gridHelper.material as THREE.Material).opacity = 0.7;
      this.scene.add(this.gridHelper);
    } else if (!v && this.gridHelper) {
      this.scene.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
      (this.gridHelper.material as THREE.Material).dispose();
      this.gridHelper = null;
    }
  }

  /**
   * Seat loaded content on the world y=0 ground plane (where the grid lies)
   * after an axis change or new import. The grid is world-space scenery — kept
   * out of `contentRoot` so this translation never drags it along and framing/
   * bounds never include its 20-unit extent.
   */
  private alignContentToGrid(): void {
    if (!this.entries.length) return;
    this.contentRoot.position.y = 0;
    this.contentRoot.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const entry of this.entries) {
      box.expandByObject(entry.wrapper);
    }
    if (box.isEmpty()) return;
    this.contentRoot.position.y = -box.min.y;
    this.contentRoot.updateMatrixWorld(true);
  }

  setAxesVisible(v: boolean): void {
    if (v && !this.axesHelper) {
      this.axesHelper = new THREE.AxesHelper(1);
      this.axesHelper.rotation.x = this.upAxis === 'z' ? -Math.PI / 2 : 0;
      this.scene.add(this.axesHelper);
    } else if (!v && this.axesHelper) {
      this.scene.remove(this.axesHelper);
      this.axesHelper.dispose();
      this.axesHelper = null;
    }
  }

  setViewGizmoVisible(v: boolean): void {
    this.showViewGizmo = v;
  }

  /**
   * Switch which axis is treated as "up". Robotics/CAD assets are often
   * exported Z-up, which looks tipped over in this Y-up three.js viewer;
   * rotating `contentRoot` -90° about X maps the asset's Z axis onto the
   * world's Y (up) axis. Applied about the world origin, so callers that care
   * about keeping content on-screen should re-frame the camera afterward
   * (main.ts does this for user-initiated changes; init already frames after
   * load).
   */
  setUpAxis(axis: 'y' | 'z'): void {
    this.upAxis = axis;
    this.contentRoot.rotation.x = axis === 'z' ? -Math.PI / 2 : 0;
    this.contentRoot.updateMatrixWorld(true);
    this.alignContentToGrid();
    if (this.axesHelper) {
      this.axesHelper.rotation.x = axis === 'z' ? -Math.PI / 2 : 0;
    }
    // The corner ViewHelper geometry stays world-aligned (render() re-derives
    // orientation from the camera every frame; click-to-snap targets are
    // hardcoded world axes). We relabel and recolor the gizmo so its text and
    // colors match the asset frame under the X=red, Y=green, Z=blue convention.
    this.rebuildGizmoAxes(axis);
    if (this.showBounds) this.rebuildBoundsHelper();
  }

  /**
   * Axis-color convention: X=red, Y=green, Z=blue.
   *
   * The gizmo geometry stays world-aligned, so each world axis must display
   * whichever asset axis the contentRoot rotation maps onto it. Y-up is the
   * identity. Z-up rotates content -90° about X, which sends asset X to
   * world X, asset Z to world +Y, and asset Y to world *-Z* — so the asset
   * Y axis (line + labeled ball) is drawn on the negative world-Z side, with
   * the dimmed ball opposite it.
   *
   * ViewHelper children layout (three.js construction order in source):
   *   [0] xAxis Mesh  [1] zAxis Mesh  [2] yAxis Mesh
   *   [3] posX Sprite [4] posY Sprite [5] posZ Sprite
   *   [6] negX Sprite [7] negY Sprite [8] negZ Sprite
   */
  private rebuildGizmoAxes(axis: 'y' | 'z'): void {
    const AXIS_HEX: Record<string, number> = { X: 0xff4466, Y: 0x88ff44, Z: 0x4488ff };
    // Per world axis (X, Y, Z order): the asset axis it carries, and whether
    // that asset axis points along the negative world direction.
    const mapping =
      axis === 'z'
        ? [
            { label: 'X', negated: false },
            { label: 'Z', negated: false },
            { label: 'Y', negated: true },
          ]
        : [
            { label: 'X', negated: false },
            { label: 'Y', negated: false },
            { label: 'Z', negated: false },
          ];
    const ch = this.viewHelper.children;
    const cylinders = [ch[0], ch[2], ch[1]]; // world X, Y, Z (added in X, Z, Y order)
    // The cylinder geometry occupies the positive half of its axis; these are
    // the absolute rotations aiming it along the +/- world direction.
    const CYL_ROTATION: [THREE.Euler, THREE.Euler][] = [
      [new THREE.Euler(0, 0, 0), new THREE.Euler(0, Math.PI, 0)],
      [new THREE.Euler(0, 0, Math.PI / 2), new THREE.Euler(0, 0, -Math.PI / 2)],
      [new THREE.Euler(0, -Math.PI / 2, 0), new THREE.Euler(0, Math.PI / 2, 0)],
    ];

    mapping.forEach(({ label, negated }, world) => {
      const color = new THREE.Color(AXIS_HEX[label] ?? 0x888888);
      const cylinder = cylinders[world];
      if (cylinder instanceof THREE.Mesh) {
        (cylinder.material as THREE.MeshBasicMaterial).color.copy(color);
        cylinder.rotation.copy(CYL_ROTATION[world][negated ? 1 : 0]);
      }
      const labeled = ch[(negated ? 6 : 3) + world];
      const dimmed = ch[(negated ? 3 : 6) + world];
      this.replaceGizmoSprite(labeled, color, label, 1.0);
      this.replaceGizmoSprite(dimmed, color, null, 0.2);
    });
  }

  /** Replace one ViewHelper sprite's material with a freshly drawn canvas. */
  private replaceGizmoSprite(
    obj: THREE.Object3D,
    color: THREE.Color,
    label: string | null,
    opacity: number,
  ): void {
    if (!(obj instanceof THREE.Sprite)) return;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.beginPath();
    ctx.arc(32, 32, 12, 0, 2 * Math.PI);
    ctx.closePath();
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.fill();
    if (label) {
      ctx.font = '20px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, 32, 41);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const oldMat = obj.material as THREE.SpriteMaterial;
    oldMat.map?.dispose();
    oldMat.dispose();
    obj.material = new THREE.SpriteMaterial({ map: texture, toneMapped: false, opacity, transparent: true, alphaTest: 0.01, depthWrite: false });
  }

  setBoundsVisible(v: boolean): void {
    this.showBounds = v;
    if (v) {
      this.rebuildBoundsHelper();
    } else if (this.boundsHelper) {
      this.scene.remove(this.boundsHelper);
      this.boundsHelper = null;
    }
  }

  /** (Re)create the bounds helper around the currently loaded content. No-op
   *  until an asset is loaded; `attachAsset` replays it once content exists. */
  private rebuildBoundsHelper(): void {
    if (this.boundsHelper) {
      this.scene.remove(this.boundsHelper);
      this.boundsHelper = null;
    }
    if (!this.entries.length) return;
    const box = new THREE.Box3().setFromObject(this.contentRoot);
    this.boundsHelper = new THREE.Box3Helper(box, new THREE.Color(0xffaa00));
    this.scene.add(this.boundsHelper);
  }

  setSkeletonVisible(v: boolean): void {
    this.showSkeleton = v;
    if (v) {
      this.rebuildSkeletonHelpers();
    } else {
      this.clearSkeletonHelpers();
    }
  }

  setWireframeOverlayVisible(v: boolean): void {
    this.showWireframeOverlay = v;
    if (v) {
      this.rebuildWireframeOverlays();
    } else {
      this.clearWireframeOverlays();
    }
  }

  /**
   * Switch the skin-weight visualization mode. When active it overrides the
   * shading dropdown on skinned meshes (they render the debug material until
   * this is set back to 'off'); non-skinned meshes keep their normal shading.
   */
  setWeightMode(mode: WeightMode): void {
    if (this.weightMode === mode) return;
    const wasActive = this.weightMode !== 'off';
    this.weightMode = mode;
    if (mode === 'off') {
      this.clearWeightMaterials();
      // Restore the selected shading mode (and x-ray state) on every mesh.
      this.applyAllShading();
    } else if (wasActive) {
      // Already showing weights — just retarget the live uniforms.
      for (const { entry } of this.weightMats) {
        applyWeightUniforms(entry, this.weightMode, this.weightBoneIndex);
      }
    } else {
      this.rebuildWeightMaterials();
    }
    // Entering/leaving 'isolate' changes whether a joint should be highlighted.
    if (this.showSkeleton) this.updateSkeletonHighlight();
  }

  /** Set which bone the 'isolate' mode highlights (index into the skeleton). */
  setWeightBone(index: number): void {
    this.weightBoneIndex = index;
    for (const { entry } of this.weightMats) {
      applyWeightUniforms(entry, this.weightMode, this.weightBoneIndex);
    }
    if (this.showSkeleton) this.updateSkeletonHighlight();
  }

  /** Bone list of the first skinned mesh, for populating the UI bone picker. */
  getSkinnedBones(): { name: string; index: number }[] {
    let result: { name: string; index: number }[] = [];
    this.contentRoot.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (result.length === 0 && skinned.isSkinnedMesh && skinned.skeleton) {
        result = skinned.skeleton.bones.map((b, i) => ({ name: b.name || `Bone ${i}`, index: i }));
      }
    });
    return result;
  }

  /** Map a scene-tree Bone to its index within any loaded skeleton, or null. */
  boneIndexOf(bone: THREE.Object3D): number | null {
    let found: number | null = null;
    this.contentRoot.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (found === null && skinned.isSkinnedMesh && skinned.skeleton) {
        const idx = skinned.skeleton.bones.indexOf(bone as THREE.Bone);
        if (idx >= 0) found = idx;
      }
    });
    return found;
  }

  private rebuildWeightMaterials(): void {
    this.clearWeightMaterials();
    this.contentRoot.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (!skinned.isSkinnedMesh || !skinned.skeleton) return;
      this.disposeTransientMaterial(skinned);
      const entry = createWeightMaterial();
      applyWeightUniforms(entry, this.weightMode, this.weightBoneIndex);
      skinned.material = entry.material;
      this.weightMats.push({ mesh: skinned, entry });
    });
  }

  private clearWeightMaterials(): void {
    for (const { entry } of this.weightMats) {
      entry.material.dispose();
    }
    this.weightMats = [];
  }

  private rebuildSkeletonHelpers(): void {
    this.clearSkeletonHelpers();
    const roots = new Set<THREE.Object3D>();
    const allBones: THREE.Bone[] = [];
    this.contentRoot.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh && skinned.skeleton) {
        const root = skinned.skeleton.bones[0]?.parent ?? o;
        if (!roots.has(root)) {
          roots.add(root);
          const helper = new THREE.SkeletonHelper(root);
          helper.material = new THREE.LineBasicMaterial({
            vertexColors: true,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
            transparent: true,
          });
          helper.renderOrder = 999;
          this.scene.add(helper);
          this.skeletonHelpers.push(helper);
          allBones.push(...skinned.skeleton.bones);
        }
      }
    });

    if (allBones.length === 0) return;

    const jointSize = this.estimateJointSize();

    // Render bone connections as cylinders for visible thickness
    const boneMat = new THREE.MeshBasicMaterial({
      color: 0x44ff44,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    this.skeletonBoneMat = boneMat;
    this.highlightBoneMat = new THREE.MeshBasicMaterial({
      color: Viewer.JOINT_HIGHLIGHT,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    const boneRadius = jointSize * 0.2;
    // Unit-length cylinder along +Z; each frame it is positioned at the
    // parent joint, aimed at the child joint, and scaled to the bone length
    // so the markers follow animation playback.
    const cyl = new THREE.CylinderGeometry(boneRadius, boneRadius, 1, 4, 1);
    cyl.translate(0, 0.5, 0);
    cyl.rotateX(Math.PI / 2);
    for (const bone of allBones) {
      if (!bone.parent || !(bone.parent as THREE.Bone).isBone) continue;
      const mesh = new THREE.Mesh(cyl, boneMat);
      mesh.renderOrder = 998;
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      this.scene.add(mesh);
      this.jointMarkers.push(mesh);
      this.boneLinks.push({ mesh, bone, parent: bone.parent });
    }

    // Joint spheres. Base color is white so per-instance colors drive the hue,
    // letting us tint the isolated bone's joint without a second draw call.
    const geo = new THREE.SphereGeometry(jointSize, 10, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    const instances = new THREE.InstancedMesh(geo, mat, allBones.length);
    instances.frustumCulled = false;
    instances.renderOrder = 1000;
    instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(instances);
    this.jointMarkers.push(instances);
    this.jointInstances = instances;
    this.skeletonBones = allBones;

    this.updateSkeletonMarkers();
    this.updateSkeletonHighlight();
  }

  /** Tint the isolated / selected bone's joint (and the segment leading into
   *  it) in the skeleton overlay. Isolate-weights wins when both apply; otherwise
   *  the currently selected bone is highlighted so a posed joint is obvious. */
  private updateSkeletonHighlight(): void {
    if (!this.jointInstances) return;
    const isolate = this.weightMode === 'isolate' ? this.resolveWeightBone() : null;
    const selected =
      this.selectedObj && (this.selectedObj as THREE.Bone).isBone
        ? (this.selectedObj as THREE.Bone)
        : null;
    const target = isolate ?? selected;
    this.highlightBone = target;
    const hi = new THREE.Color(Viewer.JOINT_HIGHLIGHT);
    // While a bone is isolated, dim every other joint so the white one pops by
    // contrast; with no target, all joints keep their normal color.
    const others = new THREE.Color(Viewer.JOINT_COLOR);
    if (target) others.multiplyScalar(0.35);
    for (let i = 0; i < this.skeletonBones.length; i++) {
      this.jointInstances.setColorAt(i, this.skeletonBones[i] === target ? hi : others);
    }
    if (this.jointInstances.instanceColor) this.jointInstances.instanceColor.needsUpdate = true;
    // Dim the bone cylinders too while isolating, except the highlighted one.
    if (this.skeletonBoneMat) this.skeletonBoneMat.opacity = target ? 0.3 : 0.9;
    for (const link of this.boneLinks) {
      link.mesh.material =
        target && link.bone === target && this.highlightBoneMat
          ? this.highlightBoneMat
          : this.skeletonBoneMat!;
    }
    // The per-instance scale is written by updateSkeletonMarkers (runs each
    // frame); refresh it now so the size change shows immediately.
    this.updateSkeletonMarkers();
  }

  /** The THREE.Bone at the current weight-bone index, from the first skinned
   *  mesh's skeleton (the same source the UI bone dropdown is built from). */
  private resolveWeightBone(): THREE.Bone | null {
    let bone: THREE.Bone | null = null;
    this.contentRoot.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (!bone && skinned.isSkinnedMesh && skinned.skeleton) {
        bone = skinned.skeleton.bones[this.weightBoneIndex] ?? null;
      }
    });
    return bone;
  }

  /** Re-pose joint spheres and bone cylinders from current bone world positions. */
  private updateSkeletonMarkers(): void {
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    for (const link of this.boneLinks) {
      link.bone.getWorldPosition(pA);
      link.parent.getWorldPosition(pB);
      const dist = pA.distanceTo(pB);
      link.mesh.visible = dist > 1e-6;
      if (!link.mesh.visible) continue;
      link.mesh.position.copy(pB);
      link.mesh.lookAt(pA);
      link.mesh.scale.set(1, 1, dist);
    }
    if (this.jointInstances) {
      const dummy = new THREE.Object3D();
      for (let i = 0; i < this.skeletonBones.length; i++) {
        const bone = this.skeletonBones[i];
        bone.getWorldPosition(dummy.position);
        const s = bone === this.highlightBone ? Viewer.HIGHLIGHT_SCALE : 1;
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        this.jointInstances.setMatrixAt(i, dummy.matrix);
      }
      this.jointInstances.instanceMatrix.needsUpdate = true;
    }
  }

  private estimateJointSize(): number {
    const box = new THREE.Box3().setFromObject(this.contentRoot);
    if (box.isEmpty()) return 0.005;
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    return maxDim * 0.006;
  }

  private clearSkeletonHelpers(): void {
    for (const h of this.skeletonHelpers) {
      this.scene.remove(h);
      h.dispose();
    }
    this.skeletonHelpers = [];
    for (const m of this.jointMarkers) {
      this.scene.remove(m);
      const mesh = m as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) mesh.material.forEach(mat => mat.dispose());
        else (mesh.material as THREE.Material).dispose();
      }
    }
    // highlightBoneMat is only assigned to a cylinder while isolating a bone; if
    // nothing was highlighted it is never referenced by a mesh in the loop above.
    this.highlightBoneMat?.dispose();
    this.highlightBoneMat = null;
    this.skeletonBoneMat = null;
    this.highlightBone = null;
    this.jointMarkers = [];
    this.boneLinks = [];
    this.jointInstances = null;
    this.skeletonBones = [];
  }

  private rebuildWireframeOverlays(): void {
    this.clearWireframeOverlays();
    const overlayMat = new THREE.MeshBasicMaterial({
      wireframe: true,
      color: 0xffffff,
      opacity: 0.15,
      transparent: true,
      depthTest: true,
    });
    const meshes: THREE.Mesh[] = [];
    this.contentRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) meshes.push(mesh);
    });
    for (const mesh of meshes) {
      const overlay = new THREE.Mesh(mesh.geometry, overlayMat);
      overlay.matrixAutoUpdate = false;
      overlay.raycast = () => {};
      mesh.add(overlay);
      this.wireframeOverlays.push(overlay);
    }
  }

  private clearWireframeOverlays(): void {
    for (const o of this.wireframeOverlays) {
      if (o.parent) o.parent.remove(o);
    }
    this.wireframeOverlays = [];
  }

  /** Current orbit pose, for mirroring onto a linked viewer. */
  getCameraState(): CameraState {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
    };
  }

  /** Apply a pose received from a linked viewer without re-emitting a change. */
  applyCameraState(state: CameraState): void {
    this.suppressCameraChange = true;
    this.camera.position.set(state.position[0], state.position[1], state.position[2]);
    this.controls.target.set(state.target[0], state.target[1], state.target[2]);
    this.controls.update();
    this.suppressCameraChange = false;
  }

  /** Orbit pose in spherical terms (about the target), for offset-mode deltas. */
  getOrbitPose(): OrbitPose {
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    return { theta: s.theta, phi: s.phi, radius: s.radius, target: this.controls.target.toArray() as [number, number, number] };
  }

  /** Apply an incremental orbit change from a linked viewer (offset mode). */
  applyOrbitDelta(d: OrbitDelta): void {
    this.suppressCameraChange = true;
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    s.theta += d.dTheta;
    s.phi += d.dPhi;
    s.radius *= d.rRatio;
    s.makeSafe();
    // Pan proportionally to this viewer's zoom vs the driver's, so equal gestures
    // feel equal across differently-scaled models.
    const scale = d.driverRadius > 1e-9 ? s.radius / d.driverRadius : 1;
    this.controls.target.set(
      this.controls.target.x + d.dTarget[0] * scale,
      this.controls.target.y + d.dTarget[1] * scale,
      this.controls.target.z + d.dTarget[2] * scale,
    );
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(s));
    this.controls.update();
    this.suppressCameraChange = false;
  }

  setAutoRotate(v: boolean): void {
    this.controls.autoRotate = v;
    this.controls.autoRotateSpeed = 1.0;
  }

  /**
   * Highlight the given object (or any of its descendant meshes) with a
   * Blender-style silhouette outline. Pass `null` to clear.
   *
   * Uses OutlinePass, so the outline:
   *  - traces the actual silhouette (no bounding box, no extra wireframe geometry)
   *  - follows animations / skinning automatically every frame
   *  - covers groups: descendant meshes are merged into one silhouette
   */
  setSelected(obj: THREE.Object3D | null): void {
    if (this.selectedObj === obj) return;
    this.cancelRotateModal();
    this.selectedObj = obj;
    this.outlinePass.selectedObjects = obj ? [obj] : [];
    const bone = obj && (obj as THREE.Bone).isBone ? (obj as THREE.Bone) : null;
    this.poseBone = bone ? resolvePoseBone(bone) : null;
    if (this.poseBone) this.poseControls.attach(this.poseBone);
    else this.poseControls.detach();
    if (this.showSkeleton) this.updateSkeletonHighlight();
  }

  /** Bone the gizmo / inspector / R-rotate edit. */
  getPoseBone(): THREE.Bone | null {
    return this.poseBone;
  }

  get hasBindPose(): boolean {
    return this.bindPoses.length > 0;
  }

  /** True while the rotate gizmo or R-modal is active — skip viewport picks. */
  isPoseGizmoBusy(): boolean {
    return this.rotateModal !== null || this.poseControls.dragging || this.poseControls.axis !== null;
  }

  /** Map a ray to a skeleton-overlay joint, or null if none was hit. */
  pickSkeletonJoint(raycaster: THREE.Raycaster): THREE.Bone | null {
    if (!this.showSkeleton || !this.jointInstances) return null;
    const hits = raycaster.intersectObject(this.jointInstances, false);
    const hit = hits[0];
    if (!hit || hit.instanceId === undefined) return null;
    return this.skeletonBones[hit.instanceId] ?? null;
  }

  /**
   * Write a bone's local Euler rotation (degrees, in that bone's existing
   * order) and pause playback so the mixer does not overwrite it.
   */
  setBoneRotationDegrees(bone: THREE.Bone, xDeg: number, yDeg: number, zDeg: number): void {
    const target = resolvePoseBone(bone);
    target.rotation.set(
      THREE.MathUtils.degToRad(xDeg),
      THREE.MathUtils.degToRad(yDeg),
      THREE.MathUtils.degToRad(zDeg),
      target.rotation.order,
    );
    this.pauseForPose();
  }

  beginPoseNumericEdit(): void {
    this.pushPoseUndo();
  }

  /** Restore every snapshotted bone to its load-time local TRS. */
  resetBindPose(): void {
    this.cancelRotateModal();
    this.pushPoseUndo();
    for (const pose of this.bindPoses) {
      pose.bone.position.copy(pose.position);
      pose.bone.quaternion.copy(pose.quaternion);
      pose.bone.scale.copy(pose.scale);
    }
    this.contentRoot.updateMatrixWorld(true);
    if (this.showSkeleton) this.updateSkeletonMarkers();
    this.pauseForPose();
  }

  /**
   * Pause the mixer (if a clip is playing) so a manual bone edit sticks, then
   * notify the UI. No-op on the mixer when already paused or nothing is active.
   */
  pauseForPose(): void {
    if (this.activeAction && !this.animationPaused) this.pauseAnimation();
    this.applyPoseToSkin();
    this.onPoseEdit?.();
  }

  /**
   * Record local TRS for every Bone under `root`, including Mixamo FK parents
   * that are not in `skeleton.bones`. Shared bones are stored once.
   */
  private snapshotBindPoses(root: THREE.Object3D): void {
    const seen = new Set<THREE.Bone>(this.bindPoses.map((p) => p.bone));
    root.traverse((o) => {
      const bone = o as THREE.Bone;
      if (!bone.isBone || seen.has(bone)) return;
      seen.add(bone);
      this.bindPoses.push({
        bone,
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone(),
      });
    });
  }

  private capturePoseSnapshot(): BindPose[] {
    return this.bindPoses.map((p) => ({
      bone: p.bone,
      position: p.bone.position.clone(),
      quaternion: p.bone.quaternion.clone(),
      scale: p.bone.scale.clone(),
    }));
  }

  private restorePoseSnapshot(snapshot: BindPose[]): void {
    for (const pose of snapshot) {
      pose.bone.position.copy(pose.position);
      pose.bone.quaternion.copy(pose.quaternion);
      pose.bone.scale.copy(pose.scale);
    }
    this.applyPoseToSkin();
  }

  private applyPoseToSkin(): void {
    this.contentRoot.updateMatrixWorld(true);
    this.contentRoot.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh && skinned.skeleton) skinned.skeleton.update();
    });
    if (this.showSkeleton) this.updateSkeletonMarkers();
  }

  pushPoseUndo(): void {
    if (this.bindPoses.length === 0) return;
    this.poseUndo.push(this.capturePoseSnapshot());
    this.poseRedo = [];
  }

  undoPose(): boolean {
    if (this.rotateModal) {
      this.cancelRotateModal();
      return true;
    }
    const prev = this.poseUndo.pop();
    if (!prev) return false;
    this.poseRedo.push(this.capturePoseSnapshot());
    this.restorePoseSnapshot(prev);
    this.pauseForPose();
    return true;
  }

  redoPose(): boolean {
    const next = this.poseRedo.pop();
    if (!next) return false;
    this.cancelRotateModal();
    this.poseUndo.push(this.capturePoseSnapshot());
    this.restorePoseSnapshot(next);
    this.pauseForPose();
    return true;
  }

  isRotateModalActive(): boolean {
    return this.rotateModal !== null;
  }

  /**
   * Blender-style rotate: first R is view-axis (angle of the mouse around the
   * joint on screen). R again is trackball (mouse X/Y tumble). X/Y/Z lock a
   * local axis. LMB/Enter confirms, RMB/Esc cancels.
   */
  startRotateModal(startX: number, startY: number): boolean {
    if (!this.poseBone) return false;
    if (this.rotateModal) {
      const next = this.rotateModal.axis === 'view' ? 'trackball' : 'view';
      this.setRotateModalAxis(next);
      return true;
    }
    this.pushPoseUndo();
    const pivot = this.projectBoneToClient(this.poseBone);
    this.rotateModal = {
      startQuat: this.poseBone.quaternion.clone(),
      startX,
      startY,
      lastX: startX,
      lastY: startY,
      pivotX: pivot.x,
      pivotY: pivot.y,
      startAngle: Math.atan2(startY - pivot.y, startX - pivot.x),
      axis: 'view',
    };
    this.controls.enabled = false;
    this.poseControls.enabled = false;
    this.canvas.style.cursor = 'crosshair';
    return true;
  }

  setRotateModalAxis(axis: 'view' | 'trackball' | 'x' | 'y' | 'z'): void {
    if (!this.rotateModal || !this.poseBone) return;
    this.rotateModal.axis = axis;
    this.rotateModal.startQuat.copy(this.poseBone.quaternion);
    this.rotateModal.startX = this.rotateModal.lastX;
    this.rotateModal.startY = this.rotateModal.lastY;
    this.rotateModal.startAngle = Math.atan2(
      this.rotateModal.lastY - this.rotateModal.pivotY,
      this.rotateModal.lastX - this.rotateModal.pivotX,
    );
  }

  confirmRotateModal(): void {
    if (!this.rotateModal) return;
    this.rotateModal = null;
    this.controls.enabled = true;
    this.poseControls.enabled = true;
    this.canvas.style.cursor = '';
    this.pauseForPose();
  }

  cancelRotateModal(): void {
    if (!this.rotateModal || !this.poseBone) {
      this.rotateModal = null;
      return;
    }
    this.poseBone.quaternion.copy(this.rotateModal.startQuat);
    this.rotateModal = null;
    this.controls.enabled = true;
    this.poseControls.enabled = true;
    this.canvas.style.cursor = '';
    // Drop the undo entry we pushed at start — cancel should leave history unchanged.
    this.poseUndo.pop();
    this.pauseForPose();
  }

  get rotateModalAxis(): 'view' | 'trackball' | 'x' | 'y' | 'z' | null {
    return this.rotateModal?.axis ?? null;
  }

  private projectBoneToClient(bone: THREE.Bone): { x: number; y: number } {
    const v = new THREE.Vector3();
    bone.getWorldPosition(v);
    v.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  private handleRotateModalMove = (ev: PointerEvent): void => {
    if (!this.rotateModal || !this.poseBone) return;
    this.rotateModal.lastX = ev.clientX;
    this.rotateModal.lastY = ev.clientY;
    this.poseBone.quaternion.copy(this.rotateModal.startQuat);
    if (this.rotateModal.axis === 'trackball') {
      const rect = this.canvas.getBoundingClientRect();
      const scale = (2 * Math.PI) / Math.max(rect.width, 400);
      const dx = ev.clientX - this.rotateModal.startX;
      const dy = ev.clientY - this.rotateModal.startY;
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.poseBone.rotateOnWorldAxis(camRight, dy * scale);
      this.poseBone.rotateOnWorldAxis(camUp, dx * scale);
    } else {
      const angle = Math.atan2(
        ev.clientY - this.rotateModal.pivotY,
        ev.clientX - this.rotateModal.pivotX,
      ) - this.rotateModal.startAngle;
      if (this.rotateModal.axis === 'view') {
        const axis = new THREE.Vector3();
        this.camera.getWorldDirection(axis);
        this.poseBone.rotateOnWorldAxis(axis, angle);
      } else {
        const local = new THREE.Vector3(
          this.rotateModal.axis === 'x' ? 1 : 0,
          this.rotateModal.axis === 'y' ? 1 : 0,
          this.rotateModal.axis === 'z' ? 1 : 0,
        );
        this.poseBone.rotateOnAxis(local, angle);
      }
    }
    this.pauseForPose();
  };

  private handleRotateModalPointer = (ev: PointerEvent): void => {
    if (!this.rotateModal) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.button === 0) this.confirmRotateModal();
    else if (ev.button === 2) this.cancelRotateModal();
  };

  private handleRotateModalContextMenu = (ev: MouseEvent): void => {
    if (!this.rotateModal) return;
    ev.preventDefault();
  };

  applyEnvironment(mode: EnvironmentMode): void {
    this.environmentMode = mode;
    this.refreshEnvironment();
  }

  /**
   * Material mode pins a fixed neutral environment (a standardized preview,
   * like Blender's material-preview HDRI); solid mode does the same so the
   * override material reads consistently. Rendered and the debug modes follow
   * the user's Environment selection.
   */
  private effectiveEnvironment(): EnvironmentMode {
    if (this.shadingMode === 'material' || this.shadingMode === 'solid') return 'neutral';
    return this.environmentMode;
  }

  private refreshEnvironment(): void {
    const mode = this.effectiveEnvironment();
    if (mode === this.appliedEnvMode) return;
    this.appliedEnvMode = mode;
    if (this.envTexture) {
      this.envTexture.dispose();
      this.envTexture = null;
    }
    if (mode === 'none') {
      this.scene.environment = null;
      return;
    }
    const room = new RoomEnvironment();
    if (mode === 'neutral') {
      room.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          const m = mesh.material as THREE.MeshStandardMaterial;
          if (m.color) m.color.setScalar(0.7);
        }
      });
    }
    const tex = this.pmremGenerator.fromScene(room, 0.04).texture;
    this.envTexture = tex;
    this.scene.environment = tex;
  }

  setShading(mode: ShadingMode): void {
    if (this.shadingMode === mode) return;
    this.shadingMode = mode;
    this.refreshEnvironment();
    this.applyAllShading();
  }

  /** Blender's Alt+Z: composes with the current shading mode. */
  setXray(v: boolean): void {
    if (this.xrayOn === v) return;
    this.xrayOn = v;
    this.applyAllShading();
  }

  /** Force faceted shading; off means "use the asset's authored normals". */
  setFlatShading(v: boolean): void {
    if (this.flatShadingOn === v) return;
    this.flatShadingOn = v;
    this.applyAllShading();
  }

  /** Re-run the active mode plus the x-ray/flat toggles over all content. */
  private applyAllShading(): void {
    this.restoreXray();
    this.contentRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
      this.applyShadingToObject(o);
    });
    if (this.xrayOn) this.applyXray();
  }

  private applyXray(): void {
    this.contentRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Same precedence as shading: leave weight-debug materials alone, and
      // originalMaterials excludes splats (Spark draws those, not three.js).
      if (this.weightMode !== 'off' && (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (!this.originalMaterials.has(o)) return;
      forEachMaterial(mesh.material, (m) => {
        if (this.xraySaved.has(m)) return;
        this.xraySaved.set(m, {
          transparent: m.transparent,
          opacity: m.opacity,
          depthWrite: m.depthWrite,
        });
        m.transparent = true;
        m.opacity = 0.35;
        m.depthWrite = false;
        m.needsUpdate = true;
      });
    });
  }

  private restoreXray(): void {
    for (const [m, saved] of this.xraySaved) {
      m.transparent = saved.transparent;
      m.opacity = saved.opacity;
      m.depthWrite = saved.depthWrite;
      m.needsUpdate = true;
    }
    this.xraySaved.clear();
  }

  /** Dispose a generated shading material (normals/points) without touching the
   *  backed-up original from attachAsset. */
  private disposeTransientMaterial(o: THREE.Object3D): void {
    const backup = this.originalMaterials.get(o);
    const mesh = o as THREE.Mesh;
    if (!backup || !mesh.isMesh) return;
    const current = mesh.material;
    if (current === backup.material) return;
    forEachMaterial(current, (m) => {
      this.xraySaved.delete(m);
      m.dispose();
    });
  }

  private applyShadingToObject(o: THREE.Object3D): void {
    // Weight display takes precedence over the shading dropdown on skinned
    // meshes — leave the debug material in place until weight mode is 'off'.
    if (this.weightMode !== 'off' && (o as THREE.SkinnedMesh).isSkinnedMesh) return;
    const backup = this.originalMaterials.get(o);
    if (!backup) return;
    const mode = this.shadingMode;
    const mesh = o as THREE.Mesh;
    const isMesh = (mesh as THREE.Mesh).isMesh === true;
    const isPoints = (o as THREE.Points).isPoints === true;

    // The previous mode may have left a generated material behind.
    this.disposeTransientMaterial(o);

    const restore = (): void => {
      (mesh as THREE.Mesh).material = backup.material;
      forEachMaterial(backup.material, (m) => {
        if ('flatShading' in m && backup.flatShading != null) {
          (m as THREE.MeshStandardMaterial).flatShading = backup.flatShading;
        }
        if ('wireframe' in m) (m as THREE.MeshBasicMaterial).wireframe = false;
        m.needsUpdate = true;
      });
    };

    switch (mode) {
      case 'material':
      case 'rendered':
        restore();
        forEachMaterial(backup.material, (m) => {
          if ('flatShading' in m) {
            // Toggle off = the asset's authored setting, not forced-smooth.
            (m as THREE.MeshStandardMaterial).flatShading = this.flatShadingOn
              ? true
              : (backup.flatShading ?? false);
          }
          m.needsUpdate = true;
        });
        break;
      case 'solid':
        if (isMesh) {
          const hasVertexColors = !!mesh.geometry?.getAttribute('color');
          mesh.material = new THREE.MeshStandardMaterial({
            // White base under vertex colors so they show unmodulated.
            color: hasVertexColors ? 0xffffff : 0xb8b8b8,
            roughness: 0.85,
            metalness: 0.0,
            flatShading: this.flatShadingOn,
            vertexColors: hasVertexColors,
          });
        } else {
          restore();
        }
        break;
      case 'wireframe':
        restore();
        forEachMaterial((mesh as THREE.Mesh).material, (m) => {
          if ('wireframe' in m) (m as THREE.MeshBasicMaterial).wireframe = true;
        });
        break;
      case 'normals':
        if (isMesh) {
          const mat = new THREE.MeshNormalMaterial({ flatShading: this.flatShadingOn });
          // Carry the asset's normal map over so the view shows what the
          // shader sees, not just the geometry normals. Multi-material
          // meshes use the first entry (the whole mesh gets one debug
          // material anyway).
          const src = (
            Array.isArray(backup.material) ? backup.material[0] : backup.material
          ) as THREE.MeshStandardMaterial;
          if (src.normalMap) {
            mat.normalMap = src.normalMap;
            mat.normalMapType = src.normalMapType;
            mat.normalScale = src.normalScale;
          }
          (mesh as THREE.Mesh).material = mat;
        } else {
          restore();
        }
        break;
      case 'points':
        if (isMesh) {
          const pts = new THREE.PointsMaterial({ size: 0.005, color: 0xffffff, sizeAttenuation: true });
          (mesh as THREE.Mesh).material = pts;
        } else if (isPoints) {
          restore();
        }
        break;
    }
  }

  // ---- Gaussian splats ----

  /** True once any loaded asset is a Gaussian splat, so the UI can reveal the
   *  splat-only controls. */
  get hasSplats(): boolean {
    let found = false;
    this.contentRoot.traverse((o) => {
      if (isSplat(o)) found = true;
    });
    return found;
  }

  /** True when any loaded object is a regular mesh, so the UI can grey out
   *  mesh-only controls (e.g. the shading HUD) in splat-only sessions. */
  get hasMeshes(): boolean {
    let found = false;
    this.contentRoot.traverse((o) => {
      if (!isSplat(o) && (o as THREE.Mesh).isMesh) found = true;
    });
    return found;
  }

  /**
   * 3DGS training pipelines export Y-down, so splats load upside down in this
   * Y-up viewer; the conventional fix is a half turn about X, which Spark's own
   * examples apply. Files that already follow a Y-up convention need it off.
   */
  setSplatsUpright(v: boolean): void {
    this.splatsUpright = v;
    this.contentRoot.traverse((o) => {
      if (isSplat(o)) this.applySplatOrientation(o);
    });
    this.alignContentToGrid();
  }

  get splatsAreUpright(): boolean {
    return this.splatsUpright;
  }

  private applySplatOrientation(o: THREE.Object3D): void {
    o.rotation.x = this.splatsUpright ? Math.PI : 0;
  }

  private ensureSparkRenderer(): void {
    if (this.sparkRenderer) return;
    this.sparkRenderer = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.sparkRenderer);
  }

  /**
   * Drop the Spark renderer once nothing needs it. It owns a sorting worker and
   * a pair of render targets, so leaving it behind after the splats are gone
   * would hold both for the rest of the session. Its dispose() is instance
   * scoped, so `ensureSparkRenderer` can build a fresh one later.
   */
  private releaseSparkRenderer(): void {
    if (!this.sparkRenderer) return;
    this.scene.remove(this.sparkRenderer);
    this.sparkRenderer.dispose();
    this.sparkRenderer = null;
  }

  /** Replace any current content with this asset, then frame the camera. */
  loadAsset(asset: LoadedAsset, label: string): AssetEntry {
    this.clearAssets();
    const entry = this.attachAsset(asset, label);
    this.frameAll();
    return entry;
  }

  /** Add another asset to the existing scene without replacing what's there. */
  addAsset(asset: LoadedAsset, label: string): AssetEntry {
    const entry = this.attachAsset(asset, label);
    this.frameAll();
    return entry;
  }

  /** Internal: wrap, snapshot materials, register animation actions. */
  private attachAsset(asset: LoadedAsset, label: string): AssetEntry {
    const wrapper = new THREE.Group();
    wrapper.name = label;
    wrapper.add(asset.root);
    this.contentRoot.add(wrapper);

    wrapper.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (isSplat(o)) {
        // No material backup: splats are drawn by Spark, not by a three.js
        // material, so the shading modes below never apply to them.
        this.ensureSparkRenderer();
        this.applySplatOrientation(o);
      } else if (mesh.isMesh) {
        // Some formats ship without normals; the normals debug mode and lit
        // shading both need them, so fill them in once at load time.
        if (mesh.geometry && !mesh.geometry.getAttribute('normal')) {
          mesh.geometry.computeVertexNormals();
        }
        this.originalMaterials.set(o, {
          material: mesh.material,
          flatShading:
            !Array.isArray(mesh.material) && 'flatShading' in mesh.material
              ? (mesh.material as THREE.MeshStandardMaterial).flatShading
              : undefined,
        });
      } else if ((o as THREE.Points).isPoints) {
        this.originalMaterials.set(o, { material: (o as THREE.Points).material });
      }
    });

    if (!this.mixer) {
      this.mixer = new THREE.AnimationMixer(this.contentRoot);
      this.mixer.addEventListener('finished', () => {
        // Only fires for LoopOnce actions. clampWhenFinished keeps the pose on
        // the last frame; flip our pause flag so the UI shows "stopped at end".
        this.animationPaused = true;
        if (this.activeAction) this.activeAction.paused = true;
        this.animationFinishedCallback?.();
      });
    }
    const actions = asset.animations.map((clip) => this.mixer!.clipAction(clip, asset.root));

    const entry: AssetEntry = { label, wrapper, asset, actions };
    this.entries.push(entry);

    // Replay the active mode + x-ray/flat toggles so they cover the new
    // objects too (the traversal is scene-wide but idempotent).
    this.applyAllShading();

    if (this.showBounds) this.rebuildBoundsHelper();
    if (this.showSkeleton) this.rebuildSkeletonHelpers();
    if (this.showWireframeOverlay) this.rebuildWireframeOverlays();
    if (this.weightMode !== 'off') this.rebuildWeightMaterials();

    this.alignContentToGrid();
    this.snapshotBindPoses(wrapper);

    return entry;
  }

  /** Remove everything currently loaded (used by loadAsset). */
  clearAssets(): void {
    this.setSelected(null);
    if (this.activeAction) {
      this.activeAction.stop();
      this.activeAction = null;
    }
    this.currentClip = null;
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.cancelRotateModal();
    this.poseControls.detach();
    this.bindPoses = [];
    this.poseUndo = [];
    this.poseRedo = [];
    this.poseBone = null;
    this.clearSkeletonHelpers();
    this.clearWireframeOverlays();
    this.clearWeightMaterials();
    while (this.contentRoot.children.length) {
      const c = this.contentRoot.children[0];
      this.contentRoot.remove(c);
      disposeObject(c);
    }
    this.entries.length = 0;
    this.originalMaterials = new WeakMap();
    this.releaseSparkRenderer();
    if (this.boundsHelper) {
      this.scene.remove(this.boundsHelper);
      this.boundsHelper = null;
    }
  }

  /** Frame the camera around all loaded content. */
  frameAll(): void {
    if (!this.entries.length) return;
    this.frameObject(this.contentRoot);
  }

  frameObject(obj: THREE.Object3D): void {
    const box = new THREE.Box3();
    box.setFromObject(obj);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = maxDim / (2 * Math.tan((Math.PI * this.camera.fov) / 360));
    const dir = new THREE.Vector3(1, 0.7, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist * 1.6);
    this.camera.near = Math.max(0.001, maxDim / 1000);
    this.camera.far = Math.max(100, dist * 100);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    if (this.boundsHelper) {
      this.scene.remove(this.boundsHelper);
      this.boundsHelper = new THREE.Box3Helper(box, new THREE.Color(0xffaa00));
      this.scene.add(this.boundsHelper);
    }
  }

  // ---- Animation ----

  /** Play one of the actions returned by `attachAsset` / available via `entries`. */
  playAction(action: THREE.AnimationAction): void {
    if (!this.mixer) return;
    if (this.activeAction && this.activeAction !== action) {
      this.activeAction.fadeOut(0.2);
    }
    action.reset().fadeIn(0.2).play();
    action.setEffectiveTimeScale(this.animationSpeed);
    this.applyLoopMode(action);
    this.activeAction = action;
    this.currentClip = action.getClip();
    this.animationPaused = false;
    action.paused = false;
  }

  /** Activate an action paused on its first frame, so the timeline can scrub
   *  and step frames without starting playback (Blender-style clip select). */
  selectActionPaused(action: THREE.AnimationAction): void {
    if (!this.mixer) return;
    if (this.activeAction && this.activeAction !== action) {
      this.activeAction.stop();
    }
    action.reset().play();
    action.setEffectiveTimeScale(this.animationSpeed);
    action.setEffectiveWeight(1);
    this.applyLoopMode(action);
    action.paused = true;
    this.activeAction = action;
    this.currentClip = action.getClip();
    this.animationPaused = true;
    // Evaluate once so the model snaps to frame 0 of the selected clip.
    this.mixer.update(0);
  }

  setClipLooping(loop: boolean): void {
    this.animationLooping = loop;
    if (this.activeAction) this.applyLoopMode(this.activeAction);
  }

  private applyLoopMode(action: THREE.AnimationAction): void {
    action.setLoop(this.animationLooping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
  }

  get clipLooping(): boolean {
    return this.animationLooping;
  }

  get isAnimationPlaying(): boolean {
    return this.activeAction !== null && !this.animationPaused;
  }

  /** Current time (seconds) of the active action, 0 when none. */
  get animationTime(): number {
    return this.activeAction ? this.activeAction.time : 0;
  }

  get activeClipDuration(): number {
    return this.currentClip ? this.currentClip.duration : 0;
  }

  pauseAnimation(): void {
    if (!this.activeAction) return;
    this.animationPaused = true;
    this.activeAction.paused = true;
  }

  resumeAnimation(): void {
    if (!this.activeAction) return;
    this.animationPaused = false;
    this.activeAction.paused = false;
  }

  stopAnimation(): void {
    if (!this.activeAction) return;
    this.activeAction.stop();
    this.activeAction = null;
    this.currentClip = null;
    this.animationPaused = false;
  }

  setAnimationSpeed(speed: number): void {
    this.animationSpeed = speed;
    if (this.activeAction) this.activeAction.setEffectiveTimeScale(speed);
  }

  /** Seek the active animation to a time (seconds). */
  seekAnimation(t: number): void {
    if (!this.activeAction) return;
    this.activeAction.time = t;
    if (this.mixer) this.mixer.update(0);
  }

  // ---- Lifecycle ----

  destroy(): void {
    this.clearAssets();
    this.canvas.removeEventListener('pointerdown', this.handleViewHelperPointer);
    this.viewHelper.dispose();
    window.removeEventListener('resize', this.handleResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer.setAnimationLoop(null);
    this.canvas.removeEventListener('pointermove', this.handleRotateModalMove);
    this.canvas.removeEventListener('pointerdown', this.handleRotateModalPointer);
    this.canvas.removeEventListener('contextmenu', this.handleRotateModalContextMenu);
    this.scene.remove(this.poseControls.getHelper());
    this.poseControls.dispose();
    this.controls.dispose();
    if (this.envTexture) this.envTexture.dispose();
    this.pmremGenerator.dispose();
    this.composer.dispose();
    this.outlinePass.dispose();
    this.renderer.dispose();
  }

  // ---- Internals ----

  private installLights(): void {
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8);
    this.scene.add(this.hemiLight);
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.dirLight.position.set(5, 10, 7);
    this.scene.add(this.dirLight);
  }

  /** Snap the camera to an axis when the user clicks the corner gizmo. */
  private handleViewHelperPointer = (event: PointerEvent): void => {
    if (!this.showViewGizmo) return;
    if (this.viewHelper.handleClick(event)) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  private handleResize = (): void => {
    const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || window.innerHeight;
    if (w <= 0 || h <= 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Postprocessing render targets must match the renderer size, otherwise the
    // outline ends up scaled/clipped.
    const pr = this.renderer.getPixelRatio();
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.outlinePass.setSize(w * pr, h * pr);
  };

  private tick = (timeMs: number): void => {
    // Throttle to the target frame rate. Bail out until at least one frame
    // budget (minus tolerance) has elapsed since the last rendered frame, then
    // snap lastFrameTime onto the 60Hz grid so refresh rates that aren't a clean
    // multiple of 60 (e.g. 144Hz) average out to ~60 instead of drifting down.
    const elapsed = timeMs - this.lastFrameTime;
    if (elapsed < Viewer.FRAME_BUDGET_MS - Viewer.FRAME_TOLERANCE_MS) return;
    this.lastFrameTime = timeMs - (elapsed % Viewer.FRAME_BUDGET_MS);

    const dt = this.clock.getDelta();
    this.controls.update();
    if (this.mixer && !this.animationPaused) {
      this.mixer.update(dt);
      if (this.activeAction && this.currentClip && this.animationCallback) {
        this.animationCallback(this.activeAction.time, this.currentClip.duration);
      }
    }
    // Keep skeleton joint/bone markers in sync with animated bone poses
    // (also covers paused timeline scrubbing, which poses bones via mixer.update(0)).
    if (this.showSkeleton && this.skeletonBones.length > 0) {
      this.updateSkeletonMarkers();
    }
    this.composer.render();

    if (this.showViewGizmo) {
      this.viewHelper.center.copy(this.controls.target);
      if (this.viewHelper.animating) {
        this.viewHelper.update(dt);
        this.controls.update();
      }
      // ViewHelper calls renderer.render(), which auto-clears the full canvas by
      // default — that would erase the composer output and hide the scene.
      const autoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.viewHelper.render(this.renderer);
      this.renderer.autoClear = autoClear;
    }

    if (this.hudCallback) {
      this.fpsSamples.push(dt);
      if (this.fpsSamples.length > 30) this.fpsSamples.shift();
      const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
      const fps = avg > 0 ? Math.round(1 / avg) : 0;
      const info = this.renderer.info;
      this.hudCallback({
        fps,
        triangles: info.render.triangles,
        drawCalls: info.render.calls,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      });
    }
  };
}

export interface HudInfo {
  fps: number;
  triangles: number;
  drawCalls: number;
  geometries: number;
  textures: number;
}

function forEachMaterial(
  m: THREE.Material | THREE.Material[],
  fn: (mat: THREE.Material) => void,
): void {
  if (Array.isArray(m)) m.forEach(fn);
  else fn(m);
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (isSplat(node)) {
      // Splats own packed GPU textures and worker state that the mesh branch
      // below cannot reach; Spark frees all of it from its own dispose().
      (node as unknown as { dispose(): void }).dispose();
      (node as unknown as { geometry?: THREE.BufferGeometry }).geometry?.dispose();
      return;
    }
    if ((mesh as THREE.Mesh).isMesh || (node as THREE.Points).isPoints) {
      const geom = (mesh as THREE.Mesh).geometry;
      if (geom) geom.dispose();
      const m = (mesh as THREE.Mesh).material;
      if (m) {
        if (Array.isArray(m)) m.forEach((mat) => disposeMaterial(mat));
        else disposeMaterial(m);
      }
    }
  });
}

function disposeMaterial(mat: THREE.Material): void {
  for (const key of Object.keys(mat)) {
    const v = (mat as unknown as Record<string, unknown>)[key];
    if (v && typeof v === 'object' && (v as { isTexture?: boolean }).isTexture) {
      (v as THREE.Texture).dispose();
    }
  }
  mat.dispose();
}

/** Compute aggregate counts across an Object3D subtree. */
export function computeStats(root: THREE.Object3D): ObjectStats {
  const stats: ObjectStats = { meshes: 0, vertices: 0, triangles: 0, points: 0, lines: 0, splats: 0 };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (isSplat(o)) {
      stats.splats += (o as unknown as { numSplats: number }).numSplats;
      return;
    }
    if (mesh.isMesh && mesh.geometry) {
      stats.meshes++;
      const g = mesh.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position');
      const verts = pos ? pos.count : 0;
      stats.vertices += verts;
      const idx = g.index;
      const triCount = idx ? idx.count / 3 : verts / 3;
      stats.triangles += triCount;
    }
    if ((o as THREE.Points).isPoints) {
      const g = (o as THREE.Points).geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position');
      stats.points += pos ? pos.count : 0;
    }
    if ((o as THREE.LineSegments).isLineSegments) {
      const g = (o as THREE.LineSegments).geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position');
      stats.lines += pos ? pos.count / 2 : 0;
    }
  });
  return stats;
}

/** Collect unique materials from an object subtree. */
export function collectMaterials(root: THREE.Object3D): THREE.Material[] {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => seen.add(m));
      else seen.add(mesh.material);
    }
  });
  return Array.from(seen);
}
