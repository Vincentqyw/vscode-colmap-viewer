# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # bundle extension + webview (esbuild.mjs builds both)
npm run watch      # rebuild both bundles on change
npm run package    # create the .vsix (runs vsce package)
npx tsc --noEmit   # type check (CI runs this; esbuild does not check types)
```

Test (a Node smoke test that cross-checks .bin vs .txt parsing against a real model):

```bash
node test/parser.test.mjs examples/sparse/0
```

`test/parser-bundle.mjs` is a checked-in esbuild ESM bundle of `src/colmap/parser.ts` — after editing the parser, regenerate it before running the test:

```bash
npx esbuild src/colmap/parser.ts --bundle --format=esm --outfile=test/parser-bundle.mjs
```

The test hard-codes the expected point count (109489) for the model in `examples/sparse/0`.

## Architecture

VS Code extension that renders COLMAP sparse reconstructions in a webview using Three.js. Two separate bundles, both built by `esbuild.mjs`:

- **Extension host** (`src/extension.ts` → `dist/extension.js`, CJS/node): registers the `colmapViewer.openModel` command and a read-only custom editor for `cameras|images|points3D.bin`. It does **not** parse model files. Its job is model discovery (`findModelDir`: breadth-first search up to 3 levels deep, preferring `sparse/` and numeric subdirs, requiring all three of cameras/images/points3D in the same `.bin` or `.txt` flavor) and webview setup: it injects a JSON `<script id="colmap-init">` block containing `asWebviewUri` URLs for the three model files, and adds the model dir to `localResourceRoots` so the webview can fetch them.

- **Webview** (`webview/main.ts` → `media/webview.js`, browser IIFE, minified): fetches the model files itself via the injected URIs, parses them, and does all rendering (Three.js point cloud, per-camera-model frustum glyphs, trajectory, filters, color modes) plus all UI (HUD/panel DOM is generated in this file; styles in `media/viewer.css`).

- **Parser** (`src/colmap/parser.ts`): environment-agnostic (DataView, no deps) — the same source is imported by the webview bundle and bundled separately for the Node test. Binary layouts follow COLMAP's `read_write_model.py`; the camera-model table (ids 0–17) mirrors `colmap/src/colmap/sensor/models.h` and also accepts legacy param counts for models 11 and 17. If you change the parser's camera-model table, the webview's glyph logic keys off model names/ids too.

## Releasing

Bump `version` in `package.json`, then push a matching `v*` tag. The release workflow fails if tag and package.json version disagree; it builds the .vsix, attaches it to a GitHub Release, and publishes to the Marketplace only when the `VSCE_PAT` secret is set.
