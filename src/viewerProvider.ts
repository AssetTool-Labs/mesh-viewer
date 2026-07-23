import * as path from 'path';
import * as vscode from 'vscode';
import type { FilePayload, InitMessage, ViewerConfig, ViewSettings, FromWebviewMessage } from './types';

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
    webviewPanel.onDidDispose(() => MeshViewerProvider.liveWebviews.delete(webview));

    const sub = webview.onDidReceiveMessage(async (msg: FromWebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          try {
            const payload = this.buildFilePayload(webview, document.uri);
            const init: InitMessage = { type: 'init', settings: this.effectiveViewSettings(), ...payload };
            await webview.postMessage(init);
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
              const payload = this.buildFilePayload(webview, pickedUri);
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
              const payload = this.buildFilePayload(webview, uri);
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
      }
    });
    webviewPanel.onDidDispose(() => sub.dispose());
  }

  private buildFilePayload(webview: vscode.Webview, uri: vscode.Uri): FilePayload {
    const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext);
    const fileUri = webview.asWebviewUri(uri).toString();

    const auxFileUris: Record<string, string> = {};
    const sidecarExts = sidecarExtensionsFor(ext);
    if (sidecarExts) {
      const dir = vscode.Uri.joinPath(uri, '..');
      try {
        const fs = require('fs') as typeof import('fs');
        const dirPath = dir.fsPath;
        const baseName = path.basename(uri.fsPath);
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (entry.name === baseName) continue;
          const lower = entry.name.toLowerCase();
          const dot = lower.lastIndexOf('.');
          if (dot < 0) continue;
          const childExt = lower.slice(dot + 1);
          if (!sidecarExts.has(childExt)) continue;
          const childUri = vscode.Uri.joinPath(dir, entry.name);
          auxFileUris[entry.name] = webview.asWebviewUri(childUri).toString();
        }
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
      autoRotate: c.get<boolean>('autoRotate', false),
      shading: c.get<ViewerConfig['shading']>('shading', 'smooth'),
      environment: c.get<ViewerConfig['environment']>('environment', 'studio'),
      upAxis: c.get<ViewerConfig['upAxis']>('upAxis', 'y'),
    };
  }

  /**
   * The view settings a freshly opened viewer should start with: the configured
   * defaults, with the last-remembered settings merged over them when the
   * `rememberViewSettings` setting is enabled.
   */
  private effectiveViewSettings(): ViewSettings {
    const defaults: ViewSettings = {
      ...this.readConfig(),
      showBounds: false,
      showSkeleton: false,
      showWireframeOverlay: false,
    };
    const remember = vscode.workspace
      .getConfiguration('3dMeshViewer')
      .get<boolean>('rememberViewSettings', true);
    if (!remember) return defaults;
    const remembered = this.context.globalState.get<Partial<ViewSettings>>(REMEMBERED_KEY);
    return remembered ? { ...defaults, ...remembered } : defaults;
  }

  private async buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): Promise<string> {
    const htmlUri = vscode.Uri.joinPath(mediaRoot, 'viewer.html');
    const raw = Buffer.from(await vscode.workspace.fs.readFile(htmlUri)).toString('utf8');

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css'));
    const nonce = makeNonce();

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `media-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `worker-src blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join('; ');

    return raw
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{csp}}', csp)
      .replaceAll('{{scriptUri}}', scriptUri.toString())
      .replaceAll('{{styleUri}}', styleUri.toString())
      .replaceAll('{{nonce}}', nonce);
  }
}

function makeNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
