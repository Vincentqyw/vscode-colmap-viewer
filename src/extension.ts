import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const MODEL_BASES = ['cameras', 'images', 'points3D'] as const;
type ModelExt = '.bin' | '.txt';

interface ModelLocation {
  dir: string;
  ext: ModelExt;
}

function modelExtIn(dir: string): ModelExt | undefined {
  for (const ext of ['.bin', '.txt'] as const) {
    if (MODEL_BASES.every((b) => fs.existsSync(path.join(dir, b + ext)))) return ext;
  }
  return undefined;
}

/**
 * Find a COLMAP model dir starting from `start`: checks the dir itself, then
 * breadth-first into subdirectories (typical layouts: ./, sparse/, sparse/0/).
 */
function findModelDir(start: string): ModelLocation | undefined {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const { dir, depth } = queue.shift()!;
    visited++;
    const ext = modelExtIn(dir);
    if (ext) return { dir, ext };
    if (depth >= 3) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // prioritize conventional COLMAP layout names
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => {
        const rank = (n: string) => (n === 'sparse' ? 0 : /^\d+$/.test(n) ? 1 : 2);
        return rank(a.name) - rank(b.name);
      });
    for (const e of dirs) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
  }
  return undefined;
}

function viewerHtml(webview: vscode.Webview, extensionUri: vscode.Uri, model: ModelLocation): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.css'));
  const fileUri = (base: string) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(model.dir, base + model.ext))).toString();
  const mediaUri = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name)).toString();
  const init = {
    ext: model.ext,
    label: model.dir,
    files: {
      cameras: fileUri('cameras'),
      images: fileUri('images'),
      points: fileUri('points3D'),
    },
    logos: {
      dark: mediaUri('colmap-logo-dark.svg'),
      light: mediaUri('colmap-logo.svg'),
    },
  };
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `script-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>COLMAP Sparse Viewer</title>
</head>
<body>
  <script id="colmap-init" type="application/json">${JSON.stringify(init)}</script>
  <div id="app"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

function configurePanel(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  model: ModelLocation
): void {
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, 'media'),
      vscode.Uri.file(model.dir),
    ],
  };
  panel.webview.html = viewerHtml(panel.webview, context.extensionUri, model);
}

async function openModelCommand(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  let start: string | undefined;
  if (uri?.fsPath) {
    const stat = fs.statSync(uri.fsPath);
    start = stat.isDirectory() ? uri.fsPath : path.dirname(uri.fsPath);
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Visualize COLMAP Model',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    start = picked?.[0]?.fsPath;
  }
  if (!start) return;

  const model = findModelDir(start);
  if (!model) {
    vscode.window.showErrorMessage(
      `No COLMAP sparse model (cameras/images/points3D .bin or .txt) found under: ${start}`
    );
    return;
  }

  const title = `COLMAP: ${path.basename(path.dirname(model.dir))}/${path.basename(model.dir)}`;
  const panel = vscode.window.createWebviewPanel('colmapViewer', title, vscode.ViewColumn.Active, {
    retainContextWhenHidden: true,
  });
  configurePanel(panel, context, model);
}

class ColmapModelEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const dir = path.dirname(document.uri.fsPath);
    const model = findModelDir(dir);
    if (!model) {
      panel.webview.options = { enableScripts: false };
      panel.webview.html = `<html><body><p>Incomplete COLMAP model in ${dir}: needs cameras, images and points3D files.</p></body></html>`;
      return;
    }
    configurePanel(panel, this.context, model);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('colmapViewer.openModel', (uri?: vscode.Uri) =>
      openModelCommand(context, uri)
    ),
    vscode.window.registerCustomEditorProvider(
      'colmapViewer.modelEditor',
      new ColmapModelEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate(): void {}
