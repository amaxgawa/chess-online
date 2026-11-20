// ─────────────────────────────────────────────────────────────────────────────
//  Chess Lounge — configuration
// ─────────────────────────────────────────────────────────────────────────────
export const APP_NAME = 'Chess Lounge';
export const APP_VERSION = '1.0.0';
export const PROTOCOL = 1;

// Everyone who uses the same NAMESPACE (on the same broker) shares one lobby.
// Change the random suffix if you fork this project so you get your own lobby.
// You can also open a separate lobby with a URL parameter:  ?lobby=우리끼리
export const NAMESPACE = 'chess-lounge/v1/k7q3xw9f';

// Free public MQTT-over-WebSocket brokers (tried in this order).
// Everyone must end up on the same broker to see each other, so keep the order identical.
export const BROKERS = [
  { id: 'emqx', name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  { id: 'hivemq', name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
  { id: 'mosquitto', name: 'Mosquitto', url: 'wss://test.mosquitto.org:8081' },
];

// Optional private broker (e.g. HiveMQ Cloud / EMQX Serverless free tier).
// When set, it is used first. Example:
// export const CUSTOM_BROKER = { id: 'custom', name: '내 서버', url: 'wss://xxxx.hivemq.cloud:8884/mqtt', username: 'chess', password: '...' };
export const CUSTOM_BROKER = null;

export const TIME_CONTROLS = [
  { b: 60, i: 0 }, { b: 180, i: 0 }, { b: 180, i: 2 }, { b: 300, i: 0 }, { b: 300, i: 3 },
  { b: 600, i: 0 }, { b: 600, i: 5 }, { b: 900, i: 10 }, { b: 1800, i: 0 }, { b: 0, i: 0 },
];
export const DEFAULT_TC = { b: 600, i: 0 };

export const ROOM_TITLES = [
  '한 판 하실 분~', '초보 환영해요 ♟', '진지하게 한 판', '심심한데 체스나', '고수만 오세요',
  '가볍게 블리츠', '체크메이트 각', '오늘의 대결', '퇴근 후 한 판', '복수전 받습니다',
];

export const RATING_START = 1000;

export const TIERS = [
  { min: -Infinity, key: 'bronze', name: '브론즈', color: '#b9773f' },
  { min: 900, key: 'silver', name: '실버', color: '#8f9aa6' },
  { min: 1100, key: 'gold', name: '골드', color: '#d4a017' },
  { min: 1300, key: 'platinum', name: '플래티넘', color: '#2bb3a3' },
  { min: 1500, key: 'diamond', name: '다이아', color: '#4f8df5' },
  { min: 1700, key: 'master', name: '마스터', color: '#b45cf0' },
];

export const AVATAR_PIECES = ['n', 'q', 'k', 'r', 'b', 'p'];
export const AVATAR_HUES = [152, 205, 262, 330, 12, 34, 48, 186];

export const PIECE_NAMES = { k: '킹', q: '퀸', r: '룩', b: '비숍', n: '나이트', p: '폰' };
export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const REASONS = {
  checkmate: '체크메이트',
  resign: '기권',
  timeout: '시간 초과',
  stalemate: '스테일메이트',
  insufficient: '기물 부족',
  threefold: '3회 동형 반복',
  fifty: '50수 규칙',
  agreement: '무승부 합의',
  abandon: '상대 이탈',
  timeoutvsinsufficient: '시간 초과 (기물 부족)',
  aborted: '게임 취소',
};

// vs-computer difficulty (engine presets live in js/engine/engine.js LEVELS)
export const BOT_LEVELS = [null,
  { name: '입문', desc: '이제 막 규칙을 배운 수준. 실수를 자주 해요', h: 152, p: 'p' },
  { name: '초급', desc: '눈앞의 기물은 챙기지만 허점이 많아요', h: 186, p: 'n' },
  { name: '중급', desc: '3수 앞을 읽고 오프닝도 알아요', h: 48, p: 'b' },
  { name: '상급', desc: '5~6수 앞까지 계산해요. 방심하면 져요', h: 262, p: 'r' },
  { name: '최강', desc: '한 수에 2초 가까이 깊게 읽어요', h: 330, p: 'q' },
];
