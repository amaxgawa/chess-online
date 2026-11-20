// Small shared helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** html`...` tagged template that escapes interpolations unless wrapped with raw() */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v && v.__raw) out += v.s;
      else if (Array.isArray(v)) out += v.map((x) => (x && x.__raw ? x.s : esc(x))).join('');
      else out += esc(v);
    }
  });
  return { __raw: true, s: out, toString() { return out; } };
}
export const raw = (s) => ({ __raw: true, s: String(s ?? ''), toString() { return this.s; } });

export function el(htmlStr) {
  const t = document.createElement('template');
  t.innerHTML = String(htmlStr).trim();
  return t.content.firstElementChild;
}

export function randId(n = 10) {
  const a = 'abcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += a[b % a.length];
  return s;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return randId(8) + '-' + randId(4) + '-' + randId(4) + '-' + randId(12);
}

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtClock(ms) {
  if (ms == null) return '∞';
  const neg = ms < 0;
  ms = Math.max(0, ms);
  if (ms < 20000 && !neg) {
    const s = Math.floor(ms / 1000), t = Math.floor((ms % 1000) / 100);
    return `0:${String(s).padStart(2, '0')}.${t}`;
  }
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtTC(tc) {
  if (!tc || !tc.b) return '무제한';
  const m = tc.b / 60;
  const base = Number.isInteger(m) ? `${m}분` : `${tc.b}초`;
  return tc.i ? `${base} +${tc.i}초` : base;
}
export function fmtTCShort(tc) {
  if (!tc || !tc.b) return '∞';
  if (tc.b < 60) return `${tc.b}초+${tc.i || 0}`;
  const m = tc.b / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}+${tc.i || 0}`;
}
export function tcCategory(tc) {
  if (!tc || !tc.b) return '무제한';
  const est = tc.b + 40 * (tc.i || 0);
  if (est < 180) return '불릿';
  if (est < 480) return '블리츠';
  if (est < 1500) return '래피드';
  return '클래식';
}

export function timeAgo(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return '방금 전';
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}일 전`;
  const dt = new Date(t);
  return `${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}`;
}

export function fmtDate(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= new Set()).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._h[ev]?.delete(fn); }
  emit(ev, ...a) { this._h[ev]?.forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }); }
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;

// Korean particle helper: 은/는, 이/가, 을/를
export function josa(word, pair) {
  const [a, b] = pair.split('/');
  const ch = String(word).charCodeAt(String(word).length - 1);
  if (ch < 0xac00 || ch > 0xd7a3) return `${word}(${a})${b}`;
  return word + ((ch - 0xac00) % 28 ? a : b);
}
