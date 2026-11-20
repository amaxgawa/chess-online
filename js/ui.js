// DOM-level UI helpers: screens, modals, toasts, avatars, confetti.
import { $, $$, el, esc } from './util.js';
import { tierOf } from './store.js';

const GLYPH = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙', bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟' };

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function pieceIcon(code, cls = '', game = false) {
  // code like 'wn'; game=true uses the current game's piece-set images when available
  return `<i class="pc ${game ? 'gpc' : 'pc'}-${code} ${cls}" data-g="${GLYPH[code] || ''}︎"></i>`;
}

export function avatar(av, size = 40, extra = '') {
  const p = av?.p || 'n';
  const h = Number.isFinite(av?.h) ? av.h : 152;
  return `<span class="avatar ${extra}" style="--s:${size}px;--h:${h}">${pieceIcon('w' + p)}</span>`;
}

export function tierBadge(rating) {
  const t = tierOf(rating ?? 1000);
  return `<span class="tier" style="--tc:${t.color}">${esc(t.name)}</span>`;
}

export function setThumbnails(map) {
  if (!map) return;
  const root = document.documentElement;
  for (const [k, url] of Object.entries(map)) root.style.setProperty(`--pc-${k}`, `url("${url}")`);
  root.classList.add('thumbs');
}

// ---------------------------------------------------------------- screens
export function showScreen(name) {
  document.body.dataset.screen = name;
  for (const s of $$('.screen')) s.classList.toggle('active', s.id === 'screen-' + name);
}

// ---------------------------------------------------------------- toasts
const TOAST_IC = { info: 'info', success: 'check', error: 'x', warn: 'info' };
export function toast(msg, { type = 'info', timeout = 3400, actions = [], icon: ic, html = false } = {}) {
  const root = $('#toast-root');
  const node = el(`<div class="toast ${type}" role="status">
    <span class="t-ic">${icon(ic || TOAST_IC[type] || 'info')}</span>
    <div class="t-msg">${html ? msg : esc(msg)}</div>
    <div class="t-acts"></div>
  </div>`);
  let timer = null;
  const close = () => {
    if (!node.isConnected || node.classList.contains('closing')) return;
    clearTimeout(timer);
    node.classList.add('closing');
    setTimeout(() => node.remove(), 230);
  };
  const acts = node.querySelector('.t-acts');
  for (const a of actions) {
    const b = el(`<button class="btn btn-sm ${a.kind ? 'btn-' + a.kind : 'btn-soft'}">${esc(a.label)}</button>`);
    b.addEventListener('click', () => { close(); a.onClick?.(); });
    acts.appendChild(b);
  }
  root.appendChild(node);
  while (root.children.length > 4) root.firstElementChild.remove();
  if (timeout) timer = setTimeout(close, timeout);
  return { close, node };
}

// ---------------------------------------------------------------- modals
const openModals = [];
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) {
    const m = openModals[openModals.length - 1];
    if (m.dismissible) m.close(null);
  }
});

/**
 * openModal({ title, body, actions:[{label, kind, value, onClick, close, id}], size, dismissible, onClose, cls })
 * returns { el, body, close(value), result: Promise }
 */
export function openModal({ title = '', body = '', actions = [], size = '', dismissible = true, onClose, cls = '', closeButton = true } = {}) {
  const root = $('#modal-root');
  const back = el(`<div class="modal-backdrop ${cls}">
    <div class="modal ${size}" role="dialog" aria-modal="true" ${title ? `aria-label="${esc(title)}"` : ''}>
      ${title || closeButton ? `<div class="modal-head">${title ? `<h3>${esc(title)}</h3>` : '<div style="flex:1"></div>'}${closeButton && dismissible ? `<button class="icon-btn" data-close aria-label="닫기">${icon('x')}</button>` : ''}</div>` : ''}
      <div class="modal-body"></div>
      ${actions.length ? '<div class="modal-foot"></div>' : ''}
    </div>
  </div>`);
  const bodyEl = back.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  let resolve;
  const result = new Promise((r) => (resolve = r));
  let closed = false;
  const api = {
    el: back, body: bodyEl, result, dismissible,
    close(value) {
      if (closed) return;
      closed = true;
      const i = openModals.indexOf(api);
      if (i >= 0) openModals.splice(i, 1);
      back.classList.add('closing');
      setTimeout(() => back.remove(), 190);
      onClose?.(value);
      resolve(value);
    },
  };
  const foot = back.querySelector('.modal-foot');
  for (const a of actions) {
    const b = el(`<button class="btn ${a.kind ? 'btn-' + a.kind : ''}" ${a.id ? `id="${a.id}"` : ''}>${a.icon ? icon(a.icon) : ''}<span>${esc(a.label)}</span></button>`);
    b.addEventListener('click', async () => {
      if (a.onClick) {
        const r = await a.onClick(api, b);
        if (r === false) return;
      }
      if (a.close !== false) api.close(a.value ?? a.label);
    });
    foot.appendChild(b);
  }
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back && dismissible) back._downOnBack = true;
  });
  back.addEventListener('click', (e) => {
    if (e.target === back && dismissible && back._downOnBack) api.close(null);
    back._downOnBack = false;
  });
  back.querySelector('[data-close]')?.addEventListener('click', () => api.close(null));
  root.appendChild(back);
  openModals.push(api);
  setTimeout(() => {
    const f = back.querySelector('[autofocus]') || back.querySelector('input:not([type=checkbox]):not([type=range])');
    if (f && !matchMedia('(pointer: coarse)').matches) f.focus();
  }, 60);
  return api;
}

export function closeAllModals() {
  for (const m of [...openModals]) m.close(null);
}

export function confirmDialog({ title = '확인', message = '', ok = '확인', cancel = '취소', danger = false } = {}) {
  const m = openModal({
    title, size: 'sm',
    body: `<p class="modal-msg">${message}</p>`,
    actions: [
      { label: cancel, value: false },
      { label: ok, kind: danger ? 'danger' : 'primary', value: true },
    ],
  });
  return m.result.then((v) => v === true);
}

export function promptDialog({ title = '', message = '', placeholder = '', value = '', maxLength = 40, type = 'text', ok = '확인' } = {}) {
  const body = el(`<div class="form-row">${message ? `<p class="modal-msg">${message}</p>` : ''}
    <input class="input" type="${type}" maxlength="${maxLength}" placeholder="${esc(placeholder)}" value="${esc(value)}" autofocus></div>`);
  const input = body.querySelector('input');
  let m;
  const submit = () => m.close(input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  m = openModal({
    title, size: 'sm', body,
    actions: [
      { label: '취소', value: null },
      { label: ok, kind: 'primary', onClick: () => { submit(); return false; } },
    ],
  });
  return m.result.then((v) => (typeof v === 'string' ? v : null));
}

// ---------------------------------------------------------------- confetti
export function confetti({ count = 160, duration = 3200 } = {}) {
  const cv = $('#confetti');
  const ctx = cv.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#f2b53a', '#2c7c59', '#e2772a', '#4f8df5', '#ec6359', '#b45cf0', '#f6efe2'];
  const parts = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.3,
    y: innerHeight * 0.32 + (Math.random() - 0.5) * 40,
    vx: (Math.random() - 0.5) * 13,
    vy: -Math.random() * 13 - 5,
    w: 6 + Math.random() * 7, h: 8 + Math.random() * 10,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
    c: colors[Math.floor(Math.random() * colors.length)],
    s: Math.random() < 0.3 ? 'c' : 'r',
  }));
  const t0 = performance.now();
  const step = (now) => {
    const t = now - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.99; p.vy *= 0.99;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - duration + 900) / 900);
      ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      if (p.s === 'c') { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 2);
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(step);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- chat log helper
export function appendChat(logEl, { name, text, me = false, sys = false, hue, html: isHtml = false }) {
  if (!logEl) return;
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  let node;
  if (sys) node = el(`<div class="chat-sys">${isHtml ? text : esc(text)}</div>`);
  else {
    const d = new Date();
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    node = el(`<div class="chat-msg ${me ? 'me' : ''}" style="--h:${hue ?? 150}"><span class="who">${esc(name)}</span><span class="txt">${esc(text)}</span><span class="ts">${ts}</span></div>`);
  }
  logEl.appendChild(node);
  while (logEl.children.length > 150) logEl.firstElementChild.remove();
  if (nearBottom || me) logEl.scrollTop = logEl.scrollHeight;
}
