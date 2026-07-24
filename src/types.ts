// Shared types used by both the extension host and the webview.

export interface ViewerConfig {
  backgroundColor: string;
  showGrid: boolean;
  showAxes: boolean;
  /** Corner orientation gizmo (ViewHelper) — on by default. */
  showViewGizmo: boolean;
  autoRotate: boolean;
  shading: 'smooth' | 'flat' | 'wireframe' | 'points' | 'normals';
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
  | { type: 'viewSettingsChanged'; settings: ViewSettings };
