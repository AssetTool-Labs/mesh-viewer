# AGENTS.md

Repo rule for coding agents (Claude Code, Codex, Cursor). Read this before touching code.

## What this repo is

`mesh-viewer` is a VS Code / Cursor extension (`AssetToolLabs.mesh-viewer-vscode`) that opens 3D
files and Gaussian splats in a custom editor. `esbuild.js` produces two independent bundles:

| Bundle            | Entry point                                    | Runs in                       |
| ----------------- | ---------------------------------------------- | ----------------------------- |
| `out/extension.js`| `src/extension.ts` → `src/viewerProvider.ts`   | extension host (Node)         |
| `out/webview.js`  | `src/webview/main.ts`                          | webview (browser, Three + Spark inlined) |

Webview modules: `viewer.ts` (scene, camera, render loop, overlays), `loaders.ts` (per-format
loading and format sniffing), `timeline.ts` (dope sheet and playback), `weightMaterial.ts` (skin
weight coloring), `viewer.html` + `style.css` (shell). `src/types.ts` is the message protocol
between the two sides. Almost every format or rendering bug lands in `src/webview/`.

---

## The loop

**Every feature request, format-support request, and rendering/loading bug fix runs through all
six phases below, in order.** Do not go from prompt straight to edit. Do not declare a visual
result working — you cannot see the viewport, so phase 6 is where the user decides.

### 1. Analyze

Before proposing a change:

- Restate the ask and the observed vs. expected behavior in one paragraph.
- Find the code that owns it. Format/loading → `src/webview/loaders.ts`. Scene, camera, shading,
  overlays → `src/webview/viewer.ts`. UI panels, tree, inspector → `src/webview/main.ts`.
  Animation → `src/webview/timeline.ts`. Webview HTML, CSP, resource URIs, file reads →
  `src/viewerProvider.ts`. Commands, activation, settings → `src/extension.ts` + `package.json`.
- Check what the pinned `three` already ships before adding a dependency —
  `node_modules/three/examples/jsm/` has loaders, decoders, and utils that are often the whole fix.
- Name the root cause. If you cannot, say so and treat phase 2 as a diagnostic step rather than
  claiming a cause you have not established.

### 2. Get real test data

Get an asset that actually exercises the code path **before** writing the fix, so there is a
before/after to compare.

- Put everything in `test_data/` (gitignored, never committed). Do not drop assets in the repo root.
- Fetch two things where possible: a **repro asset** that triggers the bug or new path, and a
  **control asset** in the same format that already works and must not regress.
- Verified sources (reachable from this sandbox):

  ```bash
  mkdir -p test_data && cd test_data

  # Khronos glTF sample assets — index of every model, then a specific one
  curl -sSLO https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/model-index.json
  curl -sSLO https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb

  # three.js example models — fbx, obj, stl, ply, collada, usdz, vox, pcd, ...
  curl -sSLO "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/fbx/Samba%20Dancing.fbx"
  curl -sSLO https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/stl/binary/pr2_head_pan.stl

  # assimp regression corpus — broad, weird, good for edge cases
  curl -sSLO https://raw.githubusercontent.com/assimp/assimp/master/test/models/OBJ/spider.obj
  ```

- **Confirm the asset really hits the path** before coding — a sample named after a feature does
  not always use it. For glTF, check the extension list; for binary formats, check the header:

  ```bash
  node -e "const b=require('fs').readFileSync('test_data/x.glb');const j=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString());console.log(j.extensionsUsed,j.extensionsRequired)"
  ```

- If nothing public exercises the path, **generate a fixture** with a small node script under
  `test_data/` and say in your report that the evidence is synthetic.
- Record where each asset came from in `test_data/SOURCES.md` so the next session can refetch it.

### 3. Plan, then get approval

Write a dedicated plan and get the user's go-ahead before editing. In Claude Code use plan mode
and `ExitPlanMode`; in Codex post the plan and wait for an ack. The plan states:

1. Root cause (or the diagnostic that will pin it down).
2. Numbered steps, each with the file it touches and why.
3. Which side of the boundary changes — extension host, webview, or both.
4. What is explicitly out of scope.
5. How each step gets verified, and which test asset proves it.

Prefer the smallest change that fixes the class of problem. If a plan starts widening the CSP,
adding a dependency, or reworking the render loop, stop and flag the tradeoff instead of
absorbing it silently.

### 4. Implement and rebuild

```bash
npm run typecheck   # tsc over both tsconfigs; esbuild does NOT typecheck
npm run build       # writes out/
```

Both must pass clean. Match the surrounding style: the existing code explains *why* in comments,
not *what*. English only — no Chinese in code, comments, or identifiers.

Update `DOCS.md` and the `package.json` `contributes` block in the same change when you add a
format, a setting, or a command. A format needs all of: a `case` in `loadAsset`, a
`filenamePattern` in `customEditors.selector`, the `explorer/context` `when` regex, the
`DOCS.md` format table, and the `README.md`/`package.json` blurbs if it is user-visible.

### 5. Install the local build

```bash
./scripts/dev-install.sh              # typecheck, build, package, install into every editor installed
./scripts/dev-install.sh --dry-run    # show what it would do
./scripts/dev-install.sh --target cursor --bump   # one editor, bump the patch version first
```

The default installs into **both VS Code and Cursor**, and into only the ones the user actually
has: the script resolves each `code` / `cursor` CLI from `PATH` or the macOS app bundle (`PATH`
usually misses in an agent sandbox), prints `skip <editor> (not installed)` for one it cannot
find, and never tries to install into an absent editor. Do not narrow with `--target` unless the
user asks for one editor — installing into both is what keeps whichever window they happen to
have open in sync.

Use `--bump` when the user needs to see the version change to be sure the reload took. If neither
editor resolves, the script exits nonzero and prints the manual route — pass that along
(**Extensions → … → Install from VSIX…**) rather than retrying.

### 6. Hand off and wait

You cannot see the render. End your turn with an explicit test script and stop — do not report the
feature as verified:

> Installed `mesh-viewer-vscode-<version>.vsix` into <the editors the script reported>.
>
> 1. In the editor you are testing in: `Cmd+Shift+P` → **Developer: Reload Window**
> 2. Open `test_data/<repro-asset>` — expect <specific observable>. Before this change it <old behavior>.
> 3. Open `test_data/<control-asset>` — expect no change from before.
> 4. Check the webview devtools console (`Cmd+Shift+P` → **Developer: Open Webview Developer Tools**) for `[3DViewer]` warnings.
>
> Tell me what you see and I will iterate.

If the user reports it still fails, go back to phase 1 with their evidence — new console output,
new asset — rather than trying variations blind.

---

## Hard constraints

- **The webview CSP is strict** (`src/viewerProvider.ts`, the `csp` array): `default-src 'none'`,
  script only via nonce plus `'wasm-unsafe-eval'`, `worker-src blob:`, and no remote origins.
  Runtime code cannot fetch from a CDN. Widening the CSP is a last resort that needs a comment
  explaining the dependent, like the existing `wasm-unsafe-eval` note.
- **Everything the webview loads must be bundled or copied into `out/`.** Two working patterns:
  inline-wasm modules that esbuild swallows into `out/webview.js` (MeshoptDecoder), or a sidecar
  copied by `copyDraco()` in `esbuild.js` and handed over as a webview URI (DRACO). New sidecars
  also need an `!out/...` line in `.vscodeignore`, which is an allowlist.
- **`three` and `@types/three` are pinned to the same exact version.** Bump them together, and
  re-check the loaders after — `examples/jsm` is not a stable API.
- **`test_data/`, `*.vsix`, and every mesh extension are gitignored.** Keep it that way; do not
  commit binary assets.

## Command reference

```bash
npm install
npm run typecheck                 # tsc --noEmit over extension + webview tsconfigs
npm run build                     # esbuild → out/
npm run watch                     # rebuild on change (pair with F5 "Run Extension")
npm run package                   # vsce package --no-dependencies → *.vsix
./scripts/dev-install.sh          # build + package + install locally (see phase 5)
```

`F5` in the editor launches an Extension Development Host from source and is the fastest inner
loop for iterating on the webview; `dev-install.sh` is for handing a real build to the user.
