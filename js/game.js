// Game controller: chess rules, clocks, move sync, offers, results.
// Modes: 'online' (I play), 'spec' (watching an online game), 'local' (practice /
// two players on one device), 'replay' (stored game).
import { Chess } from 'chess.js';
import { $, el, esc, fmtClock, fmtTC, copyText, fmtDate } from './util.js';
import { avatar, tierBadge, icon, pieceIcon, toast, openModal, confirmDialog, confetti } from './ui.js';
import * as store from './store.js';
import { REASONS, PIECE_VALUE, APP_NAME } from './config.js';
import { openBotSetup } from './bot.js';

const FLAG_GRACE = 2500;      // ms we wait past zero before claiming the opponent's flag
const ABANDON_WAIT = 45_000;  // ms before we may claim a win from a disconnected opponent
const EMOTES = ['👍', '👏', '😂', '🔥', '🤔', '😴', '⏰', '😭'];
const PHRASES = ['잘 부탁해요!', '좋은 수!', '빨리빨리~', 'GG'];
const EMOTE_OK = new Set([...EMOTES, ...PHRASES, '😮', '😅', '한 판 더?']); // incoming whitelist (incl. older clients)
// anti-spam: at most EMOTE_MAX within EMOTE_WINDOW ms, and EMOTE_GAP ms between two
const EMOTE_MAX = 3, EMOTE_WINDOW = 6000, EMOTE_GAP = 700;
const EMOTE_RX_MAX = 5; // receiver-side cap per sender per window (protects against modified clients)
const PAUSE_REQ_TTL = 20_000;   // an unanswered pause request expires
const PAUSE_RETRY = 15_000;     // wait after a declined request before asking again
const RESUME_COUNTDOWN = 3000;  // both sides count down before the clock runs again

function uciOf(m) { return m.from + m.to + (m.promotion || ''); }
function parseUci(u) { return { from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined }; }
const other = (c) => (c === 'w' ? 'b' : 'w');

export class GameController {
  constructor(app, { mode, room = null, info, myColor = null, resume = null, replay = null, bot = null }) {
    this.app = app;
    this.board = app.board;
    this.mode = mode;
    this.room = room;
    this.info = info; // { gid, w:{uid,name,rating,av}, b:{...}, tc:{b,i}, at }
    this.myColor = myColor;
    this.chess = new Chess();
    this.moves = [];
    this.hist = [];
    this.tc = info.tc || { b: 0, i: 0 };
    this.timed = this.tc.b > 0 && (mode === 'online' || mode === 'spec');
    this.clock = { w: this.tc.b * 1000, b: this.tc.b * 1000, run: null, since: 0 };
    this.over = null;
    this.viewPly = null;
    this.drawOffer = null;
    this.tbReq = null;
    this.paused = null;   // { by: color|'local', run: colour whose clock resumes, resumeAt?, resumeBy? }
    this.pauseReq = null; // colour that asked for a pause and awaits an answer
    this._pauseCdUntil = 0;
    this.goneAt = {};
    this.destroyed = false;
    this.bot = bot; // { color: bot's side, level 1..5 } in 'local' mode
    this._botToken = 0;
    this._botBusy = false;
    this.orient = myColor || (replay?.color) || (bot ? other(bot.color) : 'w');
    this.autoFlip = false;
    this.resume = resume;
    this._resyncClock = !!resume;
    this.replay = replay;
    this._prompts = {};
    this._lastTick = -1;
    this.recorded = null;
  }

  get isPlayer() { return this.mode === 'online' && !!this.myColor; }
  get turn() { return this.chess.turn(); }
  get live() { return this.viewPly === null && !this.over; }
  get oppUid() { return this.isPlayer ? this.info[other(this.myColor)].uid : null; }

  // ================================================================= lifecycle
  start({ late = false } = {}) {
    const b = this.board;
    b.setTheme(this.app.theme);
    b.clearAll();
    this.app.applyGameSets?.(this.info);
    b.setOrientation(this.orient, false);
    const screen = $('#screen-game');
    screen.dataset.mode = this.mode;
    $('#game-log').innerHTML = '';
    this._renderEmotes();

    if (this.mode === 'replay') {
      for (const u of this.replay.moves) this._apply(u);
      this.over = { result: this.replay.result, reason: this.replay.reason };
      this.viewPly = this.moves.length;
      const last = this.hist[this.hist.length - 1];
      b.setPosition(this.chess.board(), { animate: 'drop', captured: this._captured() });
      b.setLastMove(last?.from || null, last?.to || null);
      b.intro();
    } else if (this.resume && this.resume.moves?.length) {
      for (const u of this.resume.moves) this._apply(u);
      if (this.timed && this.resume.clk) {
        const c = this.resume.clk;
        this.clock.w = c.w; this.clock.b = c.b; this.clock.run = c.run || null;
        const away = Math.max(0, Date.now() - (this.resume.at || Date.now()));
        if (this.clock.run) this.clock[this.clock.run] -= away;
        this.clock.since = performance.now();
      }
      if (this.resume.paused) {
        this.paused = { by: this.resume.paused.by, run: this.resume.paused.run ?? null };
        this.clock.run = null;
      }
      this._syncBoard(false);
      b.setView('default', true);
    } else {
      b.setPosition(this.chess.board(), { animate: 'drop' });
      b.intro();
      setTimeout(() => this.app.sfx.play('start'), 250);
      if (!late && this.mode !== 'local') this._banner(`<b>${esc(this.info.w.name)}</b> (백) vs <b>${esc(this.info.b.name)}</b> (흑) · ${esc(fmtTC(this.tc))}`, { timeout: 3500, icon: 'play' });
    }
    if (this.mode === 'spec' || (this.isPlayer && (this.resume || late))) this._requestSync();
    if (this.isPlayer) this.saveActive();
    this._timer = setInterval(() => this._tick(), 100);
    this._keys = (e) => this._onKey(e);
    window.addEventListener('keydown', this._keys);
    this.renderAll();
    this._updateInteraction();
    if (this.mode === 'replay' && this.replay.autoplay) this.toggleAutoplay();
    this._maybeBotMove(1300);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this._timer);
    clearInterval(this._auto);
    clearTimeout(this._resumeT);
    clearTimeout(this._pauseReqT);
    this._cancelBot();
    window.removeEventListener('keydown', this._keys);
    this._closePrompts();
    const veil = $('#pause-veil');
    if (veil) veil.hidden = true;
    this._hidePromo();
    this.board.setInteraction({ enabled: false });
    this.board.setCheck(null);
    $('#board-banner').hidden = true;
  }

  // ================================================================= core move handling
  _apply(uci) {
    let mv;
    try {
      mv = this.chess.move(parseUci(uci));
    } catch {
      return null;
    }
    if (!mv) return null;
    this.moves.push(uciOf(mv));
    this.hist.push(mv);
    return mv;
  }

  _rebuildTo(list) {
    this.chess = new Chess();
    this.moves = [];
    this.hist = [];
    for (const u of list) if (!this._apply(u)) break;
  }

  _captured(upto = this.hist.length) {
    const caps = { w: [], b: [] };
    for (let i = 0; i < upto; i++) {
      const m = this.hist[i];
      if (m.captured) caps[m.color].push(m.captured);
    }
    return caps;
  }

  _kingSq(color, chess = this.chess) {
    return chess.findPiece({ type: 'k', color })[0] || null;
  }

  _syncBoard(animate) {
    this.board.setPosition(this.chess.board(), { animate, captured: this._captured() });
    const last = this.hist[this.hist.length - 1];
    this.board.setLastMove(last?.from || null, last?.to || null);
    this.board.setCheck(this.chess.inCheck() && !this.over ? this._kingSq(this.turn) : null);
  }

  _doMove(uci, { local = false, animate = true, remoteClk = null } = {}) {
    if (this.over) return null;
    if (this.viewPly !== null) {
      this.viewPly = null;
      this._syncBoard(false);
    }
    const mv = this._apply(uci);
    if (!mv) return null;
    if (this.timed) this._clockAfterMove(mv.color, remoteClk);
    this._clearOffers();
    this.board.playMove(mv, { instant: !animate });
    this.board.setLastMove(mv.from, mv.to);
    this.board.setCheck(this.chess.inCheck() ? this._kingSq(this.turn) : null);
    if (local && this.isPlayer) this._sendMove(mv);
    if (this.mode === 'local' && !this.bot && this.autoFlip && !this.chess.isGameOver()) {
      setTimeout(() => { if (!this.destroyed) { this.orient = this.turn; this.board.setOrientation(this.orient, true); this.renderAll(); } }, 650);
    }
    this._checkEnd(mv);
    this.renderAll();
    this._updateInteraction();
    if (this.isPlayer && !this.over) this.saveActive();
    this._maybeBotMove();
    return mv;
  }

  _clockAfterMove(color, remoteClk) {
    const c = this.clock;
    const now = performance.now();
    if (c.run === color) c[color] = c[color] - (now - c.since) + this.tc.i * 1000;
    if (remoteClk != null && Number.isFinite(remoteClk)) c[color] = remoteClk;
    if (this.paused) { this.paused.run = other(color); c.run = null; } // a move that raced the pause
    else c.run = other(color);
    c.since = now;
  }

  _clockNow(color) {
    const c = this.clock;
    if (!this.timed) return null;
    return c.run === color ? c[color] - (performance.now() - c.since) : c[color];
  }

  _stopClock() {
    const c = this.clock;
    if (c.run) {
      c[c.run] = Math.max(0, c[c.run] - (performance.now() - c.since));
      c.run = null;
    }
  }

  _sendMove(mv) {
    this.room?.send({ t: 'move', gid: this.info.gid, ply: this.moves.length, uci: uciOf(mv), list: this.moves.join(' '), clk: this.timed ? Math.round(this.clock[mv.color]) : null });
  }

  _checkEnd(mv) {
    const c = this.chess;
    if (c.isCheckmate()) return this._finish(mv.color === 'w' ? '1-0' : '0-1', 'checkmate');
    if (c.isStalemate()) return this._finish('1/2-1/2', 'stalemate');
    if (c.isInsufficientMaterial()) return this._finish('1/2-1/2', 'insufficient');
    if (c.isThreefoldRepetition()) return this._finish('1/2-1/2', 'threefold');
    if (c.isDrawByFiftyMoves()) return this._finish('1/2-1/2', 'fifty');
    return null;
  }

  // ================================================================= board interaction
  _updateInteraction() {
    let enabled = false;
    let canPick = () => false;
    if (this.paused) {
      enabled = false;
    } else if (this.live && this.isPlayer) {
      enabled = true;
      // while my pause request is pending I can't sneak a move in
      canPick = (color) => color === this.myColor && this.turn === this.myColor && this.pauseReq !== this.myColor;
    } else if (this.live && this.mode === 'local') {
      enabled = true;
      canPick = (color) => color === this.turn && (!this.bot || color === this.human);
    }
    this.board.setInteraction({
      enabled, canPick,
      getTargets: (sq) => {
        const seen = new Map();
        for (const m of this.chess.moves({ square: sq, verbose: true })) if (!seen.has(m.to)) seen.set(m.to, { to: m.to, capture: !!m.captured });
        return [...seen.values()];
      },
      onMove: (from, to) => this._onBoardMove(from, to),
    });
  }

  _onBoardMove(from, to) {
    if (!this.live || this.paused || (this.isPlayer && this.pauseReq === this.myColor)) return false;
    if (this.bot && this.turn !== this.human) return false;
    const cands = this.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!cands.length) return false;
    if (cands.some((m) => m.promotion)) {
      if (this.app.settings.autoQueen) {
        this._doMove(from + to + 'q', { local: true });
        return true;
      }
      this._askPromotion(from, to, cands[0].color);
      return 'pending';
    }
    this._doMove(from + to, { local: true });
    return true;
  }

  _askPromotion(from, to, color) {
    const box = $('#promo-picker');
    const names = { q: '퀸', r: '룩', b: '비숍', n: '나이트' };
    box.innerHTML = `<div class="pp-title">승급할 기물을 고르세요</div><div class="pp-row">${['q', 'r', 'b', 'n']
      .map((p, i) => `<button data-p="${p}" title="${names[p]} (${i + 1})">${pieceIcon(color + p, '', true)}<span>${names[p]}</span></button>`).join('')}</div>
      <button class="btn btn-ghost btn-sm" data-p="">취소</button>`;
    box.hidden = false;
    const done = (p) => {
      this._hidePromo();
      if (p) {
        this.board.clearPending();
        this._doMove(from + to + p, { local: true });
      } else this.board.cancelPending();
    };
    box.onclick = (e) => {
      const b = e.target.closest('[data-p]');
      if (b) done(b.dataset.p);
    };
    this._promoKey = (e) => {
      const map = { 1: 'q', 2: 'r', 3: 'b', 4: 'n', q: 'q', r: 'r', b: 'b', n: 'n' };
      if (e.key === 'Escape') done('');
      else if (map[e.key]) done(map[e.key]);
    };
    window.addEventListener('keydown', this._promoKey);
  }

  _hidePromo() {
    const box = $('#promo-picker');
    if (box) { box.hidden = true; box.onclick = null; }
    if (this._promoKey) { window.removeEventListener('keydown', this._promoKey); this._promoKey = null; }
  }

  // ================================================================= network
  onNet(m) {
    if (this.destroyed || !m || (m.gid && m.gid !== this.info.gid)) return;
    switch (m.t) {
      case 'move': this._onRemoteMove(m); break;
      case 'resign': {
        const color = this._colorOf(m.f);
        if (!color || this.over) return;
        this._finish(color === 'w' ? '0-1' : '1-0', 'resign');
        break;
      }
      case 'draw': this._onDraw(m); break;
      case 'tb': this._onTakeback(m); break;
      case 'pause': this._onPause(m); break;
      case 'flag': {
        if (this.over || !m.who) return;
        this._flag(m.who, false);
        break;
      }
      case 'claim': {
        const color = this._colorOf(m.f);
        if (!color || this.over) return;
        this._finish(color === 'w' ? '1-0' : '0-1', 'abandon');
        break;
      }
      case 'syncq': if (this.isPlayer || (this.mode === 'spec' && this.over)) this._sendSync(m.f); break;
      case 'sync': if (!m.to || m.to === this.app.uid) this._onSync(m); break;
      default: break;
    }
  }

  _colorOf(uid) {
    if (this.info.w.uid === uid) return 'w';
    if (this.info.b.uid === uid) return 'b';
    return null;
  }

  _onRemoteMove(m) {
    const list = String(m.list || '').split(' ').filter(Boolean);
    if (list.length <= this.moves.length) return;
    for (let i = 0; i < this.moves.length; i++) {
      if (list[i] !== this.moves[i]) { this._adoptList(list, m); return; }
    }
    const missing = list.slice(this.moves.length);
    for (let i = 0; i < missing.length; i++) {
      const last = i === missing.length - 1;
      const mv = this._doMove(missing[i], { animate: last, remoteClk: last ? m.clk : null });
      if (!mv) { this._requestSync(); return; }
      if (this.over) break;
    }
    if (document.hidden && this.isPlayer && this.turn === this.myColor) this.app.notifyTurn?.();
  }

  _adoptList(list, m) {
    const wasOver = this.over;
    this._rebuildTo(list);
    if (this.timed && m.clk != null && this.hist.length) {
      const mover = this.hist[this.hist.length - 1].color;
      this.clock[mover] = m.clk;
      this.clock.run = other(mover);
      this.clock.since = performance.now();
    }
    this._syncBoard(true);
    if (!wasOver) {
      const lm = this.hist[this.hist.length - 1];
      if (lm) this._checkEnd(lm);
    }
    this.renderAll();
    this._updateInteraction();
  }

  _requestSync() {
    this.room?.send({ t: 'syncq', gid: this.info.gid });
  }

  _sendSync(to) {
    this.room?.send({
      t: 'sync', gid: this.info.gid, to, list: this.moves.join(' '),
      clk: this.timed ? { w: Math.round(this._clockNow('w')), b: Math.round(this._clockNow('b')), run: this.clock.run } : null,
      over: this.over ? { result: this.over.result, reason: this.over.reason } : null,
      pause: this._pauseSnapshot(),
      info: this.info,
    });
  }

  _onSync(m) {
    const list = String(m.list || '').split(' ').filter(Boolean);
    const sameHead = list.slice(0, this.moves.length).every((u, i) => u === this.moves[i]);
    if (list.length > this.moves.length && sameHead) {
      const missing = list.slice(this.moves.length);
      for (let i = 0; i < missing.length; i++) {
        const mv = this._doMove(missing[i], { animate: i === missing.length - 1 && missing.length < 3 });
        if (!mv || this.over) break;
      }
    } else if (list.length < this.moves.length && this.isPlayer) {
      // they missed our latest move(s): resend
      const lm = this.hist[this.hist.length - 1];
      if (lm && lm.color === this.myColor) this._sendMove(lm);
    } else if (!sameHead || (list.length === this.moves.length && list.join() !== this.moves.join())) {
      this._adoptList(list, { clk: null });
    }
    if (m.clk && this.timed && !this.over) {
      const mine = this.myColor;
      for (const c of ['w', 'b']) {
        if (this.isPlayer && c === mine && !this._resyncClock) continue;
        if (Number.isFinite(m.clk[c])) this.clock[c] = m.clk[c];
      }
      if (m.clk.run !== undefined) this.clock.run = m.clk.run;
      this.clock.since = performance.now();
      this._resyncClock = false;
    }
    if ('pause' in m && !this.over && !m.over) this._adoptPause(m.pause);
    if (m.over && !this.over) this._finish(m.over.result, m.over.reason, { fromSync: true });
    this._hideBanner('sync');
    this.renderAll();
    this._updateInteraction();
  }

  onReconnected() {
    if (this.destroyed) return;
    if (!this.over && (this.isPlayer || this.mode === 'spec')) this._requestSync();
  }

  onPeerRejoined(uid) {
    if (this.isPlayer && uid === this.oppUid) this._sendSync(uid);
  }

  onPeerGone(uid) {
    if (this.over || this.destroyed) return;
    const color = this._colorOf(uid);
    if (!color || color === this.myColor) return;
    this.goneAt[color] = Date.now();
    this.renderAll();
    this._renderGoneBanner();
  }

  onPeerBack(uid) {
    const color = this._colorOf(uid);
    if (!color) return;
    delete this.goneAt[color];
    this._hideBanner('gone');
    this.renderAll();
    if (this.isPlayer && uid === this.oppUid && !this.over) {
      this._sendSync(uid);
      toast(`${this.info[color].name}님이 다시 연결됐어요`, { type: 'success', icon: 'wifi' });
    }
  }

  onOpponentLeft() {
    if (this.over || !this.isPlayer) return;
    this._finish(this.myColor === 'w' ? '1-0' : '0-1', 'abandon');
  }

  // ================================================================= offers & actions
  _clearOffers() {
    this.drawOffer = null;
    this.tbReq = null;
    if (this.pauseReq) {
      // a move happened, so the request no longer matches the position
      const mine = this.pauseReq === this.myColor;
      this.pauseReq = null;
      clearTimeout(this._pauseReqT);
      if (mine && !this.over) toast('수가 진행돼서 일시정지 요청이 취소됐어요', { icon: 'pause' });
    }
    this._closePrompts();
  }

  _closePrompts() {
    for (const k of Object.keys(this._prompts)) { this._prompts[k]?.close(); delete this._prompts[k]; }
  }

  async resign(skipConfirm = false) {
    if (this.over) return;
    if (this.bot) {
      if (!skipConfirm) {
        const ok = await confirmDialog({ title: '기권', message: '이번 판을 기권할까요? 봇 대전 기록에 패배로 남아요.', ok: '기권하기', danger: true });
        if (!ok || this.over) return;
      }
      this._cancelBot();
      this._finish(this.human === 'w' ? '0-1' : '1-0', 'resign');
      return;
    }
    if (!this.isPlayer) return;
    if (!skipConfirm && this.app.settings.confirmResign) {
      const ok = await confirmDialog({ title: '기권', message: '정말 기권할까요? 패배로 기록돼요.', ok: '기권하기', danger: true });
      if (!ok || this.over) return;
    }
    const result = this.myColor === 'w' ? '0-1' : '1-0';
    this._finish(result, 'resign', { send: { t: 'resign', gid: this.info.gid } });
  }

  offerDraw() {
    if (!this.isPlayer || !this.live) return;
    if (this.drawOffer === other(this.myColor)) { this._prompts.draw?.close(); this._acceptDraw(); return; }
    if (this.drawOffer) return;
    this.drawOffer = this.myColor;
    this.room.send({ t: 'draw', gid: this.info.gid, a: 'offer' });
    toast('무승부를 제안했어요', { icon: 'scale' });
    this.renderAll();
  }

  _acceptDraw() {
    this.room.send({ t: 'draw', gid: this.info.gid, a: 'accept' });
    this._finish('1/2-1/2', 'agreement');
  }

  _onDraw(m) {
    const from = this._colorOf(m.f);
    if (!from || this.over) return;
    if (m.a === 'offer') {
      if (!this.isPlayer) { this._specNote(`${this.info[from].name}님이 무승부를 제안했어요`); return; }
      this.drawOffer = from;
      this.app.sfx.play('notify');
      this._prompts.draw?.close();
      this._prompts.draw = toast(`<b>${esc(this.info[from].name)}</b>님이 무승부를 제안했어요`, {
        html: true, icon: 'scale', timeout: 0,
        actions: [
          { label: '거절', onClick: () => { this.drawOffer = null; this.room.send({ t: 'draw', gid: this.info.gid, a: 'decline' }); this.renderAll(); } },
          { label: '수락', kind: 'primary', onClick: () => this._acceptDraw() },
        ],
      });
      this.renderAll();
    } else if (m.a === 'accept') {
      if (this.isPlayer && this.drawOffer !== this.myColor) return;
      this._finish('1/2-1/2', 'agreement');
    } else if (m.a === 'decline') {
      this.drawOffer = null;
      if (this.isPlayer) toast('상대가 무승부를 거절했어요', { icon: 'scale' });
      this.renderAll();
    }
  }

  requestTakeback() {
    if (this.mode === 'local') { this._localUndo(); return; }
    if (!this.isPlayer || !this.live || this.tbReq) return;
    const myMoves = this.hist.filter((m) => m.color === this.myColor).length;
    if (!myMoves) return;
    const len = this.turn === this.myColor ? this.moves.length - 2 : this.moves.length - 1;
    if (len < 0) return;
    this.tbReq = { by: this.myColor, len, at: this.moves.length };
    this.room.send({ t: 'tb', gid: this.info.gid, a: 'req', len, at: this.moves.length });
    toast('무르기를 요청했어요', { icon: 'undo' });
    this.renderAll();
  }

  _onTakeback(m) {
    const from = this._colorOf(m.f);
    if (!from || this.over) return;
    if (m.a === 'req') {
      if (!this.isPlayer) { this._specNote(`${this.info[from].name}님이 무르기를 요청했어요`); return; }
      if (m.at !== this.moves.length) return;
      this.tbReq = { by: from, len: m.len, at: m.at };
      this.app.sfx.play('notify');
      this._prompts.tb?.close();
      this._prompts.tb = toast(`<b>${esc(this.info[from].name)}</b>님이 한 수 무르기를 요청했어요`, {
        html: true, icon: 'undo', timeout: 0,
        actions: [
          { label: '거절', onClick: () => { this.tbReq = null; this.room.send({ t: 'tb', gid: this.info.gid, a: 'decline' }); this.renderAll(); } },
          {
            label: '수락', kind: 'primary',
            onClick: () => {
              const req = this.tbReq;
              if (!req || req.at !== this.moves.length) return;
              this.room.send({ t: 'tb', gid: this.info.gid, a: 'accept', len: req.len, at: req.at });
              this._truncate(req.len);
            },
          },
        ],
      });
      this.renderAll();
    } else if (m.a === 'accept') {
      if (m.at !== this.moves.length) { this._requestSync(); return; }
      this._truncate(m.len);
      if (this.isPlayer) toast('무르기가 수락됐어요', { type: 'success', icon: 'undo' });
    } else if (m.a === 'decline') {
      this.tbReq = null;
      if (this.isPlayer) toast('상대가 무르기를 거절했어요', { icon: 'undo' });
      this.renderAll();
    }
  }

  _truncate(len) {
    const now = performance.now();
    if (this.timed && this.clock.run) {
      this.clock[this.clock.run] -= now - this.clock.since;
    }
    this._rebuildTo(this.moves.slice(0, Math.max(0, len)));
    this.tbReq = null;
    this.drawOffer = null;
    this._closePrompts();
    if (this.timed && this.clock.run) {
      this.clock.run = this.moves.length ? this.turn : null;
      this.clock.since = now;
    }
    this.viewPly = null;
    this._syncBoard(true);
    this.app.sfx.play('move');
    this.renderAll();
    this._updateInteraction();
    if (this.isPlayer) this.saveActive();
  }

  _localUndo() {
    if (!this.moves.length) return;
    if (this.bot) {
      if (this.over || this.paused) return; // a finished bot game is already recorded
      this._cancelBot();
      // back to my turn: drop the bot's reply too, unless it hasn't answered yet
      const n = Math.max(0, this.moves.length - (this.turn === this.human ? 2 : 1));
      this._truncate(n);
      this._maybeBotMove();
      return;
    }
    if (this.over) { this.over = null; }
    this._truncate(this.moves.length - 1);
  }

  newLocalGame() {
    if (this.mode !== 'local') return;
    if (this.bot) {
      this._cancelBot();
      this.info.gid = 'bot-' + Date.now().toString(36);
      this.info.at = Date.now();
      this.recorded = null;
    }
    if (this.paused) { this.paused = null; }
    this.over = null;
    this._rebuildTo([]);
    this.viewPly = null;
    this.board.clearAll();
    this.board.setPosition(this.chess.board(), { animate: 'drop' });
    this.orient = this.bot ? this.human : 'w';
    this.board.setOrientation(this.orient, true);
    this.app.sfx.play('start');
    this.renderAll();
    this._updateInteraction();
    this._maybeBotMove(1100);
  }

  // ================================================================= vs computer
  get human() { return this.bot ? other(this.bot.color) : null; }

  /** ask the engine for a move when it's the bot's turn */
  _maybeBotMove(minDelay = null) {
    if (!this.bot || this.over || this.paused || this.destroyed || this._botBusy) return;
    if (this.turn !== this.bot.color) return;
    const token = ++this._botToken;
    this._botBusy = true;
    const t0 = performance.now();
    const wait = minDelay ?? 380 + Math.random() * 520; // feels less robotic than an instant reply
    this.renderAll();
    this.app.botClient.think(this.moves.slice(), this.bot.level).then((r) => {
      if (token !== this._botToken || this.destroyed) return;
      const left = Math.max(0, wait - (performance.now() - t0));
      this._botTimer = setTimeout(() => {
        if (token !== this._botToken || this.destroyed) return;
        this._botBusy = false;
        if (this.over || this.paused || this.turn !== this.bot.color) { this.renderAll(); return; }
        if (!r?.uci || !this._doMove(r.uci)) {
          const ms = this.chess.moves({ verbose: true });
          if (ms.length) this._doMove(uciOf(ms[Math.floor(Math.random() * ms.length)]));
        }
      }, left);
    });
  }

  _cancelBot() {
    if (!this.bot) return;
    this._botToken++;
    clearTimeout(this._botTimer);
    this._botBusy = false;
    this.app.botClient?.cancel();
  }

  // ================================================================= pause
  // Online: one player asks, the other accepts -> both clocks freeze and the board
  // is veiled (no free thinking time). Either player may resume; both sides then
  // count down RESUME_COUNTDOWN ms before the clock runs again. Local: instant.
  togglePause() {
    if (this.over) return;
    if (this.paused) { this.requestResume(); return; }
    if (this.mode === 'local') { this._applyPause({ by: 'local' }); return; }
    if (!this.isPlayer || !this.room) return;
    if (this.pauseReq && this.pauseReq !== this.myColor) { this._acceptPause(); return; }
    if (this.pauseReq === this.myColor) { this._cancelPauseReq('일시정지 요청을 취소했어요'); return; }
    const wait = this._pauseCdUntil - Date.now();
    if (wait > 0) { toast(`${Math.ceil(wait / 1000)}초 뒤에 다시 요청할 수 있어요`, { icon: 'pause' }); return; }
    this.pauseReq = this.myColor;
    this.board.deselect();
    this.room.send({ t: 'pause', gid: this.info.gid, a: 'req', at: this.moves.length });
    toast('일시정지를 요청했어요. 상대가 수락하면 시계가 멈춰요', { icon: 'pause' });
    clearTimeout(this._pauseReqT);
    this._pauseReqT = setTimeout(() => {
      if (this.pauseReq === this.myColor && !this.destroyed) this._cancelPauseReq('상대가 응답하지 않아 일시정지 요청이 취소됐어요');
    }, PAUSE_REQ_TTL);
    this.renderAll();
    this._updateInteraction();
  }

  _cancelPauseReq(msg) {
    this.pauseReq = null;
    clearTimeout(this._pauseReqT);
    this.room?.send({ t: 'pause', gid: this.info.gid, a: 'cancel' });
    if (msg) toast(msg, { icon: 'pause' });
    this.renderAll();
    this._updateInteraction();
  }

  _acceptPause() {
    if (this.paused || this.over) return;
    this._applyPause({ by: other(this.myColor) });
    // the accepter's frozen clocks become the shared truth
    this.room.send({
      t: 'pause', gid: this.info.gid, a: 'accept', at: this.moves.length, run: this.paused.run,
      clk: this.timed ? { w: Math.round(this.clock.w), b: Math.round(this.clock.b) } : null,
    });
  }

  _applyPause({ by, run, clk = null }) {
    if (this.paused || this.over) return;
    const prevRun = this.clock.run;
    this._stopClock();
    if (clk && this.timed) {
      if (Number.isFinite(clk.w)) this.clock.w = clk.w;
      if (Number.isFinite(clk.b)) this.clock.b = clk.b;
    }
    this.paused = { by, run: run !== undefined ? run : prevRun };
    this._cancelBot(); // re-asked on resume
    this.pauseReq = null;
    clearTimeout(this._pauseReqT);
    this._clearOffers();
    this._hidePromo();
    this.board.cancelPending();
    this.board.deselect();
    this.app.sfx.play('notify');
    this.renderAll();
    this._updateInteraction();
    if (this.isPlayer) this.saveActive();
  }

  requestResume() {
    if (!this.paused || this.paused.resumeAt || this.over) return;
    if (this.mode === 'local') { this._unpause(); return; }
    if (!this.isPlayer) return;
    this.room.send({ t: 'pause', gid: this.info.gid, a: 'resume' });
    this._startResume(this.myColor);
  }

  _startResume(by, ms = RESUME_COUNTDOWN) {
    if (!this.paused || this.paused.resumeAt) return;
    this.paused.resumeAt = Date.now() + ms;
    this.paused.resumeBy = by;
    clearTimeout(this._resumeT);
    this._resumeT = setTimeout(() => this._unpause(), ms);
    this.app.sfx.play('tick');
    this.renderAll();
  }

  _unpause() {
    if (!this.paused) return;
    clearTimeout(this._resumeT);
    const run = this.paused.run;
    this.paused = null;
    if (this.timed && run && !this.over) {
      this.clock.run = run;
      this.clock.since = performance.now();
    }
    if (!this.over) this.app.sfx.play('start');
    this.renderAll();
    this._updateInteraction();
    if (this.isPlayer) this.saveActive();
    this._maybeBotMove();
  }

  _pauseSnapshot() {
    const p = this.paused;
    if (!p) return null;
    return { by: p.by, run: p.run, resumeIn: p.resumeAt ? Math.max(0, p.resumeAt - Date.now()) : null, resumeBy: p.resumeBy || null };
  }

  /** take over the pause state from a sync message (the sender is authoritative) */
  _adoptPause(p) {
    if (p && !this.paused) {
      this.paused = { by: p.by, run: p.run ?? null };
      this.clock.run = null;
      this.pauseReq = null;
      clearTimeout(this._pauseReqT);
      this._clearOffers();
      this._hidePromo();
      this.board.cancelPending();
    } else if (!p && this.paused) {
      clearTimeout(this._resumeT);
      this.paused = null; // clock.run already came with the sync's clk
    }
    if (p && p.resumeIn != null && this.paused && !this.paused.resumeAt) this._startResume(p.resumeBy || p.by, p.resumeIn);
    this.renderAll();
    this._updateInteraction();
  }

  _onPause(m) {
    const from = this._colorOf(m.f);
    if (!from || this.over) return;
    const name = this.info[from].name;
    if (m.a === 'req') {
      if (!this.isPlayer) { this._specNote(`${name}님이 일시정지를 요청했어요`); return; }
      if (from === this.myColor || this.paused || m.at !== this.moves.length) return;
      if (this.pauseReq === this.myColor) { this._acceptPause(); return; } // both asked at once
      this.pauseReq = from;
      this.app.sfx.play('notify');
      this._prompts.pause?.close();
      this._prompts.pause = toast(`<b>${esc(name)}</b>님이 일시정지를 요청했어요`, {
        html: true, icon: 'pause', timeout: PAUSE_REQ_TTL,
        actions: [
          {
            label: '거절',
            onClick: () => {
              if (this.pauseReq !== from) return;
              this.pauseReq = null;
              this.room.send({ t: 'pause', gid: this.info.gid, a: 'decline' });
              this.renderAll();
            },
          },
          { label: '수락', kind: 'primary', onClick: () => { if (this.pauseReq === from) this._acceptPause(); } },
        ],
      });
      this.renderAll();
    } else if (m.a === 'accept') {
      if (this.paused) return;
      if (this.isPlayer) {
        if (this.pauseReq !== this.myColor) return;
        if (m.at !== this.moves.length) { this._requestSync(); return; }
      }
      this._applyPause({ by: other(from), run: m.run, clk: m.clk });
      if (this.isPlayer) toast('일시정지됐어요. 준비되면 누구든 재개할 수 있어요', { type: 'success', icon: 'pause' });
    } else if (m.a === 'decline') {
      if (!this.isPlayer || this.pauseReq !== this.myColor) return;
      this.pauseReq = null;
      clearTimeout(this._pauseReqT);
      this._pauseCdUntil = Date.now() + PAUSE_RETRY;
      toast('상대가 일시정지를 거절했어요', { icon: 'pause' });
      this.renderAll();
      this._updateInteraction();
    } else if (m.a === 'cancel') {
      if (this.pauseReq !== from) return;
      this.pauseReq = null;
      this._prompts.pause?.close();
      delete this._prompts.pause;
      this.renderAll();
    } else if (m.a === 'resume') {
      if (this.paused && !this.paused.resumeAt) this._startResume(from);
    }
  }

  _renderPause() {
    let veil = $('#pause-veil');
    const p = this.over ? null : this.paused;
    if (!p) { if (veil) veil.hidden = true; return; }
    if (!veil) {
      veil = el(`<div class="pause-veil" id="pause-veil" hidden><div class="pv-card glass">
        <div class="pv-ic"></div><div class="pv-title"></div><div class="pv-sub"></div><div class="pv-act"></div></div></div>`);
      $('#board-area').appendChild(veil);
    }
    const nameOf = (c) => (c === 'w' || c === 'b' ? this.info[c].name : '');
    let ic = icon('pause'), title = '일시정지', sub, act = '';
    if (p.resumeAt) {
      const s = Math.max(1, Math.ceil((p.resumeAt - Date.now()) / 1000));
      ic = '';
      title = `<span class="pv-count">${s}</span>`;
      sub = this.mode === 'local' ? '곧 재개돼요' : `${esc(nameOf(p.resumeBy) || '')}님이 재개했어요 · 곧 시작해요`;
    } else {
      sub = p.by === 'local' ? '잠깐 쉬는 중이에요' : `${esc(nameOf(p.by))}님의 요청으로 멈췄어요${this.timed ? ' · 시계도 멈춰 있어요' : ''}`;
      if (this.isPlayer || this.mode === 'local') act = `<button class="btn btn-primary" data-action="g-pause">${icon('play', 'sm')}<span>재개하기</span></button>`;
    }
    const sig = `${ic}|${title}|${sub}|${act}`;
    if (veil.dataset.sig !== sig) {
      veil.dataset.sig = sig;
      veil.querySelector('.pv-ic').innerHTML = ic;
      veil.querySelector('.pv-ic').hidden = !ic;
      veil.querySelector('.pv-title').innerHTML = title;
      veil.querySelector('.pv-sub').innerHTML = sub;
      veil.querySelector('.pv-act').innerHTML = act;
    }
    veil.classList.toggle('counting', !!p.resumeAt);
    veil.hidden = false;
  }

  claimWin() {
    if (!this.isPlayer || this.over) return;
    this._finish(this.myColor === 'w' ? '1-0' : '0-1', 'abandon', { send: { t: 'claim', gid: this.info.gid } });
  }

  /** ms until the next emote is allowed (0 = now) */
  _emoteWait() {
    const now = Date.now();
    this._emoteLog = (this._emoteLog || []).filter((t) => now - t < EMOTE_WINDOW);
    const log = this._emoteLog;
    let wait = 0;
    if (log.length) wait = Math.max(wait, EMOTE_GAP - (now - log[log.length - 1]));
    if (log.length >= EMOTE_MAX) wait = Math.max(wait, EMOTE_WINDOW - (now - log[0]));
    return Math.max(0, wait);
  }

  sendEmote(e) {
    if (!EMOTE_OK.has(e)) return;
    const wait = this._emoteWait();
    if (wait > 0) {
      this._emoteCooldown(wait);
      if (wait > EMOTE_GAP && (!this._spamToastAt || Date.now() - this._spamToastAt > 2500)) {
        this._spamToastAt = Date.now();
        toast(`도배 방지! ${Math.ceil(wait / 1000)}초 뒤에 다시 보낼 수 있어요`, { type: 'warn', icon: 'smile', timeout: 1800 });
      }
      return;
    }
    this._emoteLog.push(Date.now());
    if (this.room) this.room.send({ t: 'emote', gid: this.info.gid, e });
    const myUid = this.isPlayer || this.mode !== 'local' ? this.app.uid : this.info[this.turn].uid;
    this.showBubble(myUid, e);
    this._burst(e, { mine: true, uid: myUid });
    this.app.sfx.play('emote');
    const next = this._emoteWait();
    if (next > 0) this._emoteCooldown(next);
  }

  onEmote(m) {
    const e = String(m.e || '');
    if (!EMOTE_OK.has(e)) return;
    const now = Date.now();
    this._emoteRx ||= {};
    const log = (this._emoteRx[m.f] = (this._emoteRx[m.f] || []).filter((t) => now - t < EMOTE_WINDOW));
    if (log.length >= EMOTE_RX_MAX) return; // flood from a sender: silently drop
    log.push(now);
    this.showBubble(m.f, e);
    this._burst(e, { mine: false, uid: m.f });
    this.app.sfx.play('emote');
  }

  /** Visible cooldown on the emote bar */
  _emoteCooldown(ms) {
    const box = $('#emotes');
    if (!box) return;
    box.classList.add('cooling');
    box.style.setProperty('--cd', `${ms}ms`);
    box.classList.remove('cd-anim');
    void box.offsetWidth;
    box.classList.add('cd-anim');
    clearTimeout(this._cdT);
    this._cdT = setTimeout(() => box.classList.remove('cooling', 'cd-anim'), ms);
  }

  /** Emoji fireworks over the board. Opponent's emotes are big and rain from their side. */
  _burst(e, { mine, uid }) {
    const area = $('#board-area');
    if (!area || this.app.screen !== 'game') return;
    let fx = area.querySelector('.emote-fx');
    if (!fx) { fx = el('<div class="emote-fx" aria-hidden="true"></div>'); area.appendChild(fx); }
    const color = this._colorOf(uid);
    const fromTop = color ? color !== this._bottomColor() : !mine;
    const isEmoji = EMOTES.includes(e) || /\p{Extended_Pictographic}/u.test(e);
    const W = fx.clientWidth, H = fx.clientHeight;
    if (!W || !H) return;
    while (fx.childElementCount > 40) fx.firstElementChild.remove();
    if (!isEmoji) {
      const t = el(`<div class="emote-fx-text">${esc(e)}</div>`);
      fx.appendChild(t);
      t.animate([
        { transform: 'translate(-50%, -50%) scale(.4)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.15)', opacity: 1, offset: 0.18 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.75 },
        { transform: 'translate(-50%, -80%) scale(.9)', opacity: 0 },
      ], { duration: 1700, easing: 'ease-out' }).onfinish = () => t.remove();
      return;
    }
    const n = mine ? 5 : 12;
    for (let i = 0; i < n; i++) {
      const s = el(`<span class="emote-fx-p">${esc(e)}</span>`);
      const size = mine ? 22 + Math.random() * 14 : 30 + Math.random() * 36;
      const x0 = mine ? W * (0.6 + Math.random() * 0.35) : W * (0.08 + Math.random() * 0.84);
      const travel = H * (mine ? 0.35 + Math.random() * 0.2 : 0.55 + Math.random() * 0.35);
      const sway = (Math.random() - 0.5) * (mine ? 60 : 160);
      const rot = (Math.random() - 0.5) * 70;
      const y0 = fromTop ? -size : H;
      const dir = fromTop ? 1 : -1;
      s.style.fontSize = `${size}px`;
      s.style.left = `${x0}px`;
      s.style.top = `${y0}px`;
      fx.appendChild(s);
      s.animate([
        { transform: 'translate(-50%, 0) scale(.5) rotate(0deg)', opacity: 0 },
        { transform: `translate(calc(-50% + ${sway * 0.3}px), ${dir * travel * 0.25}px) scale(1.1) rotate(${rot * 0.4}deg)`, opacity: 1, offset: 0.15 },
        { transform: `translate(calc(-50% + ${sway * 0.8}px), ${dir * travel * 0.8}px) scale(1) rotate(${rot}deg)`, opacity: 1, offset: 0.75 },
        { transform: `translate(calc(-50% + ${sway}px), ${dir * travel}px) scale(.9) rotate(${rot * 1.2}deg)`, opacity: 0 },
      ], { duration: 1500 + Math.random() * 900, delay: i * (mine ? 70 : 55), easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' }).onfinish = () => s.remove();
    }
    if (!mine) {
      area.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }], { duration: 260, iterations: 2 });
    }
  }

  showBubble(uid, text, isChat = false) {
    const color = this._colorOf(uid);
    if (!color) return;
    const slot = color === this._bottomColor() ? '#pcard-bottom' : '#pcard-top';
    const card = $(slot);
    if (!card) return;
    card.querySelector('.emote-bubble')?.remove();
    const isEmoji = !isChat && EMOTES.includes(text);
    const b = el(`<div class="emote-bubble ${isEmoji ? '' : 'text'}">${esc(text)}</div>`);
    card.appendChild(b);
    setTimeout(() => b.remove(), 2700);
  }

  // ================================================================= clocks / flags
  _tick() {
    if (this.destroyed) return;
    if (!this.over && this.timed && this.clock.run) {
      const side = this.clock.run;
      const left = this._clockNow(side);
      if (this.isPlayer) {
        if (side === this.myColor && left <= 0) this._flag(side, true);
        else if (side !== this.myColor && left <= -FLAG_GRACE) this._flag(side, true);
        else if (side === this.myColor && left < 10_000) {
          const s = Math.ceil(left / 1000);
          if (s !== this._lastTick) { this._lastTick = s; this.app.sfx.play('tick'); }
        }
      }
    }
    if (Object.keys(this.goneAt).length && !this.over) this._renderGoneBanner();
    if (this.paused?.resumeAt) this._renderPause();
    this._renderClocks();
  }

  _hasMatingMaterial(color) {
    let minors = 0;
    for (const row of this.chess.board()) {
      for (const p of row) {
        if (!p || p.color !== color || p.type === 'k') continue;
        if (p.type === 'p' || p.type === 'r' || p.type === 'q') return true;
        minors++;
      }
    }
    return minors >= 2;
  }

  _flag(color, send) {
    if (this.over) return;
    this.clock[color] = 0;
    const winner = other(color);
    const insufficient = !this._hasMatingMaterial(winner);
    const result = insufficient ? '1/2-1/2' : winner === 'w' ? '1-0' : '0-1';
    this._finish(result, insufficient ? 'timeoutvsinsufficient' : 'timeout', send ? { send: { t: 'flag', gid: this.info.gid, who: color } } : {});
  }

  // ================================================================= finishing
  _finish(result, reason, { send = null, fromSync = false } = {}) {
    if (this.over) return;
    this._stopClock();
    this._cancelBot();
    clearTimeout(this._resumeT);
    clearTimeout(this._pauseReqT);
    this.paused = null;
    this.pauseReq = null;
    const plies = this.moves.length;
    const aborted = this.mode === 'online' && ['resign', 'abandon', 'timeout', 'timeoutvsinsufficient'].includes(reason) && plies < 2;
    this.over = { result: aborted ? '*' : result, reason: aborted ? 'aborted' : reason, at: Date.now() };
    if (send) this.room?.send(send);
    this.viewPly = null;
    this._hidePromo();
    this.board.cancelPending();
    this._closePrompts();
    this._hideBanner();
    this.board.setInteraction({ enabled: false });
    this.board.setCheck(null);

    const winner = this.over.result === '1-0' ? 'w' : this.over.result === '0-1' ? 'b' : null;
    if (winner && (reason === 'checkmate' || reason === 'resign')) {
      const ks = this._kingSq(other(winner));
      if (ks) this.board.topple(ks);
      const ws = this._kingSq(winner);
      if (ws && reason === 'checkmate') this.board.celebrate(ws);
    }

    const isAbort = aborted || this.over.result === '*';
    let outcome = 'spec';
    if (this.isPlayer) outcome = isAbort ? 'aborted' : !winner ? 'draw' : winner === this.myColor ? 'win' : 'loss';
    else if (this.bot) outcome = !winner ? 'draw' : winner === this.human ? 'win' : 'loss';
    else if (this.mode === 'local') outcome = 'local';

    // bot games have their own record (never touch the rating); an instant resign isn't kept
    if (this.bot && !(reason === 'resign' && plies < 2)) {
      const cpu = this.info[this.bot.color];
      this.recorded = store.recordBotGame({
        id: this.info.gid, at: Date.now(), mode: 'bot', level: this.bot.level, color: this.human,
        opp: { uid: 'bot', name: cpu.name, av: cpu.av },
        me: { name: this.app.profile.name },
        result: outcome, reason: this.over.reason, tc: this.tc, moves: this.moves.join(' '), plies,
        sets: { w: this.info.w.ps || 'classic', b: this.info.b.ps || 'classic' },
      });
    }

    if (this.isPlayer && !isAbort) {
      const opp = this.info[other(this.myColor)];
      this.recorded = store.recordGame({
        id: this.info.gid, at: Date.now(), mode: 'online', color: this.myColor,
        opp: { uid: opp.uid, name: opp.name, rating: opp.rating, av: opp.av },
        me: { name: this.app.profile.name },
        result: outcome, reason: this.over.reason, tc: this.tc, moves: this.moves.join(' '), plies,
        sets: { w: this.info.w.ps || 'classic', b: this.info.b.ps || 'classic' },
        roomNo: this.info.no,
      });
      this.app.onStatsChanged?.();
    }
    if (this.isPlayer) store.clearActive();
    this.room?.onGameEnd(this.over);

    const delay = reason === 'checkmate' ? 1900 : reason === 'resign' ? 1400 : 500;
    setTimeout(() => {
      if (this.destroyed) return;
      const snd = { win: 'win', loss: 'lose', draw: 'draw' }[outcome] || 'draw';
      this.app.sfx.play(snd);
      if (outcome === 'win' || (outcome === 'local' && winner)) confetti();
      if (!fromSync || this.isPlayer) this._showResult(outcome);
    }, delay);
    this.renderAll();
    this._updateInteraction();
  }

  _resultTitle(outcome) {
    const r = this.over.result;
    if (outcome === 'win') return '승리!';
    if (outcome === 'loss') return '패배';
    if (outcome === 'aborted') return '게임 취소';
    if (r === '1/2-1/2') return '무승부';
    return r === '1-0' ? '백 승리' : r === '0-1' ? '흑 승리' : '게임 종료';
  }

  _showResult(outcome) {
    if (this.app.screen !== 'game' || this._resultModal) return;
    const r = this.over.result;
    const winner = r === '1-0' ? 'w' : r === '0-1' ? 'b' : null;
    const emblem = { win: 'trophy', loss: 'flag', draw: 'scale', aborted: 'x', spec: 'eye', local: winner ? 'trophy' : 'scale' }[outcome];
    const reasonText = REASONS[this.over.reason] || '';
    const moveCount = Math.ceil(this.moves.length / 2);
    const rec = this.recorded;
    const card = (c) => {
      const p = this.info[c];
      let extra = `<span class="rating">${p.rating ?? ''}</span>`;
      if (rec && c === this.myColor) {
        const d = rec.delta;
        extra = `<span class="rating">${rec.rating}</span> <span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'zero'}">${d > 0 ? '+' : ''}${d}</span>`;
      }
      return `<div class="r-player ${winner === c ? 'winner' : ''}">${avatar(p.av, 48)}<div class="nm">${esc(p.name)}</div><div class="me-sub" style="margin:0">${pieceIcon(c + 'k', '', true)}${extra}</div></div>`;
    };
    const score = r === '1-0' ? '1 – 0' : r === '0-1' ? '0 – 1' : r === '1/2-1/2' ? '½ – ½' : '–';
    const body = `<div class="result ${outcome === 'local' ? (winner ? 'win' : 'draw') : outcome}">
      <div class="r-emblem">${icon(emblem)}</div>
      <div class="r-title">${esc(this._resultTitle(outcome))}</div>
      <div class="r-reason">${esc(reasonText)}${this.over.reason !== 'aborted' ? ` · ${moveCount}수` : ' · 2수 미만이라 기록되지 않아요'}</div>
      <div class="r-players">${card('w')}<div class="r-score">${score}</div>${card('b')}</div>
    </div>`;
    const actions = [];
    if (this.moves.length && !this.bot) actions.push({ label: '기보 복사', icon: 'copy', close: false, onClick: () => this.copyPgn() });
    if (this.bot) {
      actions.push({ label: '난이도 변경', close: true, onClick: () => { setTimeout(() => openBotSetup(this.app), 0); } });
      actions.push({ label: '다시 하기', kind: 'primary', icon: 'refresh', onClick: () => this.newLocalGame() });
    } else if (this.mode === 'local') actions.push({ label: '새 게임', kind: 'primary', onClick: () => this.newLocalGame() });
    else if (this.room) actions.push({ label: '대기실로', kind: 'primary', onClick: () => this.app.backToRoom() });
    actions.unshift({ label: '보드 보기' });
    this._resultModal = openModal({ body, actions, size: 'sm', closeButton: true, onClose: () => { this._resultModal = null; } });
  }

  // ================================================================= history / navigation
  _view(ply, animate = true) {
    const n = this.moves.length;
    ply = Math.max(0, Math.min(n, ply));
    if (ply === n && !this.over) {
      if (this.viewPly === null) return;
      this.viewPly = null;
      this._syncBoard(animate);
      this._hideBanner('history');
    } else {
      this.viewPly = ply;
      const tmp = new Chess();
      for (let i = 0; i < ply; i++) tmp.move(parseUci(this.moves[i]));
      this.board.setPosition(tmp.board(), { animate, captured: this._captured(ply) });
      const lm = this.hist[ply - 1];
      this.board.setLastMove(lm?.from || null, lm?.to || null);
      this.board.setCheck(tmp.inCheck() && !(this.over && ply === n) ? this._kingSq(tmp.turn(), tmp) : null);
      if (animate && lm && Math.abs((this._lastViewed ?? ply) - ply) === 1) this.app.sfx.play(lm.captured ? 'capture' : 'move');
      if (!this.over) this._banner(`지난 수를 보는 중이에요 (${ply}/${n})`, { key: 'history', action: { label: '현재로', onClick: () => this._view(n) } });
    }
    this._lastViewed = ply;
    this.renderAll();
    this._updateInteraction();
  }

  nav(dir) {
    const n = this.moves.length;
    const cur = this.viewPly ?? n;
    if (dir === 'first') this._view(0);
    else if (dir === 'prev') this._view(cur - 1);
    else if (dir === 'next') this._view(cur + 1);
    else if (dir === 'last') this._view(n);
  }

  toggleAutoplay() {
    if (this._auto) {
      clearInterval(this._auto);
      this._auto = null;
      this.renderAll();
      return;
    }
    if ((this.viewPly ?? this.moves.length) >= this.moves.length) this._view(0);
    this._auto = setInterval(() => {
      const cur = this.viewPly ?? this.moves.length;
      if (cur >= this.moves.length) { clearInterval(this._auto); this._auto = null; this.renderAll(); return; }
      this._view(cur + 1);
    }, 1100);
    this.renderAll();
  }

  _onKey(e) {
    if (e.target.closest('input, textarea') || this.app.screen !== 'game') return;
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.nav('prev'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.nav('next'); }
    else if (e.key === 'ArrowUp' || e.key === 'Home') { e.preventDefault(); this.nav('first'); }
    else if (e.key === 'ArrowDown' || e.key === 'End') { e.preventDefault(); this.nav('last'); }
    else if (e.key === 'Escape') {
      // Esc = pause / resume in games I play; otherwise just drop the selection
      if (!$('#promo-picker').hidden) return;
      if (!this.over && (this.isPlayer || this.mode === 'local')) { e.preventDefault(); this.board.deselect(); this.togglePause(); }
      else this.board.deselect();
    }
    else if (e.key === 'f' || e.key === 'F') this.flipView();
  }

  flipView() {
    this.orient = other(this.orient);
    this.board.setOrientation(this.orient, true);
    this.renderAll();
  }

  // ================================================================= PGN / persistence
  pgn() {
    const c = new Chess();
    const d = new Date(this.info.at || Date.now());
    const p2 = (n) => String(n).padStart(2, '0');
    c.setHeader('Event', `${APP_NAME} ${this.bot ? '컴퓨터 대전' : this.mode === 'local' ? '연습' : '친선전'}`);
    c.setHeader('Site', location.origin + location.pathname);
    c.setHeader('Date', `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`);
    c.setHeader('White', this.info.w.name);
    c.setHeader('Black', this.info.b.name);
    if (this.tc.b) c.setHeader('TimeControl', `${this.tc.b}+${this.tc.i}`);
    if (this.over?.result && this.over.result !== '*') c.setHeader('Result', this.over.result);
    if (this.over?.reason) c.setHeader('Termination', REASONS[this.over.reason] || this.over.reason);
    for (const u of this.moves) c.move(parseUci(u));
    return c.pgn();
  }

  async copyPgn() {
    const ok = await copyText(this.pgn());
    toast(ok ? '기보(PGN)를 복사했어요' : '복사에 실패했어요', { type: ok ? 'success' : 'error', icon: 'copy' });
  }

  saveActive() {
    if (!this.isPlayer || this.over || !this.room) return;
    store.setActive({
      rid: this.room.id, role: this.room.role, room: this.room.state, pw: this.room.pw,
      lastHostColor: this.room.lastHostColor, info: this.info, moves: this.moves,
      clk: this.timed ? { w: this._clockNow('w'), b: this._clockNow('b'), run: this.clock.run } : null,
      paused: this.paused ? { by: this.paused.by, run: this.paused.run } : null,
    });
  }

  // ================================================================= rendering
  _bottomColor() { return this.orient; }

  _banner(htmlText, { key = 'misc', timeout = 0, action = null, icon: ic = 'info', warn = false } = {}) {
    const b = $('#board-banner');
    b.dataset.key = key;
    b.className = 'board-banner' + (warn ? ' warn' : '');
    b.innerHTML = `${icon(ic)}<span>${htmlText}</span>`;
    if (action) {
      const btn = el(`<button class="btn btn-sm ${action.kind ? 'btn-' + action.kind : 'btn-primary'}">${esc(action.label)}</button>`);
      btn.addEventListener('click', action.onClick);
      b.appendChild(btn);
    }
    b.hidden = false;
    clearTimeout(this._bannerT);
    if (timeout) this._bannerT = setTimeout(() => this._hideBanner(key), timeout);
  }

  _hideBanner(key) {
    const b = $('#board-banner');
    if (!b || (key && b.dataset.key !== key)) return;
    b.hidden = true;
  }

  _renderGoneBanner() {
    const colors = Object.keys(this.goneAt);
    if (!colors.length || this.over) return;
    const c = colors[0];
    const name = esc(this.info[c].name);
    const elapsed = Date.now() - this.goneAt[c];
    if (this.isPlayer) {
      const left = Math.max(0, Math.ceil((ABANDON_WAIT - elapsed) / 1000));
      if (left > 0) this._banner(`<b>${name}</b>님의 연결이 끊겼어요. 재접속을 기다리는 중… (${left}초)`, { key: 'gone', icon: 'wifi', warn: true });
      else {
        const b = $('#board-banner');
        if (b.dataset.key === 'gone' && b.querySelector('.btn')) return;
        this._banner(`<b>${name}</b>님이 돌아오지 않아요`, { key: 'gone', icon: 'wifi', warn: true, action: { label: '승리 처리', onClick: () => this.claimWin() } });
      }
    } else {
      this._banner(`<b>${name}</b>님의 연결이 끊겼어요…`, { key: 'gone', icon: 'wifi', warn: true });
    }
  }

  _specNote(text) {
    this._banner(esc(text), { key: 'note', timeout: 3000 });
  }

  renderAll() {
    if (this.destroyed) return;
    this._renderCards();
    this._renderMoves();
    this._renderActions();
    this._renderStatus();
    this._renderClocks();
    this._renderPause();
  }

  _material() {
    const s = { w: 0, b: 0 };
    for (const row of this.chess.board()) for (const p of row) if (p) s[p.color] += PIECE_VALUE[p.type];
    return s;
  }

  _renderCards() {
    const bottom = this._bottomColor();
    const top = other(bottom);
    const ply = this.viewPly ?? this.moves.length;
    const caps = this._captured(ply);
    const mat = this._material();
    for (const [sel, color] of [['#pcard-top', top], ['#pcard-bottom', bottom]]) {
      const card = $(sel);
      const p = this.info[color];
      const list = [...caps[color]].sort((a, b) => PIECE_VALUE[b] - PIECE_VALUE[a]);
      const adv = mat[color] - mat[other(color)];
      const online = this.mode !== 'online' && this.mode !== 'spec' ? true : !this.goneAt[color];
      const sig = JSON.stringify([p.name, p.rating, p.av, list, adv, online, color]);
      const turn = !this.over && this.turn === color && this.mode !== 'replay';
      card.classList.toggle('turn', turn);
      if (card.dataset.sig === sig) continue;
      card.dataset.sig = sig;
      const bubble = card.querySelector('.emote-bubble');
      card.innerHTML = `${avatar(p.av, 42)}
        <div class="pc-info">
          <div class="pc-name"><i class="side-dot ${color}"></i><span>${esc(p.name)}</span>${this.mode === 'online' || this.mode === 'spec' ? `<i class="net ${online ? '' : 'off'}" title="${online ? '연결됨' : '연결 끊김'}"></i>` : ''}</div>
          <div class="pc-sub">${p.rating != null ? `${tierBadge(p.rating)}<span class="rating">${p.rating}</span>` : ''}
            <span class="caps">${list.map((t) => pieceIcon(other(color) + t, '', true)).join('')}${adv > 0 ? `<span class="adv">+${adv}</span>` : ''}</span></div>
        </div>
        <div class="clock ${this.timed ? '' : 'none'}" data-clock="${color}">${this.timed ? fmtClock(this._clockNow(color)) : '∞'}</div>`;
      if (bubble) card.appendChild(bubble);
    }
  }

  _renderClocks() {
    if (!this.timed) return;
    for (const c of ['w', 'b']) {
      const node = document.querySelector(`[data-clock="${c}"]`);
      if (!node) continue;
      const ms = this._clockNow(c);
      const txt = fmtClock(ms);
      if (node.textContent !== txt) node.textContent = txt;
      const run = !this.over && this.clock.run === c;
      node.classList.toggle('run', run && ms >= 20_000);
      node.classList.toggle('low', !this.over && ms < 20_000 && (run || ms <= 0));
    }
  }

  _renderMoves() {
    const box = $('#move-list');
    const cur = this.viewPly ?? this.moves.length;
    const sig = this.moves.length + '|' + cur + '|' + (this.over?.result || '');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (!this.hist.length) {
      box.innerHTML = `<div class="empty">${this.mode === 'replay' ? '수가 없는 게임이에요' : '첫 수를 기다리는 중…'}</div>`;
      return;
    }
    let h = '';
    for (let i = 0; i < this.hist.length; i += 2) {
      h += `<span class="no">${i / 2 + 1}.</span>`;
      for (const j of [i, i + 1]) {
        const m = this.hist[j];
        if (!m) { h += '<span></span>'; continue; }
        const piece = m.piece !== 'p' && /^[KQRBN]/.test(m.san) ? pieceIcon(m.color + m.piece, '', true) : '';
        const san = piece ? m.san.slice(1) : m.san;
        h += `<span class="mv ${j + 1 === cur ? 'cur' : ''}" data-ply="${j + 1}">${piece}${esc(san)}</span>`;
      }
    }
    if (this.over && this.over.result) {
      const r = this.over.result === '*' ? '취소' : this.over.result.replace('1/2', '½');
      h += `<div class="result">${esc(r)} · ${esc(REASONS[this.over.reason] || '')}</div>`;
    }
    box.innerHTML = h;
    const curEl = box.querySelector('.mv.cur');
    if (curEl) curEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    else box.scrollTop = box.scrollHeight;
  }

  _renderActions() {
    const box = $('#game-actions');
    const b = (action, ic, label, { kind = '', disabled = false, title = '' } = {}) =>
      `<button class="btn btn-sm ${kind ? 'btn-' + kind : ''}" data-action="${action}" ${disabled ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>${icon(ic, 'sm')}<span>${label}</span></button>`;
    let h = '';
    if (this.mode === 'online' && this.isPlayer) {
      if (!this.over) {
        const myMoves = this.hist.some((m) => m.color === this.myColor);
        const pz = !!this.paused;
        h += b('g-takeback', 'undo', this.tbReq?.by === this.myColor ? '요청 중…' : '무르기', { disabled: !myMoves || !!this.tbReq || !this.live || pz });
        h += b('g-draw', 'scale', this.drawOffer === this.myColor ? '제안 중…' : this.drawOffer ? '무승부 수락' : '무승부', { disabled: this.drawOffer === this.myColor || !this.live || pz, kind: this.drawOffer && this.drawOffer !== this.myColor ? 'primary' : '' });
        h += this._pauseBtn(b);
        h += b('g-resign', 'flag', '기권', { kind: 'danger' });
      } else {
        h += b('g-pgn', 'copy', '기보 복사');
        h += b('g-room', 'back', '대기실로', { kind: 'primary' });
      }
    } else if (this.mode === 'spec') {
      h += b('g-pgn', 'copy', '기보 복사', { disabled: !this.moves.length });
      h += b('g-room', 'back', '대기실로', { kind: this.over ? 'primary' : '' });
    } else if (this.bot) {
      const mine = this.hist.some((m) => m.color === this.human);
      h += b('g-takeback', 'undo', '무르기', { disabled: !mine || !!this.over || !!this.paused });
      if (!this.over) h += this._pauseBtn(b) + b('g-resign', 'flag', '기권', { kind: 'danger' });
      h += b('g-new', 'refresh', '새 대국', { disabled: !!this.paused, kind: this.over ? 'primary' : '' });
      if (this.moves.length) h += b('g-pgn', 'copy', '기보');
    } else if (this.mode === 'local') {
      h += b('g-takeback', 'undo', '무르기', { disabled: !this.moves.length || !!this.paused });
      h += `<button class="btn btn-sm ${this.autoFlip ? 'btn-primary' : ''}" data-action="g-autoflip" title="수를 둘 때마다 보드를 돌려요">${icon('swap', 'sm')}<span>자동 회전</span></button>`;
      h += b('g-new', 'refresh', '새 게임', { disabled: !!this.paused });
      if (!this.over) h += this._pauseBtn(b);
      if (this.moves.length) h += b('g-pgn', 'copy', '기보');
    } else if (this.mode === 'replay') {
      h += `<button class="btn btn-sm ${this._auto ? 'btn-primary' : ''}" data-action="g-auto">${icon(this._auto ? 'pause' : 'play', 'sm')}<span>${this._auto ? '정지' : '자동 재생'}</span></button>`;
      h += b('g-pgn', 'copy', '기보 복사');
      h += b('g-close', 'x', '닫기');
    }
    if (box.innerHTML !== h) box.innerHTML = h;
    const n = box.children.length;
    box.classList.toggle('grid2', n === 4);
    box.classList.toggle('grid3', n >= 5);
    this._renderTopPause();
  }

  /** the pause button in the board's top bar (easier to find than the side panel) */
  _renderTopPause() {
    const btn = $('#game-pause');
    if (!btn) return;
    const show = !this.over && (this.isPlayer || this.mode === 'local');
    btn.hidden = !show;
    if (!show) return;
    const p = this.paused;
    const theirs = this.isPlayer && this.pauseReq && this.pauseReq !== this.myColor;
    const label = p ? (p.resumeAt ? '곧 재개…' : '재개') : this.isPlayer && this.pauseReq === this.myColor ? '요청 취소' : theirs ? '정지 수락' : '일시정지';
    const sig = label + (p ? 1 : 0);
    if (btn.dataset.sig === sig) return;
    btn.dataset.sig = sig;
    btn.innerHTML = `${icon(p ? 'play' : 'pause')}<span>${label}</span><kbd>Esc</kbd>`;
    btn.classList.toggle('on', !!p || !!theirs);
    btn.disabled = !!p?.resumeAt;
  }

  _pauseBtn(b) {
    const p = this.paused;
    if (p) return b('g-pause', 'play', p.resumeAt ? '곧 재개…' : '재개', { kind: 'primary', disabled: !!p.resumeAt });
    if (this.mode === 'local') return b('g-pause', 'pause', '일시정지');
    const theirs = this.pauseReq && this.pauseReq !== this.myColor;
    const label = this.pauseReq === this.myColor ? '요청 취소' : theirs ? '정지 수락' : '일시정지';
    return b('g-pause', 'pause', label, { kind: theirs ? 'primary' : '', title: '상대가 수락하면 양쪽 시계가 멈춰요' });
  }

  _renderStatus() {
    const st = $('#game-status');
    let cls = '', txt = '';
    const turnDot = (c) => `<i class="turn-dot ${c}"></i>`;
    if (this.over) {
      const r = this.over.result;
      const who = r === '1-0' ? '백 승리' : r === '0-1' ? '흑 승리' : r === '1/2-1/2' ? '무승부' : '게임 취소';
      txt = `${icon('flag', 'sm')}${who} · ${esc(REASONS[this.over.reason] || '')}`;
      if (this.mode === 'replay') txt = `${icon('play', 'sm')}다시 보기 · ${who}`;
    } else if (this.paused) {
      cls = 'paused';
      txt = `${icon('pause', 'sm')}${this.paused.resumeAt ? '곧 재개돼요' : '일시정지 중'}`;
    } else if (this.viewPly !== null) {
      txt = `${icon('eye', 'sm')}지난 수 보기 ${this.viewPly}/${this.moves.length}`;
    } else {
      const t = this.turn;
      const check = this.chess.inCheck();
      if (this.isPlayer) {
        const mine = t === this.myColor;
        cls = check && mine ? 'check' : mine ? 'mine' : '';
        txt = `${turnDot(t)}${mine ? (check ? '체크! 킹을 지키세요' : '내 차례예요') : '상대 차례'}`;
        if (this.timed && !this.clock.run && !this.moves.length) txt += ' <span class="muted" style="font-weight:600">· 첫 수 후 시계 시작</span>';
      } else if (this.bot) {
        const mine = t === this.human;
        cls = check && mine ? 'check' : mine ? 'mine' : 'thinking';
        txt = `${turnDot(t)}${mine ? (check ? '체크! 킹을 지키세요' : '내 차례예요') : '봇이 생각 중<i class="dots"><i></i><i></i><i></i></i>'}`;
      } else {
        cls = check ? 'check' : '';
        txt = `${turnDot(t)}${t === 'w' ? '백' : '흑'} 차례${check ? ' · 체크!' : ''}`;
      }
    }
    st.className = `game-status glass ${cls}`;
    if (st.innerHTML !== txt) st.innerHTML = txt;
    const exit = $('#game-exit span');
    if (exit) exit.textContent = this.mode === 'local' || this.mode === 'replay' ? '로비로' : '나가기';
  }

  _renderEmotes() {
    const box = $('#emotes');
    box.innerHTML = EMOTES.map((e) => `<button data-emote="${e}">${e}</button>`).join('') +
      PHRASES.map((p) => `<button class="txt" data-emote="${esc(p)}">${esc(p)}</button>`).join('');
  }
}

export function localInfo(profile, ps = 'classic') {
  return {
    gid: 'local', at: Date.now(), tc: { b: 0, i: 0 },
    w: { uid: 'local-w', name: `${profile.name} (백)`, av: { p: 'k', h: 40 }, ps },
    b: { uid: 'local-b', name: `${profile.name} (흑)`, av: { p: 'k', h: 220 }, ps },
  };
}

export function replayInfo(rec, profile) {
  const oc = rec.color === 'w' ? 'b' : 'w';
  const me = { uid: profile.uid, name: rec.me?.name || profile.name, rating: rec.ratingBefore, av: profile.av, ps: rec.sets?.[rec.color] || 'classic' };
  const opp = { uid: rec.opp?.uid, name: store.playerName(rec.opp?.uid, rec.opp?.name), rating: rec.opp?.rating, av: rec.opp?.av || { p: 'n', h: 205 }, ps: rec.sets?.[oc] || 'classic' };
  return {
    gid: 'replay-' + rec.id, at: rec.at, tc: rec.tc || { b: 0, i: 0 },
    w: rec.color === 'w' ? me : opp, b: rec.color === 'w' ? opp : me,
  };
}

export function replayResult(rec) {
  if (rec.result === 'draw') return '1/2-1/2';
  const iWon = rec.result === 'win';
  return (rec.color === 'w') === iWon ? '1-0' : '0-1';
}

export { fmtDate };
