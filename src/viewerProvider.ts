import * as path from 'path';
import * as vscode from 'vscode';
import type { FilePayload, InitMessage, ViewerConfig, ViewSettings, InitViewSettings, FromWebviewMessage } from './types';

const TEXT_EXTENSIONS = new Set(['obj', 'gltf', 'dae', 'wrl', 'vrml', 'usda', 'xyz']);

/** globalState key under which the last-used view settings are remembered. */
const REMEMBERED_KEY = '3dMeshViewer.viewSettings';

// Image extensions that 3D formats may reference as textures.
const TEXTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'ktx', 'ktx2', 'basis', 'tga', 'bmp', 'gif', 'exr', 'hdr'];

/**
 * Extensions of files we should ship as companion data when opening `ext`.
 * Returning `null` means "don't scan the directory at all".
 */
function sidecarExtensionsFor(ext: string): Set<string> | null {
  switch (ext) {
    case 'gltf':
      return new Set(['bin', ...TEXTURE_EXTENSIONS]);
    case 'obj':
      return new Set(['mtl', ...TEXTURE_EXTENSIONS]);
    case 'dae':
    case 'fbx':
      return new Set(TEXTURE_EXTENSIONS);
    default:
      return null;
  }
}

interface ViewerDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

export class MeshViewerProvider implements vscode.CustomReadonlyEditorProvider<ViewerDocument> {
  public static readonly viewType = '3dMeshViewer.viewer';
  private static readonly liveWebviews = new Set<vscode.Webview>();

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MeshViewerProvider.viewType,
      new MeshViewerProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  /** Send a message to every currently open viewer. */
  public static broadcast(message: unknown): void {
    for (const wv of MeshViewerProvider.liveWebviews) {
      wv.postMessage(message);
    }
  }

  /** Send a message to every open viewer except the one it originated from. */
  private static broadcastExcept(sender: vscode.Webview, message: unknown): void {
    for (const wv of MeshViewerProvider.liveWebviews) {
      if (wv !== sender) wv.postMessage(message);
    }
  }

  /** Tell every viewer how many are currently open, so they can show/hide the camera-link toggle. */
  private static broadcastViewerCount(): void {
    MeshViewerProvider.broadcast({ type: 'viewerCount', count: MeshViewerProvider.liveWebviews.size });
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<ViewerDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: ViewerDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'out');
    const fileDir = vscode.Uri.joinPath(document.uri, '..');

    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, fileDir],
    };

    webview.html = await this.buildHtml(webview, mediaRoot);

    MeshViewerProvider.liveWebviews.add(webview);
    webviewPanel.onDidDispose(() => {
      MeshViewerProvider.liveWebviews.delete(webview);
      MeshViewerProvider.broadcastViewerCount();
    });
    MeshViewerProvider.broadcastViewerCount();

    const sub = webview.onDidReceiveMessage(async (msg: FromWebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          try {
            const payload = await this.buildFilePayload(webview, document.uri);
            const init: InitMessage = { type: 'init', settings: this.effectiveViewSettings(), ...payload };
            await webview.postMessage(init);
            await webview.postMessage({ type: 'viewerCount', count: MeshViewerProvider.liveWebviews.size });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await webview.postMessage({ type: 'loadError', message });
            vscode.window.showErrorMessage(`3D Mesh Viewer: ${message}`);
          }
          break;
        case 'pickAndImport': {
          const picks = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: true,
            openLabel: 'Import into 3D Viewer',
            filters: {
              '3D Models': [
                'obj', 'fbx', 'glb', 'gltf', 'stl', 'ply', 'dae',
                '3ds', '3mf', 'wrl', 'vrml',
                'usd', 'usda', 'usdc', 'usdz',
                'vox', 'pcd', 'xyz', 'lwo', 'kmz',
                'spz', 'splat', 'ksplat', 'sog',
              ],
            },
          });
          if (!picks || picks.length === 0) {
            await webview.postMessage({
              type: 'addFileError',
              requestId: msg.requestId,
              fileName: '',
              message: '__cancelled__',
            });
            break;
          }
          for (const pickedUri of picks) {
            try {
              this.expandResourceRoots(webview, mediaRoot, fileDir, pickedUri);
              const payload = await this.buildFilePayload(webview, pickedUri);
              await webview.postMessage({ type: 'addFile', requestId: msg.requestId, ...payload });
            } catch (err) {
              await webview.postMessage({
                type: 'addFileError',
                requestId: msg.requestId,
                fileName: path.basename(pickedUri.fsPath),
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
          break;
        }
        case 'loadUris':
          for (const uriStr of msg.uris) {
            let uri: vscode.Uri;
            try {
              uri = vscode.Uri.parse(uriStr, true);
            } catch {
              try {
                uri = vscode.Uri.file(uriStr);
              } catch {
                await webview.postMessage({
                  type: 'addFileError',
                  requestId: msg.requestId,
                  fileName: uriStr,
                  message: `Could not interpret "${uriStr}" as a file URI.`,
                });
                continue;
              }
            }
            try {
              this.expandResourceRoots(webview, mediaRoot, fileDir, uri);
              const payload = await this.buildFilePayload(webview, uri);
              await webview.postMessage({ type: 'addFile', requestId: msg.requestId, ...payload });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              await webview.postMessage({
                type: 'addFileError',
                requestId: msg.requestId,
                fileName: path.basename(uri.fsPath || uriStr),
                message,
              });
            }
          }
          break;
        case 'log':
          if (msg.level === 'error') console.error('[3DViewer]', msg.message);
          else if (msg.level === 'warn') console.warn('[3DViewer]', msg.message);
          else console.log('[3DViewer]', msg.message);
          break;
        case 'error':
          vscode.window.showErrorMessage(`3D Mesh Viewer: ${msg.message}`);
          break;
        case 'viewSettingsChanged':
          // Remember the latest view settings so newly opened viewers can adopt
          // them. Persist unconditionally; `rememberViewSettings` only gates
          // whether they're re-applied on init (see effectiveViewSettings), so
          // toggling that setting off then on restores the last state.
          void this.context.globalState.update(REMEMBERED_KEY, msg.settings);
          break;
        case 'cameraSync':
          // Relay a linked camera move to the other open viewers.
          MeshViewerProvider.broadcastExcept(webview, { type: 'cameraSync', state: msg.state });
          break;
        case 'cameraOrbitDelta':
          // Relay an offset-mode orbit delta to the other open viewers.
          MeshViewerProvider.broadcastExcept(webview, { type: 'cameraOrbitDelta', delta: msg.delta });
          break;
        case 'cameraLinkChanged':
          // One click links/unlinks all viewers: mirror the toggle (and mode) everywhere else.
          MeshViewerProvider.broadcastExcept(webview, { type: 'cameraLink', enabled: msg.enabled, mode: msg.mode });
          break;
      }
    });
    webviewPanel.onDidDispose(() => sub.dispose());
  }

  private async buildFilePayload(webview: vscode.Webview, uri: vscode.Uri): Promise<FilePayload> {
    const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext);

    // Virtual documents (e.g. the left pane of a git diff, scheme `git:`) aren't
    // real files on disk, so `asWebviewUri` produces a resource URI the webview
    // can't fetch and directory scanning has no path to walk. Read the bytes for
    // that ref (see readVirtualResource) and inline them as a data: URI (allowed
    // by the CSP's `connect-src data:`); the webview fetch path is unchanged.
    // Sidecars/textures aren't resolved for these — geometry only.
    if (uri.scheme !== 'file') {
      const bytes = await this.readVirtualResource(uri);
      const dataUri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
      return {
        fileName: path.basename(uri.fsPath),
        fileExtension: ext,
        fileSizeBytes: bytes.byteLength,
        fileUri: dataUri,
        isText,
        auxFileUris: {},
      };
    }

    const fileUri = webview.asWebviewUri(uri).toString();

    const auxFileUris: Record<string, string> = {};
    const sidecarExts = sidecarExtensionsFor(ext);
    if (sidecarExts) {
      const dir = vscode.Uri.joinPath(uri, '..');
      try {
        const fs = require('fs') as typeof import('fs');
        const dirPath = dir.fsPath;
        const baseName = path.basename(uri.fsPath);
        // Walk subdirectories too: assets commonly keep textures in e.g.
        // `textures/` next to the model file. Depth-capped to keep the scan
        // cheap when a model sits in a large directory tree.
        const MAX_DEPTH = 3;
        const walk = (relDir: string, depth: number): void => {
          const entries = fs.readdirSync(path.join(dirPath, relDir), { withFileTypes: true });
          for (const entry of entries) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              if (depth < MAX_DEPTH && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                try {
                  walk(rel, depth + 1);
                } catch {
                  /* ignore unreadable subdirectory */
                }
              }
              continue;
            }
            if (!entry.isFile()) continue;
            if (rel === baseName) continue;
            const lower = entry.name.toLowerCase();
            const dot = lower.lastIndexOf('.');
            if (dot < 0) continue;
            const childExt = lower.slice(dot + 1);
            if (!sidecarExts.has(childExt)) continue;
            const childUri = vscode.Uri.joinPath(dir, ...rel.split('/'));
            auxFileUris[rel] = webview.asWebviewUri(childUri).toString();
          }
        };
        walk('', 0);
      } catch {
        /* ignore: no sidecar context available */
      }
    }

    return {
      fileName: path.basename(uri.fsPath),
      fileExtension: ext,
      fileSizeBytes: this.getFileSize(uri),
      fileUri,
      isText,
      auxFileUris,
    };
  }

  private getFileSize(uri: vscode.Uri): number {
    try {
      const fs = require('fs') as typeof import('fs');
      return fs.statSync(uri.fsPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Read a non-`file` document (e.g. the `git:` original side of a diff) as raw
   * bytes. Two strategies are tried in order:
   *   1. `workspace.fs.readFile` — works when a filesystem provider is registered
   *      for the scheme and the resource is wired into it.
   *   2. `git show <ref>:<path>` — a direct fallback for `git:` resources, which
   *      is needed because the diff "original" encodes `ref: "~"` (git's token
   *      for the index/base) that the provider can't always resolve, and because
   *      repositories nested under an ignored folder may not be in the Git model.
   */
  private async readVirtualResource(uri: vscode.Uri): Promise<Uint8Array> {
    let gitParams: { path: string; ref: string } | undefined;
    const attempts: vscode.Uri[] = [uri];
    if (uri.scheme === 'git') {
      try {
        gitParams = JSON.parse(uri.query) as { path: string; ref: string };
        for (const ref of ['HEAD', '']) {
          if (gitParams.ref !== ref) {
            attempts.push(uri.with({ query: JSON.stringify({ ...gitParams, ref }) }));
          }
        }
      } catch {
        /* query isn't the expected JSON — fall back to the URI as-is */
      }
    }

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const bytes = await vscode.workspace.fs.readFile(attempt);
        if (bytes.byteLength > 0) return bytes;
      } catch (err) {
        lastError = err;
      }
    }

    if (gitParams?.path) {
      try {
        return await this.readGitBlob(gitParams.path, gitParams.ref);
      } catch (err) {
        lastError = err;
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not read ${uri.scheme}: resource: ${detail || 'unknown error'}`);
  }

  /** Read a file blob from git via the CLI, resolving the diff's `~`/`''` refs to the index. */
  private readGitBlob(filePath: string, ref: string): Promise<Uint8Array> {
    const cp = require('child_process') as typeof import('child_process');
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    // `~` and empty are the git extension's tokens for the index/base; `:file`
    // reads the staged blob (== HEAD for an unstaged change).
    const object = ref && ref !== '~' ? `${ref}:./${base}` : `:./${base}`;
    return new Promise((resolve, reject) => {
      cp.execFile(
        'git',
        ['-C', dir, 'show', object],
        { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(new Uint8Array(stdout));
        },
      );
    });
  }

  private expandResourceRoots(
    webview: vscode.Webview,
    mediaRoot: vscode.Uri,
    primaryDir: vscode.Uri,
    newUri: vscode.Uri,
  ): void {
    const newDir = vscode.Uri.joinPath(newUri, '..');
    if (newDir.toString() === primaryDir.toString()) return;
    webview.options = {
      ...webview.options,
      localResourceRoots: [...(webview.options.localResourceRoots ?? [mediaRoot, primaryDir]), newDir],
    };
  }

  private readConfig(): ViewerConfig {
    const c = vscode.workspace.getConfiguration('3dMeshViewer');
    return {
      backgroundColor: c.get<string>('backgroundColor', '#1e1e1e'),
      showGrid: c.get<boolean>('showGrid', false),
      showAxes: c.get<boolean>('showAxes', false),
      showViewGizmo: c.get<boolean>('showViewGizmo', true),
      autoRotate: c.get<boolean>('autoRotate', false),
      shading: c.get<ViewerConfig['shading']>('shading', 'material'),
      environment: c.get<ViewerConfig['environment']>('environment', 'studio'),
      upAxis: c.get<ViewerConfig['upAxis']>('upAxis', 'y'),
    };
  }

  /**
   * The view settings a freshly opened viewer should start with: the configured
   * defaults, with the last-remembered settings merged over them when the
   * `rememberViewSettings` setting is enabled.
   */
  private effectiveViewSettings(): InitViewSettings {
    const defaults: InitViewSettings = {
      ...this.readConfig(),
      showBounds: false,
      showSkeleton: false,
      showWireframeOverlay: false,
      xray: false,
      flatShading: false,
    };
    const remember = vscode.workspace
      .getConfiguration('3dMeshViewer')
      .get<boolean>('rememberViewSettings', true);
    if (!remember) return defaults;
    const remembered = this.context.globalState.get<
      Partial<ViewSettings> & { showViewGizmo?: boolean }
    >(REMEMBERED_KEY);
    if (!remembered) return defaults;
    // Orientation gizmo is config-only — never override from remembered view settings.
    const { showViewGizmo: _ignored, ...rest } = remembered;
    return { ...defaults, ...rest };
  }

  private async buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): Promise<string> {
    const htmlUri = vscode.Uri.joinPath(mediaRoot, 'viewer.html');
    const raw = Buffer.from(await vscode.workspace.fs.readFile(htmlUri)).toString('utf8');

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css'));
    const dracoUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'draco'));
    const nonce = makeNonce();

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `media-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      // 'wasm-unsafe-eval' has two dependents: the DRACO decoder and Spark's
      // Gaussian splat sorter. Removing it breaks compressed glTF and every
      // splat format.
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `worker-src blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join('; ');

    return raw
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{csp}}', csp)
      .replaceAll('{{scriptUri}}', scriptUri.toString())
      .replaceAll('{{styleUri}}', styleUri.toString())
      .replaceAll('{{dracoUri}}', `${dracoUri.toString()}/`)
      .replaceAll('{{nonce}}', nonce);
  }
}

function makeNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
