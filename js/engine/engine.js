// Compact chess engine for the vs-computer mode (runs inside a Web Worker).
// Board: 0x88 mailbox, a1 = 0x00 … h8 = 0x77. Pieces: 1..6 = P N B R Q K, +8 = black.
// Search: iterative deepening negamax / PVS with a transposition table, null-move
// pruning, late-move reductions, killer + history ordering and a capture quiescence.
// Eval: material + piece-square tables (tapered king), pawn structure, bishop pair,
// rooks on open files and a mop-up term so it can actually finish won endgames.

const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6, BLACK = 8;
const F_EP = 1, F_CASTLE = 2, F_DOUBLE = 4;
const WK = 1, WQ = 2, BK = 4, BQ = 8;
const N_D = [33, 31, 18, 14, -33, -31, -18, -14];
const B_D = [17, 15, -17, -15];
const R_D = [16, -16, 1, -1];
const K_D = [17, 15, -17, -15, 16, -16, 1, -1];
const VAL = [0, 100, 320, 330, 500, 900, 0];
const ORD = [0, 1, 3, 3, 5, 9, 12];
const PHASE_W = [0, 0, 1, 1, 2, 4, 0];
const MATE = 30000, INF = 32000;
const MAX_PLY = 100, HIST = 4096 + MAX_PLY;
const TT_BITS = 19, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
const T_EXACT = 1, T_LOWER = 2, T_UPPER = 3;
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const mv = (from, to, promo = 0, flag = 0) => from | (to << 7) | (promo << 14) | (flag << 17);

// piece-square tables, white's view, index 0 = a8 … 63 = h1 (as printed)
const PST = [null,
  [0, 0, 0, 0, 0, 0, 0, 0, 40, 40, 40, 40, 40, 40, 40, 40, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
];
const K_MG = [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20];
const K_EG = [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50];
const PASS_MG = [0, 5, 10, 15, 25, 40, 60, 0];
const PASS_EG = [0, 10, 20, 35, 55, 85, 120, 0];

const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[4] = 15 & ~(WK | WQ); CASTLE_MASK[7] = 15 & ~WK; CASTLE_MASK[0] = 15 & ~WQ;
CASTLE_MASK[116] = 15 & ~(BK | BQ); CASTLE_MASK[119] = 15 & ~BK; CASTLE_MASK[112] = 15 & ~BQ;

// zobrist keys (two 32-bit halves), deterministic xorshift
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
const Z_LO = new Int32Array(16 * 128), Z_HI = new Int32Array(16 * 128);
for (let i = 0; i < Z_LO.length; i++) { Z_LO[i] = rnd(); Z_HI[i] = rnd(); }
const ZC_LO = new Int32Array(16), ZC_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) { ZC_LO[i] = rnd(); ZC_HI[i] = rnd(); }
const ZE_LO = new Int32Array(8), ZE_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) { ZE_LO[i] = rnd(); ZE_HI[i] = rnd(); }
const ZS_LO = rnd(), ZS_HI = rnd();

// a small opening book so the stronger levels don't play the same game every time
const BOOK = [
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7',
  'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6',
  'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 d4c6 b7c6',
  'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4 d2d4 d6d5',
  'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6',
  'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5',
  'e2e4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7 d2d3 d7d6',
  'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7',
  'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6',
  'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8',
  'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5',
  'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8',
  'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5',
  'd2d4 d7d5 g1f3 g8f6 c1f4 e7e6 e2e3 c7c5 c2c3 b8c6',
  'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 d7d5 c4d5 f6d5',
  'g1f3 d7d5 g2g3 g8f6 f1g2 e7e6 e1g1 f8e7 d2d3 e8g8',
].map((l) => l.split(' '));

/** difficulty presets (1 = 입문 … 5 = 최강) */
export const LEVELS = [null,
  { depth: 1, noise: 280, blunder: 0.15 },
  { depth: 2, noise: 130, blunder: 0.04 },
  { depth: 3, noise: 45, book: true },
  { time: 700, maxDepth: 6, book: true },
  { time: 1800, maxDepth: 40, book: true },
];

export class Engine {
  constructor() {
    this.board = new Int8Array(128);
    this.kings = [4, 116];
    this.uMove = new Int32Array(HIST); this.uCap = new Int8Array(HIST); this.uCastle = new Int8Array(HIST);
    this.uEp = new Int16Array(HIST); this.uHalf = new Int16Array(HIST);
    this.uHlo = new Int32Array(HIST); this.uHhi = new Int32Array(HIST);
    this.hhLo = new Int32Array(HIST + 1); this.hhHi = new Int32Array(HIST + 1);
    this.mlist = Array.from({ length: MAX_PLY + 1 }, () => new Int32Array(256));
    this.mscore = Array.from({ length: MAX_PLY + 1 }, () => new Int32Array(256));
    this.killers = new Int32Array((MAX_PLY + 1) * 2);
    this.history = new Int32Array(2 * 128 * 128);
    this.ttLo = new Int32Array(TT_SIZE); this.ttHi = new Int32Array(TT_SIZE); this.ttMove = new Int32Array(TT_SIZE);
    this.ttScore = new Int16Array(TT_SIZE); this.ttDepth = new Int8Array(TT_SIZE); this.ttFlag = new Int8Array(TT_SIZE);
    this.pf = { wc: new Int8Array(8), bc: new Int8Array(8), wMin: new Int8Array(8), bMax: new Int8Array(8) };
    this.pawnSq = new Int16Array(16); this.rookSq = new Int16Array(16);
    this.loadFen(START_FEN);
  }

  // ------------------------------------------------------------- position setup
  loadFen(fen) {
    const [pos, side = 'w', cas = '-', ep = '-', half = '0'] = fen.trim().split(/\s+/);
    this.board.fill(0);
    let r = 7, f = 0;
    for (const ch of pos) {
      if (ch === '/') { r--; f = 0; continue; }
      if (ch >= '1' && ch <= '8') { f += +ch; continue; }
      const t = 'pnbrqk'.indexOf(ch.toLowerCase()) + 1;
      const sq = r * 16 + f;
      this.board[sq] = t | (ch === ch.toLowerCase() ? BLACK : 0);
      if (t === KING) this.kings[ch === 'k' ? 1 : 0] = sq;
      f++;
    }
    this.side = side === 'b' ? 1 : 0;
    this.castle = (cas.includes('K') ? WK : 0) | (cas.includes('Q') ? WQ : 0) | (cas.includes('k') ? BK : 0) | (cas.includes('q') ? BQ : 0);
    this.ep = ep === '-' ? -1 : this.sqOf(ep);
    this.half = parseInt(half, 10) || 0;
    this.ply = 0;
    this._rehash();
    this.hhLo[0] = this.hashLo; this.hhHi[0] = this.hashHi;
  }

  _rehash() {
    let lo = 0, hi = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.board[sq];
      if (p) { lo ^= Z_LO[p * 128 + sq]; hi ^= Z_HI[p * 128 + sq]; }
    }
    lo ^= ZC_LO[this.castle]; hi ^= ZC_HI[this.castle];
    if (this.ep >= 0) { lo ^= ZE_LO[this.ep & 7]; hi ^= ZE_HI[this.ep & 7]; }
    if (this.side) { lo ^= ZS_LO; hi ^= ZS_HI; }
    this.hashLo = lo; this.hashHi = hi;
  }

  sqOf(s) { return (s.charCodeAt(1) - 49) * 16 + (s.charCodeAt(0) - 97); }
  sqName(sq) { return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 4)); }
  toUci(m) { const p = (m >> 14) & 7; return this.sqName(m & 127) + this.sqName((m >> 7) & 127) + (p ? ' pnbrq'[p] : ''); }

  // ------------------------------------------------------------- attacks / moves
  attacked(sq, by) {
    const b = this.board, bb = by ? BLACK : 0;
    let s;
    if (by) {
      s = sq + 15; if (!(s & 0x88) && b[s] === (PAWN | BLACK)) return true;
      s = sq + 17; if (!(s & 0x88) && b[s] === (PAWN | BLACK)) return true;
    } else {
      s = sq - 15; if (!(s & 0x88) && b[s] === PAWN) return true;
      s = sq - 17; if (!(s & 0x88) && b[s] === PAWN) return true;
    }
    const kn = KNIGHT | bb, kg = KING | bb, bi = BISHOP | bb, rk = ROOK | bb, qn = QUEEN | bb;
    for (let i = 0; i < 8; i++) {
      s = sq + N_D[i]; if (!(s & 0x88) && b[s] === kn) return true;
      s = sq + K_D[i]; if (!(s & 0x88) && b[s] === kg) return true;
    }
    for (let i = 0; i < 4; i++) {
      let d = B_D[i]; s = sq + d;
      while (!(s & 0x88)) { const p = b[s]; if (p) { if (p === bi || p === qn) return true; break; } s += d; }
      d = R_D[i]; s = sq + d;
      while (!(s & 0x88)) { const p = b[s]; if (p) { if (p === rk || p === qn) return true; break; } s += d; }
    }
    return false;
  }

  inCheck() { return this.attacked(this.kings[this.side], this.side ^ 1); }

  /** pseudo-legal moves into list; caps = captures + queen promotions only */
  gen(list, caps) {
    const b = this.board, us = this.side, ub = us ? BLACK : 0;
    let n = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const pc = b[sq];
      if (!pc || (pc & BLACK) !== ub) continue;
      const t = pc & 7;
      if (t === PAWN) {
        const fwd = us ? -16 : 16, r = sq >> 4, promoFrom = us ? 1 : 6;
        const to = sq + fwd;
        if (!b[to]) {
          if (r === promoFrom) n = this._promos(list, n, sq, to, caps);
          else if (!caps) {
            list[n++] = mv(sq, to);
            if (r === (us ? 6 : 1) && !b[to + fwd]) list[n++] = mv(sq, to + fwd, 0, F_DOUBLE);
          }
        }
        for (let k = -1; k <= 1; k += 2) {
          const c = to + k;
          if (c & 0x88) continue;
          const tp = b[c];
          if (tp) {
            if ((tp & BLACK) !== ub) {
              if (r === promoFrom) n = this._promos(list, n, sq, c, caps);
              else list[n++] = mv(sq, c);
            }
          } else if (c === this.ep) list[n++] = mv(sq, c, 0, F_EP);
        }
      } else if (t === KNIGHT || t === KING) {
        const D = t === KNIGHT ? N_D : K_D;
        for (let i = 0; i < 8; i++) {
          const to = sq + D[i];
          if (to & 0x88) continue;
          const tp = b[to];
          if (!tp) { if (!caps) list[n++] = mv(sq, to); } else if ((tp & BLACK) !== ub) list[n++] = mv(sq, to);
        }
        if (t === KING && !caps) n = this._castles(list, n, sq);
      } else {
        const D = t === BISHOP ? B_D : t === ROOK ? R_D : K_D;
        for (let i = 0; i < D.length; i++) {
          const d = D[i];
          let to = sq + d;
          while (!(to & 0x88)) {
            const tp = b[to];
            if (!tp) { if (!caps) list[n++] = mv(sq, to); } else { if ((tp & BLACK) !== ub) list[n++] = mv(sq, to); break; }
            to += d;
          }
        }
      }
    }
    return n;
  }

  _promos(list, n, from, to, caps) {
    list[n++] = mv(from, to, QUEEN);
    if (!caps) { list[n++] = mv(from, to, KNIGHT); list[n++] = mv(from, to, ROOK); list[n++] = mv(from, to, BISHOP); }
    return n;
  }

  _castles(list, n, sq) {
    const b = this.board;
    if (this.side === 0 && sq === 4) {
      if ((this.castle & WK) && !b[5] && !b[6] && b[7] === ROOK && !this.attacked(4, 1) && !this.attacked(5, 1) && !this.attacked(6, 1)) list[n++] = mv(4, 6, 0, F_CASTLE);
      if ((this.castle & WQ) && !b[3] && !b[2] && !b[1] && b[0] === ROOK && !this.attacked(4, 1) && !this.attacked(3, 1) && !this.attacked(2, 1)) list[n++] = mv(4, 2, 0, F_CASTLE);
    } else if (this.side === 1 && sq === 116) {
      if ((this.castle & BK) && !b[117] && !b[118] && b[119] === (ROOK | BLACK) && !this.attacked(116, 0) && !this.attacked(117, 0) && !this.attacked(118, 0)) list[n++] = mv(116, 118, 0, F_CASTLE);
      if ((this.castle & BQ) && !b[115] && !b[114] && !b[113] && b[112] === (ROOK | BLACK) && !this.attacked(116, 0) && !this.attacked(115, 0) && !this.attacked(114, 0)) list[n++] = mv(116, 114, 0, F_CASTLE);
    }
    return n;
  }

  legalMoves() {
    const list = new Int32Array(256);
    const n = this.gen(list, false);
    const out = [];
    for (let i = 0; i < n; i++) if (this.make(list[i])) { this.unmake(); out.push(list[i]); }
    return out;
  }

  parseUci(u) {
    if (typeof u !== 'string' || u.length < 4) return 0;
    const from = this.sqOf(u.slice(0, 2)), to = this.sqOf(u.slice(2, 4));
    const promo = u[4] ? ' pnbrq'.indexOf(u[4]) : 0;
    for (const m of this.legalMoves()) {
      if ((m & 127) === from && ((m >> 7) & 127) === to && ((m >> 14) & 7) === (promo > 0 ? promo : 0)) return m;
    }
    return 0;
  }

  // ------------------------------------------------------------- make / unmake
  _hx(p, sq) { this.hashLo ^= Z_LO[p * 128 + sq]; this.hashHi ^= Z_HI[p * 128 + sq]; }

  /** plays m; returns false (and takes it back) if it leaves our king in check */
  make(m) {
    const b = this.board, from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7;
    const us = this.side, p = this.ply, pc = b[from];
    let cap = b[to], capSq = to;
    this.uMove[p] = m; this.uCastle[p] = this.castle; this.uEp[p] = this.ep; this.uHalf[p] = this.half;
    this.uHlo[p] = this.hashLo; this.uHhi[p] = this.hashHi;
    if (flag === F_EP) { capSq = to + (us ? 16 : -16); cap = b[capSq]; b[capSq] = 0; }
    this.uCap[p] = cap;
    if (cap) this._hx(cap, capSq);
    this._hx(pc, from);
    const np = promo ? (promo | (pc & BLACK)) : pc;
    b[to] = np; b[from] = 0;
    this._hx(np, to);
    if (flag === F_CASTLE) {
      const rf = to === 6 ? 7 : to === 2 ? 0 : to === 118 ? 119 : 112;
      const rt = to === 6 ? 5 : to === 2 ? 3 : to === 118 ? 117 : 115;
      const rk = b[rf]; b[rt] = rk; b[rf] = 0; this._hx(rk, rf); this._hx(rk, rt);
    }
    if ((pc & 7) === KING) this.kings[us] = to;
    if (this.ep >= 0) { this.hashLo ^= ZE_LO[this.ep & 7]; this.hashHi ^= ZE_HI[this.ep & 7]; }
    this.ep = -1;
    if (flag === F_DOUBLE) { this.ep = (from + to) >> 1; this.hashLo ^= ZE_LO[this.ep & 7]; this.hashHi ^= ZE_HI[this.ep & 7]; }
    this.hashLo ^= ZC_LO[this.castle]; this.hashHi ^= ZC_HI[this.castle];
    this.castle &= CASTLE_MASK[from] & CASTLE_MASK[to];
    this.hashLo ^= ZC_LO[this.castle]; this.hashHi ^= ZC_HI[this.castle];
    this.half = ((pc & 7) === PAWN || cap) ? 0 : this.half + 1;
    this.side = us ^ 1;
    this.hashLo ^= ZS_LO; this.hashHi ^= ZS_HI;
    this.ply = p + 1;
    this.hhLo[p + 1] = this.hashLo; this.hhHi[p + 1] = this.hashHi;
    if (this.attacked(this.kings[us], us ^ 1)) { this.unmake(); return false; }
    return true;
  }

  unmake() {
    const p = --this.ply, b = this.board, m = this.uMove[p];
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7;
    this.side ^= 1;
    const us = this.side, pc = b[to], cap = this.uCap[p];
    b[from] = promo ? (PAWN | (pc & BLACK)) : pc;
    b[to] = 0;
    if (flag === F_EP) b[to + (us ? 16 : -16)] = cap; else b[to] = cap;
    if (flag === F_CASTLE) {
      const rf = to === 6 ? 7 : to === 2 ? 0 : to === 118 ? 119 : 112;
      const rt = to === 6 ? 5 : to === 2 ? 3 : to === 118 ? 117 : 115;
      b[rf] = b[rt]; b[rt] = 0;
    }
    if ((b[from] & 7) === KING) this.kings[us] = from;
    this.castle = this.uCastle[p]; this.ep = this.uEp[p]; this.half = this.uHalf[p];
    this.hashLo = this.uHlo[p]; this.hashHi = this.uHhi[p];
  }

  _makeNull() {
    const p = this.ply;
    this.uEp[p] = this.ep; this.uHalf[p] = this.half; this.uHlo[p] = this.hashLo; this.uHhi[p] = this.hashHi;
    if (this.ep >= 0) { this.hashLo ^= ZE_LO[this.ep & 7]; this.hashHi ^= ZE_HI[this.ep & 7]; }
    this.ep = -1;
    this.half = 0; // repetitions never span a null move
    this.side ^= 1;
    this.hashLo ^= ZS_LO; this.hashHi ^= ZS_HI;
    this.ply = p + 1;
    this.hhLo[p + 1] = this.hashLo; this.hhHi[p + 1] = this.hashHi;
  }

  _unmakeNull() {
    const p = --this.ply;
    this.side ^= 1;
    this.ep = this.uEp[p]; this.half = this.uHalf[p]; this.hashLo = this.uHlo[p]; this.hashHi = this.uHhi[p];
  }

  _repetition() {
    for (let i = this.ply - 2; i >= 0 && i >= this.ply - this.half; i -= 2) {
      if (this.hhLo[i] === this.hashLo && this.hhHi[i] === this.hashHi) return true;
    }
    return false;
  }

  _hasPieces(side) {
    const b = this.board, ub = side ? BLACK : 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (p && (p & BLACK) === ub && (p & 7) !== PAWN && (p & 7) !== KING) return true;
    }
    return false;
  }

  // ------------------------------------------------------------- evaluation
  /** score in centipawns from the side to move's point of view */
  evaluate() {
    const b = this.board, pf = this.pf;
    pf.wc.fill(0); pf.bc.fill(0); pf.wMin.fill(8); pf.bMax.fill(-1);
    let mg = 0, eg = 0, phase = 0, np = 0, nr = 0;
    let matW = 0, matB = 0, minW = 0, minB = 0, bishW = 0, bishB = 0, pawns = 0, heavy = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const pc = b[sq];
      if (!pc) continue;
      const t = pc & 7, black = pc & BLACK, r = sq >> 4, f = sq & 7;
      const idx = black ? r * 8 + f : (7 - r) * 8 + f;
      let m, e;
      if (t === KING) { m = K_MG[idx]; e = K_EG[idx]; } else { m = e = VAL[t] + PST[t][idx]; }
      phase += PHASE_W[t];
      if (black) { mg -= m; eg -= e; matB += VAL[t]; } else { mg += m; eg += e; matW += VAL[t]; }
      if (t === PAWN) {
        pawns++;
        this.pawnSq[np++] = sq;
        if (black) { pf.bc[f]++; if (r > pf.bMax[f]) pf.bMax[f] = r; } else { pf.wc[f]++; if (r < pf.wMin[f]) pf.wMin[f] = r; }
      } else if (t === KNIGHT || t === BISHOP) {
        if (black) { minB++; if (t === BISHOP) bishB++; } else { minW++; if (t === BISHOP) bishW++; }
      } else if (t === ROOK || t === QUEEN) {
        heavy++;
        if (t === ROOK && nr < 16) this.rookSq[nr++] = sq;
      }
    }
    if (!pawns && !heavy && minW <= 1 && minB <= 1) return 0; // insufficient material
    // pawn structure
    for (let i = 0; i < np; i++) {
      const sq = this.pawnSq[i], r = sq >> 4, f = sq & 7, black = b[sq] & BLACK;
      let m = 0, e = 0;
      const own = black ? pf.bc : pf.wc;
      if (own[f] > 1) { m -= 10; e -= 20; }
      if ((f === 0 || !own[f - 1]) && (f === 7 || !own[f + 1])) { m -= 12; e -= 14; }
      let passed = true;
      for (let ff = Math.max(0, f - 1); ff <= Math.min(7, f + 1); ff++) {
        if (black ? pf.wMin[ff] < r : pf.bMax[ff] > r) { passed = false; break; }
      }
      if (passed) { const rr = black ? 7 - r : r; m += PASS_MG[rr]; e += PASS_EG[rr]; }
      if (black) { mg -= m; eg -= e; } else { mg += m; eg += e; }
    }
    for (let i = 0; i < nr; i++) {
      const sq = this.rookSq[i], f = sq & 7, black = b[sq] & BLACK;
      const own = black ? pf.bc[f] : pf.wc[f], opp = black ? pf.wc[f] : pf.bc[f];
      const bonus = !own ? (!opp ? 20 : 10) : 0;
      if (black) { mg -= bonus; eg -= bonus >> 1; } else { mg += bonus; eg += bonus >> 1; }
    }
    if (bishW >= 2) { mg += 30; eg += 50; }
    if (bishB >= 2) { mg -= 30; eg -= 50; }
    // mop-up: drive the lone king to the edge and bring ours closer
    const diff = matW - matB;
    if (phase <= 8 && Math.abs(diff) >= 300) {
      const win = diff > 0 ? 0 : 1;
      const lk = this.kings[win ^ 1], wk = this.kings[win];
      const lr = lk >> 4, lf = lk & 7;
      const centre = Math.max(3 - lr, lr - 4) + Math.max(3 - lf, lf - 4);
      const dist = Math.abs(lr - (wk >> 4)) + Math.abs(lf - (wk & 7));
      const bonus = centre * 12 + (14 - dist) * 5;
      eg += win === 0 ? bonus : -bonus;
    }
    if (phase > 24) phase = 24;
    const score = ((mg * phase + eg * (24 - phase)) / 24) | 0;
    return (this.side === 0 ? score : -score) + 10;
  }

  // ------------------------------------------------------------- search
  _score(list, sc, n, ttMove, ply) {
    const b = this.board, k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1], hb = this.side << 14;
    for (let i = 0; i < n; i++) {
      const m = list[i];
      if (m === ttMove) { sc[i] = 10_000_000; continue; }
      const from = m & 127, to = (m >> 7) & 127, cap = b[to], promo = (m >> 14) & 7;
      if (cap || ((m >> 17) & 7) === F_EP) sc[i] = 1_000_000 + ORD[cap ? cap & 7 : PAWN] * 16 - ORD[b[from] & 7] + (promo ? 500 : 0);
      else if (promo) sc[i] = 900_000 + promo;
      else if (m === k1) sc[i] = 800_000;
      else if (m === k2) sc[i] = 700_000;
      else sc[i] = this.history[hb | (from << 7) | to];
    }
  }

  _pick(list, sc, i, n) {
    let bi = i, bs = sc[i];
    for (let j = i + 1; j < n; j++) if (sc[j] > bs) { bs = sc[j]; bi = j; }
    if (bi !== i) {
      const m = list[i]; list[i] = list[bi]; list[bi] = m;
      const s = sc[i]; sc[i] = sc[bi]; sc[bi] = s;
    }
    return list[i];
  }

  _tick() {
    if ((++this.nodes & 2047) === 0 && Date.now() > this.deadline) this.stop = true;
    return this.stop;
  }

  qsearch(alpha, beta, ply) {
    if (this._tick()) return 0;
    const stand = this.evaluate();
    if (ply >= MAX_PLY || stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const list = this.mlist[ply], sc = this.mscore[ply];
    const n = this.gen(list, true);
    this._score(list, sc, n, 0, ply);
    let best = stand;
    for (let i = 0; i < n; i++) {
      const m = this._pick(list, sc, i, n);
      const cap = this.board[(m >> 7) & 127];
      const gain = (cap ? VAL[cap & 7] : 100) + (((m >> 14) & 7) ? 800 : 0);
      if (stand + gain + 200 < alpha) continue; // delta pruning
      if (!this.make(m)) continue;
      const s = -this.qsearch(-beta, -alpha, ply + 1);
      this.unmake();
      if (this.stop) return 0;
      if (s > best) {
        best = s;
        if (s > alpha) { alpha = s; if (s >= beta) break; }
      }
    }
    return best;
  }

  search(depth, alpha, beta, ply, allowNull) {
    if (this._tick()) return 0;
    const root = ply === 0;
    if (!root) {
      if (this.half >= 100 || this._repetition()) return 0;
      const ma = Math.max(alpha, -MATE + ply), mb = Math.min(beta, MATE - ply - 1);
      if (ma >= mb) return ma;
      alpha = ma; beta = mb;
    }
    const inCheck = this.inCheck();
    if (inCheck) depth++;
    if (depth <= 0) return this.qsearch(alpha, beta, ply);
    if (ply >= MAX_PLY - 1) return this.evaluate();
    const pv = beta - alpha > 1;
    let ttMove = 0;
    const idx = this.hashLo & TT_MASK;
    if (this.ttLo[idx] === this.hashLo && this.ttHi[idx] === this.hashHi) {
      ttMove = this.ttMove[idx];
      if (!root && !pv && this.ttDepth[idx] >= depth) {
        let s = this.ttScore[idx];
        if (s > MATE - 200) s -= ply; else if (s < -MATE + 200) s += ply;
        const f = this.ttFlag[idx];
        if (f === T_EXACT || (f === T_LOWER && s >= beta) || (f === T_UPPER && s <= alpha)) return s;
      }
    }
    if (allowNull && !pv && !inCheck && depth >= 3 && this._hasPieces(this.side) && this.evaluate() >= beta) {
      this._makeNull();
      const s = -this.search(depth - 1 - (depth >= 6 ? 3 : 2), -beta, -beta + 1, ply + 1, false);
      this._unmakeNull();
      if (this.stop) return 0;
      if (s >= beta) return beta;
    }
    const list = this.mlist[ply], sc = this.mscore[ply];
    const n = this.gen(list, false);
    this._score(list, sc, n, ttMove, ply);
    const a0 = alpha;
    let best = -INF, bestMove = 0, legal = 0;
    for (let i = 0; i < n; i++) {
      const m = this._pick(list, sc, i, n);
      const quiet = !this.board[(m >> 7) & 127] && !((m >> 14) & 7) && ((m >> 17) & 7) !== F_EP;
      if (!this.make(m)) continue;
      legal++;
      let s;
      if (legal === 1) s = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      else {
        let r = 0;
        if (depth >= 3 && quiet && !inCheck && legal > 3 && sc[i] < 700_000 && !this.inCheck()) r = legal > 10 ? 2 : 1;
        s = -this.search(depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && r) s = -this.search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && s < beta) s = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      }
      this.unmake();
      if (this.stop) return 0;
      if (s > best) {
        best = s; bestMove = m;
        if (s > alpha) {
          alpha = s;
          if (root) { this.rootBest = m; this.rootScore = s; }
          if (s >= beta) {
            if (quiet) {
              if (this.killers[ply * 2] !== m) { this.killers[ply * 2 + 1] = this.killers[ply * 2]; this.killers[ply * 2] = m; }
              const h = (this.side << 14) | ((m & 127) << 7) | ((m >> 7) & 127);
              this.history[h] = Math.min(600_000, this.history[h] + depth * depth);
            }
            break;
          }
        }
      }
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    let ts = best;
    if (ts > MATE - 200) ts += ply; else if (ts < -MATE + 200) ts -= ply;
    this.ttLo[idx] = this.hashLo; this.ttHi[idx] = this.hashHi; this.ttMove[idx] = bestMove;
    this.ttScore[idx] = ts; this.ttDepth[idx] = depth;
    this.ttFlag[idx] = best >= beta ? T_LOWER : best > a0 ? T_EXACT : T_UPPER;
    return best;
  }

  _prepSearch(ms) {
    this.nodes = 0;
    this.stop = false;
    this.deadline = Date.now() + ms;
    this.killers.fill(0);
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 2;
  }

  /** iterative deepening within a time budget */
  searchBest(maxDepth, ms) {
    const t0 = Date.now();
    this._prepSearch(ms);
    let best = 0, score = 0, depth = 0;
    for (let d = 1; d <= maxDepth; d++) {
      this.rootBest = 0;
      const s = this.search(d, -INF, INF, 0, true);
      if (this.stop) { if (this.rootBest) { best = this.rootBest; score = this.rootScore; } break; }
      best = this.rootBest || best; score = s; depth = d;
      if (Math.abs(s) > MATE - 200) break;
      if (Date.now() - t0 > ms * 0.5) break; // the next iteration would not finish
    }
    return { move: best, score, depth };
  }

  /** score every root move at a fixed depth and pick the best after adding noise */
  searchNoisy(depth, noise) {
    this._prepSearch(60_000);
    const moves = this.legalMoves();
    let best = 0, bestNoisy = -Infinity, score = 0;
    for (const m of moves) {
      this.make(m);
      const s = -this.search(depth - 1, -INF, INF, 1, true);
      this.unmake();
      const v = s + (Math.random() * 2 - 1) * noise;
      if (v > bestNoisy) { bestNoisy = v; best = m; score = s; }
    }
    return { move: best, score, depth };
  }

  _bookMove(history) {
    const next = new Set();
    for (const line of BOOK) {
      if (line.length <= history.length) continue;
      let ok = true;
      for (let i = 0; i < history.length; i++) if (line[i] !== history[i]) { ok = false; break; }
      if (ok) next.add(line[history.length]);
    }
    const cands = [...next].filter((u) => this.parseUci(u));
    return cands.length ? cands[(Math.random() * cands.length) | 0] : null;
  }

  /** main entry: moves = UCI list from the start position, level = 1..5 */
  think(moves, level) {
    const cfg = LEVELS[level] || LEVELS[3];
    this.loadFen(START_FEN);
    for (const u of moves) { const m = this.parseUci(u); if (!m || !this.make(m)) break; }
    const legal = this.legalMoves();
    if (!legal.length) return { uci: null };
    if (cfg.book) {
      const bm = this._bookMove(moves);
      if (bm) return { uci: bm, book: true, score: 0, depth: 0, nodes: 0 };
    }
    let r;
    if (cfg.blunder && Math.random() < cfg.blunder) r = { move: legal[(Math.random() * legal.length) | 0], score: 0, depth: 0 };
    else if (cfg.depth) r = this.searchNoisy(cfg.depth, cfg.noise);
    else r = this.searchBest(cfg.maxDepth, cfg.time);
    const move = r.move || legal[0];
    return { uci: this.toUci(move), score: r.score, depth: r.depth, nodes: this.nodes };
  }

  perft(depth) {
    if (depth === 0) return 1;
    const list = new Int32Array(256);
    const n = this.gen(list, false);
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!this.make(list[i])) continue;
      total += this.perft(depth - 1);
      this.unmake();
    }
    return total;
  }
}
