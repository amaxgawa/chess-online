// Chess Lounge — application bootstrap and screen flow.
import { Chess } from 'chess.js';
import { $, $$, esc, randId, Emitter, sleep } from './util.js';
import * as store from './store.js';
import { Net } from './net.js';
import { Sound } from './sound.js';
import { Board3D, renderPieceThumbnails } from './three/board3d.js';
import { Lobby } from './lobby.js';
import { RoomController } from './room.js';
import { GameController, localInfo, replayInfo, replayResult } from './game.js';
import { openStats } from './stats.js';
import { openSettings, openProfileEditor, openConnInfo, avatarPicker, sanitizeName, openPieceSetPicker } from './settings.js';
import { loadPieceSets, preloadAll, getSet, readySet, ensureSet, ROLES } from './pieceSets.js';
import {
  showScreen, toast, openModal, confirmDialog, promptDialog, setThumbnails, closeAllModals, tierBadge,
} from './ui.js';
import { NAMESPACE, BROKERS, CUSTOM_BROKER, APP_VERSION, PROTOCOL, APP_NAME } from './config.js';

const TITLE = document.title;

class App {
  constructor() {
    this.emitter = new Emitter();
    this.profile = store.getProfile();
    this.uid = this.profile.uid;
    this.settings = store.getSettings();
    this.sfx = new Sound();
    this.room = null;
    this.game = null;
    this.screen = 'boot';
    this.theme = 'light';
    this.entered = false;
    const q = new URLSearchParams(location.search);
    this.lobbyParam = (q.get('lobby') || '').replace(/[+#/\s]+/g, '-').slice(0, 24);
    this.lobbyName = this.lobbyParam ? `우리끼리 · ${this.lobbyParam}` : '전체 로비';
    this.ns = NAMESPACE + (this.lobbyParam ? '/x-' + encodeURIComponent(this.lobbyParam.toLowerCase()) : '');
  }

  // ================================================================= boot
  async boot() {
    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.applyTheme());
    this.sfx.enabled = this.settings.sound;
    this.sfx.volume = this.settings.volume;
    document.body.classList.toggle('muted', !this.settings.sound);

    try {
      this.board = new Board3D($('#stage'), { onSound: (n, m) => this._onBoardSound(n, m) });
      this.board.setBoardStyle(this.settings.boardStyle);
      this.board.setTheme(this.theme);
      this.board.setAnimSpeed(this.settings.animSpeed);
      this.board.setShowLegal(this.settings.showLegal);
      this.board.setPosition(new Chess().board(), { animate: false });
      this.board.setIdle(true);
    } catch (e) {
      console.error(e);
      this.board = null;
    }
    setTimeout(() => {
      try {
        const thumbs = renderPieceThumbnails();
        setThumbnails(thumbs);
        this.board?.setRoleIcons(thumbs);
      } catch (e) { console.warn('thumbnails', e); }
    }, 30);
    this.setsReady = loadPieceSets().then((list) => {
      if (this.settings.pieceSet !== 'classic' && !getSet(this.settings.pieceSet)) this.saveSettings({ pieceSet: 'classic' });
      preloadAll();
      this.lobby?.renderMe();
      return list;
    });

    const brokers = [...(CUSTOM_BROKER ? [CUSTOM_BROKER] : []), ...BROKERS];
    this.net = new Net({ ns: this.ns, uid: this.uid, brokers });
    this.net.on('status', (s) => this._onNetStatus(s));
    this.lobby = new Lobby(this);
    this._bindGlobal();

    const otherTab = await this._checkOtherTabs();
    const active = store.getActive();
    this.net.connect(this.settings.broker).catch(() => {});
    $('#boot-splash').classList.add('hide');
    setTimeout(() => $('#boot-splash')?.remove(), 500);

    if (!this.board) {
      openModal({
        title: '3D를 표시할 수 없어요', dismissible: false, closeButton: false,
        body: '<p class="modal-msg">이 브라우저(또는 기기)에서 WebGL을 사용할 수 없어서 체스판을 그릴 수 없어요. 최신 Chrome, Edge, Safari, Firefox에서 열어 주세요. 하드웨어 가속이 꺼져 있다면 켜 주세요.</p>',
        actions: [{ label: '새로고침', kind: 'primary', onClick: () => location.reload() }],
      });
    }
    if (active && this.profile.name && !otherTab) this._resumeFlow(active);
    else this._showEntry(otherTab);
  }

  // ================================================================= theme / settings
  applyTheme() {
    const pref = this.settings.theme;
    const t = pref === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
    this.theme = t;
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#111317' : '#f3efe7');
    this.board?.setTheme(t);
  }

  toggleTheme() {
    this.saveSettings({ theme: this.theme === 'dark' ? 'light' : 'dark' });
    this.applyTheme();
  }

  saveSettings(patch) {
    this.settings = store.setSettings(patch);
    if ('sound' in patch) { this.sfx.enabled = patch.sound; document.body.classList.toggle('muted', !patch.sound); }
    if ('volume' in patch) this.sfx.volume = patch.volume;
    if ('boardStyle' in patch) this.board?.setBoardStyle(patch.boardStyle);
    if ('animSpeed' in patch) this.board?.setAnimSpeed(patch.animSpeed);
    if ('showLegal' in patch) this.board?.setShowLegal(patch.showLegal);
  }

  setProfile(patch) {
    this.profile = store.updateProfile(patch);
    this.updatePresence();
    this.room?.updateMyInfo();
    this.lobby.render();
  }

  setPieceSet(id) {
    if (!getSet(id)) return;
    this.saveSettings({ pieceSet: id });
    ensureSet(id);
    this.updatePresence();
    this.room?.updateMyInfo();
    this.lobby.renderMe();
    const g = this.game;
    if (g && g.mode === 'local' && !g.destroyed) {
      g.info.w.ps = id;
      g.info.b.ps = id;
      this.applyGameSets(g.info);
      g.renderAll();
    }
  }

  /** apply both sides' piece sets for a game (images load in the background if needed) */
  applyGameSets(info) {
    const want = { w: info?.w?.ps || 'classic', b: info?.b?.ps || 'classic' };
    this._wantSets = want;
    const apply = () => {
      if (this._wantSets !== want) return;
      this.board?.setPieceSets({ w: readySet(want.w), b: readySet(want.b) });
    };
    apply();
    this.setGameIcons(info);
    for (const c of ['w', 'b']) {
      const def = getSet(want[c]);
      if (def?.kind === 'image' && !readySet(want[c])) ensureSet(want[c]).then(apply);
    }
  }

  setGameIcons(info) {
    const root = document.documentElement;
    for (const c of ['w', 'b']) {
      const def = getSet(info?.[c]?.ps);
      for (const r of ROLES) {
        if (def && def.kind === 'image') root.style.setProperty(`--gpc-${c}${r}`, `url("${new URL(def.images[r], location.href).href}")`);
        else root.style.removeProperty(`--gpc-${c}${r}`);
      }
    }
  }

  onStatsChanged() {
    this.lobby.renderMe();
    this.updatePresence();
  }

  me() {
    const s = store.getStats();
    return { uid: this.uid, name: this.profile.name, rating: s.rating, rec: { w: s.w, l: s.l, d: s.d }, av: this.profile.av, ps: this.settings.pieceSet || 'classic' };
  }

  presenceData() {
    const s = store.getStats();
    let st = 'lobby', rid = null, room = null;
    if (this.room && !this.room.closed) {
      rid = this.room.id;
      const g = this.game;
      st = g && g.room === this.room && !g.over && this.screen === 'game' ? (g.isPlayer ? 'game' : 'spec') : 'room';
      if (g && g.room === this.room && g.isPlayer && !g.over) st = 'game';
      if (this.room.isHost && this.room.state) room = this.room.summary();
    } else if (this.game?.mode === 'local' && this.screen === 'game') st = 'practice';
    return {
      v: PROTOCOL, ver: APP_VERSION, uid: this.uid, name: this.profile.name, av: this.profile.av,
      rating: s.rating, rec: { w: s.w, l: s.l, d: s.d }, st, rid, room,
    };
  }

  updatePresence() {
    if (!this.entered || !this.profile.name) return;
    this.net.setPresence(this.presenceData());
    this.lobby.renderSoon();
  }

  onPresenceChange(uid, data) {
    const rc = this.room;
    if (!rc?.isHost || !data?.room || rc.closed) return;
    if (data.room.no === rc.state.no && data.room.id !== rc.id) {
      const theirs = data.room.created || 0, mine = rc.state.created || 0;
      if (theirs < mine || (theirs === mine && data.room.id < rc.id)) {
        rc.state.no = this.lobby.nextRoomNo();
        rc.commit();
      }
    }
  }

  // ================================================================= connection
  async _ensureConnected() {
    if (this.net.online) return;
    await this.net.connect(this.settings.broker);
  }

  _onNetStatus(s) {
    const pill = $('#conn-pill');
    const es = $('#entry-status');
    const name = this.net.broker?.name || '';
    const map = {
      online: ['online', `${name} 연결됨`, 'ok', `서버 연결됨 · ${name}`],
      connecting: ['busy', '연결 중…', 'busy', '서버에 연결하는 중…'],
      reconnecting: ['busy', '다시 연결 중…', 'busy', '다시 연결하는 중…'],
      failed: ['err', '연결 실패', 'err', '서버에 연결하지 못했어요 · 잠시 후 다시 시도해 주세요'],
      closed: ['err', '연결 종료', 'err', '연결이 종료됐어요'],
    }[s] || ['', s, '', s];
    pill.className = `conn-pill ${map[0]}`;
    pill.querySelector('span').textContent = map[1];
    es.className = `entry-status ${map[2]}`;
    es.querySelector('span').textContent = map[3];
    if (!this.entered) return;
    if (s === 'reconnecting' && !this._netToast) {
      this._netToast = toast('연결이 불안정해요. 다시 연결하는 중…', { type: 'warn', icon: 'wifi', timeout: 0 });
    } else if (s === 'online' && this._netToast) {
      this._netToast.close();
      this._netToast = null;
      toast('다시 연결됐어요', { type: 'success', icon: 'wifi' });
    }
  }

  async _checkOtherTabs() {
    if (!('BroadcastChannel' in window)) return false;
    this.tabId = randId(6);
    const bc = (this.bc = new BroadcastChannel('chess-lounge-' + this.ns));
    let other = false;
    bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'hello' && m.id !== this.tabId && this.entered) bc.postMessage({ t: 'here', id: this.tabId, to: m.id });
      else if (m.t === 'here' && m.to === this.tabId) other = true;
      else if (m.t === 'takeover' && m.id !== this.tabId && this.entered) this._takenOver();
    };
    bc.postMessage({ t: 'hello', id: this.tabId });
    await sleep(160);
    this._otherTab = other;
    return other;
  }

  _takenOver() {
    this.entered = false;
    this.net.close();
    this.game?.destroy();
    this.board?.pause();
    closeAllModals();
    openModal({
      title: '다른 탭에서 접속했어요', dismissible: false, closeButton: false,
      body: '<p class="modal-msg">같은 브라우저의 다른 탭에서 Chess Lounge에 접속해서 이 탭의 연결을 끊었어요.</p>',
      actions: [{ label: '이 탭에서 다시 접속', kind: 'primary', onClick: () => location.reload() }],
    });
  }

  // ================================================================= screens
  _moveStage(where) {
    const stage = $('#stage');
    if (!stage) return;
    const target = where === 'game' ? $('#board-area') : $('#bg-holder');
    if (stage.parentElement !== target) target.prepend(stage);
    this.board?.resize();
  }

  _setScreen(name) {
    this.screen = name;
    showScreen(name);
  }

  _showEntry(otherTab = false) {
    this._setScreen('entry');
    this._moveStage('bg');
    this.board?.resume();
    this.board?.setIdle(true);
    const p = this.profile;
    $('#entry-name').value = p.name || '';
    avatarPicker($('#entry-avatar'), p.av, (av) => { this.profile = store.updateProfile({ av }); });
    const s = store.getStats();
    const w = $('#entry-welcome');
    if (otherTab) {
      w.hidden = false;
      w.innerHTML = '⚠️ 다른 탭에서 이미 접속 중이에요. 여기서 입장하면 그 탭의 연결은 끊겨요.';
    } else if (p.name && s.games) {
      w.hidden = false;
      w.innerHTML = `👋 <span><b>${esc(p.name)}</b>님, 다시 오셨네요! ${tierBadge(s.rating)} ${s.rating} · ${s.w}승 ${s.d}무 ${s.l}패</span>`;
    } else w.hidden = true;
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => $('#entry-name').focus(), 400);
  }

  async _enter(e) {
    e?.preventDefault();
    this.sfx.unlock();
    const input = $('#entry-name');
    const name = sanitizeName(input.value);
    if (!name) {
      input.focus();
      toast('닉네임을 입력해 주세요', { type: 'error' });
      return;
    }
    if (name !== this.profile.name) this.profile = store.updateProfile({ name });
    const btn = $('#entry-go');
    btn.disabled = true;
    btn.querySelector('span').textContent = '연결 중…';
    try {
      await this._ensureConnected();
    } catch {
      toast('서버에 연결할 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', { type: 'error', timeout: 6000 });
      btn.disabled = false;
      btn.querySelector('span').textContent = '입장하기';
      return;
    }
    if (this._otherTab) this.bc?.postMessage({ t: 'takeover', id: this.tabId });
    btn.disabled = false;
    btn.querySelector('span').textContent = '입장하기';
    this.entered = true;
    this.lobby.start();
    this.updatePresence();
    this.showLobby();
    this.sfx.play('join');
  }

  async _resumeFlow(active) {
    this._showEntry();
    const es = $('#entry-status span');
    es.textContent = '진행 중이던 게임에 다시 연결하는 중…';
    try {
      await this._ensureConnected();
    } catch {
      toast('서버에 연결할 수 없어 게임을 이어갈 수 없어요', { type: 'error' });
      store.clearActive();
      return;
    }
    this.entered = true;
    this.lobby.start();
    try {
      const rc = await RoomController.resume(this, active);
      this.room = rc;
      rc._beginGame(active.info, { resume: { moves: active.moves || [], clk: active.clk, at: active.at, paused: active.paused || null } });
      this.updatePresence();
      toast('진행 중이던 게임에 다시 연결했어요', { type: 'success', icon: 'wifi' });
    } catch (e) {
      console.error(e);
      store.clearActive();
      this.showLobby();
    }
  }

  showLobby() {
    this._setScreen('lobby');
    this._moveStage('bg');
    this.board?.pause();
    document.title = TITLE;
    this.lobby.render();
    this.updatePresence();
  }

  showRoom() {
    if (!this.room || this.room.closed) { this.showLobby(); return; }
    this._setScreen('room');
    this._moveStage('bg');
    this.board?.resume();
    this.board?.setIdle(true);
    this.room.render();
    this.updatePresence();
  }

  enterGame(gc, { late = false } = {}) {
    closeAllModals();
    if (this.game && this.game !== gc && (this.game.mode === 'local' || this.game.mode === 'replay' || this.game.over)) {
      this.game.destroy();
    }
    const reentry = this.game === gc && gc.started;
    this.game = gc;
    this._setScreen('game');
    this._moveStage('game');
    this.board?.resume();
    this.board?.setIdle(false);
    if (!reentry) {
      gc.started = true;
      gc.start({ late });
    } else {
      this.board.setOrientation(gc.orient, false);
      gc._syncBoard(false);
      $('#screen-game').dataset.mode = gc.mode;
      gc.renderAll();
      gc._updateInteraction();
    }
    this.updatePresence();
    if (document.hidden && gc.isPlayer) this.notifyTurn('게임 시작!');
  }

  backToRoom() {
    closeAllModals();
    const g = this.game;
    if (g && (g.over || g.mode === 'local' || g.mode === 'replay')) {
      g.destroy();
      if (this.room?.game === g) this.room.game = null;
      this.game = null;
    }
    if (!this.room || this.room.closed) { this.showLobby(); return; }
    this.showRoom();
  }

  async exitGame() {
    const g = this.game;
    if (!g) { this.backToRoom(); return; }
    if (g.mode === 'local') {
      if (g.moves.length && !g.over) {
        const ok = await confirmDialog({ title: '연습 종료', message: '연습 게임을 끝낼까요?', ok: '끝내기' });
        if (!ok) return;
      }
      this.backToRoom();
      return;
    }
    if (g.mode === 'replay') {
      this.backToRoom();
      if (!this.room) openStats(this);
      return;
    }
    if (g.isPlayer && !g.over) {
      const ok = await confirmDialog({ title: '기권하고 나갈까요?', message: '게임 도중에 나가면 <b>기권패</b>로 기록돼요.', ok: '기권하고 나가기', danger: true });
      if (!ok || g.over) return;
      g.resign(true);
    }
    this.backToRoom();
  }

  // ================================================================= rooms
  async createRoom(opts) {
    if (this.room && !this.room.closed) { toast('이미 방에 들어와 있어요'); this.showRoom(); return; }
    try {
      await this._ensureConnected();
    } catch {
      toast('서버에 연결되어 있지 않아요', { type: 'error' });
      return;
    }
    const rc = await RoomController.create(this, opts);
    this.room = rc;
    this.updatePresence();
    this.showRoom();
    rc.sys('방을 만들었어요! 친구가 들어오면 <b>준비</b> 후 게임을 시작할 수 있어요.');
    this.sfx.play('join');
  }

  async joinRoom(id, { invited = false } = {}) {
    if (this.room && !this.room.closed) {
      if (this.room.id === id) { this.room.game && !this.room.game.over ? this.enterGame(this.room.game) : this.showRoom(); return; }
      const ok = await confirmDialog({ title: '방 이동', message: '지금 있는 방에서 나가서 이동할까요?', ok: '이동' });
      if (!ok) return;
      await this.room.leave();
      if (this.room) return;
    }
    if (this.game && this.game.mode !== 'online') { this.game.destroy(); this.game = null; }
    const summary = this.lobby.findRoom(id);
    let pw = '';
    if (summary?.lock && !invited) {
      pw = await promptDialog({ title: '비밀방', message: `<b>#${summary.no} ${esc(summary.title)}</b> 방의 비밀번호를 입력하세요.`, type: 'password', maxLength: 12, ok: '입장' });
      if (pw === null) return;
    }
    const as = summary && (summary.st === 'play' || summary.guest) ? 'spec' : 'player';
    const t = toast('방에 들어가는 중…', { timeout: 0, icon: 'refresh' });
    try {
      await this._ensureConnected();
      const rc = await RoomController.join(this, id, { pw, as });
      this.room = rc;
      t.close();
      if (rc.state.st === 'play' && rc.state.game) rc._beginGame(rc.state.game, { late: true });
      else this.showRoom();
      this.updatePresence();
      rc.sys(rc.isSpec ? '관전석에 들어왔어요.' : '방에 들어왔어요! 준비되면 <b>준비 완료</b>를 눌러 주세요.');
    } catch (e) {
      t.close();
      const msg = { pw: '비밀번호가 맞지 않아요', full: '방이 가득 찼어요', timeout: '방이 응답하지 않아요. 이미 사라진 방일 수 있어요' }[e.reason] || '방에 들어가지 못했어요';
      toast(msg, { type: 'error' });
      this.lobby.renderSoon();
    }
  }

  onRoomClosed(rc, msg, type = 'info') {
    if (this.room !== rc) return;
    this.room = null;
    if (this.game && this.game.room === rc) { this.game.destroy(); this.game = null; }
    store.clearActive();
    closeAllModals();
    this.updatePresence();
    this.showLobby();
    if (msg) toast(msg, { type });
  }

  startPractice() {
    if (this.room && !this.room.closed) { toast('연습 모드는 방에서 나온 뒤 할 수 있어요'); return; }
    const gc = new GameController(this, { mode: 'local', info: localInfo(this.profile, this.settings.pieceSet) });
    this.enterGame(gc);
  }

  replayGame(rec) {
    if (this.game && this.game.isPlayer && !this.game.over) { toast('게임 중에는 다시보기를 열 수 없어요'); return; }
    const moves = String(rec.moves || '').split(' ').filter(Boolean);
    const gc = new GameController(this, {
      mode: 'replay', info: replayInfo(rec, this.profile),
      replay: { moves, result: replayResult(rec), reason: rec.reason, color: rec.color },
    });
    this.enterGame(gc);
  }

  openStats() { openStats(this); }
  openSettings(tab) { openSettings(this, tab); }
  openProfileEditor() { openProfileEditor(this); }

  notifyTurn(text = '내 차례!') {
    if (!document.hidden) return;
    document.title = `♟ ${text} · ${APP_NAME}`;
  }

  _onBoardSound(name, m) {
    this.sfx.play(name);
    if (m && /[+#]$/.test(m.san || '')) setTimeout(() => this.sfx.play('check'), 90);
  }

  // ================================================================= global UI wiring
  _bindGlobal() {
    $('#entry-form').addEventListener('submit', (e) => this._enter(e));
    document.addEventListener('pointerdown', () => this.sfx.unlock(), { once: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = TITLE; });
    window.addEventListener('beforeunload', (e) => {
      if (this.game?.isPlayer && !this.game.over) {
        this.game.saveActive();
        e.preventDefault();
        e.returnValue = '';
      }
    });

    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-action]');
      if (!t || t.disabled) return;
      this._action(t.dataset.action, t, e);
    });

    $('#move-list').addEventListener('click', (e) => {
      const m = e.target.closest('[data-ply]');
      if (m && this.game) this.game._view(+m.dataset.ply);
    });
    $('#emotes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-emote]');
      if (!b || !this.game) return;
      this.game.sendEmote(b.dataset.emote);
    });
    const chatSubmit = (form) => form.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = form.querySelector('input');
      const text = inp.value.trim();
      if (!text || !this.room) return;
      inp.value = '';
      this.room.sendChat(text);
    });
    chatSubmit($('#room-chat-form'));
    chatSubmit($('#game-chat-form'));
  }

  _action(a, t) {
    const g = this.game, r = this.room;
    switch (a) {
      case 'theme': this.toggleTheme(); break;
      case 'practice': this.startPractice(); break;
      case 'stats': this.openStats(); break;
      case 'settings': this.openSettings(); break;
      case 'pick-set': openPieceSetPicker(this); break;
      case 'conn-info': openConnInfo(this); break;
      case 'create-room': this.lobby.openCreateRoom(); break;
      case 'quick-join': this.lobby.quickJoin(); break;
      case 'leave-room': r?.leave(); break;
      case 'room-start': r?.startGame(); break;
      case 'room-ready': r?.toggleReady(); break;
      case 'room-sit': r?.sit(); break;
      case 'room-stand': r?.stand(); break;
      case 'room-kick': r?.kick(t.dataset.uid); break;
      case 'room-tc': r?.setSetting({ tc: { b: +t.dataset.b, i: +t.dataset.i } }); break;
      case 'room-hc': r?.setSetting({ hc: t.dataset.hc }); break;
      case 'room-rename': r?.renameRoom(); break;
      case 'room-password': r?.setPassword(); break;
      case 'room-invite': r?.openInvite(); break;
      case 'room-watch': if (r?.game) this.enterGame(r.game); break;
      case 'game-exit': this.exitGame(); break;
      case 'view-default': this.board?.setView('default', true); break;
      case 'view-top': this.board?.setView(this.board.viewPreset === 'top' ? 'default' : 'top', true); break;
      case 'view-flip': g ? g.flipView() : this.board?.setOrientation(this.board.orientation === 'w' ? 'b' : 'w'); break;
      case 'sound': this.saveSettings({ sound: !this.settings.sound }); toast(this.settings.sound ? '소리를 켰어요' : '소리를 껐어요', { icon: this.settings.sound ? 'volume' : 'mute', timeout: 1500 }); break;
      case 'nav-first': g?.nav('first'); break;
      case 'nav-prev': g?.nav('prev'); break;
      case 'nav-next': g?.nav('next'); break;
      case 'nav-last': g?.nav('last'); break;
      case 'g-takeback': g?.requestTakeback(); break;
      case 'g-draw': g?.offerDraw(); break;
      case 'g-resign': g?.resign(); break;
      case 'g-pgn': g?.copyPgn(); break;
      case 'g-room': this.backToRoom(); break;
      case 'g-new': g?.newLocalGame(); break;
      case 'g-pause': g?.togglePause(); break;
      case 'g-autoflip': if (g) { g.autoFlip = !g.autoFlip; g.renderAll(); toast(g.autoFlip ? '수를 둘 때마다 보드를 돌려요' : '자동 회전을 껐어요', { timeout: 1600, icon: 'swap' }); } break;
      case 'g-auto': g?.toggleAutoplay(); break;
      case 'g-close': this.exitGame(); break;
      default: break;
    }
  }
}

const app = new App();
window.__app = app;
app.boot().catch((e) => {
  console.error(e);
  $('#boot-splash')?.remove();
  toast('앱을 시작하지 못했어요: ' + (e?.message || e), { type: 'error', timeout: 0 });
});
