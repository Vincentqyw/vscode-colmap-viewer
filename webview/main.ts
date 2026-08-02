import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  ColmapCamera,
  ColmapImagePose,
  ColmapPointCloud,
  parseCamerasBin,
  parseCamerasText,
  parseImagesBin,
  parseImagesText,
  parsePoints3DBin,
  parsePoints3DText,
  pinholeIntrinsics,
  poseToWorld,
} from '../src/colmap/parser';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

interface InitData {
  ext: '.bin' | '.txt';
  label: string;
  files: { cameras: string; images: string; points: string };
  logos?: { dark: string; light: string };
}

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => undefined };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface FrustumInfo {
  image: ColmapImagePose;
  center: THREE.Vector3;
  vertexStart: number; // first vertex index in the frustum LineSegments geometry
}

const state = {
  cameras: new Map<number, ColmapCamera>(),
  images: [] as ColmapImagePose[],
  points: null as ColmapPointCloud | null,
  errP95: 1,
  errMax: 1,
  trackMax: 2,
  sceneCenter: new THREE.Vector3(),
  sceneRadius: 1,
  // UI-controlled
  pointSize: 2,
  frustumScale: 0.15, // relative to sceneRadius
  frustumWidth: 1.5, // line width in px
  frustumColor: '#e74c3c',
  colorMode: 'rgb' as 'rgb' | 'error' | 'height',
  maxError: Infinity,
  minTrack: 2,
  flipped: true,
  visiblePoints: 0,
  selected: -1 as number,
};

// ---------------------------------------------------------------------------
// DOM / UI
// ---------------------------------------------------------------------------

const app = document.getElementById('app')!;
app.innerHTML = `
  <canvas id="c"></canvas>
  <div id="hud">
    <div id="hud-header">
      <img id="hud-logo" class="hidden" alt="">
      <div id="hud-title">COLMAP Sparse Viewer</div>
    </div>
    <div id="hud-path" title=""></div>
    <div id="stats"></div>
    <div class="row checks">
      <label><input type="checkbox" id="chk-points" checked> Points</label>
      <label><input type="checkbox" id="chk-cams" checked> Cameras</label>
      <label><input type="checkbox" id="chk-path"> Path</label>
      <label><input type="checkbox" id="chk-axes"> Axes</label>
    </div>
    <div class="row"><span class="lbl">Point size</span><input type="range" id="sl-psize" min="0.5" max="8" step="0.5" value="2"><span class="val" id="v-psize">2</span></div>
    <div class="row"><span class="lbl">Cam size</span><input type="range" id="sl-fsize" min="1" max="100" step="1" value="15"><span class="val" id="v-fsize"></span></div>
    <div class="row"><span class="lbl">Cam style</span><input type="range" id="sl-fwidth" min="1" max="6" step="0.5" value="1.5" title="Frustum line width"><input type="color" id="cl-frustum" value="#e74c3c" title="Frustum color"></div>
    <div class="row"><span class="lbl">Color</span>
      <select id="sel-color">
        <option value="rgb" selected>RGB</option>
        <option value="error">Reprojection error</option>
        <option value="height">Height</option>
      </select>
    </div>
    <div class="row"><span class="lbl">Error ≤</span><input type="range" id="sl-err" min="0" max="100" step="1" value="100"><span class="val" id="v-err">∞</span></div>
    <div class="row"><span class="lbl">Track ≥</span><input type="range" id="sl-track" min="2" max="20" step="1" value="2"><span class="val" id="v-track">2</span></div>
    <div class="row btns">
      <button id="btn-reset">Reset view</button>
      <button id="btn-flip">Flip up axis</button>
    </div>
  </div>
  <div id="info" class="hidden"></div>
  <div id="help">Left-drag rotate · Right-drag pan · Scroll zoom · Double-click cloud to set pivot · Click camera for info</div>
  <div id="loading"><div class="spinner"></div><div id="loading-text">Loading model…</div></div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('c');
const loadingEl = $('loading');
const loadingText = $('loading-text');
const infoEl = $('info');
const statsEl = $('stats');

function setLoading(text: string | null): void {
  if (text === null) loadingEl.classList.add('hidden');
  else {
    loadingEl.classList.remove('hidden');
    loadingText.textContent = text;
  }
}

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
const scene = new THREE.Scene();
scene.background = new THREE.Color(bg);

const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;

/** Root group; rotated by PI around X so COLMAP's y-down world appears upright. */
const root = new THREE.Group();
root.rotation.x = Math.PI;
scene.add(root);

let pointsObj: THREE.Points | null = null;
let frustumObj: LineSegments2 | null = null;
let centersObj: THREE.Points | null = null;
let pathObj: THREE.Line | null = null;
let axesObj: THREE.AxesHelper | null = null;
let highlightObj: LineSegments2 | null = null;
let frustumInfos: FrustumInfo[] = [];

const SELECT_COLOR = new THREE.Color('#ffd744');

/** Shared fat-line materials; linewidth is in pixels, resolution updated on resize. */
const frustumMat = new LineMaterial({
  color: new THREE.Color(state.frustumColor).getHex(),
  linewidth: state.frustumWidth,
  transparent: true,
  opacity: 0.9,
});
const highlightMat = new LineMaterial({
  color: SELECT_COLOR.getHex(),
  linewidth: state.frustumWidth + 1.5,
});

function disposeObj(obj: THREE.Object3D | null): void {
  if (!obj) return;
  root.remove(obj);
  const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material };
  anyObj.geometry?.dispose();
  // frustum/highlight materials are shared and reused across rebuilds
  if (anyObj.material && anyObj.material !== frustumMat && anyObj.material !== highlightMat) {
    anyObj.material.dispose();
  }
}

// --- colormap (approximate turbo) ---------------------------------------------------

const TURBO_STOPS: [number, number, number][] = [
  [48, 18, 59], [70, 107, 227], [40, 191, 220], [122, 231, 90],
  [239, 204, 34], [240, 88, 20], [122, 4, 3],
];

function turbo(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (TURBO_STOPS.length - 1);
  const i = Math.min(TURBO_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = TURBO_STOPS[i];
  const b = TURBO_STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function percentile(sorted: Float32Array | number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// --- point cloud ---------------------------------------------------------------------

function rebuildPointCloud(): void {
  const pts = state.points;
  if (!pts) return;
  const { positions, colors, errors, trackLengths, count } = pts;

  // filter
  const idx: number[] = [];
  for (let i = 0; i < count; i++) {
    if (errors[i] <= state.maxError && trackLengths[i] >= state.minTrack) idx.push(i);
  }
  state.visiblePoints = idx.length;

  const pos = new Float32Array(idx.length * 3);
  const col = new Float32Array(idx.length * 3);

  // height range for height mode (world-up = -y when flipped)
  let yMin = Infinity;
  let yMax = -Infinity;
  if (state.colorMode === 'height') {
    for (const i of idx) {
      const y = positions[i * 3 + 1];
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  const ySpan = yMax - yMin || 1;

  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    pos[k * 3] = positions[i * 3];
    pos[k * 3 + 1] = positions[i * 3 + 1];
    pos[k * 3 + 2] = positions[i * 3 + 2];
    if (state.colorMode === 'rgb') {
      col[k * 3] = colors[i * 3] / 255;
      col[k * 3 + 1] = colors[i * 3 + 1] / 255;
      col[k * 3 + 2] = colors[i * 3 + 2] / 255;
    } else if (state.colorMode === 'error') {
      const [r, g, b] = turbo(errors[i] / (state.errP95 || 1));
      col[k * 3] = r / 255;
      col[k * 3 + 1] = g / 255;
      col[k * 3 + 2] = b / 255;
    } else {
      let t = (positions[i * 3 + 1] - yMin) / ySpan;
      if (state.flipped) t = 1 - t;
      const [r, g, b] = turbo(t);
      col[k * 3] = r / 255;
      col[k * 3 + 1] = g / 255;
      col[k * 3 + 2] = b / 255;
    }
  }

  const wasVisible = pointsObj ? pointsObj.visible : true;
  disposeObj(pointsObj);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: state.pointSize, vertexColors: true, sizeAttenuation: false });
  pointsObj = new THREE.Points(geo, mat);
  pointsObj.frustumCulled = false;
  pointsObj.visible = wasVisible;
  root.add(pointsObj);
  updateStats();
}

// --- frustums ------------------------------------------------------------------------

/** 10 segments per camera: 4 apex->corner, 4 image-rect edges, 2 up-indicator. */
function frustumSegments(img: ColmapImagePose, cam: ColmapCamera | undefined, depth: number): THREE.Vector3[] {
  const { center, rotCW } = poseToWorld(img);
  const C = new THREE.Vector3(...center);
  const w = cam?.width ?? 1000;
  const h = cam?.height ?? 750;
  const { fx, fy, cx, cy } = cam
    ? pinholeIntrinsics(cam)
    : { fx: 1000, fy: 1000, cx: 500, cy: 375 };

  const toWorld = (px: number, py: number): THREE.Vector3 => {
    const xc = ((px - cx) / fx) * depth;
    const yc = ((py - cy) / fy) * depth;
    const zc = depth;
    return new THREE.Vector3(
      rotCW[0] * xc + rotCW[1] * yc + rotCW[2] * zc + C.x,
      rotCW[3] * xc + rotCW[4] * yc + rotCW[5] * zc + C.y,
      rotCW[6] * xc + rotCW[7] * yc + rotCW[8] * zc + C.z
    );
  };

  const c0 = toWorld(0, 0); // top-left
  const c1 = toWorld(w, 0); // top-right
  const c2 = toWorld(w, h); // bottom-right
  const c3 = toWorld(0, h); // bottom-left
  const peak = toWorld(w / 2, -0.3 * h); // "up" indicator above top edge

  return [
    C, c0, C, c1, C, c2, C, c3,
    c0, c1, c1, c2, c2, c3, c3, c0,
    peak, c0, peak, c1,
  ];
}

function rebuildFrustums(): void {
  const wasVisibleF = frustumObj ? frustumObj.visible : true;
  disposeObj(frustumObj);
  disposeObj(centersObj);
  disposeObj(pathObj);
  frustumObj = null;
  centersObj = null;
  pathObj = null;
  frustumInfos = [];
  clearSelection();
  if (state.images.length === 0) return;

  const depth = state.sceneRadius * state.frustumScale;
  const verts: number[] = [];
  const centerArr = new Float32Array(state.images.length * 3);

  for (let i = 0; i < state.images.length; i++) {
    const img = state.images[i];
    const cam = state.cameras.get(img.cameraId);
    const segPts = frustumSegments(img, cam, depth);
    const info: FrustumInfo = {
      image: img,
      center: segPts[0].clone(),
      vertexStart: verts.length / 3,
    };
    frustumInfos.push(info);
    for (const p of segPts) verts.push(p.x, p.y, p.z);
    centerArr[i * 3] = segPts[0].x;
    centerArr[i * 3 + 1] = segPts[0].y;
    centerArr[i * 3 + 2] = segPts[0].z;
  }

  const geo = new LineSegmentsGeometry();
  geo.setPositions(verts);
  frustumObj = new LineSegments2(geo, frustumMat);
  frustumObj.frustumCulled = false;
  frustumObj.visible = wasVisibleF;
  root.add(frustumObj);

  // pickable camera centers (invisible but raycastable when frustums visible)
  const cgeo = new THREE.BufferGeometry();
  cgeo.setAttribute('position', new THREE.BufferAttribute(centerArr, 3));
  const cmat = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, transparent: true, opacity: 0.001, depthWrite: false });
  centersObj = new THREE.Points(cgeo, cmat);
  centersObj.frustumCulled = false;
  root.add(centersObj);

  // camera path in image-name order
  const order = [...frustumInfos].sort((a, b) =>
    a.image.name.localeCompare(b.image.name, undefined, { numeric: true })
  );
  const pgeo = new THREE.BufferGeometry().setFromPoints(order.map((o) => o.center));
  pathObj = new THREE.Line(pgeo, new THREE.LineBasicMaterial({ color: '#3fd2c7' }));
  pathObj.frustumCulled = false;
  pathObj.visible = $<HTMLInputElement>('chk-path').checked;
  root.add(pathObj);
}

// --- selection -----------------------------------------------------------------------

function clearSelection(): void {
  state.selected = -1;
  disposeObj(highlightObj);
  highlightObj = null;
  infoEl.classList.add('hidden');
}

function selectCamera(index: number): void {
  clearSelection();
  state.selected = index;
  const info = frustumInfos[index];
  if (!info) return;
  const cam = state.cameras.get(info.image.cameraId);
  const depth = state.sceneRadius * state.frustumScale;
  const segPts = frustumSegments(info.image, cam, depth * 1.02);
  const verts: number[] = [];
  for (const p of segPts) verts.push(p.x, p.y, p.z);
  const geo = new LineSegmentsGeometry();
  geo.setPositions(verts);
  highlightObj = new LineSegments2(geo, highlightMat);
  highlightObj.frustumCulled = false;
  root.add(highlightObj);

  const img = info.image;
  const c = info.center;
  infoEl.innerHTML = `
    <div class="info-name">${escapeHtml(img.name)}</div>
    <div>image_id: ${img.id} · camera_id: ${img.cameraId}${cam ? ` (${cam.model} ${cam.width}×${cam.height})` : ''}</div>
    <div>center: [${c.x.toFixed(3)}, ${c.y.toFixed(3)}, ${c.z.toFixed(3)}]</div>
    ${img.numPoints2D ? `<div>observations: ${img.numPoints2D}</div>` : ''}
    <div class="info-close">Click empty space to close</div>`;
  infoEl.classList.remove('hidden');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

// --- framing -------------------------------------------------------------------------

function computeFraming(): void {
  const pts = state.points;
  const samples: number[] = [];
  if (pts && pts.count > 0) {
    const stride = Math.max(1, Math.floor(pts.count / 50000));
    for (let i = 0; i < pts.count; i += stride) {
      samples.push(pts.positions[i * 3], pts.positions[i * 3 + 1], pts.positions[i * 3 + 2]);
    }
  } else {
    for (const img of state.images) {
      const { center } = poseToWorld(img);
      samples.push(center[0], center[1], center[2]);
    }
  }
  const n = samples.length / 3;
  if (n === 0) return;

  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const zs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = samples[i * 3];
    ys[i] = samples[i * 3 + 1];
    zs[i] = samples[i * 3 + 2];
  }
  xs.sort();
  ys.sort();
  zs.sort();
  const med = new THREE.Vector3(percentile(xs, 50), percentile(ys, 50), percentile(zs, 50));

  const dists = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dx = samples[i * 3] - med.x;
    const dy = samples[i * 3 + 1] - med.y;
    const dz = samples[i * 3 + 2] - med.z;
    dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  dists.sort();
  state.sceneCenter.copy(med);
  state.sceneRadius = Math.max(percentile(dists, 92) * 1.2, 1e-6);
}

function resetView(): void {
  // scene center in world coords (root may be flipped)
  const target = state.sceneCenter.clone().applyMatrix4(new THREE.Matrix4().makeRotationX(root.rotation.x));
  const r = state.sceneRadius;
  camera.near = Math.max(r / 1000, 1e-5);
  camera.far = r * 200;
  camera.position.copy(target).add(new THREE.Vector3(r * 0.9, r * 0.7, r * 1.4));
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.update();
}

// --- stats / UI wiring ---------------------------------------------------------------

function updateStats(): void {
  const total = state.points?.count ?? 0;
  statsEl.textContent =
    `Points: ${state.visiblePoints.toLocaleString()} / ${total.toLocaleString()}` +
    `  ·  Images: ${state.images.length.toLocaleString()}  ·  Cams: ${state.cameras.size}`;
}

function wireUi(): void {
  $<HTMLInputElement>('chk-points').addEventListener('change', (e) => {
    if (pointsObj) pointsObj.visible = (e.target as HTMLInputElement).checked;
  });
  $<HTMLInputElement>('chk-cams').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (frustumObj) frustumObj.visible = on;
    if (!on) clearSelection();
  });
  $<HTMLInputElement>('chk-path').addEventListener('change', (e) => {
    if (pathObj) pathObj.visible = (e.target as HTMLInputElement).checked;
  });
  $<HTMLInputElement>('chk-axes').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (on && !axesObj) {
      axesObj = new THREE.AxesHelper(state.sceneRadius * 0.5);
      root.add(axesObj);
    }
    if (axesObj) axesObj.visible = on;
  });

  $<HTMLInputElement>('sl-psize').addEventListener('input', (e) => {
    state.pointSize = Number((e.target as HTMLInputElement).value);
    $('v-psize').textContent = String(state.pointSize);
    if (pointsObj) (pointsObj.material as THREE.PointsMaterial).size = state.pointSize;
  });

  let fsizeTimer: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>('sl-fsize').addEventListener('input', (e) => {
    state.frustumScale = Number((e.target as HTMLInputElement).value) / 100;
    clearTimeout(fsizeTimer);
    fsizeTimer = setTimeout(rebuildFrustums, 60);
  });

  $<HTMLInputElement>('sl-fwidth').addEventListener('input', (e) => {
    state.frustumWidth = Number((e.target as HTMLInputElement).value);
    frustumMat.linewidth = state.frustumWidth;
    highlightMat.linewidth = state.frustumWidth + 1.5;
  });

  $<HTMLInputElement>('cl-frustum').addEventListener('input', (e) => {
    state.frustumColor = (e.target as HTMLInputElement).value;
    frustumMat.color.set(state.frustumColor);
  });

  $<HTMLSelectElement>('sel-color').addEventListener('change', (e) => {
    state.colorMode = (e.target as HTMLSelectElement).value as typeof state.colorMode;
    rebuildPointCloud();
  });

  let errTimer: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>('sl-err').addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (v >= 100) {
      state.maxError = Infinity;
      $('v-err').textContent = '∞';
    } else {
      // slider maps quadratically onto [0, errMax] for finer control at low errors
      state.maxError = ((v / 100) ** 2) * state.errMax;
      $('v-err').textContent = state.maxError.toFixed(2);
    }
    clearTimeout(errTimer);
    errTimer = setTimeout(rebuildPointCloud, 60);
  });

  let trackTimer: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>('sl-track').addEventListener('input', (e) => {
    state.minTrack = Number((e.target as HTMLInputElement).value);
    $('v-track').textContent = String(state.minTrack);
    clearTimeout(trackTimer);
    trackTimer = setTimeout(rebuildPointCloud, 60);
  });

  $('btn-reset').addEventListener('click', resetView);
  $('btn-flip').addEventListener('click', () => {
    state.flipped = !state.flipped;
    root.rotation.x = state.flipped ? Math.PI : 0;
    if (state.colorMode === 'height') rebuildPointCloud();
    resetView();
  });
}

// --- picking -------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let downPos: [number, number] | null = null;

canvas.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
});

canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 4 || e.button !== 0) return; // it was a drag / not left click

  mouse.x = (e.clientX / canvas.clientWidth) * 2 - 1;
  mouse.y = -(e.clientY / canvas.clientHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  raycaster.params.Points.threshold = state.sceneRadius * 0.012;

  if (centersObj && frustumObj?.visible) {
    const hits = raycaster.intersectObject(centersObj, false);
    if (hits.length > 0 && hits[0].index !== undefined) {
      selectCamera(hits[0].index);
      return;
    }
  }
  clearSelection();
});

canvas.addEventListener('dblclick', (e) => {
  if (!pointsObj) return;
  mouse.x = (e.clientX / canvas.clientWidth) * 2 - 1;
  mouse.y = -(e.clientY / canvas.clientHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  raycaster.params.Points.threshold = state.sceneRadius * 0.008;
  const hits = raycaster.intersectObject(pointsObj, false);
  if (hits.length > 0) {
    controls.target.copy(hits[0].point);
    controls.update();
  }
});

// ---------------------------------------------------------------------------
// Resize + render loop
// ---------------------------------------------------------------------------

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  frustumMat.resolution.set(w, h);
  highlightMat.resolution.set(w, h);
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(): Promise<void> {
  const initEl = document.getElementById('colmap-init');
  if (!initEl?.textContent) {
    setLoading('Missing init data');
    return;
  }
  const init: InitData = JSON.parse(initEl.textContent);
  $('hud-path').textContent = init.label;
  $('hud-path').title = init.label;
  if (init.logos) {
    const logo = $<HTMLImageElement>('hud-logo');
    const pickLogo = () => {
      const light = document.body.classList.contains('vscode-light');
      logo.src = light ? init.logos!.light : init.logos!.dark;
    };
    pickLogo();
    logo.classList.remove('hidden');
    new MutationObserver(pickLogo).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  try {
    setLoading('Fetching model files…');
    const isBin = init.ext === '.bin';
    const fetchOne = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
      return isBin ? res.arrayBuffer() : res.text();
    };
    const [camsRaw, imgsRaw, ptsRaw] = await Promise.all([
      fetchOne(init.files.cameras),
      fetchOne(init.files.images),
      fetchOne(init.files.points),
    ]);

    setLoading('Parsing cameras…');
    state.cameras = isBin
      ? parseCamerasBin(camsRaw as ArrayBuffer)
      : parseCamerasText(camsRaw as string);

    setLoading('Parsing images…');
    state.images = isBin
      ? parseImagesBin(imgsRaw as ArrayBuffer)
      : parseImagesText(imgsRaw as string);

    setLoading('Parsing points3D…');
    state.points = isBin
      ? parsePoints3DBin(ptsRaw as ArrayBuffer)
      : parsePoints3DText(ptsRaw as string);

    setLoading('Building scene…');
    const errsSorted = Float32Array.from(state.points.errors).sort();
    state.errP95 = percentile(errsSorted, 95) || 1;
    state.errMax = percentile(errsSorted, 100) || 1;
    let tmax = 2;
    for (let i = 0; i < state.points.count; i++) {
      if (state.points.trackLengths[i] > tmax) tmax = state.points.trackLengths[i];
    }
    state.trackMax = tmax;
    $<HTMLInputElement>('sl-track').max = String(Math.min(tmax, 30));

    computeFraming();
    rebuildPointCloud();
    rebuildFrustums();
    resetView();
    setLoading(null);
    vscode.postMessage({ type: 'loaded', points: state.points.count, images: state.images.length });
  } catch (err) {
    setLoading(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    vscode.postMessage({ type: 'error', message: String(err) });
  }
}

wireUi();
void load();
