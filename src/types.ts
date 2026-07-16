// Shared types used by both the extension host and the webview.

export interface ViewerConfig {
  backgroundColor: string;
  showGrid: boolean;
  showAxes: boolean;
  autoRotate: boolean;
  shading: 'smooth' | 'flat' | 'wireframe' | 'points' | 'normals';
  environment: 'studio' | 'neutral' | 'none';
}

/**
 * The full set of view settings the viewer can remember across opened files.
 * Superset of `ViewerConfig`: the extra booleans are not backed by VS Code
 * settings (they default to false) but are still persisted when "remember view
 * settings" is enabled.
 */
export interface ViewSettings extends ViewerConfig {
  showBounds: boolean;
  showSkeleton: boolean;
  showWireframeOverlay: boolean;
}

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
  settings: ViewSettings;
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
