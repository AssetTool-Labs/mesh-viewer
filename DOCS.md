# 3D Mesh Viewer

A VS Code / Cursor extension that turns the editor into a fully featured **3D mesh viewer**. Open any supported 3D file (GLB, GLTF, FBX, OBJ, USD/USDZ, STL, PLY, DAE, 3MF, …) and you get an interactive Three.js viewport with a scene-hierarchy tree, per-object inspector, animation transport, drag/drop or button-based mesh import, and a rich file-info panel — all rendered inside a custom editor.

It is similar in spirit to the popular `glb-viewer` extension but with first-class support for many more formats and a deeper inspection UI.

---

## Quick install

The extension is shipped as a local `.vsix`. There's no marketplace dependency.

### 1. Build the `.vsix`

```bash
cd mesh-viewer-vscode

npm install
npm run build
npx @vscode/vsce package --no-dependencies --allow-missing-repository
# produces ./mesh-viewer-vscode-0.1.0.vsix
```

### 2. Install it

Pick whichever editor and method you use. All of them are equivalent.

#### Install into VS Code

**A. From the command line** (works on macOS / Linux / Windows once the `code` CLI is on your `PATH`):

```bash
code --install-extension mesh-viewer-vscode-0.1.0.vsix --force
```

> **macOS users**: if `code` is not found, open VS Code → Command Palette (`Cmd+Shift+P`) → **Shell Command: Install 'code' command in PATH**, then re-open your terminal.
>
> **Windows users**: the `code` command is added to `PATH` automatically by the official installer when you check "Add to PATH" during setup.

**B. From the VS Code UI** (no CLI needed):

1. Open the **Extensions** view (`Cmd/Ctrl+Shift+X`).
2. Click the `…` menu in the top-right corner of that panel.
3. Choose **Install from VSIX…**.
4. Pick `mesh-viewer-vscode-0.1.0.vsix`.

#### Install into Cursor

Same options, just swap `code` → `cursor`:

```bash
cursor --install-extension mesh-viewer-vscode-0.1.0.vsix --force
```

Or use **Extensions → … → Install from VSIX…** in the Cursor UI.

### 3. Reload and use

Reload the editor window: `Cmd/Ctrl+Shift+P` → **Developer: Reload Window**. After that, double-clicking any supported 3D file in the Explorer opens it in the viewer automatically.

> **Remote / SSH / Dev Containers / Codespaces**: the install lands on the **side where you ran the CLI**. If your files live on a remote host (Cursor over SSH, etc.), run the install command on that remote shell, not on your laptop, otherwise the extension won't be visible to remote files.

### Uninstalling

```bash
code   --uninstall-extension local.mesh-viewer-vscode    # VS Code
cursor --uninstall-extension local.mesh-viewer-vscode    # Cursor
```

Or remove it from the **Extensions** view.

### Updating after code changes

Bump the `version` in `package.json` (e.g. `0.1.0` → `0.1.1`), then re-run **steps 1 & 2**. The `--force` flag on `--install-extension` overwrites the previous build in-place, and reloading the window picks up the new version.

---

## Supported formats

| Category | Extensions |
| --- | --- |
| GLTF / Khronos | `.gltf`, `.glb` |
| Wavefront | `.obj` (with companion `.mtl` & textures) |
| Autodesk | `.fbx`, `.3ds` |
| Pixar / Apple USD | `.usd`, `.usda`, `.usdc`, `.usdz` |
| Stereolithography | `.stl` |
| Polygon File | `.ply` |
| Khronos / KMZ | `.kmz` |
| Collada | `.dae` |
| 3D Manufacturing | `.3mf` |
| VRML | `.wrl`, `.vrml` |
| LightWave | `.lwo` |
| MagicaVoxel | `.vox` |
| Point clouds | `.pcd`, `.xyz` |

For multi-file formats (`.gltf` + `.bin` + textures, `.obj` + `.mtl` + textures), only files with reference-able extensions (`.bin`, `.mtl`, common image types) in the same directory are loaded automatically. Unrelated files (`.glb` / `.fbx` siblings, etc.) are ignored so opening one model never drags 14 MB of unrelated bytes through the webview channel.

---

## Features

- **Multi-format rendering** — every loader from Three.js' `examples/jsm/loaders` is wired in, lazy-imported on demand.
- **Add more meshes to a scene** — click `+ Import Mesh…` in the sidebar, *or* drag-and-drop more files onto the viewport (see the note about *Drop into Editor* below). Each import becomes its own root in the hierarchy, with its animations listed under the file's name.
- **Scene hierarchy panel** — collapsible tree with type icons (mesh / group / bone / light / camera / points / line segments), search filter, expand-all / collapse-all, and an eye toggle on every row to hide or unhide any subtree.
- **Selection inspector** — click a node in the tree *or* directly in the viewport to see name, type, transform, vertex / triangle / index counts, attribute list, material list, bone count, and bounding box.
- **File info panel** — format, size, parse time, glTF generator/version, scene totals, geometry totals, unique materials by type, texture count, light/camera summaries. Updates as you import more meshes.
- **Animation control** — every `AnimationClip` is listed with its duration; play / pause / stop, scrub bar, and a 0–2× speed slider drive a real `THREE.AnimationMixer`. With multiple imports, animations are grouped under their source file and can be swapped on the fly.
- **Timeline / dope sheet** — a Blender-style, read-only timeline docks under the viewport whenever the scene has animations: frame ruler with a scrubbable playhead, per-node keyframe rows (expandable to position / rotation / scale / morph channels), frame-by-frame stepping, keyframe jumping, auto-detected FPS (overridable), loop toggle, and playback-speed presets. `Space` plays/pauses, `←`/`→` step one frame, `Shift+←`/`→` jump to start/end, `↑`/`↓` jump between keyframes, `Ctrl`+scroll zooms the ruler.
- **Shading modes** — smooth, flat, wireframe, points, and a normals debug shader.
- **Skin-weight visualization** — for skinned meshes, *Show skin weights* recolors the surface by its skin weights, with four modes: **all bones** (each bone a palette color, blended per vertex), **isolate bone** (one bone's weight on a blue→red ramp), **influence count** (discrete bands by number of influences per vertex), and **normalization** (flags vertices whose weights don't sum to 1.0). A contextual legend explains the current mode's colors, and the coloring deforms with animation. Pick the isolated bone from the dropdown or by clicking a bone in the hierarchy.
- **View helpers** — grid, axes, bounding box, auto-rotate, IBL studio/neutral environment, background color picker.
- **Frame-to-fit** — `Reset Camera` for the whole scene, `Frame Selection` (or double-click a tree row) for a single node.
- **HUD overlay** — live FPS, draw calls, triangle count, geometry/texture totals.
- **VS Code theme aware** — inherits editor colors so it looks right in light or dark themes.
- **Fully offline** — no CDN, no network calls; the entire Three.js bundle ships inside the extension.

---

## Usage

### Opening a file

- **Explorer double-click** — `.glb`, `.fbx`, `.obj`, etc. open in the viewer by default.
- **Right-click → Open With…** — pick *3D Mesh Viewer*. From that menu you can also set it as the default for that extension.
- **Command palette** — `3D Mesh Viewer: Open With 3D Mesh Viewer` lets you pick a file from a dialog.
- To re-open a file as text instead: right-click → **Open With…** → **Text Editor**.

### Adding more meshes to an open scene

There are two ways to import another file into the current viewer:

1. **Click `+ Import Mesh…`** in the sidebar header. It opens the standard VS Code/Cursor file picker (multi-select supported). This works in every layout and is the recommended path.
2. **Drag-and-drop** — drag a supported file from your OS file manager *or* the VS Code/Cursor Explorer onto the viewport. A blue dashed overlay confirms the drop target.

Each imported file is wrapped in a group named after its file name and added to `Content` alongside what's already there. The hierarchy, info panel, and animation list rebuild to reflect the combined scene; nothing is replaced. To start over with just one file, close and re-open the editor.

> **Why doesn't drag-and-drop work for me?** VS Code 1.83+ ships a feature called *Drop into Editor* that intercepts file drops on every editor pane (including custom editors like this one) before the webview can see them. The host overlay says **"Drop to open"** instead of our blue **"Drop to import into scene"** card, and the dropped file replaces your current viewer.
>
> Fix it once in your settings:
>
> ```jsonc
> // settings.json
> "workbench.editor.dropIntoEditor.enabled": false
> ```
>
> After reloading the window, drops land in the webview and import-into-scene works. The `+ Import Mesh…` button keeps working either way.

### Viewport controls

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Orbit | left-drag | — |
| Pan | right-drag *or* `Shift` + left-drag | — |
| Zoom | scroll wheel | — |
| Pick object | left-click on geometry | — |
| Frame whole scene | — | View tab → **Reset Camera** |
| Frame selected node | double-click a tree row, or **Frame Selection** | — |
| Toggle sidebar | sidebar arrow button | — |

### Sidebar tabs

- **Hierarchy** — tree of every `Object3D` under `Content`, with eye-toggle visibility and a search box. Selected node's details appear at the bottom. Multiple imports show as siblings at the top level.
- **Info** — file metadata + scene/geometry/material/light/camera totals, summed across all imports.
- **Animations** — list of all clips grouped by source file, transport controls, time scrubber, speed slider.

### Timeline / dope sheet

When the loaded scene has at least one animation clip, a Blender-style timeline appears under the viewport. It's a **visualization-only** panel — it never edits keyframes.

- **Transport bar** — clip dropdown, jump-to-start/end, previous/next keyframe, previous/next frame, play/pause, an editable current-frame field, auto-detected FPS (changeable), speed presets, and a loop toggle.
- **Dope sheet** — the top *summary* row aggregates every key in the clip; below it, one row per animated node shows that node's keys as diamonds. Click a node row's label to expand its channels (Position / Rotation / Scale / Morph). Areas outside the clip's frame range are shaded dark.
- **Scrubbing** — click or drag anywhere in the ruler or track area; the playhead snaps to whole frames. The frame field, sidebar scrub bar, and 3D pose all stay in sync.
- **Navigation** — `Ctrl`/`Cmd` + scroll zooms around the cursor, `Shift` + scroll (or trackpad horizontal) pans, plain scroll moves through track rows.

| Shortcut | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Step one frame back / forward |
| `Shift+←` / `Shift+→` | Jump to first / last frame |
| `↑` / `↓` | Jump to next / previous keyframe |

Selecting a clip (sidebar row or timeline dropdown) while paused shows the clip's first frame without starting playback, so you can immediately step through frames; if a clip is already playing, the new clip keeps playing.
- **View** — shading mode, skeleton overlay, skin-weight display, grid/axes/bounds toggles, auto-rotate, background, environment, up axis (Y up / Z up), reset/frame buttons.

---

## Configuration

These live under `3dMeshViewer.*` in your settings:

| Setting | Default | Description |
| --- | --- | --- |
| `3dMeshViewer.backgroundColor` | `#1e1e1e` | Default background color (any CSS color). |
| `3dMeshViewer.showGrid` | `true` | Show ground grid helper on open. |
| `3dMeshViewer.showAxes` | `true` | Show axis helper on open. |
| `3dMeshViewer.autoRotate` | `false` | Auto-rotate camera around model. |
| `3dMeshViewer.shading` | `smooth` | One of `smooth`, `flat`, `wireframe`, `points`, `normals`. |
| `3dMeshViewer.environment` | `studio` | IBL environment for PBR materials: `studio`, `neutral`, `none`. |
| `3dMeshViewer.upAxis` | `y` | Which axis is "up" in the viewport: `y` (default) or `z` for robotics/CAD assets exported Z-up, which otherwise appear tipped over. |
| `3dMeshViewer.rememberViewSettings` | `true` | Remember the last view settings you chose (shading, grid, axes, auto-rotate, background, environment, up axis, and the bounds/skeleton/wireframe-overlay toggles) and apply them to newly opened viewers. Turn off to always start from the configured defaults above. |

Settings apply to newly opened viewers; existing viewers keep their current state (you can change everything per-viewer in the **View** tab). With `rememberViewSettings` on (the default), the last view settings you picked in any viewer carry over to the next file you open — and persist across restarts — taking precedence over the defaults above.

---

## Commands

| Command | What it does |
| --- | --- |
| `3D Mesh Viewer: Open With 3D Mesh Viewer` | Open the active file (or pick one) in the viewer. |
| `3D Mesh Viewer: Reset Camera` | Reframe all open viewers around their content. |

---

## Development

```bash
npm install
npm run build      # one-shot build
npm run watch      # rebuild on change
npm run typecheck  # strict TS checks for both bundles
```

Project layout:

```
src/
  extension.ts          # activation + commands
  viewerProvider.ts     # CustomReadonlyEditorProvider + sidecar scanner + message bridge
  types.ts              # shared host ↔ webview message types
  webview/
    main.ts             # UI wiring (tree, info panel, animation, picking, drop, import button)
    viewer.ts           # Three.js scene/camera/controls/IBL/shading/multi-asset content root
    weightMaterial.ts   # skin-weight debug material (MeshBasicMaterial + onBeforeCompile)
    loaders.ts          # per-format dispatcher (lazy imports)
    viewer.html         # HTML shell
    style.css           # theme-aware styles
esbuild.js              # produces out/extension.js + out/webview.{js,css} + out/viewer.html
```

To debug interactively: open this folder in VS Code/Cursor and press `F5`. That launches an **Extension Development Host** with the extension loaded from source — handy for iterating without re-installing the `.vsix`.

To re-package after changes:

```bash
npm run build
npx @vscode/vsce package --no-dependencies --allow-missing-repository
cursor --install-extension mesh-viewer-vscode-0.1.0.vsix --force
```

The packaged `.vsix` is intentionally small (~310 KB). Test 3D files dropped into the repo root won't be included — `.vscodeignore` whitelists only the runtime files in `out/`.

---

## Troubleshooting

- **"Open With…" doesn't show 3D Mesh Viewer.** Reload the window (`Developer: Reload Window`). If it still doesn't show, run `cursor --list-extensions | grep mesh` to confirm the extension is installed on the side where the file lives (local vs. remote SSH).
- **Drop shows VS Code's "Drop to open" card and replaces my viewer.** That's *Drop into Editor* intercepting before the webview sees the drag — see the call-out under [Adding more meshes](#adding-more-meshes-to-an-open-scene). Either disable that setting or use the `+ Import Mesh…` button.
- **The viewport is black / nothing renders.** Open the webview devtools (`Developer: Open Webview Developer Tools` while the viewer is focused) and check the console. The most common cause is an unsupported variant of a format (e.g. encrypted FBX, Draco-compressed GLB without the decoder, complex USD schemas).
- **GLTF textures / .bin missing.** The extension loads sibling files automatically, but only those in the *same directory* as the `.gltf` and only if their extension is `.bin` or a known image format. Make sure your buffer/texture paths are relative and point next to the `.gltf` file.
- **Updated the code but Cursor still shows the old version.** Either bump the `version` in `package.json` before re-packaging, or pass `--force` to `--install-extension` (we already do above) and then reload the window.

---

## Notes & limitations

- Files are loaded fully into memory in the webview, so very large assets (≫ 1 GB) may be slow.
- Imported sidecar payload is capped at 32 MB per file and 96 MB total to avoid pathological postMessage sizes.
- The bundled USD loader supports a subset of USD/USDA/USDC/USDZ; complex production assets with custom schemas may not render perfectly.
- Animation editing/baking is not supported — animations are read-only.
- Skin-weight *influence count* is capped at 4 per vertex (the GPU skinning limit) — vertices originally bound to more bones can't be distinguished, since the extra influences are dropped at load. The *normalization* mode assumes weights should sum to 1.0; most loaders already deliver normalized weights, so it mainly flags atypical assets. *Isolate bone* builds its picker from the first skinned mesh's skeleton and broadcasts that bone index to every skinned mesh, so merged scenes with multiple independent rigs may highlight mismatched bones.
- DRACO / Meshopt compressed glTF requires the corresponding decoder; the extension does not yet ship those decoders.
- Encrypted or proprietary FBX variants from some pipelines may fail to parse.

---

## License

MIT — see the `LICENSE` file in this repository.
