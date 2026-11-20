// Procedural canvas textures: board surfaces (wood / marble / flat), frame, piece grain, glows.
import * as THREE from 'three';

export const TOP = 9.2;            // flat top area of the board (units)
export const FRAME = (TOP - 8) / 2; // frame width around the 8x8 squares

export const BOARD_STYLES = {
  walnut: {
    name: '원목', kind: 'wood',
    light: '#e6caa0', lightGrain: '#a87a4c', dark: '#875335', darkGrain: '#3f1f0e',
    frame: '#4a2a18', frameGrain: '#1c0d05', inlay: '#e9cf9f', label: '#f1dfbf', side: '#3a2012',
    hl: { last: 0xffd84d, sel: 0x5fd38a, dot: 0x1b4d2a },
  },
  marble: {
    name: '대리석', kind: 'marble',
    light: '#eeebe5', lightVein: '#8f8c88', dark: '#355d52', darkVein: '#b9d3c8',
    frame: '#2a2c30', frameGrain: '#55595f', inlay: '#c9b37e', label: '#d9dde3', side: '#202226',
    hl: { last: 0xffd24a, sel: 0x4fd18b, dot: 0x0f2d22 },
  },
  tournament: {
    name: '토너먼트', kind: 'flat',
    light: '#ecedd1', dark: '#6f9452',
    frame: '#3b3a33', frameGrain: '#2a2924', inlay: '#c9caa9', label: '#ecedd1', side: '#2d2c27',
    hl: { last: 0xf6ec5a, sel: 0x2f9e6a, dot: 0x173a12 },
  },
  midnight: {
    name: '미드나잇', kind: 'flat',
    light: '#c3cddc', dark: '#46587a',
    frame: '#161b26', frameGrain: '#262d3c', inlay: '#7f91b3', label: '#b9c5d8', side: '#10141c',
    hl: { last: 0x7cc4ff, sel: 0x6ee7b7, dot: 0x0e1a33 },
  },
};

// ---------------------------------------------------------------- helpers
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function shade(hex, f) {
  const [r, g, b] = hexToRgb(hex).map((c) => Math.max(0, Math.min(255, Math.round(c * f))));
  return `rgb(${r},${g},${b})`;
}

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// value noise for marble
function makeValueNoise(rand) {
  const N = 256;
  const grid = new Float32Array(N * N);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const sm = (t) => t * t * (3 - 2 * t);
  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const x0 = xi & 255, y0 = yi & 255, x1 = (x0 + 1) & 255, y1 = (y0 + 1) & 255;
    const a = grid[y0 * N + x0], b = grid[y0 * N + x1], c = grid[y1 * N + x0], d = grid[y1 * N + x1];
    const u = sm(xf), v = sm(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fbm(noise, x, y, oct = 5) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += amp * noise(x * f, y * f); f *= 2; amp *= 0.5; }
  return s;
}

// Draw wood grain into a rect. `along` = 'x' or 'y' (grain direction)
function drawWood(ctx, x, y, w, h, base, grain, rand, along = 'y', scale = 1) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
  const L = along === 'y' ? h : w; // length along grain
  const A = along === 'y' ? w : h; // across
  const P = (a, l) => (along === 'y' ? [x + a, y + l] : [x + l, y + a]);

  // broad figure bands
  const bands = 5 + Math.floor(rand() * 5);
  for (let i = 0; i < bands; i++) {
    const c = rand() * A, bw = (0.06 + rand() * 0.22) * A;
    const g = along === 'y'
      ? ctx.createLinearGradient(x + c - bw, 0, x + c + bw, 0)
      : ctx.createLinearGradient(0, y + c - bw, 0, y + c + bw);
    const col = rand() < 0.5 ? grain : '#ffffff';
    const al = rand() < 0.5 ? 0.07 + rand() * 0.09 : 0.04 + rand() * 0.05;
    g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, al)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  }
  // fine grain lines
  const lines = Math.floor((40 + rand() * 40) * (A / 220) * scale) + 10;
  const freq = 0.6 + rand() * 1.4, phase0 = rand() * 10, wob = (0.01 + rand() * 0.03) * A;
  for (let i = 0; i < lines; i++) {
    const a0 = rand() * A;
    const amp = wob * (0.5 + rand());
    const ph = phase0 + rand() * 0.6;
    ctx.strokeStyle = rgba(grain, 0.05 + rand() * 0.16);
    ctx.lineWidth = (0.5 + rand() * 1.8) * Math.max(1, A / 260);
    ctx.beginPath();
    const steps = 24;
    for (let s = 0; s <= steps; s++) {
      const l = (s / steps) * L;
      const a = a0 + Math.sin((l / L) * Math.PI * 2 * freq + ph) * amp + Math.sin((l / L) * 17 + ph * 3) * amp * 0.12;
      const [px, py] = P(a, l);
      s === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // pores
  const pores = Math.floor(A * L / 600);
  ctx.fillStyle = rgba(grain, 0.12);
  for (let i = 0; i < pores; i++) {
    const [px, py] = P(rand() * A, rand() * L);
    const len = 2 + rand() * 6;
    if (along === 'y') ctx.fillRect(px, py, 1, len); else ctx.fillRect(px, py, len, 1);
  }
  ctx.restore();
}

function marbleTile(size, base, vein, seed) {
  const rand = mulberry32(seed);
  const noise = makeValueNoise(rand);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const [br, bg, bb] = hexToRgb(base), [vr, vg, vb] = hexToRgb(vein);
  const ang = rand() * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang);
  const f = 1.6 + rand() * 1.2;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      const t = fbm(noise, u * 2.5 + 10, v * 2.5 + 3, 4);
      const d = (u * ca + v * sa) * f + t * 2.4;
      let m = Math.abs(Math.sin(d * Math.PI));
      m = Math.pow(1 - m, 10) * 0.85 + Math.pow(1 - m, 3) * 0.15; // soft veins with a faint halo
      const cloud = fbm(noise, u * 4 + 40, v * 4 + 9, 4) - 0.5;   // soft clouds
      const k = Math.min(1, m * 0.75 + Math.max(0, cloud) * 0.3);
      const p = (j * size + i) * 4;
      const sh = 1 + cloud * 0.12;
      img.data[p] = Math.min(255, (br * (1 - k) + vr * k) * sh);
      img.data[p + 1] = Math.min(255, (bg * (1 - k) + vg * k) * sh);
      img.data[p + 2] = Math.min(255, (bb * (1 - k) + vb * k) * sh);
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function speckle(ctx, x, y, w, h, rand, color, n, alpha) {
  ctx.fillStyle = rgba(color, alpha);
  for (let i = 0; i < n; i++) ctx.fillRect(x + rand() * w, y + rand() * h, 1 + rand() * 1.5, 1 + rand() * 1.5);
}

// ------------------------------------------------------------ board top
export function createBoardTopCanvas(styleKey, size = 2048) {
  const st = BOARD_STYLES[styleKey] || BOARD_STYLES.walnut;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const u = size / TOP;            // px per unit
  const f = FRAME * u;             // frame px
  const sq = u;                    // square px
  const rand = mulberry32(1234 + styleKey.length * 77);

  // frame: 4 mitred trapezoids with grain along each side
  const sides = [
    { poly: [[0, 0], [size, 0], [size - f, f], [f, f]], along: 'x' },
    { poly: [[0, size], [size, size], [size - f, size - f], [f, size - f]], along: 'x' },
    { poly: [[0, 0], [f, f], [f, size - f], [0, size]], along: 'y' },
    { poly: [[size, 0], [size - f, f], [size - f, size - f], [size, size]], along: 'y' },
  ];
  for (const s of sides) {
    ctx.save();
    ctx.beginPath();
    s.poly.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath(); ctx.clip();
    if (st.kind === 'marble') {
      ctx.fillStyle = st.frame; ctx.fillRect(0, 0, size, size);
      speckle(ctx, 0, 0, size, size, rand, st.frameGrain, 9000, 0.35);
    } else {
      drawWood(ctx, 0, 0, size, size, st.frame, st.frameGrain, rand, s.along, st.kind === 'flat' ? 0.25 : 1.4);
    }
    ctx.restore();
  }
  // mitre seams
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = Math.max(1, u * 0.008);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(f, f); ctx.moveTo(size, 0); ctx.lineTo(size - f, f);
  ctx.moveTo(0, size); ctx.lineTo(f, size - f); ctx.moveTo(size, size); ctx.lineTo(size - f, size - f);
  ctx.stroke();

  // squares
  let marbleL = null, marbleD = null;
  if (st.kind === 'marble') {
    marbleL = [0, 1, 2].map((i) => marbleTile(256, st.light, st.lightVein, 11 + i * 31));
    marbleD = [0, 1, 2].map((i) => marbleTile(256, st.dark, st.darkVein, 97 + i * 53));
  }
  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const x = f + file * sq, y = f + (7 - rank) * sq;
      const light = (file + rank) % 2 === 1;
      if (st.kind === 'wood') {
        drawWood(ctx, x, y, sq + 0.5, sq + 0.5, light ? st.light : st.dark, light ? st.lightGrain : st.darkGrain,
          mulberry32(file * 131 + rank * 17 + (light ? 7 : 3)), 'y');
      } else if (st.kind === 'marble') {
        const arr = light ? marbleL : marbleD;
        const tile = arr[Math.floor(rand() * arr.length)];
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, sq + 0.5, sq + 0.5); ctx.clip();
        ctx.translate(x + sq / 2, y + sq / 2);
        ctx.rotate(Math.floor(rand() * 4) * Math.PI / 2);
        const sc = 1.2 + rand() * 0.6;
        ctx.drawImage(tile, (-sq / 2) * sc - rand() * sq * 0.2, (-sq / 2) * sc - rand() * sq * 0.2, sq * sc * 1.15, sq * sc * 1.15);
        ctx.restore();
      } else {
        ctx.fillStyle = light ? st.light : st.dark;
        ctx.fillRect(x, y, sq + 0.5, sq + 0.5);
        const r2 = mulberry32(file * 31 + rank * 7);
        speckle(ctx, x, y, sq, sq, r2, light ? '#000000' : '#ffffff', 260, 0.035);
        // gentle vignette per square for depth
        const g = ctx.createRadialGradient(x + sq / 2, y + sq / 2, sq * 0.1, x + sq / 2, y + sq / 2, sq * 0.75);
        g.addColorStop(0, 'rgba(255,255,255,0.03)'); g.addColorStop(1, 'rgba(0,0,0,0.05)');
        ctx.fillStyle = g; ctx.fillRect(x, y, sq, sq);
      }
    }
  }
  // inlay border lines
  const lw = Math.max(2, u * 0.03);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = Math.max(1, u * 0.012);
  ctx.strokeRect(f, f, sq * 8, sq * 8);
  ctx.strokeStyle = st.inlay; ctx.lineWidth = lw;
  const io = u * 0.075;
  ctx.strokeRect(f - io, f - io, sq * 8 + io * 2, sq * 8 + io * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = Math.max(1, u * 0.006);
  ctx.strokeRect(f - io - lw / 2, f - io - lw / 2, sq * 8 + io * 2 + lw, sq * 8 + io * 2 + lw);

  // coordinates on all four sides (top/right ones rotated for the black player)
  const fs = Math.round(u * 0.26);
  ctx.font = `600 ${fs}px Georgia, 'Times New Roman', serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const labelPos = f * 0.5 - io * 0.5;
  const drawLabel = (txt, cx, cy, rot) => {
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(txt, 0, fs * 0.05);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillText(txt, 0, -fs * 0.04);
    ctx.fillStyle = st.label; ctx.fillText(txt, 0, 0);
    ctx.restore();
  };
  const files = 'abcdefgh';
  for (let i = 0; i < 8; i++) {
    const cx = f + i * sq + sq / 2;
    drawLabel(files[i], cx, size - labelPos, 0);
    drawLabel(files[i], cx, labelPos, Math.PI);
    const cy = f + (7 - i) * sq + sq / 2;
    drawLabel(String(i + 1), labelPos, cy, 0);
    drawLabel(String(i + 1), size - labelPos, cy, Math.PI);
  }
  // subtle varnish sheen
  const sheen = ctx.createLinearGradient(0, 0, size, size);
  sheen.addColorStop(0, 'rgba(255,255,255,0.035)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.04)');
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, size, size);
  return c;
}

export function createSideTexture(styleKey) {
  const st = BOARD_STYLES[styleKey] || BOARD_STYLES.walnut;
  const c = makeCanvas(512, 128);
  const ctx = c.getContext('2d');
  const rand = mulberry32(99);
  if (st.kind === 'marble') {
    ctx.fillStyle = st.side; ctx.fillRect(0, 0, 512, 128);
    speckle(ctx, 0, 0, 512, 128, rand, st.frameGrain, 1500, 0.3);
  } else {
    drawWood(ctx, 0, 0, 512, 128, st.side, st.frameGrain, rand, 'x', st.kind === 'flat' ? 0.3 : 1);
  }
  return c;
}

export function createGrainCanvas(seed = 5) {
  const c = makeCanvas(256);
  const ctx = c.getContext('2d');
  const rand = mulberry32(seed);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {
    const x0 = rand() * 256, amp = 2 + rand() * 6, ph = rand() * 6;
    ctx.strokeStyle = `rgba(120,90,60,${0.03 + rand() * 0.07})`;
    ctx.lineWidth = 0.6 + rand() * 2.2;
    ctx.beginPath();
    for (let y = 0; y <= 256; y += 8) {
      const x = x0 + Math.sin(y / 256 * Math.PI * 2 + ph) * amp;
      y === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return c;
}

export function createRadialCanvas(inner, outer = 'rgba(0,0,0,0)', size = 128, stop = 0.15) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner); g.addColorStop(stop, inner); g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return c;
}

export function createOutlineCanvas(size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const lw = size * 0.07, r = size * 0.08;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = lw;
  const o = lw / 2 + 1, s = size - o * 2;
  ctx.beginPath();
  ctx.moveTo(o + r, o); ctx.lineTo(o + s - r, o); ctx.quadraticCurveTo(o + s, o, o + s, o + r);
  ctx.lineTo(o + s, o + s - r); ctx.quadraticCurveTo(o + s, o + s, o + s - r, o + s);
  ctx.lineTo(o + r, o + s); ctx.quadraticCurveTo(o, o + s, o, o + s - r);
  ctx.lineTo(o, o + r); ctx.quadraticCurveTo(o, o, o + r, o);
  ctx.stroke();
  return c;
}

export function canvasTexture(canvas, { srgb = true, aniso = 1, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.needsUpdate = true;
  return t;
}

export { shade };
