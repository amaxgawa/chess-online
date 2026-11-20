// Room (waiting room) controller. The host is authoritative for room state; every
// member talks on the room topic. Game messages on the same topic are forwarded to
// the active GameController.
import { $, el, esc, randId, fmtTC, fmtTCShort, tcCategory } from './util.js';
import { avatar, tierBadge, icon, pieceIcon, toast, openModal, appendChat, confirmDialog, promptDialog } from './ui.js';
import { TIME_CONTROLS } from './config.js';
import { COLOR_PREF } from './lobby.js';
import { setPreviewHTML, setName } from './pieceSets.js';
import { GameController } from './game.js';

const MAX_SPECS = 8;
const pickPlayer = (p) => (p ? { uid: p.uid, name: p.name, rating: p.rating, av: p.av, rec: p.rec, ps: p.ps || 'classic' } : null);

export class RoomController {
  constructor(app, { id, role }) {
    this.app = app;
    this.net = app.net;
    this.id = id;
    this.role = role; // 'host' | 'guest' | 'spec' | 'joining'
    this.topic = app.net.t('r/' + id);
    this.state = null;
    this.pw = '';
    this.closed = false;
    this.waiters = [];
    this.game = null;
    this.lastHostColor = null;
    this._seen = new Set();
    this._handler = (data) => this._onMsg(data);
    this._unsubs = [];
    this._takeoverTimer = null;
  }

  get isHost() { return this.role === 'host'; }
  get isGuest() { return this.role === 'guest'; }
  get isSpec() { return this.role === 'spec'; }
  get uid() { return this.app.uid; }

  // ---------------------------------------------------------------- creation / joining
  static async create(app, { title, tc, hc, pw }) {
    const id = randId(10);
    const rc = new RoomController(app, { id, role: 'host' });
    rc.pw = pw || '';
    rc.state = {
      id, no: app.lobby.nextRoomNo(), title: String(title).slice(0, 24), lock: !!pw, tc, hc,
      host: pickPlayer(app.me()), guest: null, specs: [], st: 'wait', gid: null, game: null,
      created: Date.now(), seq: 0,
    };
    await rc.open();
    return rc;
  }

  static async join(app, roomId, { pw = '', as = 'player' } = {}) {
    const rc = new RoomController(app, { id: roomId, role: 'joining' });
    await rc.open();
    const me = app.me();
    rc.send({ t: 'join', name: me.name, rating: me.rating, rec: me.rec, av: me.av, ps: me.ps, pw, as });
    const res = await rc.waitFor((m) => (m.t === 'welcome' || m.t === 'deny') && m.to === app.uid, 7000);
    if (!res || res.t === 'deny') {
      rc.dispose();
      const e = new Error(res ? res.reason : 'timeout');
      e.reason = res ? res.reason : 'timeout';
      throw e;
    }
    rc.role = res.role;
    rc.state = res.room;
    rc.pw = pw;
    return rc;
  }

  /** Recreate a room session after a page reload (from the saved active-game snapshot). */
  static async resume(app, snap) {
    const rc = new RoomController(app, { id: snap.rid, role: snap.role });
    rc.state = snap.room;
    rc.pw = snap.pw || '';
    rc.lastHostColor = snap.lastHostColor || null;
    await rc.open();
    if (!rc.isHost) {
      const me = app.me();
      rc.send({ t: 'join', name: me.name, rating: me.rating, rec: me.rec, av: me.av, ps: me.ps, pw: snap.pw || '', as: 'player', rejoin: true });
    }
    return rc;
  }

  async open() {
    await this.net.subscribe(this.topic, this._handler);
    this._unsubs.push(
      this.app.emitter.on('user-gone', (uid) => this._onUserGone(uid)),
      this.app.emitter.on('user-back', (uid) => this._onUserBack(uid)),
      this.app.net.on('reconnected', () => this._onReconnected()),
    );
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._takeoverTimer);
    this.net.unsubscribe(this.topic, this._handler);
    for (const u of this._unsubs) u();
    this._unsubs = [];
    this.game?.destroy();
    this.game = null;
    for (const w of this.waiters) w.resolve(null);
  }

  send(msg) {
    msg.f = this.app.uid;
    msg.mid = randId(6);
    this.net.publish(this.topic, msg, { qos: 1 });
  }

  waitFor(match, ms) {
    return new Promise((resolve) => {
      const w = {
        match,
        resolve: (m) => {
          clearTimeout(w.timer);
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve(m);
        },
      };
      w.timer = setTimeout(() => w.resolve(null), ms);
      this.waiters.push(w);
    });
  }

  summary() {
    const s = this.state;
    const p = (x) => x && { uid: x.uid, name: x.name, rating: x.rating, av: x.av };
    return {
      id: s.id, no: s.no, title: s.title, lock: !!s.lock, tc: s.tc, hc: s.hc,
      host: p(s.host), guest: p(s.guest), st: s.st, specs: s.specs.length, created: s.created,
    };
  }

  /** host: broadcast + presence + render */
  commit() {
    if (!this.isHost || this.closed) return;
    this.state.seq = (this.state.seq || 0) + 1;
    this.state.host = { ...pickPlayer(this.app.me()) };
    this.send({ t: 'room', room: this.state });
    this.app.updatePresence();
    this.render();
    this._saveSnapshot();
  }

  _saveSnapshot() {
    if (this.game && this.game.isPlayer && !this.game.over) this.game.saveActive();
  }

  // ---------------------------------------------------------------- messages
  _onMsg(m) {
    if (!m || !m.t || this.closed) return;
    if (m.f === this.uid) return;
    if (m.mid) {
      if (this._seen.has(m.mid)) return;
      this._seen.add(m.mid);
      if (this._seen.size > 500) this._seen = new Set([...this._seen].slice(-250));
    }
    for (const w of [...this.waiters]) if (w.match(m)) w.resolve(m);
    switch (m.t) {
      case 'join': if (this.isHost) this._hostJoin(m); break;
      case 'room': if (!this.isHost) this._applyRoom(m.room, m.f); break;
      case 'leave': if (this.isHost) this._hostRemove(m.f, 'leave'); break;
      case 'ready': if (this.isHost) this._hostReady(m); break;
      case 'sit': if (this.isHost) this._hostSit(m.f); break;
      case 'stand': if (this.isHost) this._hostStand(m.f); break;
      case 'kick': if (m.to === this.uid) this._kicked(); break;
      case 'prof': if (this.isHost) this._hostProf(m); break;
      case 'close': this._onClose(m); break;
      case 'chat': this._onChat(m); break;
      case 'emote': this.game?.onEmote(m); break;
      case 'start': if (!this.isHost && m.game) this._onStart(m.game); break;
      case 'welcome': case 'deny': break;
      default: this.game?.onNet(m);
    }
  }

  _infoFrom(m) {
    return { uid: m.f, name: String(m.name || '플레이어').slice(0, 12), rating: m.rating, rec: m.rec, av: m.av, ps: typeof m.ps === 'string' ? m.ps.slice(0, 32) : 'classic' };
  }

  _hostJoin(m) {
    const s = this.state;
    const info = this._infoFrom(m);
    const known = s.guest?.uid === m.f || s.specs.some((x) => x.uid === m.f);
    if (s.lock && !known && m.pw !== this.pw) {
      this.send({ t: 'deny', to: m.f, reason: 'pw' });
      return;
    }
    let role;
    if (s.guest?.uid === m.f) {
      role = 'guest';
      s.guest = { ...s.guest, ...info };
    } else if (s.specs.some((x) => x.uid === m.f)) {
      role = 'spec';
    } else if (!s.guest && s.st === 'wait' && m.as !== 'spec') {
      s.guest = { ...info, ready: false };
      role = 'guest';
    } else {
      if (s.specs.length >= MAX_SPECS) {
        this.send({ t: 'deny', to: m.f, reason: 'full' });
        return;
      }
      s.specs.push({ uid: info.uid, name: info.name, av: info.av, rating: info.rating, rec: info.rec, ps: info.ps });
      role = 'spec';
    }
    this.send({ t: 'welcome', to: m.f, role, room: s });
    this.commit();
    if (!known) {
      this.sys(`<b>${esc(info.name)}</b>님이 ${role === 'guest' ? '입장했어요' : '관전하러 왔어요'}`);
      this.app.sfx.play('join');
    } else if (this.game && !this.game.over) {
      this.game.onPeerRejoined?.(m.f);
    }
  }

  _hostRemove(uid, why) {
    const s = this.state;
    let name = null;
    if (s.guest?.uid === uid) {
      name = s.guest.name;
      if (s.st === 'play' && this.game && !this.game.over) {
        // opponent left during play: treat as resignation if they didn't already
        this.game.onOpponentLeft();
      }
      s.guest = null;
    } else {
      const sp = s.specs.find((x) => x.uid === uid);
      if (sp) name = sp.name;
      s.specs = s.specs.filter((x) => x.uid !== uid);
    }
    if (!name) return;
    this.commit();
    this.sys(`<b>${esc(name)}</b>님이 ${why === 'kick' ? '강퇴됐어요' : why === 'gone' ? '연결이 끊겨 퇴장했어요' : '나갔어요'}`);
    this.app.sfx.play('leave');
  }

  _hostReady(m) {
    const s = this.state;
    if (s.guest?.uid !== m.f || s.st !== 'wait') return;
    s.guest.ready = !!m.v;
    if (m.info) Object.assign(s.guest, { rating: m.info.rating, rec: m.info.rec, av: m.info.av, name: m.info.name });
    this.commit();
    this.app.sfx.play(m.v ? 'ready' : 'chat');
  }

  _hostSit(uid) {
    const s = this.state;
    if (s.guest || s.st !== 'wait') return;
    const sp = s.specs.find((x) => x.uid === uid);
    if (!sp) return;
    s.specs = s.specs.filter((x) => x.uid !== uid);
    s.guest = { ...sp, ready: false, rec: sp.rec };
    this.commit();
    this.sys(`<b>${esc(sp.name)}</b>님이 자리에 앉았어요`);
  }

  _hostStand(uid) {
    const s = this.state;
    if (s.guest?.uid !== uid || s.st !== 'wait') return;
    const g = s.guest;
    s.guest = null;
    s.specs.push({ uid: g.uid, name: g.name, av: g.av, rating: g.rating, rec: g.rec, ps: g.ps });
    this.commit();
    this.sys(`<b>${esc(g.name)}</b>님이 관전석으로 이동했어요`);
  }

  _hostProf(m) {
    const s = this.state;
    const info = m.info || {};
    const upd = (x) => Object.assign(x, {
      name: typeof info.name === 'string' ? info.name.slice(0, 12) : x.name,
      rating: info.rating ?? x.rating, rec: info.rec ?? x.rec, av: info.av ?? x.av,
      ps: typeof info.ps === 'string' ? info.ps.slice(0, 32) : x.ps,
    });
    if (s.guest?.uid === m.f) upd(s.guest);
    else {
      const sp = s.specs.find((x) => x.uid === m.f);
      if (!sp) return;
      upd(sp);
    }
    this.commit();
  }

  /** my name / avatar / piece set changed */
  updateMyInfo() {
    if (this.closed || !this.state) return;
    if (this.isHost) { this.commit(); return; }
    const me = pickPlayer(this.app.me());
    const mine = this.state.guest?.uid === this.uid ? this.state.guest : this.state.specs.find((x) => x.uid === this.uid);
    if (mine) Object.assign(mine, { name: me.name, av: me.av, rating: me.rating, rec: me.rec, ps: me.ps });
    this.send({ t: 'prof', info: me });
    this.render();
  }

  _applyRoom(room, from) {
    if (!room || room.id !== this.id) return;
    if (this.state && (room.seq || 0) < (this.state.seq || 0) && room.host?.uid === this.state.host?.uid) return;
    const prevRole = this.role;
    this.state = room;
    if (room.host?.uid === this.uid) this.role = 'host';
    else if (room.guest?.uid === this.uid) this.role = 'guest';
    else if (room.specs?.some((x) => x.uid === this.uid)) this.role = 'spec';
    else if (prevRole !== 'joining') {
      // we are no longer part of this room
      this._exit('방에서 나오게 됐어요');
      return;
    }
    clearTimeout(this._takeoverTimer);
    const g = this.game;
    if (g && !g.over && (g.mode === 'online' || g.mode === 'spec') && (room.st !== 'play' || room.gid !== g.info.gid)) {
      // the game finished while we were away
      const last = room.last;
      if (last && last.gid === g.info.gid) g._finish(last.result, last.reason, { fromSync: true });
      else g._finish('*', 'aborted', { fromSync: true });
    }
    if (room.st === 'play' && room.game && (!this.game || this.game.info.gid !== room.game.gid) && this.app.screen !== 'game') {
      // game in progress that we haven't joined yet (e.g. we were spectating the lobby view)
      this._onStart(room.game, { late: true });
      return;
    }
    this.render();
    void from;
  }

  _onStart(game, { late = false } = {}) {
    if (this.game && this.game.info.gid === game.gid) return;
    this._beginGame(game, { late });
  }

  _beginGame(game, { late = false, resume = null } = {}) {
    const myColor = game.w.uid === this.uid ? 'w' : game.b.uid === this.uid ? 'b' : null;
    this.game?.destroy();
    this.game = new GameController(this.app, {
      mode: myColor ? 'online' : 'spec', room: this, info: game, myColor, resume,
    });
    this.app.enterGame(this.game, { late: late || !!resume });
    this.app.updatePresence();
  }

  startGame() {
    const s = this.state;
    if (!this.isHost || !s.guest || !s.guest.ready || s.st !== 'wait') return;
    let hostColor;
    if (s.hc === 'w' || s.hc === 'b') hostColor = s.hc;
    else if (s.hc === 'alt' && this.lastHostColor) hostColor = this.lastHostColor === 'w' ? 'b' : 'w';
    else hostColor = Math.random() < 0.5 ? 'w' : 'b';
    this.lastHostColor = hostColor;
    const host = pickPlayer(this.app.me());
    const guest = pickPlayer(s.guest);
    const game = {
      gid: randId(10),
      w: hostColor === 'w' ? host : guest,
      b: hostColor === 'w' ? guest : host,
      tc: { ...s.tc }, at: Date.now(), rid: this.id, no: s.no,
    };
    s.st = 'play';
    s.gid = game.gid;
    s.game = game;
    s.guest.ready = false;
    this.send({ t: 'start', game });
    this.commit();
    this._beginGame(game);
  }

  /** called by GameController when a game finishes */
  onGameEnd(over) {
    const s = this.state;
    if (this.isHost && s.st === 'play') {
      if (over && s.gid) s.last = { gid: s.gid, result: over.result, reason: over.reason };
      s.st = 'wait';
      s.game = null;
      s.gid = null;
      if (s.guest) s.guest.ready = false;
      this.commit();
      // drop members that went offline during the game
      for (const uid of [s.guest?.uid, ...s.specs.map((x) => x.uid)]) {
        if (uid && !this.app.lobby.isOnline(uid)) this._scheduleRemoval(uid, 2500);
      }
    }
    this.app.updatePresence();
    // if the host vanished during the game, consider taking over now
    if (!this.isHost && s.host && !this.app.lobby.isOnline(s.host.uid)) this._scheduleTakeover(1500);
  }

  _onClose(m) {
    const s = this.state;
    if (!s || m.f !== s.host?.uid) return;
    if (m.transfer === this.uid) {
      this._becomeHost('방장이 나가서 내가 방장이 됐어요');
    } else if (!m.transfer) {
      this._exit('방장이 방을 닫았어요');
    } else {
      // someone else becomes host; wait for their broadcast
      s.host = null;
      this.render();
    }
  }

  _becomeHost(msg) {
    const s = this.state;
    if (!s || this.closed) return;
    const oldHost = s.host;
    if (s.guest?.uid === this.uid) s.guest = null;
    s.specs = s.specs.filter((x) => x.uid !== this.uid && x.uid !== oldHost?.uid);
    if (s.guest?.uid === oldHost?.uid) s.guest = null;
    this.role = 'host';
    if (s.st === 'play' && (!this.game || this.game.over)) {
      s.st = 'wait';
      s.game = null;
      s.gid = null;
    }
    s.lock = false; // the previous password is unknown to us
    this.pw = '';
    this.commit();
    if (msg) {
      toast(msg, { type: 'info', icon: 'crown' });
      this.sys(esc(msg));
    }
  }

  _successor() {
    const s = this.state;
    if (!s) return null;
    if (s.guest && s.guest.uid !== s.host?.uid) return s.guest.uid;
    return s.specs.find((x) => x.uid !== s.host?.uid)?.uid || null;
  }

  _scheduleTakeover(delay = 4000) {
    clearTimeout(this._takeoverTimer);
    this._takeoverTimer = setTimeout(() => {
      const s = this.state;
      if (this.closed || this.isHost || !s) return;
      if (s.host && this.app.lobby.isOnline(s.host.uid)) return;
      if (this.game && !this.game.over && this.game.isPlayer) return; // wait for the game to resolve
      const succ = this._successor();
      if (succ === this.uid) this._becomeHost('방장의 연결이 끊겨 내가 방장이 됐어요');
      else if (!succ) this._exit('방장의 연결이 끊겨 방이 닫혔어요');
      else this._scheduleTakeover(6000); // give the successor a moment, then re-check
    }, delay);
  }

  _scheduleRemoval(uid, delay = 8000) {
    this._removals ||= new Map();
    clearTimeout(this._removals.get(uid));
    this._removals.set(uid, setTimeout(() => {
      this._removals.delete(uid);
      const s = this.state;
      if (this.closed || !this.isHost || !s) return;
      if (this.app.lobby.isOnline(uid)) return;
      if (s.st === 'play' && s.guest?.uid === uid && this.game && !this.game.over) return; // handled by the game
      this._hostRemove(uid, 'gone');
    }, delay));
  }

  _onUserGone(uid) {
    const s = this.state;
    if (!s || this.closed) return;
    if (this.isHost) {
      if (s.guest?.uid === uid) {
        if (s.st === 'play' && this.game && !this.game.over) this.game.onPeerGone(uid);
        else this._scheduleRemoval(uid);
      } else if (s.specs.some((x) => x.uid === uid)) this._scheduleRemoval(uid);
      return;
    }
    if (s.host?.uid === uid) {
      if (this.game && !this.game.over) this.game.onPeerGone(uid);
      if (s.st !== 'play' || !this.game || this.game.over) this._scheduleTakeover(4000);
    } else if (this.game && !this.game.over) this.game.onPeerGone(uid);
  }

  _onUserBack(uid) {
    if (this.closed) return;
    if (this._removals?.has(uid)) { clearTimeout(this._removals.get(uid)); this._removals.delete(uid); }
    if (this.state?.host?.uid === uid) clearTimeout(this._takeoverTimer);
    this.game?.onPeerBack(uid);
  }

  _onReconnected() {
    if (this.closed) return;
    if (this.isHost) this.commit();
    else {
      // make sure the host still has us (we may have been dropped while offline)
      const me = this.app.me();
      this.send({ t: 'join', name: me.name, rating: me.rating, rec: me.rec, av: me.av, ps: me.ps, pw: this.pw || '', as: this.isSpec ? 'spec' : 'player', rejoin: true });
    }
    this.game?.onReconnected();
  }

  _kicked() {
    this._exit('방장에 의해 강퇴됐어요', 'warn');
  }

  _exit(msg, type = 'info') {
    if (this.closed) return;
    this.dispose();
    this.app.onRoomClosed(this, msg, type);
  }

  // ---------------------------------------------------------------- user actions
  async leave() {
    if (this.closed) return;
    if (this.game && !this.game.over && this.game.isPlayer) {
      const ok = await confirmDialog({ title: '게임 중이에요', message: '지금 나가면 <b>기권패</b>로 처리돼요. 나갈까요?', ok: '기권하고 나가기', danger: true });
      if (!ok) return;
      this.game.resign(true);
    }
    if (this.isHost) this.send({ t: 'close', transfer: this._successor() });
    else this.send({ t: 'leave' });
    this.dispose();
    this.app.onRoomClosed(this, null);
  }

  toggleReady() {
    const s = this.state;
    if (!this.isGuest || s.st !== 'wait') return;
    const v = !s.guest?.ready;
    if (s.guest) s.guest.ready = v;
    this.send({ t: 'ready', v, info: pickPlayer(this.app.me()) });
    this.app.sfx.play(v ? 'ready' : 'pick');
    this.render();
  }

  sit() { if (this.isSpec) this.send({ t: 'sit' }); }
  stand() { if (this.isGuest) this.send({ t: 'stand' }); }

  async kick(uid) {
    if (!this.isHost) return;
    const s = this.state;
    const target = s.guest?.uid === uid ? s.guest : s.specs.find((x) => x.uid === uid);
    if (!target) return;
    const ok = await confirmDialog({ title: '강퇴', message: `<b>${esc(target.name)}</b>님을 내보낼까요?`, ok: '내보내기', danger: true });
    if (!ok) return;
    this.send({ t: 'kick', to: uid });
    this._hostRemove(uid, 'kick');
  }

  setSetting(patch) {
    if (!this.isHost || this.state.st !== 'wait') return;
    const s = this.state;
    const changed = Object.keys(patch).some((k) => JSON.stringify(s[k]) !== JSON.stringify(patch[k]));
    if (!changed) return;
    Object.assign(s, patch);
    if ((patch.tc || patch.hc) && s.guest?.ready) {
      s.guest.ready = false;
      this.sys('설정이 바뀌어서 준비가 해제됐어요');
    }
    if (patch.hc) this.lastHostColor = null;
    this.app.saveSettings({ lastTc: s.tc, lastHc: s.hc });
    this.commit();
  }

  async renameRoom() {
    if (!this.isHost) return;
    const v = await promptDialog({ title: '방 제목 변경', value: this.state.title, maxLength: 24 });
    if (v && v.trim()) this.setSetting({ title: v.trim().slice(0, 24) });
  }

  async setPassword() {
    if (!this.isHost) return;
    const v = await promptDialog({ title: '비밀번호 설정', message: '비워 두면 공개방이 돼요.', value: this.pw, maxLength: 12, placeholder: '비밀번호 없음' });
    if (v === null) return;
    this.pw = v.trim();
    this.state.lock = !!this.pw;
    this.commit();
    toast(this.pw ? '비밀방으로 바꿨어요' : '공개방으로 바꿨어요', { type: 'success' });
  }

  sendChat(text) {
    const me = this.app.profile;
    const m = { t: 'chat', name: me.name, h: me.av?.h, text: text.slice(0, 200) };
    this.send(m);
    this._onChat({ ...m, f: this.uid }, true);
  }

  _onChat(m, local = false) {
    if (!m.text) return;
    const mine = m.f === this.uid;
    const entry = { name: m.name, text: String(m.text).slice(0, 200), me: mine, hue: m.h };
    appendChat($('#room-log'), entry);
    appendChat($('#game-log'), entry);
    if (!local) {
      this.app.sfx.play('chat');
      if (this.app.screen === 'game') this.game?.showBubble(m.f, String(m.text).slice(0, 40), true);
    }
  }

  sys(htmlText) {
    appendChat($('#room-log'), { sys: true, text: htmlText, html: true });
    appendChat($('#game-log'), { sys: true, text: htmlText, html: true });
  }

  openInvite() {
    const lobby = this.app.lobby;
    const people = [...lobby.users.entries()].filter(([, u]) => !u.stale && (u.data.st === 'lobby' || !u.data.st));
    const body = people.length
      ? `<ul class="user-list" style="padding:0">${people.map(([uid, u]) => `<li class="user-item" data-uid="${esc(uid)}">${avatar(u.data.av, 36)}<div class="u-main"><div class="u-name">${esc(u.data.name)}</div><div class="u-sub">${tierBadge(u.data.rating)}<span class="rating">${u.data.rating ?? ''}</span></div></div><button class="btn btn-sm btn-primary" data-inv="${esc(uid)}">${icon('mail', 'sm')}초대</button></li>`).join('')}</ul>`
      : '<div class="empty-mini">로비에 초대할 수 있는 사람이 없어요.<br>친구에게 사이트 주소를 보내 주세요!</div>';
    const m = openModal({ title: '친구 초대', body, size: 'sm', actions: [{ label: '닫기' }] });
    m.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-inv]');
      if (!b) return;
      lobby.invite(b.dataset.inv);
      b.disabled = true;
      b.innerHTML = `${icon('check', 'sm')}보냄`;
    });
  }

  // ---------------------------------------------------------------- rendering
  _seatColor(isHostSeat) {
    const hc = this.state.hc;
    let host = hc === 'w' || hc === 'b' ? hc : hc === 'alt' && this.lastHostColor ? (this.lastHostColor === 'w' ? 'b' : 'w') : null;
    if (!host) return 'r';
    return isHostSeat ? host : host === 'w' ? 'b' : 'w';
  }

  _seat(p, { hostSeat }) {
    const s = this.state;
    const meIn = p && p.uid === this.uid;
    if (!p) {
      const canSit = this.isSpec && s.st === 'wait';
      return `<div class="seat seat-empty">
        <div class="ghost">${icon('user')}</div>
        <div class="seat-name" style="color:var(--text-3)">빈 자리</div>
        <div class="seat-sub hint">${s.st === 'wait' ? '상대를 기다리는 중…' : ''}</div>
        <div class="seat-badges">
          ${canSit ? `<button class="btn btn-primary btn-sm" data-action="room-sit">${icon('plus', 'sm')}여기 앉기</button>` : ''}
          ${this.isHost ? `<button class="btn btn-soft btn-sm" data-action="room-invite">${icon('mail', 'sm')}친구 초대</button>` : ''}
        </div>
      </div>`;
    }
    const rec = p.rec || { w: 0, l: 0, d: 0 };
    const col = this._seatColor(hostSeat);
    const colorBadge = col === 'w' ? `<span class="sb color-w">${pieceIcon('wk')}백</span>` : col === 'b' ? `<span class="sb color-b">${pieceIcon('bk')}흑</span>` : '<span class="sb" title="랜덤">🎲 랜덤</span>';
    const status = hostSeat
      ? `<span class="sb host">${icon('crown')}방장</span>`
      : p.ready ? `<span class="sb ready">${icon('check')}준비 완료</span>` : '<span class="sb waiting">준비 중…</span>';
    const kick = this.isHost && !hostSeat && s.st === 'wait'
      ? `<button class="icon-btn kick" data-action="room-kick" data-uid="${esc(p.uid)}" title="강퇴">${icon('kick')}</button>` : '';
    const online = this.app.lobby.isOnline(p.uid);
    return `<div class="seat glass ${meIn ? 'me' : ''}">
      ${kick}
      ${avatar(p.av, 92, p.ready && !hostSeat ? 'ring' : '')}
      <div class="seat-name">${esc(p.name)}</div>
      <div class="seat-sub">${tierBadge(p.rating)}<span class="rating">${p.rating ?? '-'}</span>${online ? '' : '<span class="u-st is-game">연결 끊김</span>'}</div>
      <div class="seat-rec">${rec.w}승 ${rec.d}무 ${rec.l}패</div>
      <div class="seat-badges">${status}${colorBadge}</div>
      <div class="seat-set" title="체스말 세트">${setPreviewHTML(p.ps, 'w', 24)}<span>${esc(setName(p.ps))}</span>${meIn ? `<button class="btn btn-soft btn-sm" data-action="pick-set">${icon('edit', 'sm')}말 바꾸기</button>` : ''}</div>
    </div>`;
  }

  render() {
    if (this.closed || !this.state) return;
    const s = this.state;
    $('#room-no').textContent = `#${s.no}`;
    $('#room-name').textContent = s.title;
    $('#room-lock').hidden = !s.lock;
    $('#seats').innerHTML = `${this._seat(s.host, { hostSeat: true })}<div class="vs-badge">VS</div>${this._seat(s.guest, { hostSeat: false })}`;

    const editable = this.isHost && s.st === 'wait';
    const tcChips = TIME_CONTROLS.map((t) => `<button class="chip ${t.b === s.tc.b && t.i === s.tc.i ? 'on' : ''}" data-action="room-tc" data-b="${t.b}" data-i="${t.i}" ${editable ? '' : 'disabled'}>${esc(fmtTCShort(t))}<small>${esc(tcCategory(t))}</small></button>`).join('');
    const hcChips = Object.entries(COLOR_PREF).map(([k, v]) => `<button class="chip ${s.hc === k ? 'on' : ''}" data-action="room-hc" data-hc="${k}" ${editable ? '' : 'disabled'}>${esc(v.label)}</button>`).join('');
    $('#room-settings').innerHTML = `
      <div class="panel-head"><div class="ph-title"><h2>게임 설정</h2></div>
        ${this.isHost ? `<div style="display:flex;gap:4px"><button class="btn btn-soft btn-sm" data-action="room-rename">${icon('edit', 'sm')}제목</button><button class="btn btn-soft btn-sm" data-action="room-password">${icon('lock', 'sm')}${s.lock ? '비밀번호' : '공개'}</button></div>` : ''}
      </div>
      <div class="rs-section"><div class="rs-label">${icon('clock')}시간 제한 · ${esc(fmtTC(s.tc))}</div><div class="rs-chips">${tcChips}</div></div>
      <div class="rs-section"><div class="rs-label">${icon('crown')}진영 (방장 기준)</div><div class="rs-chips">${hcChips}</div></div>
      <p class="rs-note">${this.isHost ? '설정을 바꾸면 상대의 준비가 해제돼요.' : '설정은 방장만 바꿀 수 있어요.'}</p>`;

    const specs = s.specs || [];
    $('#room-specs').innerHTML = specs.length
      ? `${icon('eye')}<span>관전 ${specs.length}명 · ${specs.map((x) => esc(x.name)).join(', ')}</span>` : '';

    let cta = '';
    if (this.isHost) {
      const ready = !!s.guest?.ready;
      cta = `${!s.guest ? `<button class="btn btn-soft btn-xl" data-action="room-invite" style="min-width:0">${icon('mail')}<span>초대</span></button>` : ''}
        <button class="btn btn-primary btn-xl" data-action="room-start" ${ready && s.st === 'wait' ? '' : 'disabled'}>${icon('play')}<span>${s.st === 'play' ? '게임 진행 중' : '게임 시작'}</span></button>
        ${s.st === 'wait' && !ready ? `<span class="cta-hint">${s.guest ? '상대가 준비하면 시작할 수 있어요' : '상대를 기다리는 중…'}</span>` : ''}`;
    } else if (this.isGuest) {
      const ready = !!s.guest?.ready;
      cta = `<button class="btn btn-soft btn-xl" data-action="room-stand" style="min-width:0" ${s.st === 'wait' ? '' : 'disabled'}>${icon('eye')}<span>관전</span></button>
        <button class="btn ${ready ? 'btn-soft' : 'btn-accent'} btn-xl" data-action="room-ready" ${s.st === 'wait' ? '' : 'disabled'}>${icon(ready ? 'x' : 'check')}<span>${ready ? '준비 취소' : '준비 완료'}</span></button>`;
    } else {
      cta = s.st === 'play'
        ? `<button class="btn btn-primary btn-xl" data-action="room-watch">${icon('eye')}<span>게임 관전하기</span></button>`
        : !s.guest && s.st === 'wait'
          ? `<button class="btn btn-primary btn-xl" data-action="room-sit">${icon('plus')}<span>참가하기</span></button>`
          : '<span class="cta-hint">관전 중이에요 · 게임이 시작되면 자동으로 보여드려요</span>';
    }
    $('#room-cta').innerHTML = cta;
  }
}
