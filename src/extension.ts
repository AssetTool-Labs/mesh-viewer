import * as vscode from 'vscode';
import { MeshViewerProvider } from './viewerProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(MeshViewerProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('3dMeshViewer.openWith', async (uri?: vscode.Uri) => {
      const target =
        uri ??
        (await vscode.window
          .showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: {
              '3D Models': [
                'obj', 'fbx', 'glb', 'gltf', 'stl', 'ply', 'dae',
                '3ds', '3mf', 'wrl', 'vrml',
                'usd', 'usda', 'usdc', 'usdz',
                'vox', 'pcd', 'xyz', 'lwo', 'kmz',
              ],
            },
          })
          .then((arr) => arr?.[0]));
      if (!target) return;
      await vscode.commands.executeCommand(
        'vscode.openWith',
        target,
        MeshViewerProvider.viewType,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('3dMeshViewer.resetCamera', () => {
      MeshViewerProvider.broadcast({ type: 'command', command: 'resetCamera' });
    }),
  );
}

export function deactivate(): void {}
