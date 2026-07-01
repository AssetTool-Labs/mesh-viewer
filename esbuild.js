// Build script for the 3D Mesh Viewer extension.
// Produces:
//   out/extension.js  - Node bundle for the VS Code extension host
//   out/webview.js    - Browser bundle for the custom-editor webview (Three.js inlined)
//   out/webview.css   - Stylesheet for the webview
//   out/viewer.html   - HTML shell for the webview

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const outDir = path.resolve(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const baseOpts = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const extensionOpts = {
  ...baseOpts,
  entryPoints: [path.join(__dirname, 'src/extension.ts')],
  outfile: path.join(outDir, 'extension.js'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
};

const webviewOpts = {
  ...baseOpts,
  entryPoints: [path.join(__dirname, 'src/webview/main.ts')],
  outfile: path.join(outDir, 'webview.js'),
  platform: 'browser',
  target: ['chrome110'],
  format: 'iife',
  loader: { '.css': 'css' },
};

const cssOpts = {
  ...baseOpts,
  entryPoints: [path.join(__dirname, 'src/webview/style.css')],
  outfile: path.join(outDir, 'webview.css'),
  loader: { '.css': 'css' },
};

function copyHtml() {
  const src = path.join(__dirname, 'src/webview/viewer.html');
  const dst = path.join(outDir, 'viewer.html');
  fs.copyFileSync(src, dst);
}

async function run() {
  if (watch) {
    const ctxs = await Promise.all([
      esbuild.context(extensionOpts),
      esbuild.context(webviewOpts),
      esbuild.context(cssOpts),
    ]);
    await Promise.all(ctxs.map((c) => c.watch()));
    copyHtml();
    fs.watchFile(path.join(__dirname, 'src/webview/viewer.html'), copyHtml);
    console.log('[esbuild] watching for changes…');
  } else {
    await Promise.all([
      esbuild.build(extensionOpts),
      esbuild.build(webviewOpts),
      esbuild.build(cssOpts),
    ]);
    copyHtml();
    console.log('[esbuild] build complete');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
