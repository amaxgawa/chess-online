// Local persistence (localStorage). Everything is keyed by a permanent random
// user id (uid), so stats survive nickname changes.
import { uuid } from './util.js';
import { RATING_START, TIERS, AVATAR_HUES, AVATAR_PIECES } from './config.js';

const K = {
  profile: 'cl.profile',
  stats: 'cl.stats',
  history: 'cl.history',
  players: 'cl.players',
  settings: 'cl.settings',
  active: 'cl.active',
  bot: 'cl.bot',
};
const MAX_HISTORY = 300;

function load(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- profile
export function getProfile() {
  let p = load(K.profile, null);
  if (!p || typeof p.uid !== 'string') {
    p = {
      uid: uuid(),
      name: '',
      av: { p: AVATAR_PIECES[Math.floor(Math.random() * AVATAR_PIECES.length)], h: AVATAR_HUES[Math.floor(Math.random() * AVATAR_HUES.length)] },
      created: Date.now(),
      names: [],
    };
    save(K.profile, p);
  }
  if (!p.av) p.av = { p: 'n', h: AVATAR_HUES[0] };
  if (!Array.isArray(p.names)) p.names = [];
  return p;
}

export function updateProfile(patch) {
  const p = getProfile();
  if (patch.name != null && patch.name !== p.name && p.name) {
    p.names.push({ name: p.name, until: Date.now() });
    if (p.names.length > 20) p.names.shift();
  }
  Object.assign(p, patch);
  save(K.profile, p);
  return p;
}

// ---------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = {
  theme: 'system',
  boardStyle: 'walnut',
  sound: true,
  volume: 0.7,
  showLegal: true,
  animSpeed: 1,
  autoQueen: false,
  broker: 'auto',
  confirmResign: true,
  pieceSet: 'classic',
};
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...load(K.settings, {}) };
}
export function setSettings(patch) {
  const s = { ...getSettings(), ...patch };
  save(K.settings, s);
  return s;
}

// ---------------------------------------------------------------- stats
function emptyStats() {
  return {
    rating: RATING_START, peak: RATING_START, games: 0, w: 0, l: 0, d: 0,
    streak: 0, best: 0, asW: { w: 0, l: 0, d: 0 }, asB: { w: 0, l: 0, d: 0 },
    hist: [],
  };
}
export function getStats() {
  const s = { ...emptyStats(), ...load(K.stats, {}) };
  s.asW = { w: 0, l: 0, d: 0, ...s.asW };
  s.asB = { w: 0, l: 0, d: 0, ...s.asB };
  if (!Array.isArray(s.hist)) s.hist = [];
  return s;
}
export function getHistory() {
  const h = load(K.history, []);
  return Array.isArray(h) ? h : [];
}

export function tierOf(r) {
  let t = TIERS[0];
  for (const x of TIERS) if (r >= x.min) t = x;
  return t;
}

export function expectedScore(my, opp) {
  return 1 / (1 + Math.pow(10, (opp - my) / 400));
}
export function ratingDelta(my, opp, score, games) {
  const k = games < 15 ? 40 : games < 50 ? 28 : 20;
  return Math.round(k * (score - expectedScore(my, opp)));
}

/**
 * Record a finished online game. Idempotent per game id.
 * rec = { id, at, color, opp:{uid,name,rating}, result:'win'|'loss'|'draw', reason, tc, moves, plies, myRating }
 */
export function recordGame(rec) {
  const history = getHistory();
  const existing = history.find((g) => g.id === rec.id);
  if (existing) return { delta: existing.delta, rating: existing.ratingAfter, dup: true };
  const s = getStats();
  const before = s.rating;
  const score = rec.result === 'win' ? 1 : rec.result === 'draw' ? 0.5 : 0;
  const oppR = Number.isFinite(rec.opp?.rating) ? rec.opp.rating : RATING_START;
  const delta = ratingDelta(before, oppR, score, s.games);
  s.rating = Math.max(100, before + delta);
  s.peak = Math.max(s.peak, s.rating);
  s.games += 1;
  const key = rec.result === 'win' ? 'w' : rec.result === 'loss' ? 'l' : 'd';
  s[key] += 1;
  (rec.color === 'w' ? s.asW : s.asB)[key] += 1;
  if (rec.result === 'win') s.streak = s.streak > 0 ? s.streak + 1 : 1;
  else if (rec.result === 'loss') s.streak = s.streak < 0 ? s.streak - 1 : -1;
  else s.streak = 0;
  s.best = Math.max(s.best, s.streak);
  s.hist.push({ t: rec.at || Date.now(), r: s.rating });
  if (s.hist.length > 500) s.hist.splice(0, s.hist.length - 500);
  save(K.stats, s);
  const entry = { ...rec, ratingBefore: before, ratingAfter: s.rating, delta };
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  save(K.history, history);
  if (rec.opp?.uid) notePlayer(rec.opp.uid, { name: rec.opp.name, rating: rec.opp.rating, av: rec.opp.av });
  return { delta, rating: s.rating, before };
}

// ---------------------------------------------------------------- players
export function getPlayers() {
  return load(K.players, {}) || {};
}
export function notePlayer(uid, info) {
  if (!uid) return;
  const all = getPlayers();
  const prev = all[uid] || {};
  const next = { ...prev, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v != null)), seen: Date.now() };
  if (prev.name && info.name && prev.name !== info.name) {
    next.aka = [...new Set([...(prev.aka || []), prev.name])].slice(-8);
  }
  all[uid] = next;
  // keep the map bounded
  const keys = Object.keys(all);
  if (keys.length > 400) {
    keys.sort((a, b) => (all[a].seen || 0) - (all[b].seen || 0));
    for (const k of keys.slice(0, keys.length - 400)) delete all[k];
  }
  save(K.players, all);
}
export function playerName(uid, fallback) {
  return getPlayers()[uid]?.name || fallback || '알 수 없음';
}
export function headToHead(uid) {
  const r = { w: 0, l: 0, d: 0, games: 0 };
  for (const g of getHistory()) {
    if (g.opp?.uid !== uid) continue;
    r.games++;
    if (g.result === 'win') r.w++; else if (g.result === 'loss') r.l++; else r.d++;
  }
  return r;
}
export function opponentsSummary() {
  const map = new Map();
  for (const g of getHistory()) {
    const uid = g.opp?.uid;
    if (!uid) continue;
    const o = map.get(uid) || { uid, name: g.opp.name, w: 0, l: 0, d: 0, last: 0 };
    if (g.result === 'win') o.w++; else if (g.result === 'loss') o.l++; else o.d++;
    o.last = Math.max(o.last, g.at || 0);
    map.set(uid, o);
  }
  const players = getPlayers();
  return [...map.values()]
    .map((o) => ({ ...o, name: players[o.uid]?.name || o.name }))
    .sort((a, b) => (b.w + b.l + b.d) - (a.w + a.l + a.d) || b.last - a.last);
}

// ---------------------------------------------------------------- active game (refresh resume)
export function getActive() {
  const a = load(K.active, null);
  if (!a || !a.at || Date.now() - a.at > 10 * 60 * 1000) return null;
  return a;
}
export function setActive(a) { save(K.active, { ...a, at: Date.now() }); }
export function clearActive() { try { localStorage.removeItem(K.active); } catch { /* ignore */ } }

// ---------------------------------------------------------------- backup
export function exportData() {
  const data = {
    app: 'chess-lounge', v: 1, at: Date.now(),
    profile: load(K.profile, null), stats: load(K.stats, null), history: load(K.history, []),
    players: load(K.players, {}), settings: load(K.settings, {}), bot: load(K.bot, null),
  };
  const json = JSON.stringify(data);
  return btoa(unescape(encodeURIComponent(json)));
}
export function parseBackup(code) {
  const json = decodeURIComponent(escape(atob(String(code).trim())));
  const data = JSON.parse(json);
  if (data.app !== 'chess-lounge' || !data.profile?.uid) throw new Error('invalid');
  return data;
}
export function importData(code) {
  const d = parseBackup(code);
  save(K.profile, d.profile);
  if (d.stats) save(K.stats, d.stats);
  save(K.history, Array.isArray(d.history) ? d.history : []);
  save(K.players, d.players || {});
  if (d.settings) save(K.settings, d.settings);
  if (d.bot) save(K.bot, d.bot);
  return d;
}
export function resetStats() {
  save(K.stats, emptyStats());
  save(K.history, []);
  save(K.bot, {});
}

// ---------------------------------------------------------------- vs computer (kept apart from rating)
const MAX_BOT_GAMES = 100;
export function getBotData() {
  const d = load(K.bot, {}) || {};
  return { byLevel: d.byLevel && typeof d.byLevel === 'object' ? d.byLevel : {}, games: Array.isArray(d.games) ? d.games : [] };
}
export function botRecord(level) {
  return { w: 0, d: 0, l: 0, ...(getBotData().byLevel[level] || {}) };
}
export function recordBotGame(rec) {
  const d = getBotData();
  const lv = { w: 0, d: 0, l: 0, ...(d.byLevel[rec.level] || {}) };
  const k = { win: 'w', loss: 'l', draw: 'd' }[rec.result];
  if (k) lv[k]++;
  d.byLevel[rec.level] = lv;
  d.games.unshift(rec);
  if (d.games.length > MAX_BOT_GAMES) d.games.length = MAX_BOT_GAMES;
  save(K.bot, d);
  return rec;
}
