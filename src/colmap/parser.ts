/**
 * COLMAP sparse model parser (.bin and .txt), environment-agnostic:
 * works in both Node and the browser (DataView based, no dependencies).
 *
 * Binary layouts follow colmap/scripts/python/read_write_model.py.
 */

export interface ColmapCamera {
  id: number;
  modelId: number;
  model: string;
  width: number;
  height: number;
  params: number[];
}

export interface ColmapImagePose {
  id: number;
  /** [qw, qx, qy, qz] world-to-camera rotation */
  qvec: [number, number, number, number];
  /** [tx, ty, tz] world-to-camera translation */
  tvec: [number, number, number];
  cameraId: number;
  name: string;
  numPoints2D: number;
}

export interface ColmapPointCloud {
  count: number;
  /** xyz interleaved */
  positions: Float32Array;
  /** rgb interleaved, 0-255 */
  colors: Uint8Array;
  /** reprojection error per point */
  errors: Float32Array;
  /** track length per point (clamped to 65535) */
  trackLengths: Uint16Array;
}

/** model_id -> [name, num_params]; matches colmap/src/colmap/sensor/models.h (ids 0-17) */
const CAMERA_MODELS: Record<number, [string, number]> = {
  0: ['SIMPLE_PINHOLE', 3],
  1: ['PINHOLE', 4],
  2: ['SIMPLE_RADIAL', 4],
  3: ['RADIAL', 5],
  4: ['OPENCV', 8],
  5: ['OPENCV_FISHEYE', 8],
  6: ['FULL_OPENCV', 12],
  7: ['FOV', 5],
  8: ['SIMPLE_RADIAL_FISHEYE', 4],
  9: ['RADIAL_FISHEYE', 5],
  10: ['THIN_PRISM_FISHEYE', 12],
  11: ['RAD_TAN_THIN_PRISM_FISHEYE', 16],
  12: ['SIMPLE_DIVISION', 4],
  13: ['DIVISION', 5],
  14: ['SIMPLE_FISHEYE', 3],
  15: ['FISHEYE', 4],
  16: ['EUCM', 6],
  17: ['EQUIRECTANGULAR', 2],
};

/** Older writers used different param counts for two extension models. */
const LEGACY_CAMERA_MODELS: Record<number, [string, number]> = {
  ...CAMERA_MODELS,
  11: ['RAD_TAN_THIN_PRISM_FISHEYE', 14],
  17: ['EQUIRECTANGULAR', 3],
};

class Reader {
  dv: DataView;
  off = 0;
  constructor(buf: ArrayBuffer) {
    this.dv = new DataView(buf);
  }
  i32(): number {
    const v = this.dv.getInt32(this.off, true);
    this.off += 4;
    return v;
  }
  u64(): number {
    const v = Number(this.dv.getBigUint64(this.off, true));
    this.off += 8;
    return v;
  }
  f64(): number {
    const v = this.dv.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }
  u8(): number {
    return this.dv.getUint8(this.off++);
  }
  cstr(): string {
    const bytes: number[] = [];
    for (;;) {
      const c = this.dv.getUint8(this.off++);
      if (c === 0) break;
      bytes.push(c);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  skip(n: number): void {
    this.off += n;
  }
}

function parseCamerasBinWith(
  buf: ArrayBuffer,
  table: Record<number, [string, number]>
): Map<number, ColmapCamera> {
  const r = new Reader(buf);
  const n = r.u64();
  const cameras = new Map<number, ColmapCamera>();
  for (let i = 0; i < n; i++) {
    const id = r.i32();
    const modelId = r.i32();
    const width = r.u64();
    const height = r.u64();
    const entry = table[modelId];
    if (!entry) {
      throw new Error(`Unknown camera model id ${modelId} (camera ${id})`);
    }
    const [model, numParams] = entry;
    const params: number[] = [];
    for (let p = 0; p < numParams; p++) params.push(r.f64());
    cameras.set(id, { id, modelId, model, width, height, params });
  }
  if (r.off !== buf.byteLength) {
    throw new Error(`cameras.bin: ${buf.byteLength - r.off} trailing bytes`);
  }
  return cameras;
}

export function parseCamerasBin(buf: ArrayBuffer): Map<number, ColmapCamera> {
  try {
    return parseCamerasBinWith(buf, CAMERA_MODELS);
  } catch (err) {
    // Older files may use legacy param counts for RAD_TAN_THIN_PRISM_FISHEYE /
    // EQUIRECTANGULAR; a wrong count desyncs the byte layout, so retry.
    try {
      return parseCamerasBinWith(buf, LEGACY_CAMERA_MODELS);
    } catch {
      throw err;
    }
  }
}

export function parseImagesBin(buf: ArrayBuffer): ColmapImagePose[] {
  const r = new Reader(buf);
  const n = r.u64();
  const images: ColmapImagePose[] = [];
  for (let i = 0; i < n; i++) {
    const id = r.i32();
    const qvec: [number, number, number, number] = [r.f64(), r.f64(), r.f64(), r.f64()];
    const tvec: [number, number, number] = [r.f64(), r.f64(), r.f64()];
    const cameraId = r.i32();
    const name = r.cstr();
    const numPoints2D = r.u64();
    r.skip(24 * numPoints2D); // (x: f64, y: f64, point3D_id: i64) per 2D point
    images.push({ id, qvec, tvec, cameraId, name, numPoints2D });
  }
  return images;
}

export function parsePoints3DBin(buf: ArrayBuffer): ColmapPointCloud {
  const r = new Reader(buf);
  const n = r.u64();
  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 3);
  const errors = new Float32Array(n);
  const trackLengths = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    r.skip(8); // point3D_id
    positions[i * 3] = r.f64();
    positions[i * 3 + 1] = r.f64();
    positions[i * 3 + 2] = r.f64();
    colors[i * 3] = r.u8();
    colors[i * 3 + 1] = r.u8();
    colors[i * 3 + 2] = r.u8();
    errors[i] = r.f64();
    const trackLen = r.u64();
    trackLengths[i] = Math.min(trackLen, 65535);
    r.skip(8 * trackLen); // (image_id: i32, point2D_idx: i32) per track element
  }
  return { count: n, positions, colors, errors, trackLengths };
}

export function parseCamerasText(text: string): Map<number, ColmapCamera> {
  const cameras = new Map<number, ColmapCamera>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const e = t.split(/\s+/);
    const id = parseInt(e[0], 10);
    const model = e[1];
    cameras.set(id, {
      id,
      modelId: -1,
      model,
      width: parseInt(e[2], 10),
      height: parseInt(e[3], 10),
      // text lines are self-delimiting; take all columns so legacy param
      // counts (e.g. 3-param EQUIRECTANGULAR) parse too
      params: e.slice(4).map(Number),
    });
  }
  return cameras;
}

export function parseImagesText(text: string): ColmapImagePose[] {
  const images: ColmapImagePose[] = [];
  const lines = text.split('\n');
  let expectPose = true;
  for (const line of lines) {
    const t = line.trim();
    if (expectPose) {
      if (!t || t.startsWith('#')) continue;
      const e = t.split(/\s+/);
      images.push({
        id: parseInt(e[0], 10),
        qvec: [Number(e[1]), Number(e[2]), Number(e[3]), Number(e[4])],
        tvec: [Number(e[5]), Number(e[6]), Number(e[7])],
        cameraId: parseInt(e[8], 10),
        name: e[9] ?? '',
        numPoints2D: 0,
      });
      expectPose = false;
    } else {
      // points2D line (may be empty), skipped
      images[images.length - 1].numPoints2D = t ? Math.floor(t.split(/\s+/).length / 3) : 0;
      expectPose = true;
    }
  }
  return images;
}

export function parsePoints3DText(text: string): ColmapPointCloud {
  const lines = text.split('\n');
  const rows: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('#')) rows.push(t);
  }
  const n = rows.length;
  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 3);
  const errors = new Float32Array(n);
  const trackLengths = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const e = rows[i].split(/\s+/);
    positions[i * 3] = Number(e[1]);
    positions[i * 3 + 1] = Number(e[2]);
    positions[i * 3 + 2] = Number(e[3]);
    colors[i * 3] = Number(e[4]);
    colors[i * 3 + 1] = Number(e[5]);
    colors[i * 3 + 2] = Number(e[6]);
    errors[i] = Number(e[7]);
    trackLengths[i] = Math.min(Math.floor((e.length - 8) / 2), 65535);
  }
  return { count: n, positions, colors, errors, trackLengths };
}

/** Row-major 3x3 rotation matrix from COLMAP [qw,qx,qy,qz] (world-to-camera). */
export function qvecToRotmat(q: [number, number, number, number]): number[] {
  const [w, x, y, z] = q;
  return [
    1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * z * x + 2 * w * y,
    2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x,
    2 * z * x - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y,
  ];
}

/**
 * Camera center and camera-to-world rotation from a COLMAP pose.
 * Returns { center: C = -R^T t, rotCW: R^T (row-major, camera-to-world) }.
 */
export function poseToWorld(img: ColmapImagePose): { center: [number, number, number]; rotCW: number[] } {
  const R = qvecToRotmat(img.qvec);
  const [tx, ty, tz] = img.tvec;
  // R^T (transpose of row-major R)
  const rotCW = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const center: [number, number, number] = [
    -(rotCW[0] * tx + rotCW[1] * ty + rotCW[2] * tz),
    -(rotCW[3] * tx + rotCW[4] * ty + rotCW[5] * tz),
    -(rotCW[6] * tx + rotCW[7] * ty + rotCW[8] * tz),
  ];
  return { center, rotCW };
}

const TWO_FOCAL_MODELS = new Set([
  'PINHOLE', 'OPENCV', 'OPENCV_FISHEYE', 'FULL_OPENCV', 'FOV',
  'THIN_PRISM_FISHEYE', 'RAD_TAN_THIN_PRISM_FISHEYE', 'DIVISION', 'FISHEYE', 'EUCM',
]);

const FISHEYE_MODELS = new Set([
  'OPENCV_FISHEYE', 'SIMPLE_RADIAL_FISHEYE', 'RADIAL_FISHEYE',
  'THIN_PRISM_FISHEYE', 'RAD_TAN_THIN_PRISM_FISHEYE', 'SIMPLE_FISHEYE', 'FISHEYE',
]);

/** Fisheye models: image plane is theta-scaled (equidistant base projection). */
export function isFisheyeModel(cam: ColmapCamera): boolean {
  return FISHEYE_MODELS.has(cam.model);
}

/** Spherical models cover the full sphere (no image plane). */
export function isSphericalModel(cam: ColmapCamera): boolean {
  return cam.model === 'EQUIRECTANGULAR';
}

/** Pinhole-equivalent intrinsics {fx, fy, cx, cy} for frustum drawing. */
export function pinholeIntrinsics(cam: ColmapCamera): { fx: number; fy: number; cx: number; cy: number } {
  const p = cam.params;
  if (cam.model === 'EQUIRECTANGULAR') {
    // no focal length; equivalent focal at the equator is w / 2pi
    return { fx: cam.width / (2 * Math.PI), fy: cam.height / Math.PI, cx: cam.width / 2, cy: cam.height / 2 };
  }
  if (TWO_FOCAL_MODELS.has(cam.model) && p.length >= 4) {
    return { fx: p[0], fy: p[1], cx: p[2], cy: p[3] };
  }
  if (p.length >= 3) {
    return { fx: p[0], fy: p[0], cx: p[1], cy: p[2] };
  }
  // degenerate fallback
  return { fx: Math.max(cam.width, cam.height), fy: Math.max(cam.width, cam.height), cx: cam.width / 2, cy: cam.height / 2 };
}

// ---------------------------------------------------------------------------
// Per-model unprojection (pixel -> unit bearing in camera frame), mirroring
// CamFromImg / CamRayFromImg in colmap/src/colmap/sensor/models.h.
// ---------------------------------------------------------------------------

/** Additive distortion in normalized (or fisheye) coordinates: [du, dv]. */
type DistortFn = (u: number, v: number) => [number, number];

/**
 * Invert `x0 = x + distort(x)` with Newton iteration (numeric Jacobian and the
 * same trust region as COLMAP's IterativeUndistortion).
 */
function newtonUndistort(distort: DistortFn, u0: number, v0: number): [number, number] {
  let u = u0;
  let v = v0;
  for (let it = 0; it < 50; it++) {
    const [du, dv] = distort(u, v);
    const fu = u + du - u0;
    const fv = v + dv - v0;
    const h = 1e-6 * Math.max(1, Math.abs(u), Math.abs(v));
    const [duU, dvU] = distort(u + h, v);
    const [duV, dvV] = distort(u, v + h);
    const j00 = 1 + (duU - du) / h;
    const j01 = (duV - du) / h;
    const j10 = (dvU - dv) / h;
    const j11 = 1 + (dvV - dv) / h;
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-12) break;
    let stepU = (j11 * fu - j01 * fv) / det;
    let stepV = (j00 * fv - j10 * fu) / det;
    const radius = Math.max(0.1 * Math.hypot(u, v), 0.1);
    const stepNorm = Math.hypot(stepU, stepV);
    if (stepNorm > radius) {
      stepU *= radius / stepNorm;
      stepV *= radius / stepNorm;
    }
    u -= stepU;
    v -= stepV;
    if (stepU * stepU + stepV * stepV < 1e-10) break;
  }
  return [u, v];
}

/** Distortion function on the normalized/fisheye plane, or null when none. */
function distortionFor(cam: ColmapCamera): DistortFn | null {
  const p = cam.params;
  switch (cam.model) {
    case 'SIMPLE_RADIAL':
    case 'SIMPLE_RADIAL_FISHEYE': {
      const k = p[3];
      return (u, v) => {
        const radial = k * (u * u + v * v);
        return [u * radial, v * radial];
      };
    }
    case 'RADIAL':
    case 'RADIAL_FISHEYE': {
      const [k1, k2] = [p[3], p[4]];
      return (u, v) => {
        const r2 = u * u + v * v;
        const radial = k1 * r2 + k2 * r2 * r2;
        return [u * radial, v * radial];
      };
    }
    case 'OPENCV': {
      const [k1, k2, p1, p2] = p.slice(4);
      return (u, v) => {
        const u2 = u * u, v2 = v * v, uv = u * v, r2 = u2 + v2;
        const radial = k1 * r2 + k2 * r2 * r2;
        return [
          u * radial + 2 * p1 * uv + p2 * (r2 + 2 * u2),
          v * radial + 2 * p2 * uv + p1 * (r2 + 2 * v2),
        ];
      };
    }
    case 'OPENCV_FISHEYE': {
      const [k1, k2, k3, k4] = p.slice(4);
      return (u, v) => {
        const t2 = u * u + v * v, t4 = t2 * t2;
        const radial = k1 * t2 + k2 * t4 + k3 * t4 * t2 + k4 * t4 * t4;
        return [u * radial, v * radial];
      };
    }
    case 'FULL_OPENCV': {
      const [k1, k2, p1, p2, k3, k4, k5, k6] = p.slice(4);
      return (u, v) => {
        const u2 = u * u, v2 = v * v, uv = u * v, r2 = u2 + v2;
        const r4 = r2 * r2, r6 = r4 * r2;
        const radial = (1 + k1 * r2 + k2 * r4 + k3 * r6) / (1 + k4 * r2 + k5 * r4 + k6 * r6);
        return [
          u * radial + 2 * p1 * uv + p2 * (r2 + 2 * u2) - u,
          v * radial + 2 * p2 * uv + p1 * (r2 + 2 * v2) - v,
        ];
      };
    }
    case 'THIN_PRISM_FISHEYE': {
      const [k1, k2, p1, p2, k3, k4, sx1, sy1] = p.slice(4);
      return (u, v) => {
        const u2 = u * u, v2 = v * v, uv = u * v, r2 = u2 + v2;
        const r4 = r2 * r2, r6 = r4 * r2, r8 = r6 * r2;
        const radial = k1 * r2 + k2 * r4 + k3 * r6 + k4 * r8;
        return [
          u * radial + 2 * p1 * uv + p2 * (r2 + 2 * u2) + sx1 * r2,
          v * radial + 2 * p2 * uv + p1 * (r2 + 2 * v2) + sy1 * r2,
        ];
      };
    }
    case 'RAD_TAN_THIN_PRISM_FISHEYE': {
      const ex = p.slice(4);
      const nRadial = ex.length >= 12 ? 6 : 4; // 16-param (Aria) vs legacy 14-param file
      const [p0, p1, s0, s1, s2, s3] = ex.slice(nRadial);
      return (u, v) => {
        const t2 = u * u + v * v;
        let thRadial = 1;
        let power = 1;
        for (let i = 0; i < nRadial; i++) {
          power *= t2;
          thRadial += ex[i] * power;
        }
        const x = thRadial * u, y = thRadial * v;
        const x2 = x * x, y2 = y * y, xy = x * y, r2 = x2 + y2, r4 = r2 * r2;
        const xd = x + 2 * p1 * xy + p0 * (r2 + 2 * x2) + s0 * r2 + s1 * r4;
        const yd = y + 2 * p0 * xy + p1 * (r2 + 2 * y2) + s2 * r2 + s3 * r4;
        return [xd - u, yd - v];
      };
    }
    default:
      return null;
  }
}

/**
 * Unproject pixel (x, y) to a unit bearing vector [rx, ry, rz] in the camera
 * frame (+z forward, +x right, +y down). Handles all COLMAP camera models;
 * falls back to the pinhole-equivalent linear model if inversion fails.
 */
export function camRayFromImg(cam: ColmapCamera, x: number, y: number): [number, number, number] {
  const p = cam.params;

  if (cam.model === 'EQUIRECTANGULAR') {
    // params carry no projection info (w, h metadata); use image dimensions
    const theta = 2 * Math.PI * (x / cam.width - 0.5);
    const phi = Math.PI * (0.5 - y / cam.height);
    const cosPhi = Math.cos(phi);
    return [cosPhi * Math.sin(theta), -Math.sin(phi), cosPhi * Math.cos(theta)];
  }

  const { fx, fy, cx, cy } = pinholeIntrinsics(cam);
  let u = (x - cx) / fx;
  let v = (y - cy) / fy;

  if (isFisheyeModel(cam)) {
    // (u, v) are theta-scaled fisheye coordinates; undistort there, then lift
    const distort = distortionFor(cam);
    if (distort) [u, v] = newtonUndistort(distort, u, v);
    const theta = Math.min(Math.hypot(u, v), Math.PI);
    if (theta < 1e-9) return [0, 0, 1];
    const sinc = Math.sin(theta) / Math.hypot(u, v);
    return [u * sinc, v * sinc, Math.cos(theta)];
  }

  switch (cam.model) {
    case 'FOV': {
      // analytic undistortion (Devernay-Faugeras)
      const omega = p[4];
      const r2 = u * u + v * v;
      let factor: number;
      if (omega * omega < 1e-4) {
        factor = (omega * omega * r2) / 3 - (omega * omega) / 12 + 1;
      } else if (r2 < 1e-4) {
        factor = (omega * (omega * omega * r2 + 3)) / (6 * Math.tan(omega / 2));
      } else {
        const radius = Math.sqrt(r2);
        factor = Math.tan(radius * omega) / (radius * 2 * Math.tan(omega / 2));
      }
      u *= factor;
      v *= factor;
      break;
    }
    case 'SIMPLE_DIVISION':
    case 'DIVISION': {
      const k = p[p.length - 1];
      const denom = 1 + k * (u * u + v * v);
      if (Math.abs(denom) > 1e-9) {
        u /= denom;
        v /= denom;
      }
      break;
    }
    case 'EUCM': {
      const [alpha, beta] = [p[4], p[5]];
      const r2 = u * u + v * v;
      const gamma = 1 - alpha;
      const radicand = 1 - (alpha - gamma) * beta * r2;
      if (radicand >= 0) {
        const helperDen = alpha * Math.sqrt(radicand) + gamma;
        if (helperDen > 1e-12) {
          const helper = (1 - alpha * alpha * beta * r2) / helperDen;
          if (helper > 1e-12) {
            u /= helper;
            v /= helper;
          }
        }
      }
      break;
    }
    default: {
      const distort = distortionFor(cam);
      if (distort) [u, v] = newtonUndistort(distort, u, v);
    }
  }

  const norm = Math.sqrt(u * u + v * v + 1);
  return [u / norm, v / norm, 1 / norm];
}
