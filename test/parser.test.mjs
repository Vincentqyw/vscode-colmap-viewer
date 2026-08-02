// Node smoke test: parse a real COLMAP model in both .bin and .txt formats
// and cross-check the results. Usage: node test/parser.test.mjs <model_dir>
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseCamerasBin, parseCamerasText,
  parseImagesBin, parseImagesText,
  parsePoints3DBin, parsePoints3DText,
  poseToWorld, pinholeIntrinsics,
} from './parser-bundle.mjs';

const dir = process.argv[2];
const ab = (p) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  if (!cond) {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  } else {
    console.log(`ok   ${name}`);
  }
};
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

// cameras
const camsB = parseCamerasBin(ab(join(dir, 'cameras.bin')));
const camsT = parseCamerasText(readFileSync(join(dir, 'cameras.txt'), 'utf8'));
check('cameras count bin==txt', camsB.size === camsT.size, `${camsB.size} vs ${camsT.size}`);
for (const [id, cb] of camsB) {
  const ct = camsT.get(id);
  if (!ct || cb.model !== ct.model || cb.width !== ct.width || cb.height !== ct.height ||
      cb.params.length !== ct.params.length || !cb.params.every((p, i) => close(p, ct.params[i]))) {
    check(`camera ${id} bin==txt`, false, JSON.stringify({ cb, ct }));
    break;
  }
}
check('cameras field match', true);
const c1 = camsB.get(1);
console.log('  camera 1:', c1.model, c1.width + 'x' + c1.height, 'params:', c1.params.map((p) => p.toFixed(3)).join(' '));
const intr = pinholeIntrinsics(c1);
check('intrinsics fx', close(intr.fx, c1.params[0]));

// images
const imgsB = parseImagesBin(ab(join(dir, 'images.bin')));
const imgsT = parseImagesText(readFileSync(join(dir, 'images.txt'), 'utf8'));
check('images count bin==txt', imgsB.length === imgsT.length, `${imgsB.length} vs ${imgsT.length}`);
const tById = new Map(imgsT.map((i) => [i.id, i]));
let imgMismatch = 0;
for (const ib of imgsB) {
  const it = tById.get(ib.id);
  if (!it || it.name !== ib.name || it.cameraId !== ib.cameraId ||
      !ib.qvec.every((q, i) => close(q, it.qvec[i])) || !ib.tvec.every((t, i) => close(t, it.tvec[i]))) {
    imgMismatch++;
  }
}
check('images pose/name bin==txt', imgMismatch === 0, `${imgMismatch} mismatches`);
console.log('  first image:', imgsB[0].name, 'qvec:', imgsB[0].qvec.map((v) => v.toFixed(4)).join(' '));
const pw = poseToWorld(imgsB[0]);
console.log('  center:', pw.center.map((v) => v.toFixed(4)).join(' '));
// R^T R == I sanity via |C| finite
check('pose center finite', pw.center.every(Number.isFinite));

// points
const ptsB = parsePoints3DBin(ab(join(dir, 'points3D.bin')));
const ptsT = parsePoints3DText(readFileSync(join(dir, 'points3D.txt'), 'utf8'));
check('points count bin==txt', ptsB.count === ptsT.count, `${ptsB.count} vs ${ptsT.count}`);
check('points expected count', ptsB.count === 109489, String(ptsB.count));
// order should match (both written in same iteration order)
let pMismatch = 0;
for (let i = 0; i < ptsB.count; i++) {
  for (let k = 0; k < 3; k++) {
    if (!close(ptsB.positions[i * 3 + k], ptsT.positions[i * 3 + k], 1e-5)) pMismatch++;
    if (ptsB.colors[i * 3 + k] !== ptsT.colors[i * 3 + k]) pMismatch++;
  }
  if (!close(ptsB.errors[i], ptsT.errors[i], 1e-5)) pMismatch++;
  if (ptsB.trackLengths[i] !== ptsT.trackLengths[i]) pMismatch++;
}
check('points data bin==txt', pMismatch === 0, `${pMismatch} mismatches`);
console.log('  point[0]:', [...ptsB.positions.slice(0, 3)].map((v) => v.toFixed(4)).join(' '),
  'rgb:', [...ptsB.colors.slice(0, 3)].join(','), 'err:', ptsB.errors[0].toFixed(4), 'track:', ptsB.trackLengths[0]);

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
