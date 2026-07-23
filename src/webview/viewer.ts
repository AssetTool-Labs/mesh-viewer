import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import type { LoadedAsset } from './loaders';
import { createWeightMaterial, applyWeightUniforms, type WeightMaterialEntry, type WeightMode } from './weightMaterial';

export type { WeightMode } from './weightMaterial';

export type ShadingMode = 'smooth' | 'flat' | 'wireframe' | 'points' | 'normals';
export type EnvironmentMode = 'studio' | 'neutral' | 'none';

export interface ObjectStats {
  meshes: number;
  vertices: number;
  triangles: number;
  points: number;
  lines: number;
}

interface MaterialBackup {
  material: THREE.Material | THREE.Material[];
  flatShading?: boolean;
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

  private readonly canvas: HTMLCanvasElement;
  private readonly clock = new THREE.Clock();
  private readonly pmremGenerator: THREE.PMREMGenerator;
  private envTexture: THREE.Texture | null = null;

  private gridHelper: THREE.GridHelper | null = null;
  private axesHelper: THREE.AxesHelper | null = null;
  /** Corner orientation widget (Blender-style) — always visible, tracks camera. */
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
  private activeAction: THREE.AnimationAction | null = null;
  private currentClip: THREE.AnimationClip | null = null;
  private animationSpeed = 1;
  private animationPaused = false;
  private animationLooping = true;
  private animationCallback: ((time: number, duration: number) => void) | null = null;
  private animationFinishedCallback: (() => void) | null = null;

  private originalMaterials = new WeakMap<THREE.Object3D, MaterialBackup>();
  private shadingMode: ShadingMode = 'smooth';
  private environmentMode: EnvironmentMode = 'studio';
  private fpsSamples: number[] = [];
  private hudCallback: ((info: HudInfo) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
    this.camera.position.set(3, 2.5, 5);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

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
    if (this.axesHelper) {
      this.axesHelper.rotation.x = axis === 'z' ? -Math.PI / 2 : 0;
    }
    this.viewHelper.rotation.x = axis === 'z' ? -Math.PI / 2 : 0;
    if (this.showBounds) this.rebuildBoundsHelper();
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
      // Restore whatever shading mode is currently selected on every mesh.
      this.contentRoot.traverse((o) => {
        if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) {
          this.applyShadingToObject(o);
        }
      });
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
    instances.raycast = () => {};
    instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(instances);
    this.jointMarkers.push(instances);
    this.jointInstances = instances;
    this.skeletonBones = allBones;

    this.updateSkeletonMarkers();
    this.updateSkeletonHighlight();
  }

  /** Tint the isolated bone's joint (and the segment leading into it) in the
   *  skeleton overlay. Only highlights while weight display is in 'isolate'
   *  mode; every other joint/bone renders in its base color. */
  private updateSkeletonHighlight(): void {
    if (!this.jointInstances) return;
    const target = this.weightMode === 'isolate' ? this.resolveWeightBone() : null;
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
    this.selectedObj = obj;
    this.outlinePass.selectedObjects = obj ? [obj] : [];
  }

  applyEnvironment(mode: EnvironmentMode): void {
    this.environmentMode = mode;
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
    if (this.entries.length === 0) {
      this.shadingMode = mode;
      return;
    }
    if (this.shadingMode === mode) return;
    this.shadingMode = mode;
    this.contentRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
      this.applyShadingToObject(o);
    });
  }

  /** Dispose a generated shading material (normals/points) without touching the
   *  backed-up original from attachAsset. */
  private disposeTransientMaterial(o: THREE.Object3D): void {
    const backup = this.originalMaterials.get(o);
    const mesh = o as THREE.Mesh;
    if (!backup || !mesh.isMesh) return;
    const current = mesh.material;
    if (current === backup.material) return;
    if (Array.isArray(current)) current.forEach((m) => m.dispose());
    else current.dispose();
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
      case 'smooth':
        restore();
        forEachMaterial(backup.material, (m) => {
          if ('flatShading' in m) (m as THREE.MeshStandardMaterial).flatShading = false;
          m.needsUpdate = true;
        });
        break;
      case 'flat':
        restore();
        forEachMaterial(backup.material, (m) => {
          if ('flatShading' in m) (m as THREE.MeshStandardMaterial).flatShading = true;
          m.needsUpdate = true;
        });
        break;
      case 'wireframe':
        restore();
        forEachMaterial((mesh as THREE.Mesh).material, (m) => {
          if ('wireframe' in m) (m as THREE.MeshBasicMaterial).wireframe = true;
        });
        break;
      case 'normals':
        if (isMesh) {
          (mesh as THREE.Mesh).material = new THREE.MeshNormalMaterial({ flatShading: false });
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
      if (mesh.isMesh) {
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
    // Register the entry BEFORE replaying a non-smooth shading mode. setShading
    // bails out when entries.length === 0 (its "no scene yet" guard), so if we
    // pushed after, a configured 'wireframe' / 'flat' / etc. would silently
    // never reach the traversal on initial load.
    this.entries.push(entry);

    if (this.shadingMode !== 'smooth') {
      const requested = this.shadingMode;
      this.shadingMode = 'smooth';
      this.setShading(requested);
    }

    if (this.showBounds) this.rebuildBoundsHelper();
    if (this.showSkeleton) this.rebuildSkeletonHelpers();
    if (this.showWireframeOverlay) this.rebuildWireframeOverlays();
    if (this.weightMode !== 'off') this.rebuildWeightMaterials();

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

  private tick = (): void => {
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
  const stats: ObjectStats = { meshes: 0, vertices: 0, triangles: 0, points: 0, lines: 0 };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
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
