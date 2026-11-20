// vs-computer mode: engine client (Web Worker with a main-thread fallback) and the setup dialog.
import { el, esc } from './util.js';
import { avatar, icon, pieceIcon, openModal } from './ui.js';
import { BOT_LEVELS } from './config.js';
import * as store from './store.js';

export class BotClient {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = null; // { id, resolve }
    this.busy = false;
    this.broken = false; // module workers unavailable -> think on the main thread
  }

  _spawn() {
    if (this.worker || this.broken) return;
    try {
      this.worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this._done(e.data);
      this.worker.onerror = (e) => {
        e.preventDefault?.();
        this.worker?.terminate();
        this.worker = null;
        this.broken = true;
        const p = this.pending;
        if (p) this._fallback(p.id, p.moves, p.level);
      };
    } catch {
      this.worker = null;
      this.broken = true;
    }
  }

  async _fallback(id, moves, level) {
    try {
      if (!this._engine) {
        const { Engine } = await import('./engine/engine.js');
        this._engine = new Engine();
      }
      await new Promise((r) => setTimeout(r, 30));
      if (this.pending?.id !== id) return;
      this._done({ id, ...this._engine.think(moves, level) });
    } catch (err) {
      this._done({ id, uci: null, error: String(err) });
    }
  }

  _done(msg) {
    this.busy = false;
    const p = this.pending;
    if (!p || msg?.id !== p.id) return;
    this.pending = null;
    p.resolve(msg);
  }

  /** resolves with { uci, score, depth } or null when cancelled */
  think(moves, level) {
    this.cancel();
    this._spawn();
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending = { id, resolve, moves, level };
      this.busy = true;
      if (this.worker) this.worker.postMessage({ id, moves, level });
      else this._fallback(id, moves, level);
    });
  }

  cancel() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    // a busy worker can't be interrupted: replace it so the next request starts at once
    if (this.busy && this.worker) { this.worker.terminate(); this.worker = null; }
    this.busy = false;
    p.resolve(null);
  }

  destroy() {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }
}

export function botName(level) {
  return `봇 · ${BOT_LEVELS[level]?.name || '중급'}`;
}

export function botInfo(profile, ps, bot) {
  const lv = BOT_LEVELS[bot.level] || BOT_LEVELS[3];
  const me = { uid: profile.uid, name: profile.name, av: profile.av, ps };
  const cpu = { uid: 'bot', name: botName(bot.level), av: { p: lv.p, h: lv.h }, ps: 'classic', bot: bot.level };
  return {
    gid: 'bot-' + Date.now().toString(36), at: Date.now(), tc: { b: 0, i: 0 }, bot: true,
    w: bot.color === 'w' ? cpu : me, b: bot.color === 'w' ? me : cpu,
  };
}

const recText = (r) => (r.w + r.d + r.l ? `${r.w}승 ${r.d}무 ${r.l}패` : '첫 도전');

/** "컴퓨터와 대전" dialog. Also offers the old two-players-one-device practice. */
export function openBotSetup(app) {
  let level = Math.min(5, Math.max(1, +app.settings.botLevel || 2));
  let side = app.settings.botSide || 'w'; // my colour: w | b | r
  const body = el(`<div class="bot-setup">
    <div class="form-row">
      <span class="lbl">${icon('trophy')}난이도</span>
      <div class="bot-levels" id="bot-levels"></div>
    </div>
    <div class="form-row">
      <span class="lbl">${icon('crown')}내 진영</span>
      <div class="chips" id="bot-side"></div>
    </div>
    <p class="hint">봇 대전 기록은 친구와의 레이팅·전적과 따로 저장돼요. 무르기와 일시정지(Esc)를 쓸 수 있어요.</p>
  </div>`);
  const lvBox = body.querySelector('#bot-levels');
  const renderLv = () => {
    lvBox.innerHTML = BOT_LEVELS.slice(1).map((lv, i) => {
      const n = i + 1;
      const r = store.botRecord(n);
      return `<button type="button" class="bot-lv ${n === level ? 'on' : ''}" data-lv="${n}">
        ${avatar({ p: lv.p, h: lv.h }, 38)}
        <span class="bl-main"><b>${esc(lv.name)}</b><small>${esc(lv.desc)}</small></span>
        <span class="bl-rec">${recText(r)}</span>
      </button>`;
    }).join('');
  };
  renderLv();
  lvBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lv]');
    if (!b) return;
    level = +b.dataset.lv;
    renderLv();
  });
  const sideBox = body.querySelector('#bot-side');
  const renderSide = () => {
    sideBox.innerHTML = Object.entries({ w: '백 (선공)', r: '랜덤', b: '흑 (후공)' })
      .map(([k, v]) => `<button type="button" class="chip ${side === k ? 'on' : ''}" data-side="${k}">${k === 'w' ? pieceIcon('wk') : k === 'b' ? pieceIcon('bk') : ''}${v}</button>`).join('');
  };
  renderSide();
  sideBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-side]');
    if (!b) return;
    side = b.dataset.side;
    renderSide();
  });
  openModal({
    title: '컴퓨터와 대전', body, cls: 'bot-modal',
    actions: [
      { label: '둘이서 한 기기로', icon: 'users', kind: 'ghost', onClick: () => { setTimeout(() => app.startPractice(), 0); } },
      {
        label: '대국 시작', kind: 'primary', icon: 'play',
        onClick: () => {
          app.saveSettings({ botLevel: level, botSide: side });
          const color = side === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : side;
          setTimeout(() => app.startBotGame({ level, human: color }), 0);
        },
      },
    ],
  });
}
