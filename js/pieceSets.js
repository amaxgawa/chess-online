// Piece sets: the built-in 3D "classic" set plus image sets listed in
// assets/pieces/sets.json (images you add to the site yourself).
// A player's chosen set id travels with their player info, so the opponent
// (and spectators) render that player's side with the same set.
import * as THREE from 'three';
import { esc } from './util.js';

export const PIECE_BASE = 'assets/pieces/';
export const CLASSIC = { id: 'classic', name: '클래식 3D', desc: '기본 입체 체스말', kind: '3d' };
const ROLES = ['k', 'q', 'r', 'b', 'n', 'p'];
const ALIASES = {
  king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p',
  킹: 'k', 퀸: 'q', 룩: 'r', 비숍: 'b', 나이트: 'n', 폰: 'p',
};

let registry = [];
const prepared = new Map(); // id -> Promise<preparedSet>

function resolveUrl(path) {
  if (/^(https?:|data:|\/)/.test(path)) return path;
  return PIECE_BASE + path.replace(/^\.\//, '');
}

function normalize(raw) {
  const out = [];
  const seen = new Set(['classic']);
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
    if (!id || seen.has(id)) continue;
    const folder = s.folder ? String(s.folder).replace(/\/+$/, '') + '/' : '';
    const imgs = {};
    let all = null;
    if (typeof s.images === 'string') all = s.images;
    else if (s.images && typeof s.images === 'object') {
      for (const [k, v] of Object.entries(s.images)) {
        if (typeof v !== 'string' || !v) continue;
        const key = ALIASES[k.toLowerCase?.() ?? k] || ALIASES[k] || k.toLowerCase();
        if (key === 'all' || key === 'default' || key === '*') all = v;
        else if (ROLES.includes(key)) imgs[key] = v;
      }
    }
    if (typeof s.image === 'string') all = all || s.image;
    const firstGiven = imgs.p || imgs.k || Object.values(imgs)[0] || all;
    if (!firstGiven) continue;
    const images = {};
    for (const r of ROLES) images[r] = resolveUrl(folder + (imgs[r] || all || firstGiven));
    seen.add(id);
    out.push({
      id,
      name: String(s.name || id).slice(0, 20),
      desc: s.desc ? String(s.desc).slice(0, 40) : '',
      kind: 'image',
      images,
      single: !Object.keys(imgs).length,
      pixel: s.pixel === undefined ? 'auto' : !!s.pixel,
      scale: Number.isFinite(+s.scale) && +s.scale > 0 ? Math.min(2, Math.max(0.4, +s.scale)) : 1,
      badge: s.badge !== false,
      flip: !!s.flip,
    });
  }
  return out;
}

export async function loadPieceSets() {
  try {
    const r = await fetch(PIECE_BASE + 'sets.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    registry = normalize(j.sets || j);
  } catch {
    registry = [];
  }
  return registry;
}

export function listSets() { return [CLASSIC, ...registry]; }
export function getSet(id) {
  if (!id || id === 'classic') return CLASSIC;
  return registry.find((s) => s.id === id) || null;
}
export function setName(id) { return getSet(id)?.name || CLASSIC.name; }

/** Load textures for an image set (cached). Resolves to null for classic / unknown / failed sets. */
export function prepareSet(id) {
  const def = getSet(id);
  if (!def || def.kind !== 'image') return Promise.resolve(null);
  if (prepared.has(id)) return prepared.get(id);
  const loader = new THREE.TextureLoader();
  const byUrl = new Map();
  const load = (url) => {
    if (!byUrl.has(url)) {
      byUrl.set(url, loader.loadAsync(url).then((tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        const img = tex.image;
        const w = img?.naturalWidth || img?.width || 1, h = img?.naturalHeight || img?.height || 1;
        const pixel = def.pixel === 'auto' ? Math.max(w, h) <= 160 : def.pixel;
        if (pixel) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; }
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        return { tex, aspect: w / h, w, h };
      }));
    }
    return byUrl.get(url);
  };
  const p = Promise.all(ROLES.map((r) => load(def.images[r]))).then((arr) => {
    const tex = {}, aspect = {};
    ROLES.forEach((r, i) => { tex[r] = arr[i].tex; aspect[r] = arr[i].aspect; });
    return { ...def, tex, aspect };
  }).catch((e) => {
    console.warn('[pieces] failed to load set', id, e?.message || e);
    prepared.delete(id);
    return null;
  });
  prepared.set(id, p);
  return p;
}

/** Already-loaded set (sync) or null. */
const ready = new Map();
export function readySet(id) { return ready.get(id) || null; }
export async function ensureSet(id) {
  const s = await prepareSet(id);
  if (s) ready.set(id, s);
  return s;
}
export function preloadAll() {
  return Promise.all(registry.map((s) => ensureSet(s.id)));
}

/** Small preview element for a set: its king image or the classic thumbnail. */
export function setPreviewHTML(id, color = 'w', size = 26) {
  const def = getSet(id);
  if (!def || def.kind !== 'image') {
    return `<i class="pc pc-${color}k" data-g="${color === 'w' ? '♔' : '♚'}︎" style="width:${size}px;height:${size}px"></i>`;
  }
  return `<img class="set-ic ${def.pixel === true ? 'pixel' : ''}" src="${esc(def.images.k)}" alt="" style="height:${size}px" draggable="false">`;
}

export function setStripHTML(id) {
  const def = getSet(id);
  if (!def || def.kind !== 'image') {
    return ['wk', 'bq', 'wr', 'bb', 'wn', 'bp'].map((c) => `<i class="pc pc-${c}" data-g=""></i>`).join('');
  }
  const urls = def.single ? [def.images.k] : ['k', 'q', 'r', 'b', 'n', 'p'].map((r) => def.images[r]);
  return urls.map((u) => `<img class="set-ic ${def.pixel === true ? 'pixel' : ''}" src="${esc(u)}" alt="" draggable="false">`).join('');
}

export { ROLES };
