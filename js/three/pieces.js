// Procedural Staunton-style chess pieces (no external model files).
// Every piece stands on y = 0, centred on the origin. One square = 1 unit.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const RADIAL = 64;

// A lathe profile made of "runs". Inside a run the outline is smoothed with a
// centripetal Catmull-Rom spline; between runs we get a crisp edge.
function latheRuns(runs, radial = RADIAL) {
  const out = [];
  for (const ctrl of runs) {
    let pts;
    if (ctrl.length === 2) {
      pts = ctrl.map(([x, y]) => new THREE.Vector2(x, y));
    } else {
      const curve = new THREE.CatmullRomCurve3(
        ctrl.map(([x, y]) => new THREE.Vector3(x, y, 0)), false, 'centripetal');
      const n = (ctrl.length - 1) * 7;
      pts = curve.getPoints(n).map((v) => new THREE.Vector2(Math.max(0, v.x), v.y));
    }
    // drop consecutive duplicates (zero-length segments break lathe normals)
    const clean = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].distanceToSquared(clean[clean.length - 1]) > 1e-10) clean.push(pts[i]);
    }
    if (clean.length >= 2) out.push(new THREE.LatheGeometry(clean, radial));
  }
  return out;
}

// arc sampled as control points (angles in degrees)
function arcPts(cx, cy, r, a0, a1, n = 8) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = THREE.MathUtils.degToRad(a0 + ((a1 - a0) * i) / n);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// Shared turned base (plinth + bead + flowing into the body)
function baseRun(R, h = 1) {
  return [
    [R, 0], [R, 0.042 * h], [R * 0.975, 0.058 * h], [R * 0.9, 0.066 * h],
    [R * 0.855, 0.078 * h], [R * 0.875, 0.094 * h], [R * 0.845, 0.108 * h],
    [R * 0.74, 0.122 * h],
  ];
}

function finalize(geoms) {
  const list = geoms.map((g) => {
    let gg = g;
    if (gg.index) gg = gg.toNonIndexed();
    // keep only shared attributes
    for (const name of Object.keys(gg.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) gg.deleteAttribute(name);
    }
    return gg;
  });
  let merged = mergeGeometries(list, false);
  merged = mergeVertices(merged, 1e-5);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function pawn() {
  const R = 0.255;
  return latheRuns([
    [[0, 0], [R, 0]],
    [...baseRun(R), [0.13, 0.15], [0.105, 0.2], [0.09, 0.27], [0.088, 0.3]],
    [[0.088, 0.3], [0.142, 0.31], [0.156, 0.322], [0.143, 0.334], [0.084, 0.343]],
    [[0.084, 0.343], ...arcPts(0, 0.44, 0.118, -52, 90, 10)],
  ]);
}

function rook() {
  const R = 0.29;
  const geoms = latheRuns([
    [[0, 0], [R, 0]],
    [...baseRun(R), [0.195, 0.155], [0.172, 0.24], [0.164, 0.36], [0.17, 0.43]],
    [[0.17, 0.43], [0.198, 0.455], [0.222, 0.47], [0.227, 0.481], [0.212, 0.49]],
    [[0.212, 0.49], [0.216, 0.5], [0.219, 0.585]],
    [[0.219, 0.585], [0.142, 0.585]],
    [[0.142, 0.585], [0.142, 0.555]],
    [[0.142, 0.555], [0, 0.555]],
  ]);
  // crenellations: annular sectors extruded upward
  const count = 6, span = 36, inner = 0.15, outer = 0.21, h = 0.07, bev = 0.008;
  for (let i = 0; i < count; i++) {
    const a0 = THREE.MathUtils.degToRad(i * (360 / count) + 6);
    const a1 = a0 + THREE.MathUtils.degToRad(span);
    const s = new THREE.Shape();
    s.moveTo(Math.cos(a0) * inner, Math.sin(a0) * inner);
    s.absarc(0, 0, inner, a0, a1, false);
    s.lineTo(Math.cos(a1) * outer, Math.sin(a1) * outer);
    s.absarc(0, 0, outer, a1, a0, true);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, {
      depth: h - bev * 2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev,
      bevelSegments: 2, curveSegments: 10,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.585 + bev - 0.004, 0);
    geoms.push(g);
  }
  return geoms;
}

function knight() {
  const R = 0.29;
  const geoms = latheRuns([
    [[0, 0], [R, 0]],
    [...baseRun(R), [0.205, 0.145], [0.2, 0.158]],
    [[0.2, 0.158], [0.208, 0.168], [0.196, 0.178], [0.16, 0.182], [0, 0.182]],
  ]);
  // horse head silhouette, snout towards +x
  const s = new THREE.Shape();
  s.moveTo(-0.19, 0.0);
  s.bezierCurveTo(-0.235, 0.12, -0.235, 0.27, -0.18, 0.4);
  s.bezierCurveTo(-0.14, 0.5, -0.09, 0.58, -0.035, 0.632);
  s.lineTo(-0.012, 0.664);
  s.quadraticCurveTo(0.004, 0.708, 0.028, 0.728);
  s.quadraticCurveTo(0.05, 0.684, 0.074, 0.648);
  s.bezierCurveTo(0.14, 0.6, 0.21, 0.52, 0.255, 0.43);
  s.bezierCurveTo(0.275, 0.39, 0.3, 0.355, 0.305, 0.322);
  s.bezierCurveTo(0.31, 0.29, 0.292, 0.27, 0.262, 0.266);
  s.lineTo(0.218, 0.27);
  s.bezierCurveTo(0.19, 0.25, 0.15, 0.246, 0.122, 0.266);
  s.bezierCurveTo(0.092, 0.285, 0.07, 0.27, 0.076, 0.232);
  s.bezierCurveTo(0.086, 0.16, 0.15, 0.1, 0.178, 0.0);
  s.lineTo(-0.19, 0.0);
  const depth = 0.15, bev = 0.042;
  const head = new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: true, bevelThickness: bev, bevelSize: 0.03,
    bevelSegments: 5, curveSegments: 18,
  });
  head.translate(0, 0, -depth / 2);
  head.translate(0, 0.13, 0);
  geoms.push(head);
  // eyes (tiny bumps on both sides)
  for (const z of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.02, 12, 8);
    eye.scale(1.2, 0.9, 0.6);
    eye.translate(0.15, 0.13 + 0.515, z * (depth / 2 + bev - 0.006));
    geoms.push(eye);
  }
  // mane ridge
  const mane = new THREE.Shape();
  mane.moveTo(-0.205, 0.05);
  mane.bezierCurveTo(-0.25, 0.2, -0.24, 0.32, -0.19, 0.43);
  mane.bezierCurveTo(-0.15, 0.52, -0.1, 0.58, -0.05, 0.63);
  mane.lineTo(-0.03, 0.6);
  mane.bezierCurveTo(-0.08, 0.55, -0.12, 0.49, -0.155, 0.42);
  mane.bezierCurveTo(-0.2, 0.31, -0.205, 0.2, -0.17, 0.06);
  mane.closePath();
  const maneG = new THREE.ExtrudeGeometry(mane, {
    depth: 0.05, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.012,
    bevelSegments: 3, curveSegments: 14,
  });
  maneG.translate(0, 0.13, -0.025);
  geoms.push(maneG);
  return geoms;
}

function bishop() {
  const R = 0.285;
  return latheRuns([
    [[0, 0], [R, 0]],
    [...baseRun(R), [0.16, 0.168], [0.124, 0.26], [0.1, 0.37], [0.092, 0.45]],
    [[0.092, 0.45], [0.158, 0.462], [0.171, 0.475], [0.158, 0.488], [0.104, 0.495],
      [0.128, 0.504], [0.134, 0.513], [0.119, 0.521], [0.074, 0.528]],
    [[0.074, 0.528], [0.106, 0.556], [0.126, 0.6], [0.122, 0.648], [0.096, 0.7],
      [0.054, 0.742], [0.022, 0.76]],
    [[0.022, 0.76], ...arcPts(0, 0.79, 0.033, -50, 90, 8)],
  ]);
}

function queen() {
  const R = 0.315;
  const geoms = latheRuns([
    [[0, 0], [R, 0]],
    [...baseRun(R, 1.05), [0.178, 0.185], [0.135, 0.3], [0.108, 0.44], [0.1, 0.55]],
    [[0.1, 0.55], [0.172, 0.563], [0.186, 0.577], [0.172, 0.591], [0.11, 0.599],
      [0.142, 0.609], [0.149, 0.619], [0.135, 0.628], [0.098, 0.635]],
    [[0.098, 0.635], [0.112, 0.68], [0.146, 0.74], [0.18, 0.79], [0.192, 0.808]],
    [[0.192, 0.808], [0.188, 0.82], [0.163, 0.825]],
    [[0.163, 0.825], [0.128, 0.848], [0.07, 0.872], [0.03, 0.882], [0.022, 0.886]],
    [[0.022, 0.886], ...arcPts(0, 0.922, 0.042, -58, 90, 10)],
  ]);
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = new THREE.SphereGeometry(0.027, 14, 10);
    b.translate(Math.cos(a) * 0.178, 0.826, Math.sin(a) * 0.178);
    geoms.push(b);
  }
  return geoms;
}

function king() {
  const R = 0.325;
  const geoms = latheRuns([
    [[0, 0], [R, 0]],
    [...baseRun(R, 1.08), [0.19, 0.192], [0.145, 0.32], [0.12, 0.48], [0.112, 0.6]],
    [[0.112, 0.6], [0.188, 0.613], [0.201, 0.628], [0.188, 0.643], [0.122, 0.651],
      [0.154, 0.662], [0.161, 0.672], [0.147, 0.681], [0.11, 0.689]],
    [[0.11, 0.689], [0.124, 0.74], [0.158, 0.8], [0.19, 0.845], [0.198, 0.86]],
    [[0.198, 0.86], [0.193, 0.872], [0.166, 0.877]],
    [[0.166, 0.877], [0.122, 0.9], [0.062, 0.918], [0.0, 0.925]],
  ]);
  // cross
  const w = 0.05, hb = 0.15, top = 0.21, armY = 0.115, armH = 0.048;
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, armY);
  s.lineTo(hb / 2, armY);
  s.lineTo(hb / 2, armY + armH);
  s.lineTo(w / 2, armY + armH);
  s.lineTo(w / 2, top);
  s.lineTo(-w / 2, top);
  s.lineTo(-w / 2, armY + armH);
  s.lineTo(-hb / 2, armY + armH);
  s.lineTo(-hb / 2, armY);
  s.lineTo(-w / 2, armY);
  s.closePath();
  const d = 0.034, bev = 0.011;
  const cross = new THREE.ExtrudeGeometry(s, {
    depth: d, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3,
  });
  cross.translate(0, 0.905, -d / 2);
  geoms.push(cross);
  return geoms;
}

const BUILDERS = { p: pawn, r: rook, n: knight, b: bishop, q: queen, k: king };

let cache = null;
export function getPieceGeometries() {
  if (cache) return cache;
  cache = {};
  for (const [k, fn] of Object.entries(BUILDERS)) cache[k] = finalize(fn());
  return cache;
}

export function pieceHeight(type) {
  const g = getPieceGeometries()[type];
  return g.boundingBox.max.y;
}

export function pieceRadius(type) {
  return { p: 0.255, r: 0.29, n: 0.29, b: 0.285, q: 0.315, k: 0.325 }[type];
}

// Shared materials ---------------------------------------------------------
export function createPieceMaterials(grainW, grainB) {
  const white = new THREE.MeshPhysicalMaterial({
    color: 0xe9dcc4, roughness: 0.42, metalness: 0, map: grainW || null,
    clearcoat: 0.45, clearcoatRoughness: 0.22,
  });
  const black = new THREE.MeshPhysicalMaterial({
    color: 0x2a2320, roughness: 0.32, metalness: 0, map: grainB || null,
    clearcoat: 0.85, clearcoatRoughness: 0.12,
  });
  return { w: white, b: black };
}
