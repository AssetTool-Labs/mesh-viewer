---
name: mesh-viewer-feature
description: Run the mesh-viewer feature/bugfix loop — analyze, download test meshes, plan, implement, rebuild, install the local build into VS Code or Cursor, then hand off to the user to verify. Use when implementing a feature, adding 3D format support, or fixing a rendering/loading bug in this repo. Also the default workflow for any code change here, so follow it even when invoked implicitly.
---

# mesh-viewer feature loop

The workflow is the repo rule in `AGENTS.md` — it is the single source of truth, shared with
Codex and Cursor. Read it now (`Read AGENTS.md`) and execute the six phases in order:

1. **Analyze** — locate the owning module, name the root cause.
2. **Test data** — fetch a repro asset plus a control asset into `test_data/`, and confirm the
   repro actually exercises the code path.
3. **Plan** — write a dedicated plan and get approval via `ExitPlanMode` before editing.
4. **Implement + rebuild** — `npm run typecheck && npm run build`, both clean.
5. **Install** — `./scripts/dev-install.sh` into the editor that already has the extension.
6. **Hand off** — give the user a numbered test script and stop. You cannot see the viewport, so
   do not report a visual result as verified.

If the user reports a failure, re-enter at phase 1 with their evidence instead of guessing.
