// "내 전적" — stats overview, rating chart, recent games (with replay), head-to-head.
import { el, esc, fmtDate, timeAgo, fmtTCShort } from './util.js';
import { avatar, tierBadge, icon, pieceIcon, openModal } from './ui.js';
import * as store from './store.js';
import { REASONS, RATING_START } from './config.js';

const NS = 'http://www.w3.org/2000/svg';

function niceStep(range) {
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500];
  for (const s of steps) if (range / s <= 4) return s;
  return 1000;
}

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/** Single-series rating line: 2px line, 10% area wash, end dot with surface ring,
 *  hairline grid, clean ticks, crosshair + tooltip (values via textContent). */
function renderRatingChart(box, hist) {
  const pts = [{ r: RATING_START, t: null, i: 0 }, ...hist.map((h, i) => ({ r: h.r, t: h.t, i: i + 1 }))];
  if (hist.length < 1) {
    box.innerHTML = '<div class="chart-empty">대국을 마치면 레이팅 변화가 여기에 그려져요</div>';
    return;
  }
  const W = Math.max(280, box.clientWidth - 4), H = 160;
  const pad = { l: 40, r: 56, t: 14, b: 22 };
  const rs = pts.map((p) => p.r);
  let lo = Math.min(...rs), hi = Math.max(...rs);
  if (hi - lo < 40) { const m = (hi + lo) / 2; lo = m - 20; hi = m + 20; }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const x = (i) => pad.l + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (W - pad.l - pad.r));
  const y = (r) => pad.t + (1 - (r - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: '0',
    'aria-label': `레이팅 변화: ${pts.length - 1}판 동안 ${RATING_START}에서 ${pts[pts.length - 1].r}` });
  svg.style.height = H + 'px';
  // grid + ticks
  for (let v = lo; v <= hi + 0.001; v += step) {
    const yy = y(v);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, stroke: 'var(--line)', 'stroke-width': 1 }));
    const tx = svgEl('text', { x: pad.l - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-3)', 'font-variant-numeric': 'tabular-nums' });
    tx.textContent = String(v);
    svg.appendChild(tx);
  }
  // x labels: first and last game number
  const xl = svgEl('text', { x: pad.l, y: H - 4, 'font-size': 11, fill: 'var(--text-3)' });
  xl.textContent = '시작';
  svg.appendChild(xl);
  const xr = svgEl('text', { x: W - pad.r, y: H - 4, 'font-size': 11, fill: 'var(--text-3)', 'text-anchor': 'end' });
  xr.textContent = `${pts.length - 1}판`;
  svg.appendChild(xr);

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.r).toFixed(1)}`).join('');
  const area = `${d}L${x(pts[pts.length - 1].i).toFixed(1)},${y(lo)}L${x(0).toFixed(1)},${y(lo)}Z`;
  svg.appendChild(svgEl('path', { d: area, fill: 'var(--chart-line)', 'fill-opacity': 0.1, stroke: 'none' }));
  svg.appendChild(svgEl('path', { d, fill: 'none', stroke: 'var(--chart-line)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  // end dot + end label (text token, not series color)
  const last = pts[pts.length - 1];
  svg.appendChild(svgEl('circle', { cx: x(last.i), cy: y(last.r), r: 4.5, fill: 'var(--chart-line)', stroke: 'var(--surface-2)', 'stroke-width': 2 }));
  const endLbl = svgEl('text', { x: x(last.i) + 9, y: y(last.r) + 4, 'font-size': 12.5, 'font-weight': 800, fill: 'var(--text)' });
  endLbl.textContent = String(last.r);
  svg.appendChild(endLbl);

  // hover layer
  const cross = svgEl('line', { y1: pad.t, y2: H - pad.b, stroke: 'var(--text-3)', 'stroke-width': 1, visibility: 'hidden' });
  const hov = svgEl('circle', { r: 4.5, fill: 'var(--chart-line)', stroke: 'var(--surface-2)', 'stroke-width': 2, visibility: 'hidden' });
  svg.appendChild(cross);
  svg.appendChild(hov);
  const hit = svgEl('rect', { x: pad.l - 6, y: 0, width: W - pad.l - pad.r + 12, height: H, fill: 'transparent' });
  svg.appendChild(hit);

  const tip = el('<div class="chart-tip" hidden><b></b><span></span></div>');
  const show = (idx) => {
    idx = Math.max(0, Math.min(pts.length - 1, idx));
    const p = pts[idx];
    const cx = x(p.i), cy = y(p.r);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
    hov.setAttribute('cx', cx); hov.setAttribute('cy', cy);
    cross.setAttribute('visibility', 'visible'); hov.setAttribute('visibility', 'visible');
    const prev = idx > 0 ? pts[idx - 1].r : null;
    const delta = prev == null ? null : p.r - prev;
    tip.querySelector('b').textContent = String(p.r);
    tip.querySelector('span').textContent = idx === 0 ? '시작 레이팅' : `${idx}번째 대국 · ${delta >= 0 ? '+' : ''}${delta}${p.t ? ' · ' + fmtDate(p.t).slice(2, 10) : ''}`;
    tip.hidden = false;
    const left = Math.min(W - 150, Math.max(0, cx - 70));
    tip.style.left = left + 'px';
    tip.style.top = Math.max(0, cy - 54) + 'px';
    svg._idx = idx;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); hov.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = (px - pad.l) / (W - pad.l - pad.r);
    show(Math.round(t * (pts.length - 1)));
  });
  hit.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(pts.length - 1));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show((svg._idx ?? pts.length - 1) - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show((svg._idx ?? 0) + 1); }
  });
  box.innerHTML = '';
  box.style.position = 'relative';
  box.appendChild(svg);
  box.appendChild(tip);
}

function wlBar(w, d, l) {
  const t = w + d + l;
  if (!t) return '<div class="wl-bar"></div>';
  const seg = (n, cls) => (n ? `<i class="${cls}" style="flex:${n}"></i>` : '');
  return `<div class="wl-bar" role="img" aria-label="${w}승 ${d}무 ${l}패">${seg(w, 'w')}${seg(d, 'd')}${seg(l, 'l')}</div>`;
}

export function openStats(app) {
  const p = app.profile;
  const s = store.getStats();
  const hist = store.getHistory();
  const total = s.w + s.l + s.d;
  const wr = total ? Math.round((s.w / total) * 100) : 0;
  const streak = s.streak > 0 ? `${s.streak}연승` : s.streak < 0 ? `${-s.streak}연패` : '-';
  const body = el(`<div class="stats">
    <div class="stats-hero">
      ${avatar(p.av, 74)}
      <div style="min-width:0">
        <div class="profile-name">${esc(p.name)}</div>
        <div class="me-sub">${tierBadge(s.rating)}<span class="muted" style="font-size:13px;font-weight:650">최고 ${s.peak}</span></div>
        ${p.names?.length ? `<div class="hint" style="margin-top:4px">이전 닉네임: ${p.names.slice(-4).map((n) => esc(n.name)).join(', ')}</div>` : ''}
      </div>
      <div class="stats-rating"><b>${s.rating}</b><span>레이팅</span></div>
    </div>
    <div class="tabs" role="tablist">
      <button class="on" data-tab="sum">요약</button>
      <button data-tab="games">최근 대국 <span class="count">${hist.length}</span></button>
      <button data-tab="opps">상대 전적</button>
    </div>
    <div data-pane="sum" style="display:flex;flex-direction:column;gap:12px">
      <div class="stat-cards">
        <div class="stat-card"><span>총 대국</span><b>${total}</b><small>${s.w}승 ${s.d}무 ${s.l}패</small></div>
        <div class="stat-card"><span>승률</span><b>${wr}%</b><small>${total ? `무승부 ${Math.round((s.d / total) * 100)}%` : '아직 기록 없음'}</small></div>
        <div class="stat-card"><span>현재 흐름</span><b>${streak}</b><small>최고 ${s.best}연승</small></div>
        <div class="stat-card"><span>최고 레이팅</span><b>${s.peak}</b><small>시작 ${RATING_START}</small></div>
      </div>
      ${wlBar(s.w, s.d, s.l)}
      <div class="chart-box"><div class="cb-head"><span>레이팅 변화</span><span class="muted" style="font-weight:650">대국 순서 기준</span></div><div class="chart-area"></div></div>
      <div class="split2">
        ${['w', 'b'].map((c) => {
          const x = c === 'w' ? s.asW : s.asB;
          const t = x.w + x.d + x.l;
          return `<div class="color-stat"><div class="cs-h">${pieceIcon(c + 'k')}${c === 'w' ? '백으로' : '흑으로'}<span class="muted" style="margin-left:auto;font-size:12.5px">${t}판</span></div>
            <div class="cs-n">${x.w}승 ${x.d}무 ${x.l}패 · 승률 ${t ? Math.round((x.w / t) * 100) : 0}%</div>${wlBar(x.w, x.d, x.l)}</div>`;
        }).join('')}
      </div>
    </div>
    <div data-pane="games" hidden>
      ${hist.length ? `<div class="game-rows">${hist.slice(0, 100).map((g, i) => {
        const name = store.playerName(g.opp?.uid, g.opp?.name);
        const res = { win: '승', loss: '패', draw: '무' }[g.result] || '-';
        const d = g.delta ?? 0;
        return `<div class="game-row">
          <span class="res-badge ${g.result}">${res}</span>
          <div class="gr-main">
            <div class="t">${pieceIcon(g.color + 'k')}<span style="overflow:hidden;text-overflow:ellipsis">vs ${esc(name)}</span></div>
            <div class="s">${esc(REASONS[g.reason] || '')} · ${Math.ceil((g.plies || 0) / 2)}수 · ${esc(fmtTCShort(g.tc))} · ${esc(timeAgo(g.at))}</div>
          </div>
          <span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'zero'}">${d > 0 ? '+' : ''}${d}</span>
          <button class="btn btn-sm btn-soft gr-act" data-replay="${i}">${icon('play', 'sm')}<span>다시보기</span></button>
        </div>`;
      }).join('')}</div>` : '<div class="empty-mini">아직 온라인 대국 기록이 없어요.<br>로비에서 친구와 한 판 둬 보세요!</div>'}
    </div>
    <div data-pane="opps" hidden>
      ${(() => {
        const opps = store.opponentsSummary();
        const players = store.getPlayers();
        if (!opps.length) return '<div class="empty-mini">상대 전적이 아직 없어요.</div>';
        return `<div class="opp-rows">${opps.map((o) => {
          const pl = players[o.uid];
          const aka = (pl?.aka || []).filter((n) => n !== o.name);
          return `<div class="opp-row">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">${avatar(pl?.av, 36)}<div style="min-width:0"><div class="nm">${esc(o.name)}</div>
            <div class="aka">${aka.length ? `예전 이름: ${aka.map(esc).join(', ')} · ` : ''}마지막 대국 ${esc(timeAgo(o.last))}</div></div></div>
            <div class="sc"><span class="w">${o.w}승</span> <span class="d">${o.d}무</span> <span class="l">${o.l}패</span></div>
          </div>`;
        }).join('')}</div>`;
      })()}
    </div>
    <p class="hint">전적은 이 브라우저에 저장돼요. 닉네임을 바꿔도 그대로 유지되고, 다른 기기로 옮기려면 설정 › 데이터에서 백업 코드를 사용하세요.</p>
  </div>`);
  const m = openModal({ title: '내 전적', body, size: 'lg' });
  const tabs = body.querySelector('.tabs');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    for (const x of tabs.children) x.classList.toggle('on', x === b);
    for (const pane of body.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== b.dataset.tab;
  });
  body.addEventListener('click', (e) => {
    const r = e.target.closest('[data-replay]');
    if (!r) return;
    const rec = hist[+r.dataset.replay];
    if (!rec) return;
    m.close();
    app.replayGame(rec);
  });
  requestAnimationFrame(() => renderRatingChart(body.querySelector('.chart-area'), s.hist));
}
