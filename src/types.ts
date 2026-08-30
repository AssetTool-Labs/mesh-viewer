// Shared types used by both the extension host and the webview.

export interface ViewerConfig {
  backgroundColor: string;
  showGrid: boolean;
  showAxes: boolean;
  /** Corner orientation gizmo (ViewHelper) — on by default. */
  showViewGizmo: boolean;
  autoRotate: boolean;
  shading: 'solid' | 'material' | 'rendered' | 'wireframe' | 'points' | 'normals';
  environment: 'studio' | 'neutral' | 'none';
  upAxis: 'y' | 'z';
}

/**
 * View settings the webview can change and optionally remember across opened files.
 * Config-only fields (e.g. `showViewGizmo`) are omitted — they come from
 * `ViewerConfig` on init only.
 */
export interface ViewSettings extends Omit<ViewerConfig, 'showViewGizmo'> {
  showBounds: boolean;
  showSkeleton: boolean;
  showWireframeOverlay: boolean;
  /** Blender-style see-through toggle; composes with any shading mode. */
  xray: boolean;
  /** Force flat (faceted) shading in solid/material/rendered modes. */
  flatShading: boolean;
}

/** Full settings payload sent on init, including config-only fields. */
export type InitViewSettings = ViewSettings & Pick<ViewerConfig, 'showViewGizmo'>;

/** Payload describing one loaded file. Reused by `init` and `addFile`. */
export interface FilePayload {
  fileName: string;
  fileExtension: string;
  fileSizeBytes: number;
  /** Webview-accessible URI the webview can fetch() directly. */
  fileUri: string;
  /** Whether the file should be fetched as text (true) or binary ArrayBuffer (false). */
  isText: boolean;
  /** Sidecar files keyed by filename → webview URI (textures, .bin, .mtl). */
  auxFileUris: Record<string, string>;
}

/** Message: extension -> webview, sent once when the editor opens. */
export interface InitMessage extends FilePayload {
  type: 'init';
  settings: InitViewSettings;
  /** False for virtual documents (e.g. git diff panes) — nothing on disk to reveal. */
  canReveal: boolean;
}

/** Message: extension -> webview, sent for each additional file imported via drag-and-drop. */
export interface AddFileMessage extends FilePayload {
  type: 'addFile';
  /** Correlation id echoed from the webview's loadUris request, so it can dismiss its overlay. */
  requestId?: string;
}

/** Message: extension -> webview, sent when an addFile request fails to read. */
export interface AddFileErrorMessage {
  type: 'addFileError';
  requestId?: string;
  fileName: string;
  message: string;
}

/** Orbit camera pose shared between viewers when camera linking is on. */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

/** How linked viewers track each other. */
export type CameraLinkMode = 'aligned' | 'offset';

/**
 * An incremental orbit change, used by `offset` linking so each viewer keeps its
 * own framing and only mirrors the *motion*. Angles are additive radians, radius
 * is a ratio, target pan is a world-space delta scaled by the driver's radius.
 */
export interface OrbitDelta {
  dTheta: number;
  dPhi: number;
  rRatio: number;
  dTarget: [number, number, number];
  driverRadius: number;
}

/** Message: extension -> a *different* viewer, relaying a linked camera move. */
export interface CameraSyncMessage {
  type: 'cameraSync';
  state: CameraState;
}

/** Message: extension -> a *different* viewer, relaying an `offset`-mode orbit delta. */
export interface CameraOrbitDeltaMessage {
  type: 'cameraOrbitDelta';
  delta: OrbitDelta;
}

/** Message: extension -> a *different* viewer, mirroring the link toggle state. */
export interface CameraLinkMessage {
  type: 'cameraLink';
  enabled: boolean;
  mode: CameraLinkMode;
}

/** Message: extension -> webview, how many viewers are currently open. */
export interface ViewerCountMessage {
  type: 'viewerCount';
  count: number;
}

/** Webview -> extension. */
export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string }
  /** Ask the host to read the given URIs (e.g. dragged from VS Code's Explorer) and post them back as `addFile`. */
  | { type: 'loadUris'; requestId: string; uris: string[] }
  /** Ask the host to show an open-file dialog and import the selected files. */
  | { type: 'pickAndImport'; requestId: string }
  /** Report the current view settings so the host can remember them for future viewers. */
  | { type: 'viewSettingsChanged'; settings: ViewSettings }
  /** Aligned-mode: camera moved while linking is on — relay this pose to the other viewers. */
  | { type: 'cameraSync'; state: CameraState }
  /** Offset-mode: relay just the incremental orbit change to the other viewers. */
  | { type: 'cameraOrbitDelta'; delta: OrbitDelta }
  /** The link toggle was flipped — mirror it (and its mode) to the other viewers. */
  | { type: 'cameraLinkChanged'; enabled: boolean; mode: CameraLinkMode }
  /** Ask the host to write the given PNG data URL to a file the user picks. */
  | { type: 'savePng'; dataUrl: string; suggestedName: string }
  /** Ask the host to save a copy of the primary file somewhere the user picks. */
  | { type: 'saveSourceCopy' }
  /** Ask the host to reveal the primary file in the Explorer (or the OS file manager). */
  | { type: 'revealSource' };


