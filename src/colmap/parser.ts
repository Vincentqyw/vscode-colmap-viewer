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

/** model_id -> [name, num_params]; ids 0-10 are standard COLMAP, 11-17 are extensions */
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
  11: ['RAD_TAN_THIN_PRISM_FISHEYE', 14],
  12: ['SIMPLE_DIVISION', 4],
  13: ['DIVISION', 5],
  14: ['SIMPLE_FISHEYE', 3],
  15: ['FISHEYE', 4],
  16: ['EUCM', 6],
  17: ['EQUIRECTANGULAR', 3],
};

const MODEL_NAME_TO_NUM_PARAMS: Record<string, number> = Object.fromEntries(
  Object.values(CAMERA_MODELS).map(([name, n]) => [name, n])
);

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

export function parseCamerasBin(buf: ArrayBuffer): Map<number, ColmapCamera> {
  const r = new Reader(buf);
  const n = r.u64();
  const cameras = new Map<number, ColmapCamera>();
  for (let i = 0; i < n; i++) {
    const id = r.i32();
    const modelId = r.i32();
    const width = r.u64();
    const height = r.u64();
    const entry = CAMERA_MODELS[modelId];
    if (!entry) {
      throw new Error(`Unknown camera model id ${modelId} (camera ${id})`);
    }
    const [model, numParams] = entry;
    const params: number[] = [];
    for (let p = 0; p < numParams; p++) params.push(r.f64());
    cameras.set(id, { id, modelId, model, width, height, params });
  }
  return cameras;
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
    const numParams = MODEL_NAME_TO_NUM_PARAMS[model];
    cameras.set(id, {
      id,
      modelId: -1,
      model,
      width: parseInt(e[2], 10),
      height: parseInt(e[3], 10),
      params: e.slice(4, numParams !== undefined ? 4 + numParams : undefined).map(Number),
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

/** Pinhole-equivalent intrinsics {fx, fy, cx, cy} for frustum drawing. */
export function pinholeIntrinsics(cam: ColmapCamera): { fx: number; fy: number; cx: number; cy: number } {
  const p = cam.params;
  const twoFocal = new Set([
    'PINHOLE', 'OPENCV', 'OPENCV_FISHEYE', 'FULL_OPENCV', 'FOV',
    'THIN_PRISM_FISHEYE', 'RAD_TAN_THIN_PRISM_FISHEYE', 'FISHEYE', 'EUCM',
  ]);
  if (twoFocal.has(cam.model) && p.length >= 4) {
    return { fx: p[0], fy: p[1], cx: p[2], cy: p[3] };
  }
  if (p.length >= 3) {
    return { fx: p[0], fy: p[0], cx: p[1], cy: p[2] };
  }
  // degenerate fallback
  return { fx: Math.max(cam.width, cam.height), fy: Math.max(cam.width, cam.height), cx: cam.width / 2, cy: cam.height / 2 };
}
