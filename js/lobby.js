// Lobby: live room list (derived from hosts' presence), user list, lobby chat, invites.
import { $, $$, el, esc, fmtTCShort, fmtTC, josa, randId, tcCategory } from './util.js';
import { avatar, tierBadge, icon, pieceIcon, toast, openModal, appendChat } from './ui.js';
import * as store from './store.js';
import { PROTOCOL, APP_VERSION, TIME_CONTROLS, DEFAULT_TC, ROOM_TITLES } from './config.js';
import { setPreviewHTML, setName } from './pieceSets.js';

const STALE_RETAINED = 90_000; // retained presence older than this is treated as a ghost until it refreshes
const USER_TTL = 160_000;      // forget users we haven't heard from in this long

export const COLOR_PREF = {
  w: { label: '방장 백', short: '백' },
  b: { label: '방장 흑', short: '흑' },
  r: { label: '랜덤', short: '랜덤' },
  alt: { label: '번갈아', short: '교대' },
};

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

function reconcile(container, items, keyFn, sigFn, renderFn) {
  const existing = new Map();
  for (const c of container.children) if (c.dataset.key) existing.set(c.dataset.key, c);
  const nodes = items.map((it) => {
    const k = keyFn(it), s = sigFn(it);
    let n = existing.get(k);
    if (!n || n.dataset.sig !== s) {
      n = el(renderFn(it));
      n.dataset.key = k;
      n.dataset.sig = s;
    }
    return n;
  });
  let ref = container.firstChild;
  for (const n of nodes) {
    if (n === ref) { ref = ref.nextSibling; continue; }
    container.insertBefore(n, ref);
  }
  while (ref) { const nx = ref.nextSibling; ref.remove(); ref = nx; }
}

export function statusLabel(st) {
  return { lobby: '로비', room: '대기실', game: '게임중', spec: '관전중', practice: '연습중' }[st] || '로비';
}

export class Lobby {
  constructor(app) {
    this.app = app;
    this.users = new Map(); // uid -> { data, seen, stale }
    this.filter = 'all';
    this.started = false;
    this.unread = 0;
    this._initialUntil = 0;
    this._raf = 0;
    this._noted = new Map();
    this._verWarned = false;
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (this.started) return;
    this.started = true;
    const net = this.app.net;
    this._initialUntil = Date.now() + 3000;
    net.subscribe(net.t('u/+'), (data, topic, packet) => this._onPresence(topic.split('/').pop(), data, packet));
    net.subscribe(net.t('lobby/chat'), (data) => this._onChat(data));
    net.subscribe(net.t('i/' + this.app.uid), (data) => this._onInbox(data));
    this._sweep = setInterval(() => this._sweepUsers(), 10_000);
    this._bindUI();
    appendChat($('#lobby-log'), { sys: true, text: `<b>${esc(this.app.profile.name)}</b>님, Chess Lounge에 오신 걸 환영해요! 방을 만들거나 목록에서 골라 입장하세요.`, html: true });
    this.render();
  }

  _bindUI() {
    $('#room-filter').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-f]');
      if (!b) return;
      this.filter = b.dataset.f;
      $$('#room-filter button').forEach((x) => x.classList.toggle('on', x === b));
      this.renderRooms(true);
    });
    $('#room-grid').addEventListener('click', (e) => {
      const card = e.target.closest('[data-room]');
      if (card) { this.app.sfx.play('pick'); this.app.joinRoom(card.dataset.room); return; }
      const act = e.target.closest('[data-action="create-room"]');
      if (act) this.openCreateRoom();
    });
    $('#user-list').addEventListener('click', (e) => {
      const li = e.target.closest('[data-uid]');
      if (li) this.openUser(li.dataset.uid);
    });
    $('#me-card').addEventListener('click', (e) => {
      if (e.target.closest('[data-action="edit-profile"]')) this.app.openProfileEditor();
      else if (e.target.closest('[data-action="stats"]')) this.app.openStats();
    });
    $('#lobby-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = e.target.querySelector('input');
      const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      this.sendChat(text);
    });
    $('#lobby-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      $('.lobby').dataset.tab = b.dataset.tab;
      $$('#lobby-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      if (b.dataset.tab === 'chat') { this.unread = 0; $('#chat-badge').hidden = true; const log = $('#lobby-log'); log.scrollTop = log.scrollHeight; }
    });
  }

  // ---------------------------------------------------------------- presence
  _onPresence(uid, data, packet) {
    if (!uid || uid === this.app.uid) return;
    const prev = this.users.get(uid);
    if (!data) {
      this.users.delete(uid);
      if (prev && !prev.stale) this._userLeft(uid, prev.data);
      this.renderSoon();
      return;
    }
    if (typeof data !== 'object' || !data.name) return;
    const retained = !!packet?.retain;
    const age = Date.now() - (data.ts || 0);
    const stale = retained && age > STALE_RETAINED;
    const isNew = !prev || prev.stale;
    this.users.set(uid, { data, seen: Date.now(), stale: stale && isNew });
    if (!stale) {
      if (isNew) this._userJoined(uid, data);
      const sig = `${data.name}|${data.rating}`;
      if (this._noted.get(uid) !== sig) {
        this._noted.set(uid, sig);
        store.notePlayer(uid, { name: data.name, rating: data.rating, av: data.av });
      }
      if (data.ver && cmpVer(data.ver, APP_VERSION) > 0 && !this._verWarned) {
        this._verWarned = true;
        toast('새 버전이 배포됐어요. 새로고침하면 최신 버전으로 플레이할 수 있어요.', {
          type: 'warn', timeout: 12000, actions: [{ label: '새로고침', kind: 'primary', onClick: () => location.reload() }],
        });
      }
    }
    this.app.onPresenceChange?.(uid, data);
    this.renderSoon();
  }

  _userJoined(uid, data) {
    if (Date.now() < this._initialUntil) return;
    appendChat($('#lobby-log'), { sys: true, text: `<b>${esc(data.name)}</b>님이 접속했어요`, html: true });
    this.app.emitter.emit('user-back', uid, data);
  }

  _userLeft(uid, data) {
    appendChat($('#lobby-log'), { sys: true, text: `<b>${esc(data.name)}</b>님이 나갔어요`, html: true });
    this.app.emitter.emit('user-gone', uid, data);
  }

  _sweepUsers() {
    const now = Date.now();
    let changed = false;
    for (const [uid, u] of this.users) {
      if (now - u.seen > USER_TTL) {
        this.users.delete(uid);
        if (!u.stale) this._userLeft(uid, u.data);
        changed = true;
      }
    }
    if (changed) this.renderSoon();
  }

  isOnline(uid) {
    if (uid === this.app.uid) return true;
    const u = this.users.get(uid);
    return !!u && !u.stale;
  }
  userData(uid) {
    if (uid === this.app.uid) return this.app.presenceData();
    const u = this.users.get(uid);
    return u && !u.stale ? u.data : null;
  }

  // ---------------------------------------------------------------- rooms
  get rooms() {
    const list = [];
    for (const [uid, u] of this.users) {
      if (u.stale || !u.data.room || !u.data.room.id) continue;
      list.push({ ...u.data.room, hostUid: uid });
    }
    const mine = this.app.room?.isHost ? this.app.room.summary() : null;
    if (mine) list.push({ ...mine, hostUid: this.app.uid });
    list.sort((a, b) => (a.no - b.no) || (a.created || 0) - (b.created || 0));
    return list;
  }

  findRoom(id) { return this.rooms.find((r) => r.id === id) || null; }

  nextRoomNo() {
    const used = new Set(this.rooms.map((r) => r.no));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  // ---------------------------------------------------------------- chat / inbox
  sendChat(text) {
    const net = this.app.net;
    const me = this.app.profile;
    const msg = { id: randId(8), f: this.app.uid, name: me.name, h: me.av?.h, text: text.slice(0, 200), ts: Date.now() };
    net.publish(net.t('lobby/chat'), msg, { qos: 0 });
    this._onChat(msg, true);
  }

  _onChat(m, local = false) {
    if (!m || !m.text || !m.name) return;
    if (!local && m.f === this.app.uid) return;
    this._seen ||= new Set();
    if (this._seen.has(m.id)) return;
    this._seen.add(m.id);
    appendChat($('#lobby-log'), { name: m.name, text: String(m.text).slice(0, 200), me: m.f === this.app.uid, hue: m.h });
    if (!local) {
      const lobbyEl = $('.lobby');
      const hidden = document.body.dataset.screen !== 'lobby' || (getComputedStyle($('#lobby-tabs')).display !== 'none' && lobbyEl.dataset.tab !== 'chat');
      if (hidden && document.body.dataset.screen === 'lobby') { this.unread++; $('#chat-badge').hidden = false; }
      if (document.body.dataset.screen === 'lobby') this.app.sfx.play('chat');
    }
  }

  _onInbox(m) {
    if (!m || m.t !== 'invite' || !m.room) return;
    if (this.app.game && this.app.game.isPlayer && !this.app.game.over) return; // busy playing
    this.app.sfx.play('notify');
    toast(`<b>${esc(m.name)}</b>님이 <b>#${m.room.no} ${esc(m.room.title)}</b> 방으로 초대했어요`, {
      html: true, icon: 'mail', timeout: 15000,
      actions: [
        { label: '거절' },
        { label: '입장', kind: 'primary', onClick: () => this.app.joinRoom(m.room.id, { invited: true }) },
      ],
    });
  }

  invite(uid) {
    const room = this.app.room;
    if (!room) return;
    const net = this.app.net;
    net.publish(net.t('i/' + uid), { t: 'invite', f: this.app.uid, name: this.app.profile.name, room: room.summary(), ts: Date.now() }, { qos: 1 });
    toast('초대를 보냈어요', { type: 'success' });
  }

  // ---------------------------------------------------------------- rendering
  renderSoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  render() {
    this.renderRooms();
    this.renderUsers();
    this.renderMe();
  }

  renderRooms(force = false) {
    const grid = $('#room-grid');
    const all = this.rooms;
    $('#room-count').textContent = all.length;
    const rooms = all.filter((r) => this.filter === 'all' || (r.st === 'wait' && !r.guest));
    if (!rooms.length) {
      if (!grid.querySelector('.empty-state') || force) {
        grid.innerHTML = `<div class="empty-state">
          ${pieceIcon('wn', 'big-pc')}
          <h3>${all.length ? '들어갈 수 있는 대기방이 없어요' : '아직 열린 방이 없어요'}</h3>
          <p>첫 방을 만들고 친구를 기다려 보세요!</p>
          <button class="btn btn-primary" data-action="create-room">${icon('plus')}<span>방 만들기</span></button>
        </div>`;
      }
      return;
    }
    if (grid.querySelector('.empty-state')) grid.innerHTML = '';
    reconcile(grid, rooms, (r) => r.id, (r) => JSON.stringify([r.no, r.title, r.st, r.lock, r.tc, r.hc, r.host, r.guest, r.specs]), (r) => this._roomCard(r));
  }

  _roomCard(r) {
    const playing = r.st === 'play';
    const full = !!r.guest;
    const player = (p) => p
      ? `<div class="rc-player">${avatar(p.av, 30)}<div style="min-width:0"><div class="nm">${esc(p.name)}</div><div class="rt">${p.rating ?? ''}</div></div></div>`
      : `<div class="rc-player empty"><span class="ghost-av">${icon('plus', 'sm')}</span><span>빈 자리</span></div>`;
    const status = playing ? '게임중' : full ? '준비중' : '대기중';
    const joinLabel = playing || full ? '관전하기 →' : '입장하기 →';
    return `<button class="room-card ${playing ? 'play' : 'wait'}" data-room="${esc(r.id)}" aria-label="${esc(r.no)}번 방 ${esc(r.title)} ${status}">
      <div class="rc-top">
        <span class="rc-no">No.${String(r.no).padStart(3, '0')}</span>
        <span class="badge-st ${playing ? 'play' : 'wait'}">${status}</span>
        ${r.lock ? `<span class="room-lock-ic" title="비밀방">${icon('lock', 'sm')}</span>` : ''}
      </div>
      <div class="rc-title">${esc(r.title)}</div>
      <div class="rc-players">${player(r.host)}<span class="rc-vs">VS</span>${player(r.guest)}</div>
      <div class="rc-foot">
        <span class="mini" title="${esc(fmtTC(r.tc))}">${icon('clock')}${esc(fmtTCShort(r.tc))} · ${esc(tcCategory(r.tc))}</span>
        <span class="mini">${esc(COLOR_PREF[r.hc]?.short || '랜덤')}</span>
        ${r.specs ? `<span class="mini">${icon('eye')}${r.specs}</span>` : ''}
        <span class="spacer"></span>
        <span class="rc-join">${joinLabel}</span>
      </div>
    </button>`;
  }

  _userStatus(d) {
    if (!d) return 'lobby';
    return d.st || 'lobby';
  }

  renderUsers() {
    const list = $('#user-list');
    const meData = this.app.presenceData();
    const others = [];
    for (const [uid, u] of this.users) if (!u.stale) others.push({ uid, ...u.data });
    others.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const all = [{ uid: this.app.uid, ...meData, me: true }, ...others];
    $('#user-count').textContent = all.length;
    reconcile(list, all, (u) => u.uid, (u) => JSON.stringify([u.name, u.rating, u.rec, u.st, u.av, u.me]), (u) => {
      const st = this._userStatus(u);
      const rec = u.rec || { w: 0, l: 0, d: 0 };
      return `<li class="user-item" data-uid="${esc(u.uid)}">
        ${avatar(u.av, 36)}
        <div class="u-main">
          <div class="u-name"><span>${esc(u.name)}</span>${u.me ? '<span class="u-me">나</span>' : ''}</div>
          <div class="u-sub">${tierBadge(u.rating)}<span class="rating">${u.rating ?? ''}</span><span>${rec.w}승 ${rec.l}패</span></div>
        </div>
        <span class="u-st ${st === 'game' || st === 'spec' ? 'is-game' : st === 'room' ? 'is-room' : ''}">${statusLabel(st)}</span>
      </li>`;
    });
  }

  renderMe() {
    const p = this.app.profile;
    const s = store.getStats();
    const total = s.w + s.l + s.d;
    const wr = total ? Math.round((s.w / total) * 100) : 0;
    const ps = this.app.settings.pieceSet || 'classic';
    const sig = JSON.stringify([p.name, p.av, s.rating, s.w, s.l, s.d, s.streak, ps, setName(ps)]);
    const card = $('#me-card');
    if (card.dataset.sig === sig) return;
    card.dataset.sig = sig;
    card.innerHTML = `
      <div class="me-top">
        ${avatar(p.av, 58)}
        <div style="min-width:0;flex:1">
          <div class="me-name"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
            <button class="icon-btn" data-action="edit-profile" title="닉네임/캐릭터 변경">${icon('edit')}</button></div>
          <div class="me-sub">${tierBadge(s.rating)}<span class="rating">${s.rating}</span>
            ${s.streak >= 2 ? `<span class="mini" style="height:20px">🔥 ${s.streak}연승</span>` : ''}</div>
        </div>
      </div>
      <div class="me-stats">
        <div class="me-stat"><b>${total}</b><span>대국</span></div>
        <div class="me-stat w"><b>${s.w}</b><span>승</span></div>
        <div class="me-stat"><b>${s.d}</b><span>무</span></div>
        <div class="me-stat l"><b>${s.l}</b><span>패</span></div>
      </div>
      <div class="wl-bar" title="승률 ${wr}%">${total ? `<i class="w" style="flex:${s.w}"></i><i class="d" style="flex:${s.d}"></i><i class="l" style="flex:${s.l}"></i>`.replace(/<i class="\w" style="flex:0"><\/i>/g, '') : ''}</div>
      <div class="me-set"><span class="muted">내 체스말</span>${setPreviewHTML(ps, 'w', 24)}<b>${esc(setName(ps))}</b><button class="btn btn-soft btn-sm" data-action="pick-set">바꾸기</button></div>
      <button class="btn btn-soft btn-sm" data-action="stats">${icon('chart')}<span>전적 자세히 보기 · 승률 ${wr}%</span></button>`;
  }

  // ---------------------------------------------------------------- modals
  openCreateRoom(prefill = {}) {
    const title0 = prefill.title || ROOM_TITLES[Math.floor(Math.random() * ROOM_TITLES.length)];
    let tc = prefill.tc || this.app.settings.lastTc || DEFAULT_TC;
    let hc = prefill.hc || this.app.settings.lastHc || 'r';
    const body = el(`<div class="create-room">
      <div class="form-row">
        <span class="lbl">방 제목</span>
        <input class="input" id="cr-title" maxlength="24" value="${esc(title0)}">
      </div>
      <div class="form-row">
        <span class="lbl">${icon('clock')}시간 제한 <span class="muted" style="font-weight:600">(분 + 수당 추가 초)</span></span>
        <div class="chips" id="cr-tc"></div>
      </div>
      <div class="form-row">
        <span class="lbl">${icon('crown')}내 진영</span>
        <div class="chips" id="cr-hc"></div>
      </div>
      <div class="form-row">
        <span class="lbl">${icon('lock')}비밀번호 <span class="muted" style="font-weight:600">(선택 · 비우면 공개방)</span></span>
        <input class="input" id="cr-pw" maxlength="12" placeholder="비밀번호 없음" autocomplete="off">
      </div>
    </div>`);
    const tcBox = body.querySelector('#cr-tc');
    const renderTc = () => {
      tcBox.innerHTML = TIME_CONTROLS.map((t) => `<button type="button" class="chip ${t.b === tc.b && t.i === tc.i ? 'on' : ''}" data-b="${t.b}" data-i="${t.i}">${esc(fmtTCShort(t))}<small>${esc(tcCategory(t))}</small></button>`).join('');
    };
    renderTc();
    tcBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-b]');
      if (!b) return;
      tc = { b: +b.dataset.b, i: +b.dataset.i };
      renderTc();
    });
    const hcBox = body.querySelector('#cr-hc');
    const renderHc = () => {
      hcBox.innerHTML = Object.entries({ w: '백 (선공)', b: '흑 (후공)', r: '랜덤', alt: '판마다 교대' })
        .map(([k, v]) => `<button type="button" class="chip ${hc === k ? 'on' : ''}" data-hc="${k}">${k === 'w' ? pieceIcon('wk') : k === 'b' ? pieceIcon('bk') : ''}${v}</button>`).join('');
    };
    renderHc();
    hcBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-hc]');
      if (!b) return;
      hc = b.dataset.hc;
      renderHc();
    });
    const m = openModal({
      title: '방 만들기', body,
      actions: [
        { label: '취소' },
        {
          label: '만들기', kind: 'primary', icon: 'plus',
          onClick: async () => {
            const title = body.querySelector('#cr-title').value.trim() || title0;
            const pw = body.querySelector('#cr-pw').value.trim();
            this.app.saveSettings({ lastTc: tc, lastHc: hc });
            m.close('ok');
            await this.app.createRoom({ title, tc, hc, pw });
            return false;
          },
        },
      ],
    });
    body.querySelector('#cr-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); m.el.querySelector('.modal-foot .btn-primary').click(); }
    });
  }

  quickJoin() {
    const rooms = this.rooms.filter((r) => r.st === 'wait' && !r.guest && !r.lock && r.hostUid !== this.app.uid);
    rooms.sort((a, b) => (a.created || 0) - (b.created || 0));
    if (rooms.length) {
      this.app.joinRoom(rooms[0].id);
      return;
    }
    toast('입장할 수 있는 방이 없어서 새 방을 만들었어요', { type: 'info', icon: 'bolt' });
    const title = ROOM_TITLES[Math.floor(Math.random() * ROOM_TITLES.length)];
    this.app.createRoom({ title, tc: this.app.settings.lastTc || DEFAULT_TC, hc: this.app.settings.lastHc || 'r', pw: '' });
  }

  openUser(uid) {
    if (uid === this.app.uid) { this.app.openProfileEditor(); return; }
    const d = this.userData(uid);
    if (!d) return;
    const h = store.headToHead(uid);
    const known = store.getPlayers()[uid];
    const rec = d.rec || { w: 0, l: 0, d: 0 };
    const total = rec.w + rec.l + rec.d;
    const room = this.app.room;
    const canInvite = room && !room.closed && (d.st === 'lobby' || !d.st) && !(room.state?.guest && room.state.st === 'play');
    const aka = (known?.aka || []).filter((n) => n !== d.name);
    const body = `
      <div class="profile-head">
        ${avatar(d.av, 70)}
        <div style="min-width:0">
          <div class="profile-name">${esc(d.name)}</div>
          <div class="me-sub">${tierBadge(d.rating)}<span class="rating">${d.rating ?? '-'}</span><span class="u-st">${statusLabel(d.st)}</span></div>
          ${aka.length ? `<div class="hint" style="margin-top:4px">이전 닉네임: ${aka.map(esc).join(', ')}</div>` : ''}
        </div>
      </div>
      <div class="me-stats">
        <div class="me-stat"><b>${total}</b><span>대국</span></div>
        <div class="me-stat w"><b>${rec.w}</b><span>승</span></div>
        <div class="me-stat"><b>${rec.d}</b><span>무</span></div>
        <div class="me-stat l"><b>${rec.l}</b><span>패</span></div>
      </div>
      <div class="h2h">
        <div><div class="lbl">나와의 상대 전적</div><div class="hint">${h.games ? `총 ${h.games}판` : '아직 대국 기록이 없어요'}</div></div>
        <div class="score"><span class="w">${h.w}승</span> <span class="d">${h.d}무</span> <span class="l">${h.l}패</span></div>
      </div>`;
    const actions = [{ label: '닫기' }];
    if (canInvite) actions.push({ label: '내 방으로 초대', kind: 'primary', icon: 'mail', onClick: () => this.invite(uid) });
    else if (d.room && d.room.id) actions.push({ label: d.room.st === 'play' ? '관전하기' : '방으로 가기', kind: 'primary', onClick: () => this.app.joinRoom(d.room.id) });
    else if (d.rid && (d.st === 'game' || d.st === 'room')) actions.push({ label: '그 방으로 가기', kind: 'primary', onClick: () => this.app.joinRoom(d.rid) });
    openModal({ title: '플레이어 정보', body, actions, size: 'sm' });
  }
}
