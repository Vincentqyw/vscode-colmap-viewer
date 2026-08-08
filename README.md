# COLMAP Sparse Viewer

Visualize COLMAP sparse reconstructions directly inside VS Code, powered by Three.js.

![Viewer UI](assets/ui.webp)

## Features

- Reads standard COLMAP sparse models: `cameras` / `images` / `points3D` in **`.bin`** or **`.txt`** format
- Renders the sparse point cloud with true RGB colors, plus reprojection-error and height color modes
- Draws every registered image with model-aware camera geometry, using the true per-model unprojection (including lens distortion): pinhole-family models get the classic frustum, fisheye models a curved-border frustum that stays correct beyond 180° FOV, and equirectangular panoramas a wireframe sphere; size, line width and color are all adjustable
- Optional camera trajectory polyline (ordered by image name)
- Filters: max reprojection error, min track length
- Click a camera to inspect image name / camera model / position; double-click the cloud to re-center the orbit pivot
- Handles all COLMAP camera models (IDs 0–17: standard models plus division, fisheye, EUCM and equirectangular extensions), and reads models written by both current COLMAP (16-param `RAD_TAN_THIN_PRISM_FISHEYE`, 2-param `EQUIRECTANGULAR`) and older writers (legacy 14-/3-param variants)

## Install

- From the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vincentqyw.colmap-sparse-viewer), or
- Download the `.vsix` from [GitHub Releases](https://github.com/Vincentqyw/vscode-colmap-viewer/releases) and run `code --install-extension colmap-sparse-viewer-<version>.vsix`

## Usage

- **Double-click** any `cameras.bin`, `images.bin`, or `points3D.bin` in the Explorer, or
- **Right-click a folder** (e.g. `sparse/0`, or any ancestor — the model is auto-discovered up to 3 levels deep) → *COLMAP: Visualize Sparse Model*, or
- Run **`COLMAP: Visualize Sparse Model`** from the command palette and pick a folder.

https://github.com/user-attachments/assets/66d9f7dc-7e90-4e09-b429-33982b24714a

## Sample data

Two sample reconstructions are attached to the [v0.1.6 release](https://github.com/Vincentqyw/vscode-colmap-viewer/releases/tag/v0.1.6) for quick testing:

- [`sparse_garden.zip`](https://github.com/Vincentqyw/vscode-colmap-viewer/releases/download/v0.1.6/sparse_garden.zip) — model in both `.bin` and `.txt` flavors
- [`sparse_store.zip`](https://github.com/Vincentqyw/vscode-colmap-viewer/releases/download/v0.1.6/sparse_store.zip) — binary-only model written by a newer COLMAP (also contains `rigs.bin` / `frames.bin`)

Unzip one, open the folder in VS Code, then right-click it → *COLMAP: Visualize Sparse Model*.

## Controls

| Action | Effect |
|---|---|
| Left drag | Orbit |
| Right drag | Pan |
| Scroll | Zoom |
| Click frustum | Show image info |
| Double-click cloud | Set orbit pivot |

## Development

```bash
git clone https://github.com/Vincentqyw/vscode-colmap-viewer.git
cd vscode-colmap-viewer
npm install
npm run build      # bundle extension + webview
npm run package    # create .vsix
```

Install the generated `.vsix` with `code --install-extension colmap-sparse-viewer-<version>.vsix`.


## License

MIT © [Vincent Qin](https://github.com/Vincentqyw)
