// STARFALL — HUD / 2D presentation layer (v2: one or two players).
// DOM + CSS for screens, 2D canvases for everything that updates per frame
// (pictogram lane, camera views, live pose read-outs, sync meters). No dependency
// on other game modules at import time; ./choreo.js is imported lazily only when
// a timeline move arrives without a resolved `poseData`.
//
// Player index 0 = P1 (screen-left, teal), 1 = P2 (screen-right, coral). Every
// `player` argument defaults to 0, so v1 callers keep working unchanged.
//
// Two game modes share this HUD: 'dance' (the default, one or two players) and 'slash'
// ("STAR SLASH", one player). The run screens are laid out for the slash mode only when the
// game asks for it (setMode / showScreen(name, { mode }) / showResults(stats, { mode })), so a
// caller that knows nothing about the second mode keeps getting the dance HUD.

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

import { SONGS, SONG_IDS, DEFAULT_SONG, timingOf } from './song.js';

const RATING_ORDER = ['perfect', 'super', 'good', 'ok', 'miss'];

const RATING_INFO = {
  perfect: { word: 'PERFECT', ko: '완벽해요!', color: '#ffe08a' },
  super: { word: 'SUPER', ko: '멋져요!', color: '#19e3d2' },
  good: { word: 'GOOD', ko: '좋아요!', color: '#a98bff' },
  ok: { word: 'OK', ko: '조금만 더!', color: '#d5d8ff' },
  miss: { word: 'MISS', ko: '놓쳤어요', color: '#ff5a6e' },
};

// how much of the burst each rating gets: 0 miss, 1 ok, 2 good, 3 super, 4 perfect
const RATING_TIER = { miss: 0, ok: 1, good: 2, super: 3, perfect: 4 };

const SECTION_LABELS = {
  intro: '인트로',
  verseA: '1절',
  build: '빌드업',
  chorus1: '코러스',
  verseB: '2절',
  bridge: '브리지',
  chorus2: '파이널 코러스',
  outro: '아웃트로',
};

const RESULT_TITLES = ['다시 도전!', '워밍업 완료', '좋은 출발', '빛나는 무대', '눈부신 무대', '슈퍼노바!'];

const CAMERA_STATUS = {
  requesting: '카메라를 준비하는 중…',
  searching: '아직 보이지 않아요. 카메라 앞에 서 주세요',
  almost: '조금만 더! 어깨와 양팔이 화면에 들어오게 서 주세요',
  ready: '좋아요! 그대로 잠깐만 계세요',
  go: '준비 완료! 곧 시작합니다',
};

const CAMERA_STATUS_2P = {
  requesting: '카메라를 준비하는 중…',
  searching: 'P1은 왼쪽, P2는 오른쪽에 서 주세요',
  almost: '두 사람 모두 상반신이 보이게 서 주세요',
  ready: '좋아요! 둘 다 그대로 잠깐만 계세요',
  go: '준비 완료! 곧 시작합니다',
};

// per-player chips on the 2P camera screen: status 0 nobody / 1 partly seen / 2 wrong half / 3 ready
const CHIP_STATES = ['none', 'partial', 'side', 'ready'];
const CHIP_TEXT = [
  ['P1 왼쪽에 서 주세요', 'P1 양팔까지 보이게 서 주세요', 'P1 왼쪽으로 조금 더 가 주세요', 'P1 준비 완료!'],
  ['P2 오른쪽에 서 주세요', 'P2 양팔까지 보이게 서 주세요', 'P2 오른쪽으로 조금 더 가 주세요', 'P2 준비 완료!'],
];
const WAITING_TEXT = ['P2 준비 완료! P1을 기다리고 있어요', 'P1 준비 완료! P2를 기다리고 있어요'];

/**
 * What this page is running on. It decides the wording of the camera help (a phone has no
 * address-bar camera icon and no lid), whether the page sits inside another app's web view
 * (KakaoTalk, Instagram …: those often cannot open the camera at all), and whether the
 * keyboard mode gets touch pads.
 */
export function sniffDevice(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : {});
  const ua = String(n.userAgent || '');
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && n.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  let inApp = '';
  if (/KAKAOTALK/i.test(ua)) inApp = '카카오톡';
  else if (/NAVER\(inapp/i.test(ua)) inApp = '네이버 앱';
  else if (/Instagram/i.test(ua)) inApp = '인스타그램';
  else if (/FBAN|FBAV|FB_IAB/i.test(ua)) inApp = '페이스북';
  else if (/\bLine\//i.test(ua)) inApp = '라인';
  else if (/DaumApps/i.test(ua)) inApp = '다음 앱';
  else if (android && /; wv\)/.test(ua)) inApp = '이 앱';
  else if (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua)) inApp = '이 앱';
  let coarse = false;
  try {
    coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch (e) {
    coarse = false;
  }
  return { ios, android, mobile: ios || android, inApp, kakao: /KAKAOTALK/i.test(ua), touch: coarse };
}

// the same errors on a phone: where the permission lives there, and no talk of webcams and lids
const CAMERA_ERRORS_MOBILE = {
  denied: {
    title: '카메라 권한이 필요해요',
    ios: '주소창의 "ᴀA"(또는 ⋯) → 웹사이트 설정에서 카메라를 "허용"으로 바꾼 뒤 다시 시도해 주세요. 터치 플레이와 데모는 카메라 없이도 돼요.',
    android: '주소창의 자물쇠(또는 ⓘ) → 권한에서 카메라를 허용한 뒤 다시 시도해 주세요. 터치 플레이와 데모는 카메라 없이도 돼요.',
  },
  nodevice: {
    title: '카메라를 열 수 없어요',
    desc: '이 브라우저에서 카메라를 쓸 수 없어요. Safari나 Chrome에서 열어 보세요. 터치 플레이와 데모는 카메라 없이도 돼요.',
  },
};

const CAMERA_ERRORS = {
  // the page was opened inside another app (title and desc get the app's name)
  inapp: {
    title: ' 안에서는 카메라를 쓸 수 없어요',
    desc: 'Safari나 Chrome에서 열면 카메라로 플레이할 수 있어요. 아래 버튼을 누르거나, 메뉴(⋯)의 "다른 브라우저로 열기"를 눌러 주세요. 터치 플레이와 데모는 여기서도 돼요.',
  },
  denied: {
    title: '카메라 권한이 필요해요',
    desc: '주소창의 카메라 아이콘에서 권한을 허용한 뒤 다시 시도해 주세요. 카메라 없이 데모로도 즐길 수 있어요.',
  },
  nodevice: {
    title: '카메라를 찾을 수 없어요',
    desc: '웹캠이 연결되어 있는지 확인해 주세요. 노트북 덮개를 닫고 외부 모니터를 쓰는 중이라면 덮개를 열어야 내장 카메라가 켜져요. 카메라가 없다면 데모로 무대를 감상할 수 있어요.',
  },
  busy: {
    title: '카메라를 사용할 수 없어요',
    desc: '다른 앱이나 탭이 카메라를 쓰고 있을 수 있어요. 닫은 뒤 다시 시도해 주세요.',
  },
  insecure: {
    title: '보안 연결이 필요해요',
    desc: '카메라는 https 또는 localhost 에서만 사용할 수 있어요. 데모로는 바로 즐길 수 있어요.',
  },
  model: {
    title: '동작 인식을 불러오지 못했어요',
    desc: '네트워크 상태를 확인한 뒤 다시 시도해 주세요. 그동안 데모로 플레이할 수 있어요.',
  },
  unknown: {
    title: '카메라를 시작하지 못했어요',
    desc: '잠시 후 다시 시도하거나, 카메라 없이 데모로 플레이해 보세요.',
  },
};

const FONT_DISPLAY = '"Unbounded", "Gothic A1", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const FONT_KO = '"Gothic A1", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';

const C_INK = '#0b0620';
const C_TEAL = '#19e3d2';
const C_GOLD = '#ffc24a';
const C_CORAL = '#ff5a6e';
const C_WHITE = '#f6f1ff';
const C_UNSEEN = 'rgba(190,180,255,0.42)'; // a limb the camera cannot see: neither right nor wrong

const PLAYER_COLORS = [C_TEAL, C_CORAL];
const PLAYER_TAGS = ['P1', 'P2'];

const BEST_KEY = 'starfall.best';
const DEMO_ONLY = typeof window !== 'undefined' && window.STARFALL_DEMO_ONLY === true;

// ---------------------------------------------------------------------------
// STAR SLASH (the second mode: one player cuts star shards with both hands)
// ---------------------------------------------------------------------------

const DIFFICULTIES = ['easy', 'normal', 'hard'];
const DIFFICULTY_LABELS = { easy: '쉬움', normal: '보통', hard: '어려움' };

const SLASH_ORDER = ['perfect', 'good', 'bad', 'miss'];
const SLASH_WORDS = { perfect: 'PERFECT', good: 'GOOD', bad: 'BAD', miss: 'MISS' };
const SLASH_RANKS = ['S', 'A', 'B', 'C', 'D'];
const SLASH_RANK_STARS = { S: 5, A: 4, B: 3, C: 2, D: 1 };
const SLASH_TITLES = { S: '슈퍼노바!', A: '눈부신 궤적', B: '빛나는 궤적', C: '좋은 출발', D: '다시 도전!' };
const SLASH_HINT = '화살표 방향으로 손을 휘둘러 베세요';
// the same line for a run on the keyboard (data-input="keys" on the root)
const KEYS_HINT = '화살표와 같은 방향 키를 누르세요 · 청록은 W A S D · 금빛은 방향키';
// … and on a touch screen (data-touch on the root): two pads under the thumbs
const TOUCH_HINT = '화살표와 같은 방향을 누르세요 · 청록은 왼쪽 패드 · 금빛은 오른쪽 패드';
const HINT_SPANS = `<span class="in-cam">${SLASH_HINT}</span><span class="in-keys"><span class="in-notouch">${KEYS_HINT}</span><span class="in-touch">${TOUCH_HINT}</span></span>`;

const CAMERA_STATUS_SLASH = {
  requesting: '카메라를 준비하는 중…',
  searching: '아직 보이지 않아요. 카메라 앞에 서 주세요',
  almost: '조금만 더! 두 손이 화면 안에 들어오게 서 주세요',
  ready: '좋아요! 그대로 잠깐만 계세요',
  go: '준비 완료! 곧 시작합니다',
};

// hand colours of the mode: screen-left hand teal, screen-right hand amber
const HAND_COLORS = [C_TEAL, C_GOLD];
const C_SLASH_BONE = '#d9d2ff'; // the skeleton stays neutral so the two hand marks carry the colour

const MRING_STEPS = 8; // segments of the multiplier ring (the judge steps the multiplier every 8 hits)
const POP_COUNT = 12; // pooled rating pops: never more than this many on screen

const MODE_KEY = 'starfall.mode';
const SONG_KEY = 'starfall.song'; // the song picked on the title (each song is one difficulty)
const SLASH_BEST_KEY = 'starfall.slash.best.'; // + difficulty (camera runs)
const SLASH_KEYS_BEST_KEY = 'starfall.slash.best.keys.'; // + difficulty (keyboard runs: a score of their own)

// "0" .. "9" and "×0" .. "×9": looked up, never built, where a value may change during play
const DIGIT_TEXT = [];
const MULT_TEXT = [];
for (let i = 0; i < 10; i++) {
  DIGIT_TEXT.push(String(i));
  MULT_TEXT.push('×' + i);
}

// ---------------------------------------------------------------------------
// Live match colours ("sync")
// ---------------------------------------------------------------------------

// A limb is "맞음" (teal) from SYNC_HIT, "거의" (amber) from SYNC_NEAR, otherwise "다름" (coral).
// Once in a band it has to drop SYNC_HYST below the threshold to leave it, and the drawn colour
// eases along a coral -> amber -> teal ramp, so webcam jitter never makes a limb flicker.
const SYNC_HIT = 0.75;
const SYNC_NEAR = 0.45;
const SYNC_HYST = 0.06;
const SYNC_VALUE_TAU = 110; // ms, smoothing of the incoming match values
const SYNC_TONE_TAU = 90; // ms, easing of the drawn colour
const SYNC_STALE_MS = 600; // no setSync() for this long: fall back to the plain v1 look
const UPPER_LOW = 0.45; // below this the player is "not really in frame" during play

function hex2(n) {
  const s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
  return s.length < 2 ? '0' + s : s;
}

function mixHex(a, b, t) {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  return '#' + hex2(ar + (br - ar) * t) + hex2(ag + (bg - ag) * t) + hex2(ab + (bb - ab) * t);
}

// tone 0 = coral, 0.5 = amber, 1 = teal; strings are built once so per-frame drawing allocates nothing
const TONE_N = 33;
const TONE_LUT = [];
for (let i = 0; i < TONE_N; i++) {
  const t = i / (TONE_N - 1);
  TONE_LUT.push(t < 0.5 ? mixHex(C_CORAL, C_GOLD, t * 2) : mixHex(C_GOLD, C_TEAL, (t - 0.5) * 2));
}

function toneColor(tone) {
  const i = (tone * (TONE_N - 1) + 0.5) | 0;
  return TONE_LUT[i < 0 ? 0 : i >= TONE_N ? TONE_N - 1 : i];
}

function nextSyncState(cur, v) {
  if (cur === 2) return v >= SYNC_HIT - SYNC_HYST ? 2 : v >= SYNC_NEAR ? 1 : 0;
  if (cur === 1) return v >= SYNC_HIT ? 2 : v >= SYNC_NEAR - SYNC_HYST ? 1 : 0;
  return v >= SYNC_HIT ? 2 : v >= SYNC_NEAR ? 1 : 0;
}

// "0%" .. "100%" and scaleX(0) .. scaleX(1): looked up, never concatenated, in per-frame code
const PCT = [];
const SCALE_X = [];
for (let i = 0; i <= 100; i++) {
  PCT.push(i + '%');
  SCALE_X.push('scaleX(' + i / 100 + ')');
}

// ---------------------------------------------------------------------------
// Pictogram
// ---------------------------------------------------------------------------

// Figure proportions in "figure units" (standing height ~0.96).
const FIG = {
  neck: 0.3, // hip centre -> neck
  shoulderDrop: 0.272, // hip centre -> shoulder line, along the spine
  shoulderW: 0.1,
  hipW: 0.056,
  upperArm: 0.165,
  forearm: 0.155,
  thigh: 0.235,
  shin: 0.235,
  foot: 0.05,
  headOff: 0.118, // neck -> head centre
  headR: 0.08,
  scale: 0.78, // figure units -> fraction of `size`
  baseline: 0.47, // ground line below the box centre, fraction of `size`
  foreshortenMin: 0.5, // limbs pointing at the camera never get shorter than this
};

const J_HIP = 0, J_NECK = 1, J_HEAD = 2, J_LSH = 3, J_RSH = 4, J_LEL = 5, J_REL = 6, J_LWR = 7,
  J_RWR = 8, J_LHP = 9, J_RHP = 10, J_LKN = 11, J_RKN = 12, J_LAN = 13, J_RAN = 14, J_LTO = 15,
  J_RTO = 16, J_COUNT = 17;

const J = new Float64Array(J_COUNT * 2); // scratch joints, reused by every call
// Scratch scalars live in a typed array as well: a `let` that holds a non-integer number is
// boxed anew on every write, which made each figure cost about twenty tiny allocations.
const SCR = new Float64Array(3);
const S_DX = 0; // direction of the segment solved last
const S_DY = 1;
const S_MINY = 2; // lowest joint of the figure solved last

const NO_OPTS = Object.freeze({});

function segDir(v, defX, defY) {
  // `+def`: keeps x / y plain numbers for the JIT. Merging the raw arguments with the values
  // read from the pose made every non-integer coordinate a fresh heap number (two per segment).
  let x = +defX;
  let y = +defY;
  let z = 0;
  if (v) {
    x = +v[0] || 0;
    y = +v[1] || 0;
    z = +v[2] || 0;
  }
  const l2 = Math.sqrt(x * x + y * y);
  const l3 = Math.sqrt(x * x + y * y + z * z);
  if (l3 < 1e-6 || l2 < 1e-4) {
    SCR[S_DX] = defX * FIG.foreshortenMin;
    SCR[S_DY] = defY * FIG.foreshortenMin;
    return;
  }
  const f = FIG.foreshortenMin + (1 - FIG.foreshortenMin) * (l2 / l3);
  SCR[S_DX] = (x / l2) * f;
  SCR[S_DY] = (y / l2) * f;
}

function setJ(i, x, y) {
  J[i * 2] = x;
  J[i * 2 + 1] = y;
}

// Limb lengths as module constants: a number read from an object and handed to a function is
// boxed on every call, a constant is not.
const LEN_HEAD = FIG.headOff;
const LEN_UPPER_ARM = FIG.upperArm;
const LEN_FOREARM = FIG.forearm;
const LEN_THIGH = FIG.thigh;
const LEN_SHIN = FIG.shin;

function chain(from, to, v, defX, defY, len) {
  segDir(v, defX, defY);
  J[to * 2] = J[from * 2] + SCR[S_DX] * len;
  J[to * 2 + 1] = J[from * 2 + 1] + SCR[S_DY] * len;
}

// Fills J with joints in figure units (y up, origin at the un-shifted hip centre).
function solveFigure(pose) {
  const hipX = (+pose.hipX || 0) / 1.7;
  const turn = Math.max(0.5, Math.abs(Math.cos(+pose.yaw || 0)));

  segDir(pose.spine, 0, 1);
  const sx = SCR[S_DX];
  const sy = SCR[S_DY];
  const sl = Math.sqrt(sx * sx + sy * sy) || 1;
  const px = sy / sl; // screen-right perpendicular of the spine
  const py = -sx / sl;

  setJ(J_HIP, hipX, 0);
  setJ(J_NECK, hipX + sx * FIG.neck, sy * FIG.neck);
  const bx = hipX + sx * FIG.shoulderDrop;
  const by = sy * FIG.shoulderDrop;
  const sw = FIG.shoulderW * turn;
  const hw = FIG.hipW * turn;
  setJ(J_LSH, bx - px * sw, by - py * sw);
  setJ(J_RSH, bx + px * sw, by + py * sw);
  setJ(J_LHP, hipX - px * hw, -py * hw);
  setJ(J_RHP, hipX + px * hw, py * hw);

  chain(J_NECK, J_HEAD, pose.head, 0, 1, LEN_HEAD);
  chain(J_LSH, J_LEL, pose.lUpperArm, 0, -1, LEN_UPPER_ARM);
  chain(J_LEL, J_LWR, pose.lForearm, 0, -1, LEN_FOREARM);
  chain(J_RSH, J_REL, pose.rUpperArm, 0, -1, LEN_UPPER_ARM);
  chain(J_REL, J_RWR, pose.rForearm, 0, -1, LEN_FOREARM);
  chain(J_LHP, J_LKN, pose.lThigh, 0, -1, LEN_THIGH);
  chain(J_LKN, J_LAN, pose.lShin, 0, -1, LEN_SHIN);
  chain(J_RHP, J_RKN, pose.rThigh, 0, -1, LEN_THIGH);
  chain(J_RKN, J_RAN, pose.rShin, 0, -1, LEN_SHIN);
  setJ(J_LTO, J[J_LAN * 2] - FIG.foot, J[J_LAN * 2 + 1]);
  setJ(J_RTO, J[J_RAN * 2] + FIG.foot, J[J_RAN * 2 + 1]);

  SCR[S_MINY] = Math.min(J[J_LAN * 2 + 1], J[J_RAN * 2 + 1], J[J_LKN * 2 + 1], J[J_RKN * 2 + 1]);
}

function pathLimb(ctx, a, b, c, d) {
  ctx.beginPath();
  ctx.moveTo(J[a * 2], J[a * 2 + 1]);
  ctx.lineTo(J[b * 2], J[b * 2 + 1]);
  ctx.lineTo(J[c * 2], J[c * 2 + 1]);
  if (d >= 0) ctx.lineTo(J[d * 2], J[d * 2 + 1]);
}

function pathBone(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(J[a * 2], J[a * 2 + 1]);
  ctx.lineTo(J[b * 2], J[b * 2 + 1]);
}

function pathTorso(ctx) {
  ctx.beginPath();
  ctx.moveTo(J[J_LSH * 2], J[J_LSH * 2 + 1]);
  ctx.lineTo(J[J_RSH * 2], J[J_RSH * 2 + 1]);
  ctx.lineTo(J[J_RHP * 2], J[J_RHP * 2 + 1]);
  ctx.lineTo(J[J_LHP * 2], J[J_LHP * 2 + 1]);
  ctx.closePath();
}

function dot(ctx, j, r) {
  ctx.beginPath();
  ctx.arc(J[j * 2], J[j * 2 + 1], r, 0, 6.283185307179586);
  ctx.fill();
}

/**
 * Draws a bold rounded-limb figure for `pose` (contract pose format, x/y only).
 * (x, y) is the centre of a size×size box; the figure stands on a ground line
 * near the bottom of the box and always fits inside it.
 *
 * opts: { gold, color, accent, outline, alpha, glow (px), glowColor,
 *         segColors }  — segColors: { spine, head, lUpperArm, … } one CSS colour per pose
 *                        segment (missing ones use `color`); this is how the live figures show
 *                        which limbs match.
 * The call allocates nothing; it is safe to use every frame.
 */
export function drawPictogram(ctx, pose, x, y, size, opts) {
  if (!ctx || !pose || !(size > 0)) return;
  const o = opts || NO_OPTS;
  solveFigure(pose);

  // figure units -> canvas pixels
  const s = size * FIG.scale;
  const oy = y + size * FIG.baseline + SCR[S_MINY] * s;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < J_COUNT; i++) {
    const jx = x + J[i * 2] * s;
    J[i * 2] = jx;
    J[i * 2 + 1] = oy - J[i * 2 + 1] * s;
    if (jx < minX) minX = jx;
    if (jx > maxX) maxX = jx;
  }
  // keep extreme hip shifts inside the box
  const lim = size * 0.44;
  let shift = 0;
  if (maxX - x > lim) shift = lim - (maxX - x);
  if (minX - x + shift < -lim) shift = -lim - (minX - x);
  if (shift !== 0) for (let i = 0; i < J_COUNT; i++) J[i * 2] += shift;

  const gold = !!o.gold;
  const body = o.color || (gold ? C_GOLD : C_WHITE);
  const accent = o.accent || (gold ? '#fff7dc' : C_TEAL);
  const outline = o.outline || (gold ? 'rgba(52,24,0,0.92)' : 'rgba(11,6,32,0.92)');
  const sc = o.segColors || null;
  const armW = size * 0.086;
  const legW = size * 0.098;
  const torsoW = size * 0.066;
  const ol = Math.max(2, size * 0.056); // total extra width of the outline stroke
  const headR = size * FIG.headR * FIG.scale * 1.08;

  ctx.save();
  if (o.alpha != null) ctx.globalAlpha *= o.alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (o.glow > 0) {
    // one silhouette pass that only exists to cast the glow
    ctx.shadowColor = o.glowColor || body;
    ctx.shadowBlur = o.glow;
    ctx.strokeStyle = body;
    ctx.fillStyle = body;
    ctx.lineWidth = legW;
    pathLimb(ctx, J_LHP, J_LKN, J_LAN, J_LTO);
    ctx.stroke();
    pathLimb(ctx, J_RHP, J_RKN, J_RAN, J_RTO);
    ctx.stroke();
    ctx.lineWidth = armW;
    pathLimb(ctx, J_LSH, J_LEL, J_LWR, -1);
    ctx.stroke();
    pathLimb(ctx, J_RSH, J_REL, J_RWR, -1);
    ctx.stroke();
    pathTorso(ctx);
    ctx.fill();
    dot(ctx, J_HEAD, headR);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  // legs
  ctx.strokeStyle = outline;
  ctx.lineWidth = legW + ol;
  pathLimb(ctx, J_LHP, J_LKN, J_LAN, J_LTO);
  ctx.stroke();
  pathLimb(ctx, J_RHP, J_RKN, J_RAN, J_RTO);
  ctx.stroke();
  ctx.lineWidth = legW;
  if (sc) {
    ctx.strokeStyle = sc.lThigh || body;
    pathBone(ctx, J_LHP, J_LKN);
    ctx.stroke();
    ctx.strokeStyle = sc.lShin || body;
    pathLimb(ctx, J_LKN, J_LAN, J_LTO, -1);
    ctx.stroke();
    ctx.strokeStyle = sc.rThigh || body;
    pathBone(ctx, J_RHP, J_RKN);
    ctx.stroke();
    ctx.strokeStyle = sc.rShin || body;
    pathLimb(ctx, J_RKN, J_RAN, J_RTO, -1);
    ctx.stroke();
  } else {
    ctx.strokeStyle = body;
    pathLimb(ctx, J_LHP, J_LKN, J_LAN, J_LTO);
    ctx.stroke();
    pathLimb(ctx, J_RHP, J_RKN, J_RAN, J_RTO);
    ctx.stroke();
  }

  // torso
  const torsoC = (sc && sc.spine) || body;
  pathTorso(ctx);
  ctx.strokeStyle = outline;
  ctx.fillStyle = outline;
  ctx.lineWidth = torsoW + ol;
  ctx.stroke();
  ctx.fill();
  ctx.strokeStyle = torsoC;
  ctx.fillStyle = torsoC;
  ctx.lineWidth = torsoW;
  ctx.stroke();
  ctx.fill();

  // neck + head
  const headC = (sc && sc.head) || body;
  ctx.fillStyle = outline;
  dot(ctx, J_HEAD, headR + ol * 0.5);
  ctx.strokeStyle = headC;
  ctx.lineWidth = armW * 0.8;
  ctx.beginPath();
  ctx.moveTo(J[J_NECK * 2], J[J_NECK * 2 + 1]);
  ctx.lineTo(J[J_HEAD * 2], J[J_HEAD * 2 + 1]);
  ctx.stroke();
  ctx.fillStyle = headC;
  dot(ctx, J_HEAD, headR);

  // arms last, each with its own outline so they read when crossing the body
  ctx.strokeStyle = outline;
  ctx.lineWidth = armW + ol;
  pathLimb(ctx, J_LSH, J_LEL, J_LWR, -1);
  ctx.stroke();
  ctx.lineWidth = armW;
  if (sc) {
    ctx.strokeStyle = sc.lUpperArm || body;
    pathBone(ctx, J_LSH, J_LEL);
    ctx.stroke();
    ctx.strokeStyle = sc.lForearm || body;
    pathBone(ctx, J_LEL, J_LWR);
    ctx.stroke();
  } else {
    ctx.strokeStyle = body;
    pathLimb(ctx, J_LSH, J_LEL, J_LWR, -1);
    ctx.stroke();
  }
  ctx.strokeStyle = outline;
  ctx.lineWidth = armW + ol;
  pathLimb(ctx, J_RSH, J_REL, J_RWR, -1);
  ctx.stroke();
  ctx.lineWidth = armW;
  if (sc) {
    ctx.strokeStyle = sc.rUpperArm || body;
    pathBone(ctx, J_RSH, J_REL);
    ctx.stroke();
    ctx.strokeStyle = sc.rForearm || body;
    pathBone(ctx, J_REL, J_RWR);
    ctx.stroke();
  } else {
    ctx.strokeStyle = body;
    pathLimb(ctx, J_RSH, J_REL, J_RWR, -1);
    ctx.stroke();
  }

  // hands
  ctx.fillStyle = outline;
  dot(ctx, J_LWR, armW * 0.66 + ol * 0.4);
  dot(ctx, J_RWR, armW * 0.66 + ol * 0.4);
  ctx.fillStyle = accent;
  dot(ctx, J_LWR, armW * 0.66);
  dot(ctx, J_RWR, armW * 0.66);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Built-in decorative poses (loading figure, how-to icons, camera guide)
// ---------------------------------------------------------------------------

const SEGS = ['spine', 'head', 'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm', 'lThigh', 'lShin', 'rThigh', 'rShin'];

function P(spine, head, lu, lf, ru, rf, lt, ls, rt, rs, hipX) {
  return {
    spine, head, lUpperArm: lu, lForearm: lf, rUpperArm: ru, rForearm: rf,
    lThigh: lt, lShin: ls, rThigh: rt, rShin: rs, hipX: hipX || 0, yaw: 0,
  };
}

const DECO = {
  idle: P([0, 1, 0], [0, 1, 0], [-0.2, -1, 0], [-0.1, -1, 0], [0.2, -1, 0], [0.1, -1, 0], [-0.08, -1, 0], [0, -1, 0], [0.08, -1, 0], [0, -1, 0]),
  vee: P([0, 1, 0], [0, 1, 0], [-0.62, 0.78, 0], [-0.5, 0.87, 0], [0.62, 0.78, 0], [0.5, 0.87, 0], [-0.26, -1, 0], [-0.05, -1, 0], [0.26, -1, 0], [0.05, -1, 0]),
  point: P([0.06, 1, 0], [-0.12, 1, 0], [-0.72, 0.7, 0], [-0.7, 0.72, 0], [0.62, -0.78, 0], [-0.7, -0.5, 0], [-0.3, -1, 0], [0.04, -1, 0], [0.12, -1, 0], [0, -1, 0], 0.05),
  flag: P([0, 1, 0], [0.1, 1, 0], [-1, 0.05, 0], [0, 1, 0], [1, 0.05, 0], [0, -1, 0], [-0.2, -1, 0], [0, -1, 0], [0.34, -0.94, 0], [0.1, -1, 0]),
  star: P([0, 1, 0], [0, 1, 0], [-1, 0.22, 0], [-1, 0.3, 0], [1, 0.22, 0], [1, 0.3, 0], [-0.45, -0.9, 0], [-0.2, -1, 0], [0.45, -0.9, 0], [0.2, -1, 0]),
  reach: P([0.16, 1, 0], [0.2, 1, 0], [-0.5, -0.86, 0], [-0.85, -0.4, 0], [0.5, 0.86, 0], [0.2, 0.98, 0], [-0.4, -0.9, 0], [0.12, -1, 0], [0.2, -1, 0], [0.05, -1, 0], -0.06),
  // low-arm dance shapes (v2 vocabulary: chest level, hips, low diagonals)
  chest: P([0, 1, 0], [0.06, 1, 0], [-0.62, -0.78, 0], [0.5, 0.86, 0], [0.62, -0.78, 0], [-0.5, 0.86, 0], [-0.16, -1, 0], [0, -1, 0], [0.16, -1, 0], [0, -1, 0]),
  hips: P([0.05, 1, 0], [-0.08, 1, 0], [-0.76, -0.65, 0], [0.74, -0.67, 0], [0.76, -0.65, 0], [-0.74, -0.67, 0], [-0.24, -1, 0], [0.04, -1, 0], [0.2, -1, 0], [0, -1, 0], 0.05),
  sway: P([-0.08, 1, 0], [0.1, 1, 0], [-0.86, -0.5, 0], [-0.9, -0.44, 0], [0.5, -0.86, 0], [-0.62, 0.78, 0], [-0.3, -0.95, 0], [0.06, -1, 0], [0.14, -1, 0], [0, -1, 0], -0.07),
  // STAR SLASH: both hands up beside the shoulders, where the camera can see them
  guard: P([0, 1, 0], [0, 1, 0], [-0.55, -0.83, 0], [-0.5, 0.87, 0], [0.55, -0.83, 0], [0.5, 0.87, 0], [-0.12, -1, 0], [0, -1, 0], [0.12, -1, 0], [0, -1, 0]),
};

const LOADING_SEQ = [DECO.idle, DECO.hips, DECO.sway, DECO.chest, DECO.point, DECO.star, DECO.reach];

function blankPose() {
  const p = { hipX: 0, yaw: 0 };
  for (const s of SEGS) p[s] = [0, 0, 0];
  return p;
}

function mixPose(out, a, b, t) {
  for (let i = 0; i < SEGS.length; i++) {
    const k = SEGS[i];
    const o = out[k];
    const va = a[k];
    const vb = b[k];
    o[0] = va[0] + (vb[0] - va[0]) * t;
    o[1] = va[1] + (vb[1] - va[1]) * t;
    o[2] = va[2] + (vb[2] - va[2]) * t;
  }
  out.hipX = (a.hipX || 0) + ((b.hipX || 0) - (a.hipX || 0)) * t;
  return out;
}

const MIRROR_PAIRS = [['lUpperArm', 'rUpperArm'], ['lForearm', 'rForearm'], ['lThigh', 'rThigh'], ['lShin', 'rShin']];

function mirrorPose(out, p) {
  out.spine[0] = -p.spine[0]; out.spine[1] = p.spine[1]; out.spine[2] = p.spine[2];
  out.head[0] = -p.head[0]; out.head[1] = p.head[1]; out.head[2] = p.head[2];
  for (const [l, r] of MIRROR_PAIRS) {
    out[l][0] = -p[r][0]; out[l][1] = p[r][1]; out[l][2] = p[r][2];
    out[r][0] = -p[l][0]; out[r][1] = p[l][1]; out[r][2] = p[l][2];
  }
  out.hipX = -(p.hipX || 0);
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) * (1 - t);
}

function fmt(n) {
  const v = Math.round(+n || 0);
  const s = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return v < 0 ? '-' + out : out;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function starPath(ctx, cx, cy, r) {
  const k = r * 0.16;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + k, cy - k, cx + r, cy);
  ctx.quadraticCurveTo(cx + k, cy + k, cx, cy + r);
  ctx.quadraticCurveTo(cx - k, cy + k, cx - r, cy);
  ctx.quadraticCurveTo(cx - k, cy - k, cx, cy - r);
  ctx.closePath();
}

function makeSprite(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// dance records are kept per song (STARFALL keeps the key it always had)
const songBestKey = (id) => (id === DEFAULT_SONG ? BEST_KEY : BEST_KEY + '.' + id);

// "1분 35초"
function songLength(id) {
  const sec = Math.round(timingOf(SONGS[id]).duration - 1);
  return Math.floor(sec / 60) + '분 ' + (sec % 60) + '초';
}

function readBest(key) {
  try {
    const v = parseInt(window.localStorage.getItem(key || BEST_KEY), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (e) {
    return 0;
  }
}

function writeBest(v, key) {
  try {
    window.localStorage.setItem(key || BEST_KEY, String(Math.round(v)));
  } catch (e) {
    /* storage unavailable: best score simply is not persisted */
  }
}

// remembered choices of the title screen and the STAR SLASH records
function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (e) {
    /* storage unavailable: the choice simply is not remembered */
  }
}

function readStoredScore(key) {
  const v = parseInt(readStored(key), 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0C12.9 7.6 16.4 11.1 24 12 16.4 12.9 12.9 16.4 12 24 11.1 16.4 7.6 12.9 0 12 7.6 11.1 11.1 7.6 12 0Z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.6a1 1 0 0 1 1.5-.86l12 7.4a1 1 0 0 1 0 1.72l-12 7.4A1 1 0 0 1 7 19.4Z"/></svg>';
const RETRY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-7.4 5h2.2A6 6 0 1 0 12 6v3L7 5.5 12 2Z"/></svg>';
const WARN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 22.5 21h-21Zm-1 6.5v6h2V9Zm0 8v2h2v-2Z"/></svg>';
const ONE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM4.5 20c0-4.2 3.2-7 7.5-7s7.5 2.8 7.5 7c0 .6-.4 1-1 1h-13c-.6 0-1-.4-1-1Z"/></svg>';
const TWO_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM2.2 20c0-4 3-6.5 6.8-6.5s6.8 2.5 6.8 6.5c0 .6-.4 1-1 1H3.2c-.6 0-1-.4-1-1ZM17 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm.8 16h3c.6 0 1-.4 1-1 0-3.4-2.3-5.8-5.6-6.2 1.3 1.5 2 3.5 2 5.9 0 .5-.1.9-.4 1.3Z"/></svg>';
const CROWN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.5 4.2 7.5l4.6 3.9L12 4.5l3.2 6.9 4.6-3.9L21 17.5Zm.8 1.5h16.4v1.5H3.8Z"/></svg>';
// mode marks: a dancing figure, and a star shard cut in two along its line
const DANCE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12.6" cy="4.2" r="2.5"/><path fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" d="M12 9.2v5.6M12 10 6.6 6.2M12 10l5.6 2.8M12 14.8l-3.8 6.4M12 14.8l4.6 5.2"/></svg>';
const SLASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.6 1.4 18.3 6.8 5.5 14.7 3.6 7.9ZM19 8l1.4 1.1-3.5 13h-9l-1.7-6.2Z"/></svg>';
const TOUCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2.5a2 2 0 0 1 2 2V10l6.300 1.200a2.500 2.500 0 0 1 2 2.900l-.9 5a3 3 0 0 1-3 2.400H10.600a3 3 0 0 1-2.300-1.100L3.700 14.800a1.700 1.700 0 0 1 2.500-2.300L7 13.300V4.500a2 2 0 0 1 2-2Z"/></svg>';
const PAD_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.500 20.500 14h-5v6.500h-7V14h-5Z"/></svg>';
const KEYS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M3.5 5.5h17A2 2 0 0 1 22.500 7.5v9a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM5 8.500v2.200h2.200V8.500Zm3.900 0v2.200h2.200V8.500Zm3.900 0v2.200H15V8.500Zm3.900 0v2.200h2.200V8.500ZM5 13.300v2.200h2.200v-2.200Zm3.900 0v2.200H15v-2.200Zm7.800 0v2.200h2.200v-2.200Z"/></svg>';

function btn(kind, act, inner, extra, attrs) {
  return `<button type="button" class="btn btn--${kind}${extra ? ' ' + extra : ''}" data-act="${act}"${attrs ? ' ' + attrs : ''}><i class="btn__bg"><i class="btn__shine"></i></i><span class="btn__label">${inner}</span></button>`;
}

function logo(extraClass) {
  return `<div class="logo${extraClass ? ' ' + extraClass : ''}" role="img" aria-label="STARFALL">
    <span class="logo__comet"><i></i>${STAR_SVG}</span>
    <span class="logo__word"><b>STAR</b><b class="logo__fall">FALL</b></span>
    <span class="logo__tag">COSMIC DANCE STAGE</span>
  </div>`;
}

function digitCols() {
  let h = '';
  for (let i = 0; i < 7; i++) {
    if (i === 1 || i === 4) h += '<span class="digits__sep">,</span>';
    h += `<span class="digit is-dim" style="--d:${i}"><span class="digit__strip">`;
    for (let d = 0; d < 10; d++) h += `<span>${d}</span>`;
    h += '</span></span>';
  }
  return h;
}

// rating-count rows; `prefix` keeps the data-refs of the 1P block and the two 2P columns apart
function breakdownRows(prefix) {
  const k = prefix || '';
  let h = '';
  RATING_ORDER.forEach((r, i) => {
    h += `<div class="brow" data-rating="${r}" style="--i:${i}">
      <span class="brow__name">${RATING_INFO[r].word}</span>
      <span class="brow__track"><i class="brow__fill" data-ref="${k}bar-${r}"></i></span>
      <b class="brow__count" data-ref="${k}cnt-${r}">0</b>
    </div>`;
  });
  return h;
}

function starSlots() {
  let h = '';
  for (let i = 0; i < 5; i++) {
    h += `<span class="star" style="--i:${i}">${STAR_SVG}<span class="star__fill">${STAR_SVG}</span></span>`;
  }
  return h;
}

function raySpans(n) {
  let h = '';
  for (let i = 0; i < n; i++) h += `<i style="--a:${(360 / n) * i}deg;--l:${i % 2 ? 0.62 : 1}"></i>`;
  return h;
}

function sparkSpans(n) {
  let h = '';
  for (let i = 0; i < n; i++) {
    const a = (360 / n) * i + (i % 2 ? 14 : -8);
    const r = i % 2 ? 11.2 : 8.2;
    const s = i % 3 === 0 ? 1.25 : 0.8;
    h += `<i style="--a:${a}deg;--r:${r};--s:${s}">${STAR_SVG}</i>`;
  }
  return h;
}

// STAR SLASH multiplier ring: eight arcs of a 48-unit circle, clockwise from the top. One lights
// up per hit of the current step; the multiplier itself sits in the middle.
function ringArcs() {
  const step = 360 / MRING_STEPS;
  const at = (deg) => {
    const a = (deg * Math.PI) / 180;
    return (24 + 20 * Math.cos(a)).toFixed(2) + ' ' + (24 + 20 * Math.sin(a)).toFixed(2);
  };
  let h = '';
  for (let i = 0; i < MRING_STEPS; i++) {
    h += `<path d="M${at(-90 + i * step + 6.5)}A20 20 0 0 1 ${at(-90 + (i + 1) * step - 6.5)}"/>`;
  }
  return h;
}

function mringMarkup() {
  const arcs = ringArcs();
  return `<div class="mring" data-ref="mring" data-fill="0" data-mult="1" aria-hidden="true">
      <i class="mring__burst" data-ref="mringBurst"></i>
      <svg class="mring__svg" data-ref="mringSvg" viewBox="0 0 48 48"><g class="mring__track">${arcs}</g><g class="mring__lit">${arcs}</g></svg>
      <b class="mring__num" data-ref="mringNum">×1</b>
    </div>`;
}

// STAR SLASH rating pops: a fixed pool of small nodes, moved to where the cut happened
function popMarkup() {
  let h = '';
  for (let i = 0; i < POP_COUNT; i++) {
    h += '<div class="spop" data-rating="perfect"><i class="spop__ring"></i><div class="spop__body"><b class="spop__word">PERFECT</b><span class="spop__pts"></span></div></div>';
  }
  return h;
}

// one player's corner of the play HUD: score, live card (2P only) and combo
function sideMarkup(p) {
  return `<div class="scorebox scorebox--p${p}" data-player="${p}">
    <div class="scorebox__head"><b class="pbadge pbadge--${p}">P${p + 1}</b><span class="scorebox__label">SCORE</span></div>
    <div class="scorebox__score" data-ref="scoreWrap${p}">
      <i class="scorebox__flash" data-ref="scoreFlash${p}"></i>
      <div class="digits" data-ref="digits${p}">${digitCols()}</div>
      <b class="fly" data-ref="fly${p}"></b>
    </div>
    <div class="livecard" data-ref="card${p}">
      <canvas class="livecard__canvas" data-ref="cardCanvas${p}"></canvas>
      <span class="livecard__label">싱크</span>
      <span class="livecard__lost">안 보여요</span>
    </div>
    ${p === 0 ? mringMarkup() : ''}
    <div class="combo" data-ref="combo${p}">
      <i class="combo__burst" data-ref="comboBurst${p}"></i>
      <b class="combo__num" data-ref="comboNum${p}">0</b>
      <span class="combo__label">COMBO</span>
      <i class="combo__mult" data-ref="comboMult${p}">×1.0</i>
    </div>
  </div>`;
}

// 2P: one player's own camera view (a crop of the shared picture that follows them), so each
// player can check at a glance how the camera sees them. Sits at the screen edge on their side,
// below the rating band and above the combo banner. Without a camera (a demo) the tile stays and
// says so: it is where players look for themselves, and the place to learn that the figure
// dancing for them is a simulated player.
function pcamMarkup(p) {
  return `<div class="pcam pcam--p${p} is-off" data-ref="pcam${p}">
    <canvas class="pcam__canvas" data-ref="pcamCanvas${p}"></canvas>
    <span class="pcam__tag"><b>P${p + 1}</b><i>LIVE</i></span>
    <span class="pcam__lost">안 보여요</span>
    <span class="pcam__off"><b>카메라 꺼짐</b><i>지금은 데모 플레이어예요</i><i>카메라를 켜면 여기에 내 모습이 나와요</i></span>
  </div>`;
}

// one player's rating burst; lives on that player's side of the stage, in the band between
// their corner HUD and the head of their avatar: never over NOVA, never over "my character"
function ratingMarkup(p) {
  return `<div class="rating rating--p${p}" data-ref="rating${p}" data-rating="perfect" data-player="${p}" aria-hidden="true">
    <i class="rating__flash" data-ref="ratingFlash${p}"></i>
    <i class="rating__ring" data-ref="ratingRing${p}"></i>
    <i class="rating__ring rating__ring--b" data-ref="ratingRingB${p}"></i>
    <div class="rating__rays" data-ref="ratingRays${p}">${raySpans(14)}</div>
    <div class="rating__sparks" data-ref="ratingSparks${p}">${sparkSpans(8)}</div>
    <div class="rating__body" data-ref="ratingBody${p}">
      <div class="rating__gold">${STAR_SVG}<span>스타 무브 ×2</span>${STAR_SVG}</div>
      <div class="rating__wordwrap">
        <div class="rating__echo" data-ref="ratingEcho${p}">PERFECT</div>
        <div class="rating__word" data-ref="ratingWord${p}">PERFECT</div>
      </div>
      <div class="rating__sub" data-ref="ratingKo${p}">완벽해요!</div>
    </div>
  </div>`;
}

function bannerMarkup(p) {
  return `<div class="cbanner cbanner--p${p}" data-ref="cbanner${p}" aria-hidden="true">
    <div class="cbanner__plate" data-ref="cbannerPlate${p}">
      <b data-ref="cbannerNum${p}">10</b><span>콤보!</span><em data-ref="cbannerSub${p}">연속 성공!</em>
    </div>
  </div>`;
}

function chipMarkup(p) {
  return `<div class="pchip" data-ref="chip${p}" data-player="${p}" data-state="none">
    <b class="pbadge pbadge--${p}">P${p + 1}</b>
    <span class="pchip__text" data-ref="chipText${p}">${CHIP_TEXT[p][0]}</span>
    <span class="pchip__bar"><i data-ref="chipFill${p}"></i></span>
  </div>`;
}

function duoColumn(p) {
  return `<div class="duo__col duo__col--p${p}" data-ref="duoCol${p}" data-player="${p}">
    <div class="duo__head">
      <b class="pbadge pbadge--${p}">P${p + 1}</b>
      <span class="duo__crown">${CROWN_SVG}</span>
      <span class="duo__verdict" data-ref="duoVerdict${p}"></span>
      <i class="results__new" data-ref="duoNew${p}">신기록!</i>
    </div>
    <b class="duo__score" data-ref="duoScore${p}">0</b>
    <div class="duo__stars" data-ref="duoStars${p}">${starSlots()}</div>
    <div class="duo__rows">${breakdownRows('d' + p)}</div>
    <div class="duo__stats">
      <div><span>최대 콤보</span><b data-ref="duoCombo${p}">0</b></div>
      <div><span>정확도</span><b data-ref="duoAcc${p}">0%</b></div>
    </div>
  </div>`;
}

const TITLE_ACTIONS = DEMO_ONLY
  ? btn('primary', 'startDemo', `${PLAY_SVG}<span>데모 보기</span><kbd>SPACE</kbd>`)
  : btn('primary', 'start', `${ONE_SVG}<span>1인 플레이</span><kbd>SPACE</kbd>`, '', 'data-players="1"')
    + btn('ghost', 'start', `${TWO_SVG}<span>2인 플레이</span><kbd>2</kbd>`, 'btn--duo', 'data-players="2"')
    + btn('ghost', 'startDemo', `${PLAY_SVG}<span>데모 보기 <small>(카메라 없이)</small></span>`, 'btn--sm btn--quiet');

// song picker of the title (both modes): one song per difficulty. One to three shard pips, the
// song's name, and its difficulty and tempo underneath.
function songsMarkup() {
  let h = '<div class="levels songs" style="--i:3" role="radiogroup" aria-label="곡 선택">'; // (no visible label: the plates speak for themselves)
  SONG_IDS.forEach((id) => {
    const sg = SONGS[id];
    let pips = '';
    for (let k = 0; k <= DIFFICULTIES.indexOf(sg.level); k++) pips += '<i></i>';
    h += `<button type="button" class="level level--${sg.level}" role="radio" aria-checked="false" data-act="pickSong" data-value="${id}"><span class="level__pips">${pips}</span><span class="level__text"><b>${sg.title}</b><small>${DIFFICULTY_LABELS[sg.level]} · ${sg.bpm} BPM</small></span></button>`;
  });
  return h + '<kbd class="levels__key">↑ ↓</kbd></div>';
}

// the STAR SLASH side of the title: one player with the camera or on the keyboard, or the demo
// (the only button of a demo-only page)
const SLASH_ACTIONS = (DEMO_ONLY
  ? btn('primary', 'startDemo', `${PLAY_SVG}<span>데모 보기</span><kbd>SPACE</kbd>`)
  : btn('primary', 'start', `${SLASH_SVG}<span>슬래시 시작</span><kbd>SPACE</kbd>`, '', 'data-players="1"')
    + btn('ghost', 'startKeys', `<span class="in-notouch">${KEYS_SVG}</span><span class="in-touch">${TOUCH_SVG}</span><span class="in-notouch">키보드로 플레이</span><span class="in-touch">터치로 플레이</span><kbd class="in-notouch">K</kbd>`, 'btn--duo')
    + btn('ghost', 'startDemo', `${PLAY_SVG}<span>데모 보기 <small>(카메라 없이)</small></span>`, 'btn--sm btn--quiet'));

// rating-count rows of the STAR SLASH results ("s" keeps their data-refs apart from the dance rows)
function slashRows() {
  let h = '';
  SLASH_ORDER.forEach((r, i) => {
    h += `<div class="brow" data-rating="${r}" style="--i:${i}">
      <span class="brow__name">${SLASH_WORDS[r]}</span>
      <span class="brow__track"><i class="brow__fill" data-ref="sbar-${r}"></i></span>
      <b class="brow__count" data-ref="scnt-${r}">0</b>
    </div>`;
  });
  return h;
}

const TEMPLATE = `
<section class="screen screen--loading" data-name="loading">
  <div class="sky"><i class="sky__stars"></i><i class="sky__stars sky__stars--b"></i><i class="sky__disc"></i></div>
  <div class="loading">
    ${logo('logo--sm')}
    <canvas class="loading__fig" data-ref="loadFig"></canvas>
    <div class="loadbar"><div class="loadbar__fill" data-ref="loadFill"></div></div>
    <div class="loading__row"><span data-ref="loadText">무대를 준비하는 중…</span><b data-ref="loadPct">0%</b></div>
  </div>
</section>

<section class="screen screen--title" data-name="title" data-ref="titleSection">
  <div class="title__scrim"></div>
  <div class="title__col">
    <div class="eyebrow" style="--i:0">${STAR_SVG}<span class="pick-dance">NOVA LIVE · 카메라 댄스 스테이지</span><span class="pick-slash">NOVA LIVE · 스타 슬래시</span></div>
    <div class="title__logo" style="--i:1">${logo('')}</div>
    <div class="songcard" style="--i:2">
      <div class="songcard__disc"><span class="eq"><i></i><i></i><i></i><i></i></span></div>
      <div class="songcard__meta">
        <span class="songcard__label">선택한 곡</span>
        <strong class="songcard__title" data-ref="songTitle">STARFALL — NOVA · 124 BPM</strong>
        <span class="songcard__sub"><span data-ref="songInfo">일렉트로 팝 · 1분 35초</span> · <span data-ref="best">첫 무대에 도전해 보세요</span></span>
      </div>
    </div>
    ${songsMarkup()}
    <div class="modeswitch" style="--i:3" role="tablist" aria-label="게임 모드">
      <i class="modeswitch__thumb"></i>
      <button type="button" class="modeswitch__tab" role="tab" aria-selected="true" data-act="pickMode" data-value="dance" data-ref="tabDance">${DANCE_SVG}<span>댄스</span></button>
      <button type="button" class="modeswitch__tab" role="tab" aria-selected="false" data-act="pickMode" data-value="slash" data-ref="tabSlash">${SLASH_SVG}<span>스타 슬래시</span></button>
      <kbd class="modeswitch__key">TAB</kbd>
    </div>
    <div class="title__actions pick-dance" style="--i:4">${TITLE_ACTIONS}</div>
    <div class="title__actions pick-slash" style="--i:4">${SLASH_ACTIONS}</div>
    <p class="title__privacy" style="--i:5">${DEMO_ONLY ? '이 페이지는 데모 버전이에요. NOVA의 무대를 감상해 보세요. 버튼을 누르면 음악이 재생돼요.' : '<span class="pick-dance">혼자서도, 둘이서도! </span><span class="pick-slash">혼자 즐기는 모드예요. 카메라가 없으면 <span class="in-notouch">키보드로도</span><span class="in-touch">터치로도</span> 할 수 있어요. </span>카메라 영상은 이 기기 안에서만 처리되고, 저장되거나 전송되지 않아요.'}</p>
  </div>
  <ol class="howto pick-dance">
    <li style="--i:6"><canvas data-ref="how0"></canvas><div><em>01</em><strong>상반신이 보이게 1.5~3m</strong><span>머리부터 허리까지 보이면 OK · 전신도 좋아요</span></div></li>
    <li style="--i:7"><canvas data-ref="how1"></canvas><div><em>02</em><strong>거울처럼 따라하기</strong><span>NOVA가 화면 왼쪽 팔을 움직이면 나도 왼팔!</span></div></li>
    <li style="--i:8"><canvas data-ref="how2"></canvas><div><em>03</em><strong>보이면 바로 따라 하기</strong><span>조금 늦어도 GOOD · 금빛 스타 무브는 2배</span></div></li>
  </ol>
  <ol class="howto pick-slash">
    <li style="--i:6"><canvas data-ref="sHow0"></canvas><div><em>01</em><strong>손이 화면에 보이게 서기</strong><span>1.5~3m 거리 · 팔을 뻗어도 두 손이 보이게</span></div></li>
    <li style="--i:7"><canvas data-ref="sHow1"></canvas><div><em>02</em><strong>화살표 방향으로 휘둘러 베기</strong><span>왼손은 청록, 오른손은 금빛 별 조각</span></div></li>
    <li style="--i:8"><canvas data-ref="sHow2"></canvas><div><em>03</em><strong>콤보를 이어 배수 올리기</strong><span>놓치지 않고 이어 가면 점수가 최대 ×4</span></div></li>
  </ol>
</section>

<section class="screen screen--camera" data-name="camera" data-ref="camSection" data-state="requesting">
  <div class="cam">
    <div class="cam__frame">
      <canvas class="cam__canvas" data-ref="camCanvas"></canvas>
      <div class="cam__slots" aria-hidden="true">
        <span class="cam__slot cam__slot--0" data-ref="slot0"><b class="pbadge pbadge--0">P1</b><em>왼쪽</em></span>
        <i class="cam__divider"></i>
        <span class="cam__slot cam__slot--1" data-ref="slot1"><b class="pbadge pbadge--1">P2</b><em>오른쪽</em></span>
      </div>
      <i class="corner corner--tl"></i><i class="corner corner--tr"></i><i class="corner corner--bl"></i><i class="corner corner--br"></i>
      <span class="cam__badge">거울 모드</span>
      <div class="cam__hold"><div class="cam__holdfill" data-ref="holdFill"></div></div>
      <div class="cam__error" role="alert">
        <span class="cam__erricon">${WARN_SVG}</span>
        <h3 data-ref="errTitle"></h3>
        <p data-ref="errDesc"></p>
        <div class="cam__erractions">
          ${btn('primary', 'startDemo', `${PLAY_SVG}<span>데모로 플레이</span>`, 'btn--sm')}
          ${DEMO_ONLY ? '' : btn('ghost', 'startKeys', `<span class="in-notouch">${KEYS_SVG}</span><span class="in-touch">${TOUCH_SVG}</span><span class="in-notouch">키보드로 플레이</span><span class="in-touch">터치로 플레이</span>`, 'btn--sm only-slash')}
          ${btn('ghost', 'openExternal', '<span>브라우저로 열기</span>', 'btn--sm only-inapp')}
          ${btn('ghost', 'copyLink', '<span data-ref="copyLabel">주소 복사</span>', 'btn--sm only-inapp')}
          ${btn('ghost', 'retryCamera', `${RETRY_SVG}<span>다시 시도</span>`, 'btn--sm')}
        </div>
      </div>
    </div>
    <div class="cam__side">
      <div class="eyebrow">${STAR_SVG}<span>STEP 1 · 카메라 설정</span><i class="modepill" data-ref="camMode">1인 플레이</i></div>
      <h2 class="cam__headline">
        <span class="cam__h cam__h--search"><span class="only-1p only-dance">상반신이 보이게<br>카메라 앞에 서 주세요</span><span class="only-2p only-dance">둘이 나란히<br>카메라 앞에 서 주세요</span><span class="only-slash">두 손이 화면 안에<br>들어오게 서 주세요</span></span>
        <span class="cam__h cam__h--ready">좋아요!<br>그대로 계세요</span>
        <span class="cam__h cam__h--error">카메라 없이도<br>즐길 수 있어요</span>
      </h2>
      <p class="cam__status" data-ref="camStatus">${CAMERA_STATUS.requesting}</p>
      <div class="meter">
        <div class="meter__head"><span><span class="only-dance">상반신 인식</span><span class="only-slash">손 · 상반신 인식</span></span><b data-ref="meterPct">0%</b></div>
        <div class="meter__track"><div class="meter__fill" data-ref="meterFill"></div><i class="meter__goal" data-ref="meterGoal"></i></div>
      </div>
      <div class="pchips">${chipMarkup(0)}${chipMarkup(1)}</div>
      <ul class="cam__tips">
        <li>${STAR_SVG}<span class="in-desktop">카메라에서 1.5~3m 떨어지기</span><span class="in-mobile">휴대폰을 가로로 세워 두고 1.5~3m 떨어지기</span></li>
        <li class="only-dance">${STAR_SVG}상반신이 화면에 보이면 준비 완료</li>
        <li class="only-1p only-dance">${STAR_SVG}전신이 보이면 더 좋아요 · 밝은 곳에서</li>
        <li class="only-2p only-dance">${STAR_SVG}P1은 왼쪽, P2는 오른쪽 · 팔 간격 넉넉히</li>
        <li class="only-slash">${STAR_SVG}팔을 뻗어도 두 손이 보이면 준비 완료</li>
        <li class="only-slash"><i class="handdot"></i>왼손은 청록 · <i class="handdot handdot--r"></i>오른손은 금빛으로 표시돼요</li>
      </ul>
      <p class="cam__diag" data-ref="camDiag"></p>
      <div class="cam__actions">
        ${btn('ghost', 'skipCamera', '<span>바로 시작</span>', 'btn--sm cam__skip')}
        <button type="button" class="linkbtn" data-act="menu">메뉴로 돌아가기</button>
      </div>
    </div>
  </div>
</section>

<section class="screen screen--play" data-name="play">
  <i class="edge edge--0" data-ref="edge0" data-rating="perfect"><i></i></i>
  <i class="edge edge--1" data-ref="edge1" data-rating="perfect"><i></i></i>
  ${sideMarkup(0)}
  ${sideMarkup(1)}
  <div class="songbar">
    <div class="songbar__row">
      <div class="chip" data-ref="sectionChip"><i class="chip__dot"></i><span data-ref="sectionText">인트로</span></div>
      <span class="songbar__title"><span class="only-dance" data-ref="barDance">STARFALL — NOVA</span><span class="only-slash" data-ref="barSlash">STAR SLASH · STARFALL</span></span>
      <button type="button" class="pausebtn" data-act="pause" aria-label="일시정지"><i></i><i></i></button>
    </div>
    <div class="progress">
      <div class="progress__fill" data-ref="progFill"></div>
      <div class="progress__runner" data-ref="progRunner"><i class="progress__head"></i></div>
    </div>
  </div>
  <div class="tile" data-ref="tile">
    <div class="tile__view">
      <canvas class="tile__canvas" data-ref="tileCanvas"></canvas>
      <span class="tile__tag"><b data-ref="tileTag">나</b><i class="tile__live">LIVE</i></span>
      <span class="tile__warn"><span class="only-dance">상반신이 보이게 서 주세요</span><span class="only-slash">화면 안으로 들어와 주세요</span></span>
      <span class="tile__off"><b>카메라 꺼짐</b><i>카메라를 켜면 여기에<br>내 모습이 나와요</i></span>
      <span class="tile__touch" aria-hidden="true"><b>터치 패드</b><i>왼쪽은 청록 · 오른쪽은 금빛<br>화살표 방향을 누르세요</i></span>
      <span class="tile__keys" aria-hidden="true">
        <span class="keypad keypad--l"><kbd data-key="KeyW">W</kbd><kbd data-key="KeyA">A</kbd><kbd data-key="KeyS">S</kbd><kbd data-key="KeyD">D</kbd><em>왼손 · 청록</em></span>
        <span class="keypad keypad--r"><kbd data-key="ArrowUp">↑</kbd><kbd data-key="ArrowLeft">←</kbd><kbd data-key="ArrowDown">↓</kbd><kbd data-key="ArrowRight">→</kbd><em>오른손 · 금빛</em></span>
      </span>
    </div>
    <div class="tile__sync">
      <span class="tile__synclabel">싱크</span>
      <span class="tile__meterbox"><canvas class="tile__meter" data-ref="tileMeter"></canvas></span>
    </div>
    <ul class="legend" aria-hidden="true"><li class="legend__hit">맞음</li><li class="legend__near">거의</li><li class="legend__off">다름</li></ul>
    <div class="sacc">
      <span class="sacc__label">정확도</span>
      <b class="sacc__num" data-ref="saccNum">—</b>
      <span class="sacc__bar"><i data-ref="saccFill"></i></span>
    </div>
  </div>
  ${pcamMarkup(0)}
  ${pcamMarkup(1)}
  ${ratingMarkup(0)}
  ${ratingMarkup(1)}
  ${bannerMarkup(0)}
  ${bannerMarkup(1)}
  <div class="lane">
    <span class="lane__label">NEXT</span>
    <canvas class="lane__canvas" data-ref="laneCanvas"></canvas>
  </div>
  <div class="spops" aria-hidden="true">${popMarkup()}</div>
  <div class="shint"><div class="shint__plate" data-ref="shint">${SLASH_SVG}<span>${HINT_SPANS}</span></div></div>
</section>

<section class="screen screen--countdown" data-name="countdown">
  <div class="count">
    <div class="count__ring" data-ref="countRing"></div>
    <div class="count__num" data-ref="countNum">3</div>
    <p class="count__hint"><span class="only-1p only-dance">NOVA를 거울처럼 따라 하세요</span><span class="only-2p only-dance">P1 왼쪽 · P2 오른쪽 · NOVA를 거울처럼!</span><span class="only-slash">${HINT_SPANS}</span></p>
  </div>
</section>

<section class="screen screen--pause" data-name="pause">
  <div class="pause">
    <div class="eyebrow">${STAR_SVG}<span>PAUSED</span></div>
    <h2 class="pause__title">일시정지</h2>
    <p class="pause__hint">숨 고르고, 준비되면 다시 무대로!</p>
    <div class="pause__actions">
      ${btn('primary', 'resume', `${PLAY_SVG}<span>계속하기</span><kbd>ESC</kbd>`)}
      ${btn('ghost', 'retry', `${RETRY_SVG}<span>다시 하기</span>`)}
      ${btn('ghost', 'menu', '<span>메뉴로</span>')}
    </div>
  </div>
</section>

<section class="screen screen--results" data-name="results" data-ref="resSection" data-mode="solo">
  <div class="results">
    <div class="eyebrow">${STAR_SVG}<span data-ref="resEyebrow">STAGE CLEAR · STARFALL — NOVA</span></div>
    <h2 class="results__title" data-ref="resTitle">빛나는 무대</h2>
    <p class="results__sub" data-ref="resSub"></p>
    <div class="hero">
      <div class="rank" data-ref="rank" data-rank="S"><i class="rank__gem"></i><i class="rank__cut"></i><b class="rank__letter" data-ref="rankLetter">S</b><span class="rank__label">RANK</span></div>
      <div class="stars" data-ref="stars">${starSlots()}</div>
    </div>
    <div class="results__score">
      <span class="results__scorelabel">SCORE</span>
      <b class="results__scorenum" data-ref="resScore">0</b>
      <span class="results__best"><i class="results__new" data-ref="resNew">신기록!</i><span data-ref="resBest">최고 기록 0</span></span>
    </div>
    <div class="results__grid">
      <div class="breakdown only-dance">${breakdownRows('')}</div>
      <div class="breakdown breakdown--slash only-slash">${slashRows()}</div>
      <div class="statcol">
        <div class="stat"><span>최대 콤보</span><b data-ref="resCombo">0</b></div>
        <div class="stat"><span>정확도</span><b data-ref="resAcc">0%</b><span class="stat__bar"><i data-ref="resAccBar"></i></span></div>
      </div>
    </div>
    <div class="duo">
      ${duoColumn(0)}
      <div class="duo__vs" aria-hidden="true">VS</div>
      ${duoColumn(1)}
    </div>
    <div class="results__actions">
      ${btn('primary', 'retry', `${RETRY_SVG}<span>다시 하기</span><kbd>SPACE</kbd>`)}
      ${btn('ghost', 'menu', '<span>메뉴로</span>')}
    </div>
  </div>
</section>

<div class="pads" aria-hidden="true">
  <div class="pad pad--l" data-pad="l">
    <i class="pad__hit"></i>
    <i class="pad__a pad__a--u">${PAD_ARROW}</i><i class="pad__a pad__a--r">${PAD_ARROW}</i><i class="pad__a pad__a--d">${PAD_ARROW}</i><i class="pad__a pad__a--l">${PAD_ARROW}</i>
    <i class="pad__d pad__d--ur"></i><i class="pad__d pad__d--dr"></i><i class="pad__d pad__d--dl"></i><i class="pad__d pad__d--ul"></i>
  </div>
  <div class="pad pad--r" data-pad="r">
    <i class="pad__hit"></i>
    <i class="pad__a pad__a--u">${PAD_ARROW}</i><i class="pad__a pad__a--r">${PAD_ARROW}</i><i class="pad__a pad__a--d">${PAD_ARROW}</i><i class="pad__a pad__a--l">${PAD_ARROW}</i>
    <i class="pad__d pad__d--ur"></i><i class="pad__d pad__d--dr"></i><i class="pad__d pad__d--dl"></i><i class="pad__d pad__d--ul"></i>
  </div>
</div>

<div class="rotate" role="alert">
  <i class="rotate__phone"></i>
  <b>휴대폰을 가로로 돌려 주세요</b>
  <span>화면 회전 잠금이 켜져 있다면 풀어 주세요</span>
</div>
`;

// ---------------------------------------------------------------------------
// MediaPipe landmark skeleton
// ---------------------------------------------------------------------------

// Bones are drawn torso first and arms last. LM_BONE_S is the index (into SEGS) of the pose
// segment whose match colour the bone takes: MediaPipe LEFT_* landmarks are the screen-left
// (l*) limbs because the image is mirrored. Shoulder, hip and side lines follow the spine.
const LM_BONE_A = new Uint8Array([11, 11, 12, 23, 23, 25, 24, 26, 11, 13, 12, 14]);
const LM_BONE_B = new Uint8Array([12, 23, 24, 24, 25, 27, 26, 28, 13, 15, 14, 16]);
const LM_BONE_S = new Uint8Array([0, 0, 0, 0, 6, 7, 8, 9, 2, 3, 4, 5]);
const LM_BONES = LM_BONE_A.length;
const LM_JOINTS = new Uint8Array([11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);
const LM_UPPER = new Uint8Array([11, 12, 13, 14, 15, 16]); // shoulders, elbows, wrists
const LM_XY = new Float32Array(33 * 2);
const LM_VIS = new Float32Array(33);
const LM_MIN_VIS = 0.35;
const SEG_HEAD = 1; // index of 'head' in SEGS

const DIGIT_T = [];
for (let d = 0; d < 10; d++) DIGIT_T.push(`translateY(${-d * 10}%)`);
const POW10 = [1000000, 100000, 10000, 1000, 100, 10, 1];

const SCREENS = ['loading', 'title', 'camera', 'countdown', 'play', 'pause', 'results'];

// points fly from the rating burst into the score; the score "lands" when they arrive
const FLY_MS = 720;
const FLY_ARRIVE_MS = 560;

// ---------------------------------------------------------------------------
// createHud
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} root  the #hud element
 * @param {object} [options]
 *   players            1 (default) | 2: initial player count; showScreen(name, { players }) changes it
 *   landmarksMirrored  true (default): landmark x is already mirrored, 0 = screen left, as js/pose-tracker.js
 *                      emits them / false: raw MediaPipe image coordinates
 *   readyThreshold     upperVisible (shoulders + elbows + wrists) needed on the camera screen (default 0.7)
 *   readyHoldMs        how long every expected player has to stay above it (default 2600:
 *                      long enough to see for yourself how the camera frames you)
 *   beatsAhead         how many beats of upcoming moves the lane shows (default 7)
 *   maxDpr             canvas pixel-ratio cap (default 2)
 *   keyboard           false disables the built-in Space/Enter/Tab/arrows/1/2/3/Esc handling
 *   mode               'dance' (default) | 'slash': initial game mode; setMode() / showScreen(name, { mode }) change it
 *   maxMultiplier      STAR SLASH: the multiplier at which the ring is shown full (default 4)
 *   hintMs             STAR SLASH: how long the how-to line stays up at the start of a run (default 7000, 0 = never)
 */
export function createHud(root, options) {
  if (!root) throw new Error('createHud(root): root element is required');

  const cfg = Object.assign(
    {
      players: 1, landmarksMirrored: true, readyThreshold: 0.7, readyHoldMs: 2600, beatsAhead: 7, maxDpr: 2, keyboard: true,
      mode: '', maxMultiplier: 4, hintMs: 7000,
    },
    options || {},
  );

  root.classList.add('sf');
  root.innerHTML = TEMPLATE;
  root.setAttribute('data-screen', 'loading');

  const refs = {};
  root.querySelectorAll('[data-ref]').forEach((el) => {
    refs[el.getAttribute('data-ref')] = el;
  });

  const listeners = new Map();
  let screen = 'loading';
  let runActive = false;
  let destroyed = false;
  let dpr = 1;
  let best = readBest();
  let playerCount = cfg.players === 2 ? 2 : 1;
  let layoutPlayers = 0; // the player count the canvases were last laid out for

  // Game mode. `mode` is what the run screens (camera, countdown, play, pause, results) are laid
  // out for; it becomes 'slash' only when the game says so. `pick` is the title's mode switch and
  // `song` its song picker (each song is one difficulty, `level`, which is the STAR SLASH chart):
  // both are remembered between visits, and both travel in the start / startDemo events.
  let mode = cfg.mode === 'slash' ? 'slash' : 'dance';
  let pick = cfg.mode === 'slash' || cfg.mode === 'dance' ? mode : readStored(MODE_KEY) === 'slash' ? 'slash' : 'dance';
  let song = SONGS[cfg.song] ? cfg.song : readStored(SONG_KEY);
  if (!SONGS[song]) song = DEFAULT_SONG;
  let level = SONGS[song].level;
  best = readBest(songBestKey(song));
  let layoutMode = ''; // the mode the canvases were last laid out for
  const slashBest = {};
  const slashKeysBest = {};
  for (const d of DIFFICULTIES) {
    slashBest[d] = readStoredScore(SLASH_BEST_KEY + d);
    slashKeysBest[d] = readStoredScore(SLASH_KEYS_BEST_KEY + d);
  }
  // who plays the run on screen: 'camera' | 'keys' (STAR SLASH on the keyboard) | 'demo'
  let input = 'camera';
  root.setAttribute('data-input', input);
  // the device: a phone gets its own camera help, a touch screen gets pads for the keyboard mode
  const device = cfg.device || sniffDevice();
  let touch = false;
  function setTouch(on) {
    if (on === touch) return;
    touch = on;
    if (on) root.setAttribute('data-touch', ''); else root.removeAttribute('data-touch');
    tileDemo = null; // the panel's tag is written again
  }
  if (device.mobile) root.setAttribute('data-mobile', '');
  if (mode === 'slash') playerCount = 1; // STAR SLASH is a one-player mode

  root.setAttribute('data-players', String(playerCount));
  root.setAttribute('data-mode', mode);
  root.setAttribute('data-pick', pick);

  // ---- events -------------------------------------------------------------

  function on(event, cb) {
    if (typeof cb !== 'function') return () => {};
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  let lastEmitName = '';
  let lastEmitAt = -1e9;

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error('[hud] listener for "' + event + '" failed', err);
      }
    });
  }

  // user-triggered events are debounced so a double click cannot start twice
  function gate(event) {
    const now = performance.now();
    if (event === lastEmitName && now - lastEmitAt < 350) return false;
    lastEmitName = event;
    lastEmitAt = now;
    return true;
  }

  function fire(event, payload) {
    if (gate(event)) emit(event, payload);
  }

  // ---- reusable animations (WAAPI, transform/opacity only) -----------------

  function makeAnim(el, frames, timing) {
    if (!el || typeof el.animate !== 'function') return null;
    const a = el.animate(frames, timing);
    a.cancel();
    return a;
  }

  function replay(a) {
    if (!a) return;
    a.cancel();
    a.play();
  }

  function halt(a) {
    if (a) a.cancel();
  }

  // replay when `yes`, otherwise make sure a previous run is not still showing
  function replayIf(a, yes) {
    if (!a) return;
    a.cancel();
    if (yes) a.play();
  }

  const anims = {
    chip: makeAnim(refs.sectionChip, [
      { opacity: 0, transform: 'translateY(-60%) skewX(-12deg) scale(1.15)' },
      { opacity: 1, transform: 'translateY(0) skewX(0deg) scale(1)' },
    ], { duration: 460, easing: 'cubic-bezier(.2,.9,.2,1)' }),
    count: makeAnim(refs.countNum, [
      { opacity: 0, transform: 'scale(1.9)', easing: 'cubic-bezier(.2,.9,.2,1)' },
      { opacity: 1, transform: 'scale(1)', offset: 0.2 },
      { opacity: 1, transform: 'scale(0.96)', offset: 0.78 },
      { opacity: 0, transform: 'scale(0.8)' },
    ], { duration: 960, easing: 'linear', fill: 'both' }), // linear overall: a global ease-out left the numeral visible for only ~250 ms
    countRing: makeAnim(refs.countRing, [
      { opacity: 0.9, transform: 'scale(0.55)' },
      { opacity: 0, transform: 'scale(1.5)' },
    ], { duration: 900, easing: 'cubic-bezier(.1,.7,.2,1)', fill: 'both' }),
    // STAR SLASH: the multiplier ring ticks on every hit, pops when it steps up, shudders when
    // the streak is lost; the how-to line rises, stays for the first seconds, and leaves
    mringTick: makeAnim(refs.mringSvg, [
      { transform: 'scale(1.1)' },
      { transform: 'scale(1)' },
    ], { duration: 190, easing: 'cubic-bezier(.2,.9,.3,1)' }),
    mringUp: makeAnim(refs.mringNum, [
      { transform: 'scale(1.9) rotate(-8deg)' },
      { transform: 'scale(0.9) rotate(0deg)', offset: 0.55 },
      { transform: 'scale(1) rotate(0deg)' },
    ], { duration: 340, easing: 'cubic-bezier(.2,.9,.3,1)' }),
    mringBurst: makeAnim(refs.mringBurst, [
      { opacity: 0.95, transform: 'scale(0.6)' },
      { opacity: 0, transform: 'scale(2)' },
    ], { duration: 480, easing: 'cubic-bezier(.1,.7,.2,1)' }),
    mringDrop: makeAnim(refs.mring, [
      { opacity: 1, transform: 'translateX(0%)' },
      { opacity: 0.45, transform: 'translateX(-7%)', offset: 0.22 },
      { opacity: 0.6, transform: 'translateX(5%)', offset: 0.5 },
      { opacity: 1, transform: 'translateX(0%)' },
    ], { duration: 360, easing: 'ease-out' }),
    hint: makeAnim(refs.shint, [
      { opacity: 0, transform: 'translateY(60%)', easing: 'cubic-bezier(.2,.9,.2,1)' },
      { opacity: 1, transform: 'translateY(0%)', offset: 0.07 },
      { opacity: 1, transform: 'translateY(0%)', offset: 0.9, easing: 'ease-in' },
      { opacity: 0, transform: 'translateY(-30%)' },
    ], { duration: cfg.hintMs > 0 ? +cfg.hintMs : 7000, easing: 'linear' }),
  };

  // ---- per-player state ------------------------------------------------------

  // live match read-out of one player; written by setSync(), read by the per-frame painters
  function makeSync() {
    const n = SEGS.length;
    const colors = {};
    for (let i = 0; i < n; i++) colors[SEGS[i]] = C_WHITE;
    return {
      at: -1e9, // performance.now() of the last setSync()
      value: 0, // smoothed overall match 0..1
      state: 0, // 0 off / 1 near / 2 hit, with hysteresis
      tone: 0, // eased colour position of the overall match (0 coral .. 1 teal)
      has: new Uint8Array(n), // did the last setSync() carry a value for the segment?
      val: new Float32Array(n),
      st: new Uint8Array(n),
      segTone: new Float32Array(n),
      seen: new Uint8Array(n).fill(1), // can the camera see the segment? (hysteresis)
      seenW: new Float32Array(n).fill(1), // eased 0..1, blends unseen limbs to a neutral stance
      colors, // segment name -> colour string, handed to drawPictogram as segColors
    };
  }

  function makeMeter() {
    return { ok: false, x: 0, y: 0, w: 0, h: 0, skew: 0, tick: 1, numX: 0, numY: 0, font: '', align: 'right', dir: 1 };
  }

  function makePlayerUi(p) {
    const dir = p === 0 ? 1 : -1; // +1: this player's side is the screen-left
    const digitsEl = refs['digits' + p];
    const digitEls = Array.prototype.slice.call(digitsEl.querySelectorAll('.digit'));
    const body = refs['ratingBody' + p];
    const cardCanvas = refs['cardCanvas' + p];
    const sync = makeSync();
    const ui = {
      index: p,
      dir,
      // score + combo
      digitEls,
      stripEls: digitEls.map((d) => d.firstElementChild),
      digitCur: [0, 0, 0, 0, 0, 0, 0],
      digitDim: [true, true, true, true, true, true, true],
      lastScore: 0,
      lastCombo: 0,
      lastMult: -1,
      mult: 1,
      comboOn: false,
      flyUntil: 0,
      scoreWrap: refs['scoreWrap' + p],
      combo: refs['combo' + p],
      comboNum: refs['comboNum' + p],
      comboMult: refs['comboMult' + p],
      // rating burst
      rating: refs['rating' + p],
      ratingWord: refs['ratingWord' + p],
      ratingEcho: refs['ratingEcho' + p],
      ratingKo: refs['ratingKo' + p],
      ratingShown: '',
      ratingGold: null,
      edge: refs['edge' + p],
      fly: refs['fly' + p],
      flyGold: false,
      banner: refs['cbanner' + p],
      bannerNum: refs['cbannerNum' + p],
      bannerSub: refs['cbannerSub' + p],
      bannerHot: false,
      // live pose read-out
      sync,
      figPose: blankPose(),
      figOpts: { color: C_WHITE, accent: '#ffffff', segColors: sync.colors },
      plainOpts: { color: C_WHITE, accent: PLAYER_COLORS[p] },
      card: refs['card' + p],
      cardView: { canvas: cardCanvas, ctx: cardCanvas.getContext('2d'), ok: false, W: 0, H: 0, figX: 0, figY: 0, figS: 0 },
      cardMeter: makeMeter(),
      cardLost: false,
      cardLowSince: 0,
      // 2P camera tile
      pcam: refs['pcam' + p],
      pcamView: makeView(refs['pcamCanvas' + p]),
      pcamCx: p === 0 ? 0.27 : 0.73, // where the crop is centred (mirrored x), eased toward the player
      pcamShown: false,
      a: null,
    };

    ui.a = {
      // PERFECT / SUPER / GOOD: the word slams in from 2.6x, overshoots, settles, lifts away
      slam: makeAnim(body, [
        { opacity: 0, transform: `translateY(0%) scale(2.6) rotate(${-5 * dir}deg)`, easing: 'cubic-bezier(.55,0,.9,.45)' },
        { opacity: 1, transform: 'translateY(0%) scale(0.84) rotate(0deg)', offset: 0.11, easing: 'cubic-bezier(.2,.8,.3,1)' },
        { opacity: 1, transform: 'translateY(0%) scale(1.13) rotate(0deg)', offset: 0.2, easing: 'ease-in-out' },
        { opacity: 1, transform: 'translateY(0%) scale(0.98) rotate(0deg)', offset: 0.29, easing: 'ease-in-out' },
        { opacity: 1, transform: 'translateY(0%) scale(1) rotate(0deg)', offset: 0.37 },
        { opacity: 1, transform: 'translateY(0%) scale(1) rotate(0deg)', offset: 0.78, easing: 'ease-in' },
        { opacity: 0, transform: 'translateY(-16%) scale(0.94) rotate(0deg)' },
      ], { duration: 860, easing: 'linear' }),
      // OK: a plain pop
      pop: makeAnim(body, [
        { opacity: 0, transform: 'translateY(0%) scale(0.5)', easing: 'cubic-bezier(.2,.9,.3,1)' },
        { opacity: 1, transform: 'translateY(0%) scale(1.1)', offset: 0.2 },
        { opacity: 1, transform: 'translateY(0%) scale(1)', offset: 0.34 },
        { opacity: 1, transform: 'translateY(0%) scale(1)', offset: 0.72, easing: 'ease-in' },
        { opacity: 0, transform: 'translateY(-12%) scale(0.96)' },
      ], { duration: 620, easing: 'linear' }),
      // MISS: small, dull, quick; drops in, shudders, sinks
      miss: makeAnim(body, [
        { opacity: 0, transform: 'translate(0%, -14%) scale(1)' },
        { opacity: 0.9, transform: `translate(${-1.6 * dir}%, 0%) scale(1)`, offset: 0.16 },
        { opacity: 0.9, transform: `translate(${1.4 * dir}%, 0%) scale(1)`, offset: 0.3 },
        { opacity: 0.9, transform: 'translate(0%, 0%) scale(1)', offset: 0.44 },
        { opacity: 0.8, transform: 'translate(0%, 0%) scale(1)', offset: 0.7, easing: 'ease-in' },
        { opacity: 0, transform: 'translate(0%, 14%) scale(0.96)' },
      ], { duration: 460, easing: 'linear' }),
      echo: makeAnim(refs['ratingEcho' + p], [
        { opacity: 0.6, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(1.9)' },
      ], { duration: 460, delay: 95, easing: 'cubic-bezier(.1,.7,.2,1)' }),
      rays: makeAnim(refs['ratingRays' + p], [
        { opacity: 0, transform: 'scale(0.2) rotate(0deg)' },
        { opacity: 1, transform: `scale(0.8) rotate(${7 * dir}deg)`, offset: 0.22 },
        { opacity: 0, transform: `scale(1.4) rotate(${18 * dir}deg)` },
      ], { duration: 620, delay: 80, easing: 'cubic-bezier(.1,.7,.2,1)' }),
      ring: makeAnim(refs['ratingRing' + p], [
        { opacity: 0.95, transform: 'scale(0.2)' },
        { opacity: 0, transform: 'scale(1.6)' },
      ], { duration: 520, delay: 90, easing: 'cubic-bezier(.1,.7,.2,1)' }),
      ringB: makeAnim(refs['ratingRingB' + p], [
        { opacity: 0.8, transform: 'scale(0.2)' },
        { opacity: 0, transform: 'scale(2.1)' },
      ], { duration: 700, delay: 190, easing: 'cubic-bezier(.1,.7,.2,1)' }),
      flash: makeAnim(refs['ratingFlash' + p], [
        { opacity: 0.95, transform: 'scale(0.3)' },
        { opacity: 0, transform: 'scale(1.5)' },
      ], { duration: 420, delay: 80, easing: 'ease-out' }),
      sparks: makeAnim(refs['ratingSparks' + p], [
        { opacity: 0, transform: `scale(0.3) rotate(${-24 * dir}deg)` },
        { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 0.25 },
        { opacity: 1, transform: `scale(1.18) rotate(${14 * dir}deg)`, offset: 0.6 },
        { opacity: 0, transform: `scale(1.4) rotate(${30 * dir}deg)` },
      ], { duration: 980, delay: 90, easing: 'cubic-bezier(.1,.7,.2,1)' }),
      // colour wash on this player's edge of the screen
      edge: makeAnim(refs['edge' + p], [
        { opacity: 0, transform: 'scaleX(0.35)' },
        { opacity: 1, transform: 'scaleX(1)', offset: 0.16 },
        { opacity: 0, transform: 'scaleX(1.12)' },
      ], { duration: 640, delay: 80, easing: 'ease-out' }),
      combo: makeAnim(ui.comboNum, [
        { transform: `scale(1.9) rotate(${-6 * dir}deg)` },
        { transform: 'scale(0.92) rotate(0deg)', offset: 0.55 },
        { transform: 'scale(1) rotate(0deg)' },
      ], { duration: 320, easing: 'cubic-bezier(.2,.9,.3,1)' }),
      comboBurst: makeAnim(refs['comboBurst' + p], [
        { opacity: 0.9, transform: 'scale(0.4)' },
        { opacity: 0, transform: 'scale(2.1)' },
      ], { duration: 380, easing: 'cubic-bezier(.1,.7,.2,1)' }),
      comboBreak: makeAnim(ui.combo, [
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0.9, transform: `translateX(${-4 * dir}%)`, offset: 0.2 },
        { opacity: 0.7, transform: `translateX(${3 * dir}%)`, offset: 0.45 },
        { opacity: 0, transform: 'translateY(30%)' },
      ], { duration: 420, easing: 'ease-in' }),
      // small bump whenever the number goes up without a burst (v1 behaviour)
      score: makeAnim(digitsEl, [
        { transform: 'scale(1.07)' },
        { transform: 'scale(1)' },
      ], { duration: 300, easing: 'cubic-bezier(.2,.9,.3,1)' }),
      // the bigger bump when the flying points land
      scoreHit: makeAnim(digitsEl, [
        { transform: 'scale(1)' },
        { transform: 'scale(1.17)', offset: 0.3 },
        { transform: 'scale(1)' },
      ], { duration: 340, delay: FLY_ARRIVE_MS, easing: 'cubic-bezier(.2,.9,.3,1)' }),
      scoreFlash: makeAnim(refs['scoreFlash' + p], [
        { opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { opacity: 0 },
      ], { duration: 460, delay: FLY_ARRIVE_MS - 40, easing: 'ease-out' }),
      banner: makeAnim(refs['cbannerPlate' + p], [
        { opacity: 0, transform: `translateX(${-110 * dir}%) skewX(${-14 * dir}deg)`, easing: 'cubic-bezier(.2,.9,.2,1)' },
        { opacity: 1, transform: `translateX(${3 * dir}%) skewX(0deg)`, offset: 0.14 },
        { opacity: 1, transform: 'translateX(0%) skewX(0deg)', offset: 0.2 },
        { opacity: 1, transform: 'translateX(0%) skewX(0deg)', offset: 0.82, easing: 'ease-in' },
        { opacity: 0, transform: `translateX(${-24 * dir}%) skewX(0deg)` },
      ], { duration: 1500, easing: 'linear' }),
      fly: null, // built by layoutPlayGeometry(): it needs the on-screen distance burst -> score
    };
    return ui;
  }

  const PU = [makePlayerUi(0), makePlayerUi(1)];

  function playerUi(player) {
    return PU[player === 1 || player === '1' ? 1 : 0];
  }

  // ---- canvases ------------------------------------------------------------

  function sizeCanvas(canvas) {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!(cw > 0 && ch > 0)) return false;
    const w = Math.max(2, Math.round(cw * dpr));
    const h = Math.max(2, Math.round(ch * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return true;
  }

  // -- lane ------------------------------------------------------------------

  const L = {
    canvas: refs.laneCanvas,
    ctx: refs.laneCanvas.getContext('2d'),
    ok: false, W: 0, H: 0, markerX: 0, cy: 0, sw: 0, sh: 0, pad: 0, ps: 0, ppb: 0,
    tickY: 0, tickW: 0, tickH: 0,
    marker: null, markerFlash: {}, placeholder: null, placeholderGold: null,
  };
  const spriteByMove = new Map();
  const spriteByKey = new Map();
  let anonKey = 0;
  let tlMoves = null;
  let tlCursor = 0;
  const tlBeat = new Float64Array(1); // beat of the previous frame (typed: written every frame)
  let flashKind = '';
  let flashAt = -1e9;

  const CARD_OPTS = { color: C_WHITE, accent: C_TEAL };
  const GOLD_OPTS = { gold: true };
  const PASS_BEATS = 0.75;
  const FLASH_MS = 460;

  let choreoGetPose = null;
  let choreoState = 0; // 0 idle, 1 loading, 2 ready, 3 failed

  function requestChoreo() {
    if (choreoState !== 0) return;
    choreoState = 1;
    import('./choreo.js').then((m) => {
      if (m && typeof m.getPose === 'function') {
        choreoGetPose = m.getPose;
        choreoState = 2;
      } else {
        choreoState = 3;
      }
    }).catch(() => {
      choreoState = 3;
    });
  }

  function bakeCard(pose, label, gold) {
    const w = L.sw;
    const h = L.sh;
    const pad = L.pad;
    const c = makeSprite(w, h);
    const g = c.getContext('2d');
    const pw = w - pad * 2;
    const ph = h - pad * 2;
    const r = pw * 0.16;

    // plate
    g.save();
    if (gold) {
      g.shadowColor = 'rgba(255,194,74,0.9)';
      g.shadowBlur = pad * 0.85;
    } else {
      g.shadowColor = 'rgba(11,6,32,0.6)';
      g.shadowBlur = pad * 0.5;
    }
    const grad = g.createLinearGradient(0, pad, 0, pad + ph);
    if (gold) {
      grad.addColorStop(0, 'rgba(96,58,8,0.94)');
      grad.addColorStop(1, 'rgba(46,22,6,0.94)');
    } else {
      grad.addColorStop(0, 'rgba(44,28,104,0.88)');
      grad.addColorStop(1, 'rgba(16,9,44,0.9)');
    }
    g.fillStyle = grad;
    roundRectPath(g, pad, pad, pw, ph, r);
    g.fill();
    g.restore();

    const lw = Math.max(1.5, w * 0.014);
    g.lineWidth = gold ? lw * 1.6 : lw;
    g.strokeStyle = gold ? C_GOLD : 'rgba(190,176,255,0.42)';
    roundRectPath(g, pad + g.lineWidth / 2, pad + g.lineWidth / 2, pw - g.lineWidth, ph - g.lineWidth, r);
    g.stroke();

    // inner top sheen
    g.save();
    roundRectPath(g, pad, pad, pw, ph, r);
    g.clip();
    const sheen = g.createLinearGradient(0, pad, 0, pad + ph * 0.5);
    sheen.addColorStop(0, gold ? 'rgba(255,236,170,0.26)' : 'rgba(255,255,255,0.13)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.fillRect(pad, pad, pw, ph * 0.5);
    g.restore();

    // figure
    const figY = pad + ph * 0.42;
    if (pose) {
      drawPictogram(g, pose, w / 2, figY, L.ps, gold ? GOLD_OPTS : CARD_OPTS);
    } else {
      g.fillStyle = gold ? C_GOLD : 'rgba(190,176,255,0.6)';
      starPath(g, w / 2, figY, L.ps * 0.2);
      g.fill();
    }

    // label
    const text = label ? String(label) : '';
    if (text) {
      let fs = h * 0.118;
      const maxW = pw * 0.88;
      g.font = `800 ${fs}px ${FONT_KO}`;
      const tw = g.measureText(text).width;
      if (tw > maxW) {
        fs *= maxW / tw;
        g.font = `800 ${fs}px ${FONT_KO}`;
      }
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = gold ? '#ffe9a8' : '#ffffff';
      g.fillText(text, w / 2, pad + ph * 0.885);
    }

    // gold badge
    if (gold) {
      const br = w * 0.085;
      g.save();
      g.shadowColor = 'rgba(255,220,130,0.95)';
      g.shadowBlur = br;
      g.fillStyle = '#fff3c4';
      starPath(g, pad + pw - br * 1.25, pad + br * 1.3, br);
      g.fill();
      g.restore();
    }
    return c;
  }

  function bakeMarker(color, strong) {
    const w = L.sw * 1.3;
    const h = L.H;
    const c = makeSprite(w, h);
    const g = c.getContext('2d');
    const fw = (L.sw - L.pad * 2) * 1.1;
    const fh = (L.sh - L.pad * 2) * 1.07;
    const x = (w - fw) / 2;
    const y = L.cy - fh / 2;
    const r = fw * 0.17;
    const lw = Math.max(2, L.sw * (strong ? 0.036 : 0.026));

    g.save();
    g.shadowColor = color;
    g.shadowBlur = L.pad * (strong ? 1.5 : 1.05);
    g.strokeStyle = color;
    g.lineWidth = lw;
    roundRectPath(g, x, y, fw, fh, r);
    g.stroke();
    if (strong) g.stroke();
    g.restore();

    g.save();
    g.globalAlpha = strong ? 0.26 : 0.1;
    g.fillStyle = color;
    roundRectPath(g, x, y, fw, fh, r);
    g.fill();
    g.restore();

    // chevrons pointing in from above and below
    const t = Math.max(4, L.sw * 0.06);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(w / 2 - t, y - t * 1.5);
    g.lineTo(w / 2 + t, y - t * 1.5);
    g.lineTo(w / 2, y - t * 0.35);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(w / 2 - t, y + fh + t * 1.5);
    g.lineTo(w / 2 + t, y + fh + t * 1.5);
    g.lineTo(w / 2, y + fh + t * 0.35);
    g.closePath();
    g.fill();
    return c;
  }

  function clearSprites() {
    spriteByMove.clear();
    spriteByKey.clear();
  }

  function layoutLane() {
    L.ok = false;
    if (!sizeCanvas(L.canvas)) return false;
    const W = L.canvas.width;
    const H = L.canvas.height;
    L.W = W;
    L.H = H;
    L.cy = H * 0.525;
    L.pad = Math.round(H * 0.085);
    L.sh = Math.round(H * 0.73) + L.pad * 2;
    L.ps = H * 0.56;
    L.sw = Math.round(H * 0.56) + L.pad * 2;
    L.markerX = Math.max(W * 0.15, L.sw * 0.95);
    L.ppb = Math.max((L.sw - L.pad * 2) * 1.1, (W - L.markerX) / cfg.beatsAhead);
    L.tickY = H * 0.955;
    L.tickW = Math.max(2, Math.round(H * 0.014));
    L.tickH = Math.max(3, Math.round(H * 0.035));
    clearSprites();
    L.marker = bakeMarker(C_TEAL, false);
    L.markerFlash.perfect = bakeMarker(RATING_INFO.perfect.color, true);
    L.markerFlash.super = bakeMarker(RATING_INFO.super.color, true);
    L.markerFlash.good = bakeMarker(RATING_INFO.good.color, true);
    L.markerFlash.ok = bakeMarker(RATING_INFO.ok.color, true);
    L.markerFlash.miss = bakeMarker(RATING_INFO.miss.color, true);
    L.markerFlash.gold = bakeMarker(C_GOLD, true);
    L.placeholder = bakeCard(null, '', false);
    L.placeholderGold = bakeCard(null, '', true);
    L.ok = true;
    return true;
  }

  function spriteFor(m) {
    const cached = spriteByMove.get(m);
    if (cached) return cached;
    let pose = m.poseData || null;
    const ref = m.pose;
    if (!pose && ref && typeof ref === 'object') pose = ref;
    if (!pose && typeof ref === 'string') {
      if (choreoState === 2) {
        try {
          pose = choreoGetPose(ref);
        } catch (e) {
          pose = null;
        }
      } else {
        requestChoreo();
      }
    }
    const gold = !!m.gold;
    if (!pose) {
      if (choreoState === 3 || choreoState === 2) {
        // unresolvable: still show the label so the lane stays informative
        const s = bakeCard(null, m.label, gold);
        spriteByMove.set(m, s);
        return s;
      }
      return gold ? L.placeholderGold : L.placeholder;
    }
    const name = typeof ref === 'string' ? ref : 'pose#' + (m.id != null ? m.id : anonKey++);
    const key = name + '|' + (m.label || '') + '|' + (gold ? 1 : 0);
    let s = spriteByKey.get(key);
    if (!s) {
      s = bakeCard(pose, m.label, gold);
      spriteByKey.set(key, s);
    }
    spriteByMove.set(m, s);
    return s;
  }

  // Called every frame. No allocation, no layout access.
  function updateTimeline(beat, moves) {
    if (!L.ok) return;
    const ctx = L.ctx;
    const W = L.W;
    const H = L.H;
    const mx = L.markerX;
    const ppb = L.ppb;
    const cy = L.cy;
    const b = +beat || 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);

    // beat ticks
    ctx.fillStyle = '#ffffff';
    const b0 = Math.max(0, Math.ceil(b - mx / ppb));
    const b1 = Math.floor(b + (W - mx) / ppb);
    for (let k = b0; k <= b1; k++) {
      const x = mx + (k - b) * ppb;
      const bar = (k & 3) === 0;
      const th = bar ? L.tickH * 2 : L.tickH;
      const edge = clamp01((W - x) / (ppb * 0.6));
      ctx.globalAlpha = (bar ? 0.5 : 0.2) * edge;
      ctx.fillRect(x - L.tickW * 0.5, L.tickY - th, L.tickW, th);
    }

    // hit marker with a pulse on every beat
    const frac = b - Math.floor(b);
    const pulse = b >= -4 ? (1 - frac) * (1 - frac) * (1 - frac) : 0;
    const ms = 1 + 0.045 * pulse;
    const mw = L.marker.width * ms;
    const mh = L.marker.height * ms;
    ctx.globalAlpha = 0.7 + 0.3 * pulse;
    ctx.drawImage(L.marker, mx - mw * 0.5, cy - (cy / H) * mh, mw, mh);

    if (moves && moves.length) {
      if (moves !== tlMoves || b < tlBeat[0] - 0.5) {
        tlMoves = moves;
        tlCursor = 0;
      }
      tlBeat[0] = b;
      const n = moves.length;
      let i0 = tlCursor;
      while (i0 < n && moves[i0].beat < b - PASS_BEATS) i0++;
      tlCursor = i0;
      const maxRel = (W - mx + L.sw) / ppb;
      let i1 = i0;
      while (i1 < n && moves[i1].beat - b <= maxRel) i1++;

      // hold tails, under the cards
      for (let i = i0; i < i1; i++) {
        const m = moves[i];
        const hold = +m.hold || 0;
        if (hold < 0.75) continue;
        const rel = m.beat - b;
        const x = mx + Math.max(rel, 0) * ppb;
        const x2 = Math.min(W, mx + (rel + hold) * ppb);
        if (x2 <= x) continue;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = m.gold ? C_GOLD : C_TEAL;
        ctx.fillRect(x, L.tickY - L.tickH * 0.5, x2 - x, Math.max(2, L.tickH * 0.5));
      }

      // cards, far to near so the next move is always on top
      for (let i = i1 - 1; i >= i0; i--) {
        const m = moves[i];
        const rel = m.beat - b;
        const spr = spriteFor(m);
        let x;
        let sc;
        let a;
        if (rel >= 0) {
          x = mx + rel * ppb;
          const t = clamp01(1 - rel / 1.6);
          sc = 0.8 + 0.2 * t * t * (3 - 2 * t);
          a = clamp01((W - (x - L.sw * 0.35)) / (ppb * 0.55));
          if (rel > 1) a *= 0.86;
        } else {
          const k = clamp01(-rel / PASS_BEATS);
          x = mx + rel * ppb * 0.3;
          sc = 1 + 0.16 * k;
          a = 1 - k * k;
        }
        if (a <= 0.004) continue;
        const w = spr.width * sc;
        const h = spr.height * sc;
        ctx.globalAlpha = a;
        ctx.drawImage(spr, x - w * 0.5, cy - h * 0.5, w, h);
      }
    }

    // rating flash over the marker
    const ft = (performance.now() - flashAt) / FLASH_MS;
    if (ft >= 0 && ft < 1) {
      const fs = L.markerFlash[flashKind];
      if (fs) {
        const k = 1 - ft;
        const sc = 1 + 0.2 * ft;
        const fw = fs.width * sc;
        const fh = fs.height * sc;
        ctx.globalAlpha = k * k;
        ctx.drawImage(fs, mx - fw * 0.5, cy - (cy / H) * fh, fw, fh);
      }
    }
    ctx.globalAlpha = 1;
  }

  // -- camera views ----------------------------------------------------------

  function makeView(canvas) {
    return { canvas, ctx: canvas.getContext('2d'), ok: false, W: 0, H: 0, cx: 0, cy: 0, figS: 0, bg: null, vignette: null, tagFont: '' };
  }

  const tileView = makeView(refs.tileCanvas);
  const camView = makeView(refs.camCanvas);
  const tileMeterView = { canvas: refs.tileMeter, ctx: refs.tileMeter.getContext('2d'), ok: false, W: 0, H: 0 };
  const tileMeter = makeMeter();

  function layoutView(v) {
    v.ok = false;
    if (!sizeCanvas(v.canvas)) return false;
    const W = v.canvas.width;
    const H = v.canvas.height;
    v.W = W;
    v.H = H;
    v.cx = Math.round(W / 2); // box of a full-view figure, in whole pixels
    v.cy = Math.round(H / 2);
    v.figS = Math.round(H * 0.92);
    const bg = v.ctx.createLinearGradient(0, 0, W * 0.4, H);
    bg.addColorStop(0, '#1d1150');
    bg.addColorStop(0.6, '#120a34');
    bg.addColorStop(1, '#0b0620');
    v.bg = bg;
    const vg = v.ctx.createRadialGradient(W / 2, H * 0.5, Math.min(W, H) * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(11,6,32,0)');
    vg.addColorStop(1, 'rgba(11,6,32,0.62)');
    v.vignette = vg;
    v.tagFont = '900 ' + Math.max(10, Math.round(H * 0.046)) + 'px ' + FONT_DISPLAY;
    v.ok = true;
    return true;
  }

  // sync meters: the bar under the 1P "나" panel and the one inside each 2P live card
  function layoutMeters() {
    // 1P: [ bar ............ ] 87%
    tileMeterView.ok = false;
    tileMeter.ok = false;
    if (sizeCanvas(tileMeterView.canvas)) {
      const W = tileMeterView.canvas.width;
      const H = tileMeterView.canvas.height;
      tileMeterView.W = W;
      tileMeterView.H = H;
      const m = tileMeter;
      const numW = H * 2.25;
      m.h = Math.max(4, Math.round(H * 0.36));
      m.skew = m.h * 0.445;
      m.x = Math.round(H * 0.06);
      m.w = Math.max(8, W - numW - m.x - m.skew);
      m.y = Math.round((H - m.h) * 0.5);
      m.tick = Math.max(1.5, H * 0.045);
      m.numX = W - 1;
      m.numY = H * 0.54;
      m.font = '800 ' + Math.max(9, Math.round(H * 0.6)) + 'px ' + FONT_DISPLAY;
      m.align = 'right';
      m.dir = 1;
      m.ok = true;
      tileMeterView.ok = true;
    }
    // 2P: figure on the outer side of the card, number above the bar, bar filling toward the centre
    for (let p = 0; p < 2; p++) {
      const ui = PU[p];
      const cv = ui.cardView;
      const m = ui.cardMeter;
      cv.ok = false;
      m.ok = false;
      if (!sizeCanvas(cv.canvas)) continue;
      const W = cv.canvas.width;
      const H = cv.canvas.height;
      cv.W = W;
      cv.H = H;
      // whole pixels: the live figure is drawn every frame, and integers are passed around for free
      cv.figS = Math.round(H * 0.98);
      cv.figY = Math.round(H * 0.5);
      cv.figX = Math.round(p === 0 ? H * 0.52 : W - H * 0.52);
      const r0 = p === 0 ? H * 1.09 : H * 0.2; // meter region
      const r1 = p === 0 ? W - H * 0.2 : W - H * 1.09;
      m.h = Math.max(4, Math.round(H * 0.15));
      m.skew = m.h * 0.445;
      m.x = Math.round(r0);
      m.w = Math.max(8, r1 - r0 - m.skew);
      m.y = Math.round(H * 0.64);
      m.tick = Math.max(1.5, H * 0.02);
      m.numX = p === 0 ? r1 : r0;
      m.numY = H * 0.33;
      m.font = '800 ' + Math.max(9, Math.round(H * 0.3)) + 'px ' + FONT_DISPLAY;
      m.align = p === 0 ? 'right' : 'left';
      m.dir = p === 0 ? 1 : -1;
      m.ok = true;
      cv.ok = true;
    }
  }

  const PLAYER_OPTS = { color: C_WHITE, accent: C_TEAL };
  const PLAYER_LOW_OPTS = { color: '#ffd0d6', accent: C_CORAL };
  const GUIDE_OPTS = { color: '#bfb4ff', accent: '#bfb4ff', outline: 'rgba(11,6,32,0.2)', alpha: 0.2 };
  const GHOST_OPTS = { color: 'rgba(190,180,255,0.4)', accent: 'rgba(190,180,255,0.4)', outline: 'rgba(11,6,32,0.55)' };
  const CAM_FIG_OPTS = [{ color: C_WHITE, accent: C_TEAL }, { color: C_WHITE, accent: C_CORAL }];
  const SLASH_FIG_OPTS = { color: C_SLASH_BONE, accent: C_SLASH_BONE };

  function isLive(video) {
    return !!video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  }

  // The two measurements below hand their result back through this typed slot: a non-integer
  // number returned from a function that is too big to be inlined is boxed on every call.
  const RET = new Float64Array(1);

  // How much of the upper body (shoulders, elbows, wrists) the camera sees, 0..1.
  // Order: result.upperVisible (v2 tracker) -> the six upper landmarks (v1 tracker results carry
  // landmarks but no upperVisible) -> result.bodyVisible -> "there is a pose". Allocates nothing.
  function upperOf(res) {
    measureUpper(res);
    return RET[0];
  }

  function measureUpper(res) {
    RET[0] = 0;
    if (!res) return;
    const uv = res.upperVisible;
    if (uv !== undefined) {
      RET[0] = clamp01(+uv || 0);
      return;
    }
    const lms = res.landmarks;
    if (lms && lms.length >= 17) {
      let sum = 0;
      for (let k = 0; k < LM_UPPER.length; k++) {
        const q = lms[LM_UPPER[k]];
        let c = 0;
        let u = 0.5;
        let w = 0.5;
        if (q) {
          if (q.x !== undefined) {
            u = q.x;
            w = q.y;
            c = q.v !== undefined ? q.v : q.visibility !== undefined ? q.visibility : 1;
          } else {
            u = q[0];
            w = q[1];
            c = q[3] !== undefined ? q[3] : 1;
          }
        }
        // a joint guessed outside the picture does not count as seen
        if (u < -0.02 || u > 1.02 || w < -0.02 || w > 1.02) c = 0;
        sum += +c || 0;
      }
      RET[0] = clamp01(sum / LM_UPPER.length);
      return;
    }
    const bv = res.bodyVisible;
    if (bv !== undefined) RET[0] = clamp01(+bv || 0);
    else RET[0] = res.pose ? 1 : 0;
  }

  // Mirrored x (0 = screen left) of the player's shoulder midpoint, or -1 when unknown.
  function centreOf(res) {
    measureCentre(res);
    return RET[0];
  }

  function measureCentre(res) {
    RET[0] = -1;
    if (!res) return;
    const cx = +res.cx; // NaN when the result carries no cx
    if (cx === cx) {
      RET[0] = clamp01(cx);
      return;
    }
    const lms = res.landmarks;
    if (lms && lms.length >= 13 && lms[11] && lms[12]) {
      const a = lms[11];
      const b = lms[12];
      const ax = a.x !== undefined ? a.x : a[0];
      const bx = b.x !== undefined ? b.x : b[0];
      const mid = (ax + bx) * 0.5;
      if (mid === mid) RET[0] = clamp01(cfg.landmarksMirrored ? mid : 1 - mid);
    }
  }

  // Shared scratch of the camera painters (typed, so writing it every frame allocates nothing):
  // the source crop of the backdrop painted last, and the head-ring radius of the skeleton
  // painted last.
  const VS = new Float64Array(7);
  const V_CROP_X = 0;
  const V_CROP_Y = 1;
  const V_CROP_W = 2;
  const V_CROP_H = 3;
  const V_SRC_W = 4;
  const V_SRC_H = 5;
  const V_HEAD_R = 6;
  VS[V_CROP_W] = 1;
  VS[V_CROP_H] = 1;
  VS[V_SRC_W] = 4;
  VS[V_SRC_H] = 3;

  // Mirrored, cover-cropped camera frame (or the indigo backdrop when there is no camera).
  function paintBackdrop(v, video) {
    const ctx = v.ctx;
    const W = v.W;
    const H = v.H;
    const live = isLive(video);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    let srcW = 4;
    let srcH = 3;
    if (live) {
      srcW = video.videoWidth;
      srcH = video.videoHeight;
    }
    const va = srcW / srcH;
    const ca = W / H;
    let cropX = 0;
    let cropY = 0;
    let cropW = srcW;
    let cropH = srcH;
    if (va > ca) {
      cropW = srcH * ca;
      cropX = (srcW - cropW) * 0.5;
    } else {
      cropH = srcW / ca;
      cropY = (srcH - cropH) * 0.5;
    }
    VS[V_CROP_X] = cropX;
    VS[V_CROP_Y] = cropY;
    VS[V_CROP_W] = cropW;
    VS[V_CROP_H] = cropH;
    VS[V_SRC_W] = srcW;
    VS[V_SRC_H] = srcH;

    if (live) {
      ctx.setTransform(-1, 0, 0, 1, W, 0); // mirror, like looking into a mirror
      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, W, H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(20,8,60,0.2)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = v.bg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = v.vignette;
    ctx.fillRect(0, 0, W, H);
    return live;
  }

  // Projects landmarks into the (mirrored, cropped) view painted last -> LM_XY / LM_VIS.
  function projectLandmarks(v, lms) {
    const W = v.W;
    const H = v.H;
    const n = lms.length < 33 ? lms.length : 33;
    const cropX = VS[V_CROP_X];
    const cropY = VS[V_CROP_Y];
    const cropW = VS[V_CROP_W];
    const cropH = VS[V_CROP_H];
    const srcW = VS[V_SRC_W];
    const srcH = VS[V_SRC_H];
    for (let i = 0; i < n; i++) {
      const p = lms[i];
      let u = 0;
      let w = 0;
      let c = 0;
      if (p) {
        if (p.x !== undefined) {
          u = p.x;
          w = p.y;
          c = p.v !== undefined ? p.v : p.visibility !== undefined ? p.visibility : 1;
        } else {
          u = p[0];
          w = p[1];
          c = p[3] !== undefined ? p[3] : 1;
        }
      }
      const fx = (u * srcW - cropX) / cropW;
      LM_XY[i * 2] = (cfg.landmarksMirrored ? fx : 1 - fx) * W;
      LM_XY[i * 2 + 1] = ((w * srcH - cropY) / cropH) * H;
      LM_VIS[i] = c;
    }
    for (let i = n; i < 33; i++) LM_VIS[i] = 0;
  }

  function segColorOf(s, i) {
    return toneColor(s.has[i] ? s.segTone[i] : s.tone);
  }

  // Skeleton over the projected landmarks. With `s` (a player's sync read-out) every limb takes
  // its own match colour and matching limbs get a soft halo; without it one flat `color`.
  function paintSkeleton(v, big, s, color) {
    const ctx = v.ctx;
    const W = v.W;
    const lw = Math.max(2, W * (big ? 0.009 : 0.013));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // dark underlay so the lines read on any background
    ctx.strokeStyle = 'rgba(11,6,32,0.75)';
    ctx.lineWidth = lw * 2;
    ctx.beginPath();
    for (let k = 0; k < LM_BONES; k++) {
      const a = LM_BONE_A[k];
      const c = LM_BONE_B[k];
      if (LM_VIS[a] < LM_MIN_VIS || LM_VIS[c] < LM_MIN_VIS) continue;
      ctx.moveTo(LM_XY[a * 2], LM_XY[a * 2 + 1]);
      ctx.lineTo(LM_XY[c * 2], LM_XY[c * 2 + 1]);
    }
    ctx.stroke();

    if (s) {
      const base = ctx.globalAlpha;
      for (let k = 0; k < LM_BONES; k++) {
        const a = LM_BONE_A[k];
        const c = LM_BONE_B[k];
        if (LM_VIS[a] < LM_MIN_VIS || LM_VIS[c] < LM_MIN_VIS) continue;
        const i = LM_BONE_S[k];
        ctx.strokeStyle = segColorOf(s, i);
        if ((s.has[i] ? s.st[i] : s.state) === 2) {
          ctx.globalAlpha = base * 0.3;
          ctx.lineWidth = lw * 2.8;
          ctx.beginPath();
          ctx.moveTo(LM_XY[a * 2], LM_XY[a * 2 + 1]);
          ctx.lineTo(LM_XY[c * 2], LM_XY[c * 2 + 1]);
          ctx.stroke();
          ctx.globalAlpha = base;
        }
        ctx.lineWidth = lw * 1.15;
        ctx.beginPath();
        ctx.moveTo(LM_XY[a * 2], LM_XY[a * 2 + 1]);
        ctx.lineTo(LM_XY[c * 2], LM_XY[c * 2 + 1]);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let k = 0; k < LM_BONES; k++) {
        const a = LM_BONE_A[k];
        const c = LM_BONE_B[k];
        if (LM_VIS[a] < LM_MIN_VIS || LM_VIS[c] < LM_MIN_VIS) continue;
        ctx.moveTo(LM_XY[a * 2], LM_XY[a * 2 + 1]);
        ctx.lineTo(LM_XY[c * 2], LM_XY[c * 2 + 1]);
      }
      ctx.stroke();
    }

    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < LM_JOINTS.length; k++) {
      const j = LM_JOINTS[k];
      if (LM_VIS[j] < LM_MIN_VIS) continue;
      ctx.beginPath();
      ctx.arc(LM_XY[j * 2], LM_XY[j * 2 + 1], lw * 0.95, 0, 6.283185307179586);
      ctx.fill();
    }

    // head ring from the nose and the shoulder width
    let headR = 0;
    if (LM_VIS[0] >= LM_MIN_VIS) {
      const dxs = LM_XY[22] - LM_XY[24];
      const dys = LM_XY[23] - LM_XY[25];
      headR = Math.max(lw * 2, Math.sqrt(dxs * dxs + dys * dys) * 0.3);
      ctx.strokeStyle = s ? segColorOf(s, SEG_HEAD) : color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(LM_XY[0], LM_XY[1], headR, 0, 6.283185307179586);
      ctx.stroke();
    }
    VS[V_HEAD_R] = headR;
  }

  // STAR SLASH: one mark per hand in that hand's colour (screen-left teal, screen-right amber),
  // so players see at a glance that both hands are in the picture and which is which.
  // Position and radius of the mark painted next sit in a typed slot: a non-integer number
  // handed to a function as an argument would be boxed on every call.
  const HM = new Float64Array(3);
  const HM_X = 0;
  const HM_Y = 1;
  const HM_R = 2;

  function handMark(ctx, color) {
    const x = HM[HM_X];
    const y = HM[HM_Y];
    const r = HM[HM_R];
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r * 2, 0, 6.283185307179586);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(11,6,32,0.85)';
    ctx.beginPath();
    ctx.arc(x, y, r * 1.22, 0, 6.283185307179586);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.283185307179586);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.42, 0, 6.283185307179586);
    ctx.fill();
  }

  // Over the landmarks projected last: the palm is read as wrist + 0.35 x (wrist - elbow), the
  // same point the game's hand reader uses. MediaPipe LEFT_* are the screen-left limbs.
  // big = 1 on the camera screen (large view, smaller marks), 0 on the play panel.
  function paintHands(v, big) {
    const ctx = v.ctx;
    HM[HM_R] = Math.max(3, v.W * (big ? 0.02 : 0.036));
    for (let h = 0; h < 2; h++) {
      const wi = 15 + h;
      const ei = 13 + h;
      if (LM_VIS[wi] < LM_MIN_VIS) continue;
      const k = LM_VIS[ei] < LM_MIN_VIS ? 0 : 0.35;
      HM[HM_X] = LM_XY[wi * 2] + (LM_XY[wi * 2] - LM_XY[ei * 2]) * k;
      HM[HM_Y] = LM_XY[wi * 2 + 1] + (LM_XY[wi * 2 + 1] - LM_XY[ei * 2 + 1]) * k;
      handMark(ctx, HAND_COLORS[h]);
    }
  }

  // Over the figure drawn last (J still holds its joints in canvas pixels).
  function paintFigureHands(v, big) {
    HM[HM_R] = Math.max(3, v.W * (big ? 0.02 : 0.036));
    HM[HM_X] = J[J_LWR * 2];
    HM[HM_Y] = J[J_LWR * 2 + 1];
    handMark(v.ctx, HAND_COLORS[0]);
    HM[HM_X] = J[J_RWR * 2];
    HM[HM_Y] = J[J_RWR * 2 + 1];
    handMark(v.ctx, HAND_COLORS[1]);
  }

  // "P1" / "P2" plate above a head on the 2P camera screen
  function paintTag(v, text, color, x, y) {
    const ctx = v.ctx;
    const h = Math.max(12, v.H * 0.072);
    const w = h * 1.75;
    const top = Math.max(2, y - h);
    ctx.fillStyle = 'rgba(11,6,32,0.8)';
    roundRectPath(ctx, x - w * 0.5 - 2, top - 2, w + 4, h + 4, h * 0.3);
    ctx.fill();
    ctx.fillStyle = color;
    roundRectPath(ctx, x - w * 0.5, top, w, h, h * 0.24);
    ctx.fill();
    ctx.fillStyle = C_INK;
    ctx.font = v.tagFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, top + h * 0.54);
  }

  // Fills ui.figPose / ui.sync.colors for a live figure: limbs the camera cannot see relax to a
  // neutral stance and are drawn in a neutral colour instead of being marked "wrong".
  function resolveFigure(ui, res, tinted) {
    const s = ui.sync;
    const pose = res.pose;
    const conf = res.confidence || null;
    const out = ui.figPose;
    const idle = DECO.idle;
    for (let i = 0; i < SEGS.length; i++) {
      const k = SEGS[i];
      const src = pose[k];
      let seen = src ? 1 : 0;
      if (seen && conf) {
        const c = conf[k];
        if (c !== undefined) seen = c >= (s.seen[i] ? 0.2 : 0.35) ? 1 : 0;
      }
      s.seen[i] = seen;
      let w = s.seenW[i];
      w += (seen - w) * 0.2;
      s.seenW[i] = w;
      const o = out[k];
      const d = idle[k];
      if (src) {
        o[0] = d[0] + ((+src[0] || 0) - d[0]) * w;
        o[1] = d[1] + ((+src[1] || 0) - d[1]) * w;
        o[2] = d[2] + ((+src[2] || 0) - d[2]) * w;
      } else {
        o[0] = d[0];
        o[1] = d[1];
        o[2] = d[2];
      }
      s.colors[k] = !seen ? C_UNSEEN : tinted ? segColorOf(s, i) : C_WHITE;
    }
    out.hipX = +pose.hipX || 0;
    out.yaw = +pose.yaw || 0;
  }

  // Skewed bar + percentage. Canvas only: called every frame.
  function paintMeter(ctx, m, s, live) {
    if (!m.ok) return;
    const v = live ? s.value : 0;
    const col = live ? toneColor(s.tone) : C_UNSEEN;
    const x = m.x;
    const y = m.y;
    const w = m.w;
    const h = m.h;
    const k = m.skew;
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(x + k, y);
    ctx.lineTo(x + w + k, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fill();

    const fw = w * v;
    if (fw > 0.5) {
      const x0 = m.dir > 0 ? x : x + w - fw;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x0 + k, y);
      ctx.lineTo(x0 + fw + k, y);
      ctx.lineTo(x0 + fw, y + h);
      ctx.lineTo(x0, y + h);
      ctx.closePath();
      ctx.fill();
      // sheen on the upper third
      const hh = h * 0.36;
      const kk = k * 0.64;
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(x0 + k, y);
      ctx.lineTo(x0 + fw + k, y);
      ctx.lineTo(x0 + fw + kk, y + hh);
      ctx.lineTo(x0 + kk, y + hh);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // band marks: "거의" from 45 %, "맞음" from 75 %
    ctx.fillStyle = 'rgba(11,6,32,0.72)';
    for (let t = 0; t < 2; t++) {
      const f = t === 0 ? SYNC_NEAR : SYNC_HIT;
      const tx = m.dir > 0 ? x + w * f : x + w * (1 - f);
      ctx.beginPath();
      ctx.moveTo(tx + k, y);
      ctx.lineTo(tx + k + m.tick, y);
      ctx.lineTo(tx + m.tick, y + h);
      ctx.lineTo(tx, y + h);
      ctx.closePath();
      ctx.fill();
    }

    ctx.font = m.font;
    ctx.textAlign = m.align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = !live ? C_UNSEEN : s.state === 2 ? col : '#ffffff';
    ctx.fillText(PCT[(v * 100 + 0.5) | 0], m.numX, m.numY);
  }

  // -- camera screen (upper-body readiness, one or two players) ------------------

  let camState = 'requesting';
  let camError = '';
  const CAMT = new Float64Array(2); // [0] ms the "ready" pose has been held, [1] time of the previous frame
  const C_HOLD = 0;
  const C_LAST = 1;
  let camFired = false;
  let camMsgKey = -1;
  let meterQ = -1;
  let holdQ = -1;
  let meterPctShown = -1;
  const camUp = new Float64Array(2); // eased upper-body visibility per player
  const camP = [0, 1].map((p) => ({
    status: -1, ready: false, barQ: -1,
    chip: refs['chip' + p], text: refs['chipText' + p], fill: refs['chipFill' + p], slot: refs['slot' + p],
  }));
  const CAM_STATES = ['requesting', 'searching', 'almost', 'ready', 'go'];

  function camStatusText() {
    if (mode === 'slash') return CAMERA_STATUS_SLASH[camState] || '';
    if (playerCount !== 2) return CAMERA_STATUS[camState] || '';
    if (camState === 'almost') {
      if (camP[0].ready && !camP[1].ready) return WAITING_TEXT[1];
      if (camP[1].ready && !camP[0].ready) return WAITING_TEXT[0];
    }
    return CAMERA_STATUS_2P[camState] || '';
  }

  // the status line only changes when the overall state or a player's status changes
  function refreshCamStatus(force) {
    const key = CAM_STATES.indexOf(camState) * 100 + (camP[0].ready ? 10 : 0) + (camP[1].ready ? 1 : 0) + playerCount * 1000
      + (mode === 'slash' ? 10000 : 0);
    if (key === camMsgKey && !force) return;
    camMsgKey = key;
    refs.camStatus.textContent = camStatusText();
  }

  function setCamState(s) {
    if (s === camState) return;
    camState = s;
    refs.camSection.setAttribute('data-state', s);
    refreshCamStatus(true);
  }

  function setChip(p, status) {
    const cp = camP[p];
    if (status === cp.status) return;
    cp.status = status;
    cp.ready = status === 3;
    cp.chip.setAttribute('data-state', CHIP_STATES[status]);
    cp.text.textContent = CHIP_TEXT[p][status];
    cp.slot.classList.toggle('is-ready', status === 3);
  }

  function resetCamera() {
    CAMT[C_HOLD] = 0;
    CAMT[C_LAST] = 0;
    camFired = false;
    meterQ = -1;
    holdQ = -1;
    meterPctShown = -1;
    camMsgKey = -1;
    for (let p = 0; p < 2; p++) {
      camUp[p] = 0;
      camP[p].barQ = -1;
      camP[p].status = -1;
      setChip(p, 0);
      camP[p].fill.style.transform = SCALE_X[0];
    }
    camState = '';
    setCamState('requesting');
    refs.meterFill.style.transform = SCALE_X[0];
    refs.holdFill.style.transform = SCALE_X[0];
    refs.meterPct.textContent = PCT[0];
  }

  function cameraReadyNow() {
    if (camFired) return;
    camFired = true;
    setCamState('go');
    emit('cameraReady', { players: playerCount, mode });
  }

  // 0 nobody / 1 partly in frame / 2 standing in the other player's half / 3 ready
  function playerStatus(p, res) {
    const cp = camP[p];
    const up = camUp[p];
    if (!res || up < 0.12) return 0;
    if (up < (cp.ready ? cfg.readyThreshold - 0.08 : cfg.readyThreshold)) return 1;
    if (playerCount === 2) {
      const cx = centreOf(res);
      if (cx >= 0) {
        const lim = cp.ready ? 0.57 : 0.5; // a ready player near the middle does not flip back and forth
        if (p === 0 ? cx > lim : cx < 1 - lim) return 2;
      }
    }
    return 3;
  }

  function paintCamPlayer(p, res, n) {
    const v = camView;
    const ctx = v.ctx;
    const W = v.W;
    const H = v.H;
    const cp = camP[p];
    const slotX = n === 2 ? W * (p === 0 ? 0.27 : 0.73) : W * 0.5;
    const lms = res ? res.landmarks : null;
    if (lms && lms.length >= 29) {
      projectLandmarks(v, lms);
      const col = n === 2 ? PLAYER_COLORS[p] : camUp[p] < UPPER_LOW ? C_CORAL : C_TEAL;
      ctx.globalAlpha = n === 2 && !cp.ready ? 0.62 : 1;
      paintSkeleton(v, true, null, col);
      ctx.globalAlpha = 1;
      if (n === 2 && VS[V_HEAD_R] > 0) paintTag(v, PLAYER_TAGS[p], col, LM_XY[0], LM_XY[1] - VS[V_HEAD_R] * 1.5);
    } else if (res && res.pose) {
      if (n === 2) {
        drawPictogram(ctx, res.pose, slotX, H * 0.52, H * 0.82, CAM_FIG_OPTS[p]);
        paintTag(v, PLAYER_TAGS[p], PLAYER_COLORS[p], slotX, H * 0.15);
      } else {
        drawPictogram(ctx, res.pose, v.cx, v.cy, v.figS, camUp[p] < UPPER_LOW ? PLAYER_LOW_OPTS : PLAYER_OPTS);
      }
    } else if (n === 2) {
      // "stand here": an upper body filling the slot, cut off at the hips by the frame
      drawPictogram(ctx, DECO.idle, slotX, H * 0.625, H * 1.5, GUIDE_OPTS);
    } else {
      drawPictogram(ctx, DECO.idle, slotX, H * 0.656, H * 1.88, GUIDE_OPTS);
    }
  }

  // STAR SLASH camera setup (always one player): neutral skeleton, a mark on each hand, and a
  // guide figure that holds both hands up where they have to be seen
  function paintCamSlash(res) {
    const v = camView;
    const ctx = v.ctx;
    const lms = res ? res.landmarks : null;
    if (lms && lms.length >= 29) {
      projectLandmarks(v, lms);
      paintSkeleton(v, true, null, camUp[0] < UPPER_LOW ? C_CORAL : C_SLASH_BONE);
      paintHands(v, 1);
    } else if (res && res.pose) {
      drawPictogram(ctx, res.pose, v.cx, v.cy, v.figS, camUp[0] < UPPER_LOW ? PLAYER_LOW_OPTS : SLASH_FIG_OPTS);
      paintFigureHands(v, 1);
    } else {
      drawPictogram(ctx, DECO.guard, v.W * 0.5, v.H * 0.656, v.H * 1.88, GUIDE_OPTS);
    }
  }

  function updateCameraScreen(video, r0, r1) {
    const now = performance.now();
    const dt = CAMT[C_LAST] ? Math.min(100, now - CAMT[C_LAST]) : 16;
    CAMT[C_LAST] = now;
    const n = playerCount;
    const k = Math.min(1, dt / 140);
    camUp[0] += (upperOf(r0) - camUp[0]) * k;
    camUp[1] += ((n === 2 ? upperOf(r1) : 0) - camUp[1]) * k;

    let live = false;
    if (camView.ok) {
      live = paintBackdrop(camView, video);
      if (mode === 'slash') {
        paintCamSlash(r0);
      } else {
        paintCamPlayer(0, r0, n);
        if (n === 2) paintCamPlayer(1, r1, n);
      }
    } else {
      live = isLive(video);
    }
    if (camError || camFired) return;

    let allReady = true;
    let anyReady = false;
    let maxUp = 0;
    for (let p = 0; p < n; p++) {
      const cp = camP[p];
      setChip(p, playerStatus(p, p === 0 ? r0 : r1));
      if (cp.ready) anyReady = true;
      else allReady = false;
      if (camUp[p] > maxUp) maxUp = camUp[p];
      if (n === 2) {
        const bq = (camUp[p] * 100 + 0.5) | 0;
        if (bq !== cp.barQ) {
          cp.barQ = bq;
          cp.fill.style.transform = SCALE_X[bq];
        }
      }
    }

    if (!live && !r0 && !r1) {
      setCamState('requesting');
    } else if (allReady) {
      setCamState('ready');
      CAMT[C_HOLD] += dt;
    } else {
      setCamState(anyReady || maxUp > 0.3 ? 'almost' : 'searching');
      CAMT[C_HOLD] = Math.max(0, CAMT[C_HOLD] - dt * 2);
    }
    refreshCamStatus(false);

    if (n === 1) {
      const mq = (camUp[0] * 100 + 0.5) | 0;
      if (mq !== meterQ) {
        meterQ = mq;
        refs.meterFill.style.transform = SCALE_X[mq];
      }
      if (mq !== meterPctShown) {
        meterPctShown = mq;
        refs.meterPct.textContent = PCT[mq];
      }
    }
    const hq = (clamp01(CAMT[C_HOLD] / cfg.readyHoldMs) * 100 + 0.5) | 0;
    if (hq !== holdQ) {
      holdQ = hq;
      refs.holdFill.style.transform = SCALE_X[hq];
    }
    if (CAMT[C_HOLD] >= cfg.readyHoldMs) cameraReadyNow();
  }

  // -- 1P "나" panel: mirrored camera (or a figure in demo) with per-limb match colours ----------

  let tileDemo = null;
  let tileWarn = false;
  let tileLowSince = 0;
  let tileEmpty = false; // STAR SLASH without a camera and without a figure: the panel explains itself

  function updateTile(video, res) {
    const ui = PU[0];
    const s = ui.sync;
    const now = performance.now();
    const synced = now - s.at < SYNC_STALE_MS;
    let live = false;
    let up = 1;

    if (tileView.ok) {
      const v = tileView;
      live = paintBackdrop(v, video);
      if (res) up = upperOf(res);
      else if (live) up = 0;
      const lms = res ? res.landmarks : null;
      if (lms && lms.length >= 29) {
        projectLandmarks(v, lms);
        paintSkeleton(v, false, synced ? s : null, up < UPPER_LOW ? C_CORAL : C_TEAL);
      } else if (res && res.pose) {
        if (synced) {
          resolveFigure(ui, res, true);
          drawPictogram(v.ctx, ui.figPose, v.cx, v.cy, v.figS, ui.figOpts);
        } else {
          drawPictogram(v.ctx, res.pose, v.cx, v.cy, v.figS, up < UPPER_LOW ? PLAYER_LOW_OPTS : PLAYER_OPTS);
        }
      }
    } else {
      live = isLive(video);
      if (res) up = upperOf(res);
      else if (live) up = 0;
    }

    if (tileMeterView.ok) {
      const mc = tileMeterView.ctx;
      mc.setTransform(1, 0, 0, 1, 0, 0);
      mc.clearRect(0, 0, tileMeterView.W, tileMeterView.H);
      paintMeter(mc, tileMeter, s, synced && !!res);
    }

    const demo = !live;
    if (demo !== tileDemo) {
      tileDemo = demo;
      refs.tileTag.textContent = demo ? 'DEMO' : '나';
      refs.tile.classList.toggle('is-demo', demo);
    }
    let warn = false;
    if (live && up < UPPER_LOW) {
      if (!tileLowSince) tileLowSince = now;
      warn = now - tileLowSince > 700;
    } else {
      tileLowSince = 0;
    }
    if (warn !== tileWarn) {
      tileWarn = warn;
      refs.tile.classList.toggle('is-warn', warn);
    }
  }

  // STAR SLASH uses the same panel, smaller: no match colours and no sync meter (there is no pose
  // to copy), a neutral skeleton and one mark per hand in the hand colours. Its own function, so
  // that the dance panel above stays exactly the code it was.
  function updateTileSlash(video, res) {
    const now = performance.now();
    let live = false;
    let up = 1;

    if (tileView.ok) {
      const v = tileView;
      live = paintBackdrop(v, video);
      if (res) {
        measureUpper(res);
        up = RET[0];
      } else if (live) {
        up = 0;
      }
      const lms = res ? res.landmarks : null;
      if (lms && lms.length >= 29) {
        projectLandmarks(v, lms);
        paintSkeleton(v, false, null, up < UPPER_LOW ? C_CORAL : C_SLASH_BONE);
        paintHands(v, 0);
      } else if (res && res.pose) {
        drawPictogram(v.ctx, res.pose, v.cx, v.cy, v.figS, up < UPPER_LOW ? PLAYER_LOW_OPTS : SLASH_FIG_OPTS);
        paintFigureHands(v, 0);
      }
    } else {
      live = isLive(video);
      if (res) {
        measureUpper(res);
        up = RET[0];
      } else if (live) {
        up = 0;
      }
    }

    const demo = !live;
    if (demo !== tileDemo) {
      tileDemo = demo;
      refs.tileTag.textContent = demo ? (input === 'keys' ? (touch ? 'TOUCH' : 'KEYBOARD') : 'DEMO') : '나';
      refs.tile.classList.toggle('is-demo', demo);
    }
    // no camera and no figure to draw: the panel says what it is for
    const empty = demo && !(res && (res.pose || res.landmarks));
    if (empty !== tileEmpty) {
      tileEmpty = empty;
      refs.tile.classList.toggle('is-empty', empty);
    }
    let warn = false;
    if (live && up < UPPER_LOW) {
      if (!tileLowSince) tileLowSince = now;
      warn = now - tileLowSince > 700;
    } else {
      tileLowSince = 0;
    }
    if (warn !== tileWarn) {
      tileWarn = warn;
      refs.tile.classList.toggle('is-warn', warn);
    }
  }

  // -- 2P live cards: a small figure of each player's current pose + their sync meter ------------

  function updateCard(ui, res) {
    const cv = ui.cardView;
    const s = ui.sync;
    const now = performance.now();
    const up = res ? upperOf(res) : 0;
    if (cv.ok) {
      const ctx = cv.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, cv.W, cv.H);
      const synced = now - s.at < SYNC_STALE_MS;
      if (res && res.pose) {
        resolveFigure(ui, res, synced);
        drawPictogram(ctx, ui.figPose, cv.figX, cv.figY, cv.figS, synced ? ui.figOpts : ui.plainOpts);
      } else {
        drawPictogram(ctx, DECO.idle, cv.figX, cv.figY, cv.figS, GHOST_OPTS);
      }
      paintMeter(ctx, ui.cardMeter, s, synced && !!res);
    }
    let lost = false;
    if (up < UPPER_LOW) {
      if (!ui.cardLowSince) ui.cardLowSince = now;
      lost = now - ui.cardLowSince > 700;
    } else {
      ui.cardLowSince = 0;
    }
    if (lost !== ui.cardLost) {
      ui.cardLost = lost;
      ui.card.classList.toggle('is-lost', lost);
      ui.pcam.classList.toggle('is-lost', lost);
    }
  }

  // -- 2P camera tiles: each player's own crop of the shared camera picture ----------------------

  function updatePcam(ui, video, res) {
    const live = isLive(video);
    if (live !== ui.pcamShown) {
      ui.pcamShown = live;
      ui.pcam.classList.toggle('is-off', !live); // no camera: the tile explains instead of showing
    }
    const v = ui.pcamView;
    if (!live || !v.ok) return;
    const ctx = v.ctx;
    const W = v.W;
    const H = v.H;
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    // a window as tall as the picture, with the tile's shape, that follows the player sideways
    let cropH = srcH;
    let cropW = cropH * (W / H);
    if (cropW > srcW) { cropW = srcW; cropH = cropW * (H / W); }
    let want = ui.index === 0 ? 0.27 : 0.73;
    if (res && res.cx === res.cx && res.cx !== undefined) want = res.cx;
    ui.pcamCx += (want - ui.pcamCx) * 0.1;
    let left = ui.pcamCx * srcW - cropW * 0.5; // left edge in MIRRORED picture pixels
    if (left < 0) left = 0;
    if (left > srcW - cropW) left = srcW - cropW;
    const cropY = (srcH - cropH) * 0.5;
    const rawX = srcW - (left + cropW);        // the same window in the raw (un-mirrored) picture
    VS[V_CROP_X] = cfg.landmarksMirrored ? left : rawX;
    VS[V_CROP_Y] = cropY;
    VS[V_CROP_W] = cropW;
    VS[V_CROP_H] = cropH;
    VS[V_SRC_W] = srcW;
    VS[V_SRC_H] = srcH;

    ctx.globalAlpha = 1;
    ctx.setTransform(-1, 0, 0, 1, W, 0); // mirror, like looking into a mirror
    ctx.drawImage(video, rawX, cropY, cropW, cropH, 0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(20,8,60,0.16)';
    ctx.fillRect(0, 0, W, H);

    const lms = res ? res.landmarks : null;
    if (lms && lms.length >= 29) {
      const s = ui.sync;
      const synced = performance.now() - s.at < SYNC_STALE_MS;
      projectLandmarks(v, lms);
      paintSkeleton(v, false, synced ? s : null, upperOf(res) < UPPER_LOW ? C_CORAL : PLAYER_COLORS[ui.index]);
    }
  }

  /**
   * Called every frame by the game loop on the camera and play screens.
   * `results` is the tracker's [r0, r1] (a slot is null when nobody is there); a single result
   * object, as in v1, is still accepted and means player 0. No allocation, no layout access.
   */
  function drawPlayer(videoEl, results) {
    let r0 = null;
    let r1 = null;
    if (Array.isArray(results)) {
      r0 = results[0] || null;
      r1 = results[1] || null;
    } else if (results) {
      r0 = results;
    }
    if (screen === 'camera') {
      updateCameraScreen(videoEl, r0, r1);
    } else if (screen === 'play' || screen === 'countdown' || screen === 'pause') {
      if (playerCount === 2) {
        updateCard(PU[0], r0);
        updateCard(PU[1], r1);
        updatePcam(PU[0], videoEl, r0);
        updatePcam(PU[1], videoEl, r1);
      } else if (mode === 'slash') {
        updateTileSlash(videoEl, r0);
      } else {
        updateTile(videoEl, r0);
      }
    }
  }

  // -- decorative canvases -----------------------------------------------------

  const fig = { canvas: refs.loadFig, ctx: refs.loadFig.getContext('2d'), ok: false };
  const figPose = blankPose();
  const tmpPose = blankPose();
  const FIG_OPTS = { color: C_WHITE, accent: C_TEAL, glow: 0, glowColor: 'rgba(106,61,240,0.9)' };

  function drawLoadingFigure(now) {
    if (!fig.ok) return;
    const W = fig.canvas.width;
    const H = fig.canvas.height;
    const step = 820;
    const t = now / step;
    const i = Math.floor(t) % LOADING_SEQ.length;
    const k = easeInOut(clamp01((t - Math.floor(t)) / 0.42));
    mixPose(figPose, LOADING_SEQ[i], LOADING_SEQ[(i + 1) % LOADING_SEQ.length], k);
    fig.ctx.clearRect(0, 0, W, H);
    FIG_OPTS.glow = H * 0.09;
    drawPictogram(fig.ctx, figPose, W / 2, H / 2, H * 0.84, FIG_OPTS);
  }

  const HOWTO_DIM_OPTS = { color: '#cfc6ff', accent: '#cfc6ff' };
  const HOWTO_ECHO_OPTS = { color: '#bfb4ff', accent: '#bfb4ff', outline: 'rgba(11,6,32,0.4)', alpha: 0.42 };

  function drawHowto() {
    for (let n = 0; n < 3; n++) {
      const c = refs['how' + n];
      if (!sizeCanvas(c)) continue;
      const g = c.getContext('2d');
      const W = c.width;
      const H = c.height;
      g.clearRect(0, 0, W, H);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (n === 0) {
        // upper body inside a viewfinder: the frame cuts the legs off, and that is fine
        const m = H * 0.1;
        const k = H * 0.2;
        g.save();
        g.beginPath();
        g.rect(m, m, W - m * 2, H - m * 2);
        g.clip();
        drawPictogram(g, DECO.chest, W / 2, H * 0.66, H * 1.5, CARD_OPTS);
        g.restore();
        g.strokeStyle = C_TEAL;
        g.lineWidth = Math.max(2, H * 0.045);
        g.beginPath();
        g.moveTo(m, m + k); g.lineTo(m, m); g.lineTo(m + k, m);
        g.moveTo(W - m - k, m); g.lineTo(W - m, m); g.lineTo(W - m, m + k);
        g.moveTo(W - m, H - m - k); g.lineTo(W - m, H - m); g.lineTo(W - m - k, H - m);
        g.moveTo(m + k, H - m); g.lineTo(m, H - m); g.lineTo(m, H - m - k);
        g.stroke();
      } else if (n === 1) {
        // figure and its reflection
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = Math.max(1.5, H * 0.025);
        g.setLineDash([H * 0.06, H * 0.07]);
        g.beginPath();
        g.moveTo(W / 2, H * 0.08);
        g.lineTo(W / 2, H * 0.92);
        g.stroke();
        g.setLineDash([]);
        drawPictogram(g, DECO.sway, W * 0.27, H / 2, H * 0.74, GOLD_OPTS);
        mirrorPose(tmpPose, DECO.sway);
        drawPictogram(g, tmpPose, W * 0.73, H / 2, H * 0.74, HOWTO_DIM_OPTS);
      } else {
        // follow window: the pose still scores a moment after it appeared (faint "just now" echo)
        const s = H * 0.8;
        g.save();
        g.shadowColor = C_GOLD;
        g.shadowBlur = H * 0.12;
        g.strokeStyle = C_GOLD;
        g.lineWidth = Math.max(2, H * 0.04);
        roundRectPath(g, W / 2 - s * 0.42, H / 2 - s / 2, s * 0.84, s, s * 0.14);
        g.stroke();
        g.restore();
        drawPictogram(g, DECO.hips, W / 2 - H * 0.13, H / 2, H * 0.6, HOWTO_ECHO_OPTS);
        drawPictogram(g, DECO.hips, W / 2 + H * 0.05, H / 2, H * 0.66, GOLD_OPTS);
      }
    }
    drawHowtoSlash();
  }

  // a glowing dot (how-to icons only: shadows are fine here, nothing of this runs per frame)
  function glowDot(g, x, y, r, color) {
    g.save();
    g.shadowColor = color;
    g.shadowBlur = r * 2.4;
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, 6.283185307179586);
    g.fill();
    g.restore();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(x, y, r * 0.45, 0, 6.283185307179586);
    g.fill();
  }

  // the outline of a star shard: a five-sided crystal standing on its narrow end
  function shardPath(g, cx, cy, r) {
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r * 0.82, cy - r * 0.34);
    g.lineTo(cx + r * 0.46, cy + r);
    g.lineTo(cx - r * 0.46, cy + r);
    g.lineTo(cx - r * 0.82, cy - r * 0.34);
    g.closePath();
  }

  // The three how-to icons of the STAR SLASH side of the title (drawn only while that side is
  // showing: a hidden canvas has no size).
  function drawHowtoSlash() {
    for (let n = 0; n < 3; n++) {
      const c = refs['sHow' + n];
      if (!sizeCanvas(c)) continue;
      const g = c.getContext('2d');
      const W = c.width;
      const H = c.height;
      g.clearRect(0, 0, W, H);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (n === 0) {
        // both hands inside the viewfinder, each marked in its own colour
        const m = H * 0.1;
        const k = H * 0.2;
        g.save();
        g.beginPath();
        g.rect(m, m, W - m * 2, H - m * 2);
        g.clip();
        drawPictogram(g, DECO.guard, W / 2, H * 0.66, H * 1.4, HOWTO_DIM_OPTS);
        g.restore();
        const lx = J[J_LWR * 2];
        const ly = J[J_LWR * 2 + 1];
        const rx = J[J_RWR * 2];
        const ry = J[J_RWR * 2 + 1];
        glowDot(g, lx, ly, H * 0.075, HAND_COLORS[0]);
        glowDot(g, rx, ry, H * 0.075, HAND_COLORS[1]);
        g.strokeStyle = C_TEAL;
        g.lineWidth = Math.max(2, H * 0.045);
        g.beginPath();
        g.moveTo(m, m + k); g.lineTo(m, m); g.lineTo(m + k, m);
        g.moveTo(W - m - k, m); g.lineTo(W - m, m); g.lineTo(W - m, m + k);
        g.moveTo(W - m, H - m - k); g.lineTo(W - m, H - m); g.lineTo(W - m - k, H - m);
        g.moveTo(m + k, H - m); g.lineTo(m, H - m); g.lineTo(m, H - m - k);
        g.stroke();
      } else if (n === 1) {
        // a star shard with its cut line, and the hand's comet trail sweeping along that line
        const cx = W * 0.5;
        const cy = H * 0.5;
        const r = H * 0.33;
        const ux = 0.86; // direction of the cut: up and to the right
        const uy = -0.5;
        const body = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
        body.addColorStop(0, 'rgba(169,139,255,0.95)');
        body.addColorStop(0.55, 'rgba(74,43,168,0.95)');
        body.addColorStop(1, 'rgba(26,15,74,0.95)');
        shardPath(g, cx, cy, r);
        g.fillStyle = body;
        g.fill();
        // facets
        g.strokeStyle = 'rgba(246,241,255,0.3)';
        g.lineWidth = Math.max(1, H * 0.014);
        g.beginPath();
        g.moveTo(cx, cy - r); g.lineTo(cx - r * 0.2, cy + r * 0.1); g.lineTo(cx - r * 0.46, cy + r);
        g.moveTo(cx - r * 0.2, cy + r * 0.1); g.lineTo(cx - r * 0.82, cy - r * 0.34);
        g.moveTo(cx, cy - r); g.lineTo(cx + r * 0.3, cy + r * 0.2); g.lineTo(cx + r * 0.46, cy + r);
        g.moveTo(cx + r * 0.3, cy + r * 0.2); g.lineTo(cx + r * 0.82, cy - r * 0.34);
        g.stroke();
        shardPath(g, cx, cy, r);
        g.strokeStyle = 'rgba(207,198,255,0.9)';
        g.lineWidth = Math.max(1.5, H * 0.026);
        g.stroke();
        // comet trail: three passes, wide and faint to thin and bright, ending in the head
        const tx = cx + ux * r * 1.3;
        const ty = cy + uy * r * 1.3;
        const sx = cx - ux * r * 1.3;
        const sy = cy - uy * r * 1.3;
        for (let pass = 0; pass < 3; pass++) {
          g.strokeStyle = pass === 2 ? '#eafffd' : C_TEAL;
          g.globalAlpha = pass === 0 ? 0.22 : pass === 1 ? 0.55 : 1;
          g.lineWidth = H * (pass === 0 ? 0.13 : pass === 1 ? 0.07 : 0.03);
          g.beginPath();
          g.moveTo(W * 0.06 + pass * H * 0.05, H * 0.93 - pass * H * 0.03);
          g.quadraticCurveTo(sx - H * 0.05, sy + H * 0.12, sx, sy);
          g.lineTo(tx, ty);
          g.stroke();
        }
        g.globalAlpha = 1;
        glowDot(g, tx, ty, H * 0.07, C_TEAL);
        // the cut line itself, on the face of the shard, with a chevron pointing the way
        g.save();
        g.shadowColor = '#ffffff';
        g.shadowBlur = H * 0.08;
        g.strokeStyle = '#ffffff';
        g.lineWidth = Math.max(2, H * 0.036);
        g.beginPath();
        g.moveTo(cx - ux * r * 0.62, cy - uy * r * 0.62);
        g.lineTo(cx + ux * r * 0.62, cy + uy * r * 0.62);
        g.stroke();
        g.restore();
      } else {
        // the multiplier ring: five of eight hits done, x3 in the middle
        const cx = W / 2;
        const cy = H / 2;
        const r = H * 0.35;
        const step = 6.283185307179586 / MRING_STEPS;
        g.lineWidth = Math.max(2, H * 0.085);
        for (let i = 0; i < MRING_STEPS; i++) {
          const lit = i < 5;
          g.save();
          if (lit) {
            g.shadowColor = C_GOLD;
            g.shadowBlur = H * 0.09;
          }
          g.strokeStyle = lit ? C_GOLD : 'rgba(246,241,255,0.22)';
          g.beginPath();
          g.arc(cx, cy, r, -1.5707963267948966 + i * step + 0.13, -1.5707963267948966 + (i + 1) * step - 0.13);
          g.stroke();
          g.restore();
        }
        g.fillStyle = '#fff3c4';
        g.font = '900 ' + Math.round(H * 0.27) + 'px ' + FONT_DISPLAY;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('×3', cx, cy + H * 0.02);
      }
    }
  }

  // CSS sizes the burst box and its biggest word in --u; keep these two in step with css/style.css
  const RATING_BOX_U = 27;
  const RATING_WORD_U = 4.4;

  // "PERFECT" is the widest word of the burst. If the display face runs wider than planned
  // (or a fallback face is in use) shrink it so the word never leaves its side of the screen.
  function fitRatingWord() {
    let fit = 1;
    try {
      const g = L.ctx;
      g.save();
      g.font = '900 100px ' + FONT_DISPLAY;
      const em = g.measureText('PERFECT').width / 100 - 0.035 * 7;
      g.restore();
      if (em > 0) fit = Math.max(0.62, Math.min(1, (RATING_BOX_U * 0.93) / (em * RATING_WORD_U)));
    } catch (e) {
      fit = 1;
    }
    if (root.style && typeof root.style.setProperty === 'function') {
      root.style.setProperty('--rfit', String(Math.round(fit * 1000) / 1000));
    }
  }

  // The "+1,400" that flies from each player's burst into their score needs the on-screen
  // distance between the two. Measured here (layout time), never while playing.
  function layoutPlayGeometry() {
    for (let p = 0; p < 2; p++) {
      const ui = PU[p];
      halt(ui.a.fly);
      let dx = 0;
      let dy = 0;
      let lift = 0;
      const rt = ui.rating;
      const sw = ui.scoreWrap;
      if (typeof rt.getBoundingClientRect === 'function' && typeof sw.getBoundingClientRect === 'function') {
        const a = rt.getBoundingClientRect();
        const b = sw.getBoundingClientRect();
        if (a && b && a.width > 0 && b.width > 0) {
          // .fly is set at 1.9u (the digits it sits on at 2.9u - 3.2u)
          let fs = b.height * 0.6;
          if (typeof window.getComputedStyle === 'function') {
            const v = parseFloat(window.getComputedStyle(ui.fly).fontSize);
            if (v > 0) fs = v;
          }
          dx = a.left + a.width * 0.5 - (b.left + b.width * 0.5);
          // It pops just under the burst box (beside the avatar's head, clear of the word and
          // of "스타 무브" stack above it): even at its biggest (1.45x) its top edge stays below the box.
          lift = fs * 0.3;
          dy = a.top + a.height + fs * 0.925 + lift - (b.top + b.height * 0.5);
        }
      }
      const from = 'translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px) ';
      const hang = 'translate(' + dx.toFixed(1) + 'px, ' + (dy - lift).toFixed(1) + 'px) ';
      ui.a.fly = makeAnim(ui.fly, [
        { opacity: 0, transform: from + 'scale(0.5)', easing: 'cubic-bezier(.2,.9,.3,1)' },
        { opacity: 1, transform: hang + 'scale(1.45)', offset: 0.16 },
        { opacity: 1, transform: hang + 'scale(1.25)', offset: 0.4, easing: 'cubic-bezier(.6,0,.8,.4)' },
        { opacity: 1, transform: 'translate(0px, 0px) scale(0.8)', offset: FLY_ARRIVE_MS / FLY_MS },
        { opacity: 0, transform: 'translate(0px, 0px) scale(0.55)' },
      ], { duration: FLY_MS, easing: 'linear' });
    }
  }

  function canvasesReady() {
    if (!camView.ok || !fig.ok || layoutPlayers !== playerCount || layoutMode !== mode) return false;
    if (mode === 'slash') return tileView.ok; // no lane and no sync meter in STAR SLASH
    if (!L.ok) return false;
    return playerCount === 2 ? PU[0].cardView.ok && PU[1].cardView.ok : tileView.ok && tileMeterView.ok;
  }

  // Where a STAR SLASH pop may be centred so that it never leaves the screen. Measured at
  // layout time; slashPop() only reads these numbers.
  const popBox = { w: 0, h: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };

  function layoutPops() {
    const w = +root.clientWidth || 0;
    const h = +root.clientHeight || 0;
    const u = Math.min(w / 100, h / 56.25); // the CSS unit --u in pixels
    popBox.w = w;
    popBox.h = h;
    popBox.minX = u * 5.5;
    popBox.maxX = w - u * 5.5;
    popBox.minY = u * 6.5;
    popBox.maxY = h - u * 1.5;
  }

  function layout() {
    if (destroyed) return;
    dpr = Math.min(cfg.maxDpr, window.devicePixelRatio || 1);
    layoutLane();
    layoutView(tileView);
    layoutView(camView);
    layoutView(PU[0].pcamView);
    layoutView(PU[1].pcamView);
    layoutMeters();
    fig.ok = sizeCanvas(fig.canvas);
    drawHowto();
    fitRatingWord();
    layoutPlayGeometry();
    layoutPops();
    layoutPlayers = playerCount;
    layoutMode = mode;
  }

  let layoutQueued = false;
  function queueLayout() {
    if (layoutQueued || destroyed) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layout();
    });
  }

  // ---- loading -------------------------------------------------------------

  let loadQ = -1;
  let loadTextShown = '';

  function setLoading(progress01, text) {
    const p = clamp01(+progress01 || 0);
    const q = Math.round(p * 200);
    if (q !== loadQ) {
      loadQ = q;
      refs.loadFill.style.transform = 'scaleX(' + q / 200 + ')';
      refs.loadPct.textContent = Math.round(p * 100) + '%';
    }
    if (text != null && text !== loadTextShown) {
      loadTextShown = String(text);
      refs.loadText.textContent = loadTextShown;
    }
    // the pose model may still be loading while the camera screen is up
    if (screen === 'camera' && !camError && camState === 'requesting' && text != null) {
      refs.camStatus.textContent = String(text) + ' ' + Math.round(p * 100) + '%';
    }
  }

  // ---- score / combo ---------------------------------------------------------

  function fmtMult(m) {
    return Number.isInteger(Math.round(m * 100) / 10) ? m.toFixed(1) : m.toFixed(2);
  }

  // The combo counter punches on every hit and shatters on a miss.
  function applyCombo(ui, combo) {
    const c = Math.max(0, Math.round(+combo || 0));
    if (c === ui.lastCombo) return;
    const a = ui.a;
    const show = c >= 2;
    if (show) {
      ui.comboNum.textContent = String(c);
      halt(a.comboBreak);
      if (c > ui.lastCombo) {
        replay(a.combo);
        replay(a.comboBurst);
      }
    } else if (ui.comboOn) {
      ui.comboNum.textContent = String(c); // never leave the old streak on screen while it fades
      replay(a.comboBreak);
    }
    if (show !== ui.comboOn) {
      ui.comboOn = show;
      ui.combo.classList.toggle('is-on', show);
    }
    ui.combo.classList.toggle('is-hot', c >= 10);
    ui.lastCombo = c;
  }

  // the rolling digits of one player's score
  function applyDigits(ui, score) {
    let s = Math.round(+score || 0);
    if (s < 0) s = 0;
    if (s > 9999999) s = 9999999;
    if (s !== ui.lastScore) {
      for (let i = 0; i < 7; i++) {
        const d = Math.floor(s / POW10[i]) % 10;
        if (d !== ui.digitCur[i]) {
          ui.digitCur[i] = d;
          ui.stripEls[i].style.transform = DIGIT_T[d];
        }
        const dim = s < POW10[i] && i !== 6;
        if (dim !== ui.digitDim[i]) {
          ui.digitDim[i] = dim;
          ui.digitEls[i].classList.toggle('is-dim', dim);
        }
      }
      // while points are flying in, their landing does the bump
      if (s > ui.lastScore && performance.now() > ui.flyUntil) replay(ui.a.score);
      ui.lastScore = s;
    }
  }

  /**
   * setScore(score, combo, multiplier, player = 0)
   * In STAR SLASH this also works (score, combo and the number inside the multiplier ring);
   * setSlashScore() additionally carries the accuracy and the progress toward the next step.
   */
  function setScore(score, combo, multiplier, player) {
    const ui = playerUi(player);
    applyDigits(ui, score);
    applyCombo(ui, combo);

    const m = multiplier == null ? 1 : Math.round(+multiplier * 100) / 100;
    if (m !== ui.lastMult) {
      ui.lastMult = m;
      ui.mult = m;
      ui.comboMult.textContent = '×' + fmtMult(m);
      ui.comboMult.classList.toggle('is-boost', m > 1.001);
    }
    if (mode === 'slash' && ui === PU[0]) applySlashMult(multiplier, null);
  }

  // ---- STAR SLASH: score line, multiplier ring, accuracy, rating pops ---------------------

  // what is on screen right now, as integers: every write below is guarded by a comparison
  const SL = {
    multQ: 0, // multiplier x 100 (0 = nothing shown yet)
    tier: -1, // 1..4: the ring's colour step
    fill: -1, // lit segments of the ring, 0..MRING_STEPS
    maxed: false,
    accQ: -2, // accuracy in whole percent, -1 = no value yet
  };

  // -- a shown value changed (these run when a number on screen changes, never every frame) --

  // the number in the ring (x1 .. x4), its colour step, the glow of the top multiplier, and the
  // step animations: a pop and a burst on the way up, a shudder when the streak is lost
  function showSlashMult(mq) {
    const prev = SL.multQ;
    SL.multQ = mq;
    PU[0].mult = mq / 100;
    refs.mringNum.textContent = mq % 100 === 0 && mq < 1000 ? MULT_TEXT[mq / 100] : '×' + fmtMult(mq / 100);
    let tier = (mq / 100) | 0;
    if (tier > 4) tier = 4;
    if (tier !== SL.tier) {
      SL.tier = tier;
      refs.mring.setAttribute('data-mult', DIGIT_TEXT[tier]);
    }
    const maxed = mq >= cfg.maxMultiplier * 100;
    if (maxed !== SL.maxed) {
      SL.maxed = maxed;
      refs.mring.classList.toggle('is-max', maxed);
    }
    if (prev > 0) {
      if (mq > prev) {
        replay(anims.mringUp);
        replay(anims.mringBurst);
      } else {
        replay(anims.mringDrop);
      }
    }
  }

  // how many segments of the ring are lit; a segment lighting up inside a step ticks the ring
  function showSlashFill(f, tick) {
    const grew = tick && f > SL.fill && SL.fill >= 0;
    SL.fill = f;
    refs.mring.setAttribute('data-fill', DIGIT_TEXT[f]);
    if (grew) replay(anims.mringTick);
  }

  // live accuracy in whole percent; -1 = nothing judged yet, shown as a dash
  function showSlashAcc(q) {
    SL.accQ = q;
    refs.saccNum.textContent = q < 0 ? '—' : PCT[q];
    refs.saccFill.style.transform = SCALE_X[q < 0 ? 0 : q];
  }

  // -- safe every frame: quantise, compare with what is shown, and only then show --

  // progress01: 0..1 toward the next step; null = not given (keep what is lit)
  function applySlashMult(multiplier, progress01) {
    let m = multiplier == null ? 1 : +multiplier;
    if (!(m >= 1)) m = 1;
    if (m > 99) m = 99;
    const mq = Math.round(m * 100);
    const stepped = mq !== SL.multQ;
    if (stepped) showSlashMult(mq);
    let f = SL.fill;
    if (SL.maxed) f = MRING_STEPS; // nothing left to climb: the ring stays full
    else if (progress01 != null) f = (clamp01(+progress01 || 0) * MRING_STEPS + 0.5) | 0;
    else if (stepped || f < 0) f = 0; // a new step starts empty
    if (f !== SL.fill) showSlashFill(f, !stepped);
  }

  // nothing judged yet (null, NaN or 0) shows a dash
  function applySlashAcc(accuracy01) {
    let q = -1;
    if (accuracy01 != null) {
      let a = +accuracy01;
      if (a > 1.0001) a /= 100;
      if (a > 0) q = (clamp01(a) * 100 + 0.5) | 0;
    }
    if (q !== SL.accQ) showSlashAcc(q);
  }

  /**
   * setSlashScore(score, combo, multiplier, accuracy01, multProgress01)   (STAR SLASH, one player)
   *   multiplier      1 .. 4 (the number inside the ring)
   *   accuracy01      0..1 (0..100 is accepted too); null / 0 = nothing judged yet, shown as a dash
   *   multProgress01  0..1 progress toward the next multiplier step: lights the ring's eight
   *                   segments; omitted = keep what is shown. At the top multiplier the ring is full.
   * Safe to call every frame: it only touches the DOM when a shown value changes.
   */
  function setSlashScore(score, combo, multiplier, accuracy01, multProgress01) {
    const ui = PU[0];
    applyDigits(ui, score);
    const c = Math.max(0, Math.round(+combo || 0));
    if (c !== ui.lastCombo) applyCombo(ui, c);
    applySlashMult(multiplier, multProgress01 === undefined ? null : multProgress01);
    applySlashAcc(accuracy01);
  }

  // The pool. Each pop is an anchor moved to the cut (transform only) and a body that plays one
  // of three short motions; the centring translate lives in the keyframes.
  const pops = Array.prototype.map.call(root.querySelectorAll('.spop'), (el) => {
    const body = el.querySelector('.spop__body');
    return {
      el,
      word: el.querySelector('.spop__word'),
      pts: el.querySelector('.spop__pts'),
      rating: 'perfect',
      gold: false,
      points: 0,
      // PERFECT / GOOD: pops up from the cut, hangs for a blink, floats away
      hit: makeAnim(body, [
        { opacity: 0, transform: 'translate(-50%, 35%) scale(0.5)', easing: 'cubic-bezier(.2,.9,.3,1)' },
        { opacity: 1, transform: 'translate(-50%, 0%) scale(1.16)', offset: 0.15 },
        { opacity: 1, transform: 'translate(-50%, -4%) scale(1)', offset: 0.28 },
        { opacity: 1, transform: 'translate(-50%, -22%) scale(1)', offset: 0.68, easing: 'ease-in' },
        { opacity: 0, transform: 'translate(-50%, -55%) scale(0.94)' },
      ], { duration: 620, easing: 'linear' }),
      // BAD: a short shudder, then it drops
      bad: makeAnim(body, [
        { opacity: 0, transform: 'translate(-50%, 0%) scale(1.12)' },
        { opacity: 0.95, transform: 'translate(-57%, 0%) scale(1)', offset: 0.16 },
        { opacity: 0.95, transform: 'translate(-44%, 0%) scale(1)', offset: 0.32 },
        { opacity: 0.9, transform: 'translate(-50%, 0%) scale(1)', offset: 0.48 },
        { opacity: 0.85, transform: 'translate(-50%, 0%) scale(1)', offset: 0.7, easing: 'ease-in' },
        { opacity: 0, transform: 'translate(-50%, 30%) scale(0.96)' },
      ], { duration: 440, easing: 'linear' }),
      // MISS: small and dull; it just sinks out of sight
      miss: makeAnim(body, [
        { opacity: 0, transform: 'translate(-50%, -25%) scale(1)' },
        { opacity: 0.7, transform: 'translate(-50%, 0%) scale(1)', offset: 0.22 },
        { opacity: 0.62, transform: 'translate(-50%, 12%) scale(1)', offset: 0.62, easing: 'ease-in' },
        { opacity: 0, transform: 'translate(-50%, 55%) scale(0.96)' },
      ], { duration: 380, easing: 'linear' }),
      // PERFECT and gold: a thin ring snaps outward from the cut itself
      ring: makeAnim(el.querySelector('.spop__ring'), [
        { opacity: 0.95, transform: 'scale(0.3)' },
        { opacity: 0, transform: 'scale(1.5)' },
      ], { duration: 360, easing: 'cubic-bezier(.1,.7,.2,1)' }),
    };
  });
  let popNext = 0;

  /**
   * slashPop(rating, xCss, yCss, { points, gold })   (STAR SLASH)
   * A small, fast pop where a shard was cut: the rating word and, when it scored, "+points".
   *   rating      'perfect' | 'good' | 'bad' | 'miss' (anything else counts as a miss)
   *   xCss, yCss  CSS pixels from the top-left of the HUD root (= the viewport), e.g. what the
   *               3D view's project() returns for the event's position
   * The pool holds POP_COUNT nodes: the oldest is reused, so no more than that are ever alive.
   * Per event, never per frame; transform / opacity only.
   */
  function slashPop(rating, xCss, yCss, info) {
    if (!pops.length) return;
    const name = String(rating).toLowerCase();
    const key = SLASH_WORDS[name] ? name : 'miss';
    const p = pops[popNext];
    popNext = (popNext + 1) % pops.length;
    const gold = (key === 'perfect' || key === 'good') && !!(info && info.gold);
    const points = key !== 'miss' && info && info.points != null ? Math.round(+info.points || 0) : 0;

    let x = +xCss;
    let y = +yCss;
    if (x !== x) x = popBox.w * 0.5;
    if (y !== y) y = popBox.h * 0.5;
    if (popBox.maxX > popBox.minX) x = x < popBox.minX ? popBox.minX : x > popBox.maxX ? popBox.maxX : x;
    if (popBox.maxY > popBox.minY) y = y < popBox.minY ? popBox.minY : y > popBox.maxY ? popBox.maxY : y;
    p.el.style.transform = 'translate3d(' + Math.round(x * 10) / 10 + 'px, ' + Math.round(y * 10) / 10 + 'px, 0)';

    if (key !== p.rating) {
      p.rating = key;
      p.el.setAttribute('data-rating', key);
      p.word.textContent = SLASH_WORDS[key];
    }
    if (gold !== p.gold) {
      p.gold = gold;
      p.el.classList.toggle('is-gold', gold);
    }
    if (points !== p.points) {
      p.points = points;
      p.pts.textContent = points > 0 ? '+' + fmt(points) : '';
    }

    halt(p.hit);
    halt(p.bad);
    halt(p.miss);
    replay(key === 'miss' ? p.miss : key === 'bad' ? p.bad : p.hit);
    replayIf(p.ring, key === 'perfect' || gold);
  }

  // back to the start of a run: x1 with an empty ring, no accuracy yet, no pop in flight
  function resetSlash() {
    halt(anims.mringTick);
    halt(anims.mringUp);
    halt(anims.mringBurst);
    halt(anims.mringDrop);
    SL.multQ = 0; // "nothing shown": the first value never plays a step animation
    applySlashMult(1, 0);
    applySlashAcc(null);
    for (let i = 0; i < pops.length; i++) {
      const p = pops[i];
      halt(p.hit);
      halt(p.bad);
      halt(p.miss);
      halt(p.ring);
    }
  }

  // ---- rating burst ------------------------------------------------------------

  /**
   * showRating(rating, { gold, points, player = 0, combo })
   * Layered impact on the scoring player's side: word slam, shock ring, radial streaks, edge
   * glow, points flying into the score. MISS is small, dull and quick. `combo` (optional) lets
   * the combo counter punch in the same frame even if setScore() is called later.
   * Dance mode only: STAR SLASH shows its ratings where the cut happened, with slashPop().
   */
  function showRating(rating, info) {
    if (mode === 'slash') return;
    const name = String(rating).toLowerCase();
    const key = RATING_INFO[name] ? name : 'miss';
    const def = RATING_INFO[key];
    const ui = playerUi(info ? info.player : 0);
    const a = ui.a;
    const tier = RATING_TIER[key];
    const gold = !!(info && info.gold) && tier > 0;
    const points = info && info.points != null ? Math.round(+info.points || 0) : 0;
    const now = performance.now();

    if (key !== ui.ratingShown) {
      ui.ratingShown = key;
      ui.rating.setAttribute('data-rating', key);
      ui.edge.setAttribute('data-rating', key);
      ui.ratingWord.textContent = def.word;
      ui.ratingEcho.textContent = def.word;
      ui.ratingKo.textContent = def.ko;
    }
    if (gold !== ui.ratingGold) {
      ui.ratingGold = gold;
      ui.rating.classList.toggle('is-gold', gold);
      ui.edge.classList.toggle('is-gold', gold);
    }

    halt(a.slam);
    halt(a.pop);
    halt(a.miss);
    replay(tier === 0 ? a.miss : tier === 1 ? a.pop : a.slam);
    replayIf(a.ring, tier >= 2);
    replayIf(a.edge, tier >= 1);
    replayIf(a.flash, tier >= 3 || gold);
    replayIf(a.rays, tier >= 3 || gold);
    replayIf(a.echo, tier >= 3 || gold);
    replayIf(a.ringB, tier >= 4 || gold);
    replayIf(a.sparks, gold);

    if (points > 0 && tier > 0) {
      ui.fly.textContent = '+' + fmt(points);
      if (gold !== ui.flyGold) {
        ui.flyGold = gold;
        ui.fly.classList.toggle('is-gold', gold);
      }
      replay(a.fly);
      replay(a.scoreHit);
      replay(a.scoreFlash);
      ui.flyUntil = now + FLY_MS;
    } else {
      halt(a.fly);
      halt(a.scoreHit);
      halt(a.scoreFlash);
      ui.flyUntil = 0;
    }

    if (info && info.combo != null) applyCombo(ui, info.combo);

    flashKind = gold ? 'gold' : key;
    flashAt = now;
  }

  /**
   * showCombo(player, combo): milestone banner on that player's side (main calls it at 5, 10,
   * 20, 30 …). showCombo(combo) alone means player 0.
   */
  function showCombo(player, combo) {
    let pl = player;
    let cb = combo;
    if (cb === undefined) {
      cb = pl;
      pl = 0;
    }
    const ui = playerUi(pl);
    const c = Math.max(0, Math.round(+cb || 0));
    if (c < 2) return;
    ui.bannerNum.textContent = String(c);
    if (mode === 'slash') ui.bannerSub.textContent = ui.mult > 1.001 ? '점수 ×' + (Number.isInteger(ui.mult) ? ui.mult : fmtMult(ui.mult)) : '연속 성공!';
    else ui.bannerSub.textContent = ui.mult > 1.001 ? '점수 보너스 ×' + fmtMult(ui.mult) : '연속 성공!';
    const hot = c >= 20;
    if (hot !== ui.bannerHot) {
      ui.bannerHot = hot;
      ui.banner.classList.toggle('is-hot', hot);
    }
    replay(ui.a.banner);
    if (ui.comboOn) {
      replay(ui.a.combo);
      replay(ui.a.comboBurst);
    }
  }

  // ---- live sync ---------------------------------------------------------------------

  /**
   * setSync(player, score01, perSegment): how well the player matches right now. Call every
   * frame with the live matcher's output; it only stores numbers (no DOM, no allocation). The
   * painters in drawPlayer() turn them into limb colours and the sync meter.
   *   perSegment  { spine, head, lUpperArm, … } each 0..1; segments that are missing take the
   *               overall colour. >= 0.75 teal "맞음", >= 0.45 amber "거의", below coral "다름".
   */
  function setSync(player, score01, perSegment) {
    const s = playerUi(player).sync;
    const now = performance.now();
    let dt = now - s.at;
    const fresh = !(dt >= 0 && dt < 400); // first call, or back after a pause: snap instead of easing
    if (dt > 100) dt = 100;
    s.at = now;
    const kv = fresh ? 1 : 1 - Math.exp(-dt / SYNC_VALUE_TAU);
    const kt = fresh ? 1 : 1 - Math.exp(-dt / SYNC_TONE_TAU);

    s.value += (clamp01(+score01 || 0) - s.value) * kv;
    s.state = nextSyncState(s.state, s.value);
    s.tone += (s.state * 0.5 - s.tone) * kt;

    for (let i = 0; i < SEGS.length; i++) {
      const r = perSegment ? perSegment[SEGS[i]] : undefined;
      if (r === undefined || r === null || r !== r) {
        s.has[i] = 0;
        continue;
      }
      if (!s.has[i]) {
        // the segment just (re)appeared: start from the incoming value, not from a stale one
        s.has[i] = 1;
        s.val[i] = clamp01(+r || 0);
        s.st[i] = nextSyncState(0, s.val[i]);
        s.segTone[i] = s.st[i] * 0.5;
        continue;
      }
      s.val[i] += (clamp01(+r || 0) - s.val[i]) * kv;
      const st = nextSyncState(s.st[i], s.val[i]);
      s.st[i] = st;
      s.segTone[i] += (st * 0.5 - s.segTone[i]) * kt;
    }
  }

  // ---- progress / section --------------------------------------------------------

  let progQ = -1;
  function setProgress(p01) {
    const q = Math.round(clamp01(+p01 || 0) * 1000);
    if (q === progQ) return;
    progQ = q;
    refs.progFill.style.transform = 'scaleX(' + q / 1000 + ')';
    refs.progRunner.style.transform = 'translateX(' + q / 10 + '%)';
  }

  let sectionShown = null;
  function setSection(name) {
    if (name === sectionShown) return;
    sectionShown = name;
    const key = name == null ? '' : String(name);
    refs.sectionText.textContent = SECTION_LABELS[key] || key;
    refs.sectionChip.classList.toggle('is-peak', key.indexOf('chorus') === 0);
    replay(anims.chip);
  }

  // ---- countdown ---------------------------------------------------------------------

  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }
  function clearTimers() {
    timers.forEach((id) => clearTimeout(id));
    timers.clear();
  }

  function setCount(n) {
    const go = !(n > 0);
    refs.countNum.textContent = go ? '시작!' : String(n);
    refs.countNum.classList.toggle('is-go', go);
    replay(anims.count);
    replay(anims.countRing);
  }

  function runCountdown(data) {
    clearTimers();
    if (typeof data === 'number') {
      setCount(data);
      return;
    }
    if (data && data.count != null) {
      setCount(+data.count);
      return;
    }
    const total = data && data.seconds > 0 ? Math.round(data.seconds) : 3;
    const interval = data && data.interval > 0 ? +data.interval : 1000;
    for (let i = 0; i <= total; i++) {
      const n = total - i;
      const step = () => {
        if (screen !== 'countdown') return;
        setCount(n);
        emit('countdownTick', n);
        if (n === 0) emit('countdownDone');
      };
      if (i === 0) step();
      else later(step, i * interval);
    }
  }

  // ---- results ---------------------------------------------------------------------------

  const starAnims = [];
  // count-up slots: one for the 1P block, two for the 2P columns
  const resSolo = { score: 0, acc: 0, combo: 0, shown: -1, elScore: refs.resScore, elAcc: refs.resAcc, elCombo: refs.resCombo };
  const resDuo = [0, 1].map((p) => ({
    score: 0, acc: 0, combo: 0, shown: -1, elScore: refs['duoScore' + p], elAcc: refs['duoAcc' + p], elCombo: refs['duoCombo' + p],
  }));
  const res = { active: false, t0: 0, dur: 1700, duo: false };

  function readStats(stats, order) {
    const st = stats || {};
    const counts = st.counts || {};
    const score = Math.max(0, Math.round(+st.score || 0));
    const maxScore = +st.maxScore || 0;
    let acc = st.accuracy != null ? +st.accuracy : maxScore > 0 ? score / maxScore : 0;
    if (acc > 1.0001) acc /= 100;
    acc = clamp01(acc || 0);
    const out = {
      score,
      acc,
      stars: Math.max(0, Math.min(5, Math.round(+st.stars || 0))),
      maxCombo: Math.max(0, Math.round(+(st.maxCombo != null ? st.maxCombo : st.combo) || 0)),
      counts: {},
      total: 0,
    };
    for (const r of order || RATING_ORDER) {
      out.counts[r] = Math.max(0, Math.round(+counts[r] || 0));
      out.total += out.counts[r];
    }
    return out;
  }

  // STAR SLASH stats: counts perfect / good / bad / miss, plus a rank and the difficulty played
  function readSlashStats(stats) {
    const st = stats || {};
    const out = readStats(st, SLASH_ORDER);
    const rank = typeof st.rank === 'string' ? st.rank.toUpperCase() : '';
    const a = out.acc;
    out.rank = SLASH_RANKS.indexOf(rank) >= 0 ? rank : a >= 0.92 ? 'S' : a >= 0.8 ? 'A' : a >= 0.65 ? 'B' : a >= 0.45 ? 'C' : 'D';
    if (st.stars == null) out.stars = out.score > 0 ? SLASH_RANK_STARS[out.rank] : 0;
    out.level = DIFFICULTIES.indexOf(st.difficulty) >= 0 ? st.difficulty : level;
    return out;
  }

  function isStatsLike(data) {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data)) return data.length > 0 && !!data[0] && typeof data[0] === 'object';
    return data.score !== undefined || data.counts !== undefined || data.stars !== undefined || data.accuracy !== undefined;
  }

  function lightStars(host, stars, baseDelay) {
    const els = host.querySelectorAll('.star');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const onStar = i < stars;
      el.classList.toggle('is-on', onStar);
      const fill = el.lastElementChild;
      if (onStar && fill && typeof fill.animate === 'function') {
        starAnims.push(fill.animate([
          { opacity: 0, transform: 'scale(0) rotate(-50deg)' },
          { opacity: 1, transform: 'scale(1.4) rotate(10deg)', offset: 0.6 },
          { opacity: 1, transform: 'scale(1) rotate(0deg)' },
        ], { duration: 560, delay: baseDelay + i * 240, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'backwards' }));
      }
    }
  }

  // rating-count bars: reset now, grow on the next frames
  function primeBars(prefix, st, order) {
    for (const r of order || RATING_ORDER) {
      const bar = refs[prefix + 'bar-' + r];
      bar.style.transition = 'none';
      bar.style.transform = 'scaleX(0)';
      refs[prefix + 'cnt-' + r].textContent = String(st.counts[r]);
    }
  }

  function growBars(prefix, st, order) {
    for (const r of order || RATING_ORDER) {
      const bar = refs[prefix + 'bar-' + r];
      const v = st.total > 0 ? st.counts[r] / st.total : 0;
      bar.style.transition = '';
      bar.style.transform = 'scaleX(' + (v > 0 ? Math.max(0.02, v) : 0) + ')';
    }
  }

  function startCount(slot, st) {
    slot.score = st.score;
    slot.acc = st.acc;
    slot.combo = st.maxCombo;
    slot.shown = -1;
    slot.elScore.textContent = '0';
    slot.elAcc.textContent = '0%';
    slot.elCombo.textContent = '0';
  }

  function recordBest(score) {
    const isNew = input !== 'demo' && score > best && score > 0; // a demo is nobody's record
    if (isNew) {
      best = score;
      writeBest(best, songBestKey(song));
    }
    updateBestLabel();
    return isNew;
  }

  /**
   * showResults(stats)                     one player (v1)
   * showResults([stats0, stats1])          two players: two columns, the higher score wins ("승리!"),
   *                                        equal scores are a draw ("무승부")
   * showResults(stats, { mode: 'slash' })  STAR SLASH: the one-player layout with the rank letter
   *                                        beside the stars and PERFECT / GOOD / BAD / MISS counts;
   *                                        stats = { score, counts: { perfect, good, bad, miss }, accuracy,
   *                                        maxCombo, rank: 'S'..'D', stars, difficulty? }
   * Without the second argument the results are shown for the mode the HUD is in.
   */
  function showResults(statsOrArray, opts) {
    let s0 = statsOrArray;
    let s1 = null;
    if (Array.isArray(statsOrArray)) {
      s0 = statsOrArray[0];
      s1 = statsOrArray.length > 1 ? statsOrArray[1] : null;
    }
    if (opts && (opts.mode === 'dance' || opts.mode === 'slash')) setMode(opts.mode);
    if (screen !== 'results') showScreen('results');
    clearTimers();
    starAnims.forEach((a) => a.cancel());
    starAnims.length = 0;
    if (mode === 'slash') showResultsSlash(readSlashStats(s0));
    else if (s1) showResultsDuo(readStats(s0), readStats(s1));
    else showResultsSolo(readStats(s0));
    res.t0 = performance.now() + 350;
    res.active = true;
    kick();
  }

  function showResultsSolo(st) {
    res.duo = false;
    refs.resSection.setAttribute('data-mode', 'solo');
    refs.resSection.removeAttribute('data-winner');
    refs.resEyebrow.textContent = 'STAGE CLEAR · ' + SONGS[song].title + ' — NOVA';
    refs.resTitle.textContent = RESULT_TITLES[st.stars];
    refs.resSub.textContent = '';
    const isNew = recordBest(st.score);
    refs.resNew.classList.toggle('is-on', isNew);
    refs.resBest.textContent = '최고 기록 ' + fmt(best);

    lightStars(refs.stars, st.stars, 450);
    later(() => {
      if (screen === 'results') emit('resultsStars', st.stars);
    }, 450 + st.stars * 240);

    primeBars('', st);
    refs.resAccBar.style.transition = 'none';
    refs.resAccBar.style.transform = 'scaleX(0)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        growBars('', st);
        refs.resAccBar.style.transition = '';
        refs.resAccBar.style.transform = 'scaleX(' + st.acc + ')';
      });
    });
    startCount(resSolo, st);
  }

  // STAR SLASH: the solo layout, with the rank letter as the hero beside the stars, the four
  // slash ratings in the breakdown and the best score of the difficulty that was played
  function showResultsSlash(st) {
    res.duo = false;
    refs.resSection.setAttribute('data-mode', 'solo');
    refs.resSection.removeAttribute('data-winner');
    // the keyboard keeps a record of its own (it is far more exact than a camera), a demo keeps none
    const kb = input === 'keys';
    const table = kb ? slashKeysBest : slashBest;
    const kbWord = touch ? '터치' : '키보드';
    refs.resEyebrow.textContent = 'STAGE CLEAR · STAR SLASH · ' + SONGS[song].title + ' · ' + DIFFICULTY_LABELS[st.level] + (kb ? ' · ' + kbWord : '');
    refs.resTitle.textContent = SLASH_TITLES[st.rank];
    refs.resSub.textContent = '';
    const isNew = input !== 'demo' && st.score > table[st.level] && st.score > 0;
    if (isNew) {
      table[st.level] = st.score;
      writeStored((kb ? SLASH_KEYS_BEST_KEY : SLASH_BEST_KEY) + st.level, st.score);
    }
    updateBestLabel();
    refs.resNew.classList.toggle('is-on', isNew);
    refs.resBest.textContent = DIFFICULTY_LABELS[st.level] + (kb ? ' ' + kbWord : '') + ' 최고 기록 ' + fmt(table[st.level]);

    // the rank slams in first, then the stars light up one by one
    refs.rank.setAttribute('data-rank', st.rank);
    refs.rankLetter.textContent = st.rank;
    if (typeof refs.rank.animate === 'function') {
      starAnims.push(refs.rank.animate([
        { opacity: 0, transform: 'scale(2.4) rotate(-10deg)', easing: 'cubic-bezier(.55,0,.9,.45)' },
        { opacity: 1, transform: 'scale(0.88) rotate(0deg)', offset: 0.45, easing: 'cubic-bezier(.2,.8,.3,1)' },
        { opacity: 1, transform: 'scale(1.06) rotate(0deg)', offset: 0.72 },
        { opacity: 1, transform: 'scale(1) rotate(0deg)' },
      ], { duration: 520, delay: 380, easing: 'linear', fill: 'backwards' }));
    }
    lightStars(refs.stars, st.stars, 760);
    later(() => {
      if (screen === 'results') emit('resultsStars', st.stars);
    }, 760 + st.stars * 240);

    primeBars('s', st, SLASH_ORDER);
    refs.resAccBar.style.transition = 'none';
    refs.resAccBar.style.transform = 'scaleX(0)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        growBars('s', st, SLASH_ORDER);
        refs.resAccBar.style.transition = '';
        refs.resAccBar.style.transform = 'scaleX(' + st.acc + ')';
      });
    });
    startCount(resSolo, st);
  }

  function showResultsDuo(a, b) {
    const pair = [a, b];
    const winner = a.score === b.score ? -1 : a.score > b.score ? 0 : 1;
    res.duo = true;
    refs.resSection.setAttribute('data-mode', 'duo');
    refs.resSection.setAttribute('data-winner', winner < 0 ? 'draw' : String(winner));
    refs.resEyebrow.textContent = 'STAGE CLEAR · 2인 플레이';
    if (winner < 0) {
      refs.resTitle.textContent = '무승부!';
      refs.resSub.textContent = '점수가 똑같아요. 한 판 더 어때요?';
    } else {
      refs.resTitle.textContent = PLAYER_TAGS[winner] + ' 승리!';
      refs.resSub.textContent = fmt(Math.abs(a.score - b.score)) + '점 차이로 ' + (winner === 0 ? 'P1이' : 'P2가') + ' 이겼어요';
    }
    const top = Math.max(a.score, b.score);
    const isNew = recordBest(top);
    refs.resNew.classList.toggle('is-on', false);
    refs.resBest.textContent = '최고 기록 ' + fmt(best);

    for (let p = 0; p < 2; p++) {
      const st = pair[p];
      const col = refs['duoCol' + p];
      col.classList.toggle('is-win', winner === p);
      col.classList.toggle('is-lose', winner >= 0 && winner !== p);
      col.classList.toggle('is-draw', winner < 0);
      refs['duoVerdict' + p].textContent = winner === p ? '승리!' : winner < 0 ? '무승부' : '';
      refs['duoNew' + p].classList.toggle('is-on', isNew && st.score === top);
      lightStars(refs['duoStars' + p], st.stars, 500);
      primeBars('d' + p, st);
      startCount(resDuo[p], st);
    }
    const stars = Math.max(a.stars, b.stars);
    later(() => {
      if (screen === 'results') emit('resultsStars', stars);
    }, 500 + stars * 240);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        growBars('d0', a);
        growBars('d1', b);
      });
    });
  }

  function stepCount(slot, e, done) {
    const v = done ? slot.score : Math.round(slot.score * e);
    if (v === slot.shown && !done) return;
    slot.shown = v;
    slot.elScore.textContent = fmt(v);
    slot.elAcc.textContent = Math.round(slot.acc * 100 * (done ? 1 : e)) + '%';
    slot.elCombo.textContent = String(Math.round(slot.combo * (done ? 1 : e)));
  }

  function stepResults(now) {
    const t = clamp01((now - res.t0) / res.dur);
    const e = easeOutCubic(t);
    const done = t >= 1;
    if (res.duo) {
      stepCount(resDuo[0], e, done);
      stepCount(resDuo[1], e, done);
    } else {
      stepCount(resSolo, e, done);
    }
    if (done) res.active = false;
  }

  // the title's song card: the best of the side that is showing (STAR SLASH: per difficulty)
  function updateBestLabel() {
    if (pick === 'slash') {
      // the camera record; someone who only plays on the keyboard sees that one instead
      const b = slashBest[level];
      const kb = slashKeysBest[level];
      refs.best.textContent = b > 0 ? DIFFICULTY_LABELS[level] + ' 최고 기록 ' + fmt(b)
        : kb > 0 ? DIFFICULTY_LABELS[level] + (touch ? ' 터치' : ' 키보드') + ' 최고 기록 ' + fmt(kb) : '첫 슬래시에 도전해 보세요';
    } else {
      refs.best.textContent = best > 0 ? '최고 기록 ' + fmt(best) : '첫 무대에 도전해 보세요';
    }
  }

  // ---- internal ticker (only for loading figure / results count-up) -----------------------

  let tickId = 0;
  function needTick() {
    return !destroyed && (screen === 'loading' || res.active);
  }
  function tick(now) {
    tickId = 0;
    if (screen === 'loading') drawLoadingFigure(now);
    if (res.active) stepResults(now);
    if (needTick()) tickId = requestAnimationFrame(tick);
  }
  function kick() {
    if (!tickId && needTick()) tickId = requestAnimationFrame(tick);
  }

  // ---- camera errors -------------------------------------------------------------------------

  function classifyError(kind) {
    if (kind == null || kind === false || kind === '') return '';
    if (typeof kind === 'object' && typeof kind.kind === 'string' && CAMERA_ERRORS[kind.kind]) return kind.kind;
    let s = '';
    if (typeof kind === 'string') s = kind;
    else s = [kind.kind, kind.code, kind.tag, kind.name, kind.message].filter(Boolean).join(' ');
    s = s.toLowerCase();
    if (/denied|notallowed|permission|dismiss/.test(s)) return 'denied';
    if (/nodevice|no-device|no_device|notfound|devicesnotfound|overconstrained|nocamera|no camera/.test(s)) return 'nodevice';
    if (/notreadable|trackstart|busy|in use|abort/.test(s)) return 'busy';
    if (/insecure|secure|https|unsupported|mediadevices/.test(s)) return 'insecure';
    if (/model|wasm|mediapipe|landmarker|network|fetch|load/.test(s)) return 'model';
    return 'unknown';
  }

  function setCameraError(kind) {
    const k = classifyError(kind);
    camError = k;
    if (!k) {
      refs.camSection.removeAttribute('data-error');
      return;
    }
    // Inside another app's web view the camera is usually not ours to open, whatever the error
    // says: the way out is a real browser. A missing pose model is a different story.
    const shown = device.inApp && k !== 'model' ? 'inapp' : k;
    const def = CAMERA_ERRORS[shown];
    const mob = device.mobile && shown !== 'inapp' ? CAMERA_ERRORS_MOBILE[shown] : null;
    refs.errTitle.textContent = shown === 'inapp' ? device.inApp + def.title : (mob ? mob.title : def.title);
    refs.errDesc.textContent = mob ? (mob.desc || (device.ios ? mob.ios : mob.android)) : def.desc;
    refs.camSection.setAttribute('data-error', shown);
    refs.copyLabel.textContent = '주소 복사';
    if (screen !== 'camera') showScreen('camera', { keepError: true });
    focusPrimary();
  }

  // ---- screens ------------------------------------------------------------------------------------

  function resetRun() {
    for (let p = 0; p < 2; p++) {
      const ui = PU[p];
      const a = ui.a;
      setScore(0, 0, 1, p);
      halt(a.slam);
      halt(a.pop);
      halt(a.miss);
      halt(a.echo);
      halt(a.rays);
      halt(a.ring);
      halt(a.ringB);
      halt(a.flash);
      halt(a.sparks);
      halt(a.edge);
      halt(a.comboBreak);
      halt(a.fly);
      halt(a.scoreHit);
      halt(a.scoreFlash);
      halt(a.banner);
      ui.flyUntil = 0;
      ui.cardLowSince = 0;
      ui.sync.at = -1e9; // the next setSync() snaps instead of easing from the last run
    }
    flashAt = -1e9;
    tlMoves = null;
    tlCursor = 0;
    progQ = -1;
    setProgress(0);
    tileLowSince = 0;
    resetSlash();
  }

  function modeLabel() {
    return mode === 'slash' ? '스타 슬래시' : playerCount === 2 ? '2인 플레이' : '1인 플레이';
  }

  /** One or two players. Switches the whole HUD (title -> results) between the 1P and 2P layouts. */
  function setPlayers(n) {
    const count = n === 2 || n === '2' ? 2 : 1;
    if (count === 2 && mode === 'slash') applyMode('dance'); // STAR SLASH is a one-player mode
    if (count === playerCount) return;
    playerCount = count;
    root.setAttribute('data-players', String(count));
    refs.camMode.textContent = modeLabel();
    if (screen === 'camera') resetCamera();
    layout(); // the tile / live-card canvases and the burst positions depend on the mode
  }

  // ---- game mode: dance / STAR SLASH ---------------------------------------------------------------

  const levelEls = Array.prototype.slice.call(root.querySelectorAll('.level'));

  function syncPick() {
    root.setAttribute('data-pick', pick);
    refs.tabDance.setAttribute('aria-selected', pick === 'dance' ? 'true' : 'false');
    refs.tabSlash.setAttribute('aria-selected', pick === 'slash' ? 'true' : 'false');
  }

  function syncLevel() {
    for (let i = 0; i < levelEls.length; i++) {
      const on = levelEls[i].getAttribute('data-value') === song;
      levelEls[i].classList.toggle('is-on', on);
      levelEls[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  // The title's mode switch. `byUser`: remember the choice and tell the game.
  function setPick(m, byUser) {
    const v = m === 'slash' ? 'slash' : 'dance';
    if (v === pick) return;
    pick = v;
    syncPick();
    updateBestLabel();
    drawHowto(); // the how-to list that just appeared has never had a size
    if (byUser) {
      writeStored(MODE_KEY, v);
      refs.titleSection.classList.add('is-picked'); // a switch, not an entrance: no stagger
      emit('modeChange', { mode: pick, difficulty: level, song });
    }
  }

  // everything that names the song: the title's card, the bar over the play screen, and the
  // little equaliser, which bounces at the song's tempo
  function syncSongText() {
    const sg = SONGS[song];
    refs.songTitle.textContent = sg.title + ' — ' + sg.artist + ' · ' + sg.bpm + ' BPM';
    refs.songInfo.textContent = sg.genre + ' · ' + songLength(song);
    refs.barDance.textContent = sg.title + ' — ' + sg.artist;
    refs.barSlash.textContent = 'STAR SLASH · ' + sg.title;
    root.style.setProperty('--song-beat', (60 / sg.bpm).toFixed(3) + 's');
  }

  // The song picker of the title. `byUser`: remember the choice and tell the game.
  function setSongPick(id, byUser) {
    if (!SONGS[id] || id === song) return;
    song = id;
    level = SONGS[id].level;
    best = readBest(songBestKey(song));
    syncLevel();
    syncSongText();
    updateBestLabel();
    if (byUser) {
      writeStored(SONG_KEY, id);
      emit('modeChange', { mode: pick, difficulty: level, song });
    }
  }

  // by difficulty: the song of that level
  function setLevel(d, byUser) {
    for (let i = 0; i < SONG_IDS.length; i++) {
      if (SONGS[SONG_IDS[i]].level === d) { setSongPick(SONG_IDS[i], byUser); return; }
    }
  }

  // Lays the run screens out for a mode (the title's switch is left alone).
  function applyMode(m) {
    const v = m === 'slash' ? 'slash' : 'dance';
    if (v === mode) return;
    mode = v;
    root.setAttribute('data-mode', v);
    if (v === 'slash' && playerCount !== 1) {
      playerCount = 1;
      root.setAttribute('data-players', '1');
    }
    refs.camMode.textContent = modeLabel();
    resetSlash();
    if (tileEmpty) {
      tileEmpty = false;
      refs.tile.classList.remove('is-empty');
    }
    if (screen === 'camera') resetCamera();
    layout(); // the lane, the camera panel and the burst positions depend on the mode
  }

  /**
   * setMode('dance' | 'slash'): the game mode of the run screens (camera setup, countdown, play,
   * pause, results); the title's switch follows. The mode is sticky: it stays until the next
   * setMode() / showScreen(name, { mode }) / showResults(stats, { mode }), except that asking
   * for two players or starting from the title's dance side always returns to 'dance'.
   */
  function setMode(m) {
    if (m !== 'dance' && m !== 'slash') return;
    setPick(m, false);
    applyMode(m);
  }

  /** setDifficulty('easy' | 'normal' | 'hard'): picks the song of that level (not remembered, no event). */
  function setDifficulty(d) {
    setLevel(d, false);
  }

  /** setSong(id): moves the title's song picker (not remembered, no event). */
  function setSong(id) {
    setSongPick(id, false);
  }

  /**
   * setInput('camera' | 'keys' | 'demo'): who plays the run that is about to be shown. On the
   * keyboard the camera panel carries the key legend and the hint lines name the keys; the
   * results keep a keyboard record of their own, and a demo leaves the records alone.
   */
  function setInput(kind) {
    const v = kind === 'keys' || kind === 'demo' ? kind : 'camera';
    if (v === input) return;
    input = v;
    root.setAttribute('data-input', v);
    tileDemo = null; // the panel's tag is written again
  }

  /**
   * The touch pads of a keyboard run (shown on a touch screen): one per hand, under the thumbs.
   * A touch is a cut in the direction it lies from the middle of the pad — four ways, or eight
   * when the chart has diagonal shards (setPads). The game hears on('padDown', { hand, dir }).
   */
  let padEight = false;
  const PAD_DIRS4 = ['r', 'u', 'l', 'd'];
  const PAD_DIRS8 = ['r', 'ur', 'u', 'ul', 'l', 'dl', 'd', 'dr'];
  function setPads(eight) {
    padEight = !!eight;
    if (padEight) root.setAttribute('data-pad8', ''); else root.removeAttribute('data-pad8');
  }
  function onPadDown(e) {
    const pad = e.currentTarget;
    if (input !== 'keys' || (screen !== 'play' && screen !== 'countdown')) return;
    if (e.cancelable) e.preventDefault();
    const r = pad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = (r.top + r.height / 2) - e.clientY; // up is positive
    const steps = padEight ? 8 : 4;
    const k = ((Math.round(Math.atan2(dy, dx) / (2 * Math.PI / steps)) % steps) + steps) % steps;
    const dir = padEight ? PAD_DIRS8[k] : PAD_DIRS4[k];
    emit('padDown', { hand: pad.getAttribute('data-pad'), dir });
    const hit = pad.firstElementChild;
    if (hit && typeof hit.animate === 'function') {
      const turn = 'rotate(' + (90 - k * (360 / steps)) + 'deg)';
      hit.animate([
        { opacity: 0.95, transform: turn + ' scale(0.92)' },
        { opacity: 0, transform: turn + ' scale(1.06)' },
      ], { duration: 240, easing: 'cubic-bezier(.2,.8,.3,1)' });
    }
  }
  Array.prototype.forEach.call(root.querySelectorAll('.pad'), (el) => {
    el.addEventListener('pointerdown', onPadDown);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  setTouch(device.touch);
  // a touch on a device that did not look like one (a laptop with a touch screen): pads from then on
  const onFirstTouch = () => { setTouch(true); window.removeEventListener('touchstart', onFirstTouch); };
  window.addEventListener('touchstart', onFirstTouch, { passive: true });

  /** setCameraInfo(text): the small line under the camera tips (what the camera and the detector are doing). */
  function setCameraInfo(text) {
    const t = text || '';
    if (refs.camDiag.textContent !== t) refs.camDiag.textContent = t;
  }

  // out of an in-app browser: KakaoTalk has a link for it, Android an intent; elsewhere the
  // address is copied for the player to paste into a real browser
  function openExternal() {
    const url = location.href;
    try {
      if (device.kakao) { location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url); return; }
      if (device.android) { location.href = 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=https;end'; return; }
    } catch (e) {
      /* fall through to the copy */
    }
    copyLink();
  }
  function copyLink() {
    const done = (ok) => { refs.copyLabel.textContent = ok ? '주소를 복사했어요' : '주소창의 주소를 복사해 주세요'; };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(location.href).then(() => done(true), () => done(false));
        return;
      }
    } catch (e) {
      /* no clipboard here */
    }
    done(false);
  }

  /** keyTap(code): lights the key of the legend that was just pressed (keyboard runs). */
  const keyEls = {};
  Array.prototype.forEach.call(root.querySelectorAll('.tile__keys kbd'), (el) => { keyEls[el.getAttribute('data-key')] = el; });
  function keyTap(code) {
    const el = keyEls[code];
    if (!el || typeof el.animate !== 'function') return;
    el.animate([
      { transform: 'scale(0.86)', filter: 'brightness(2.4)' },
      { transform: 'scale(1)', filter: 'brightness(1)' },
    ], { duration: 190, easing: 'cubic-bezier(.2,.8,.3,1)' });
  }

  // the how-to line of a STAR SLASH run: up for the first seconds of play, once per run
  let hintDone = false;
  function syncHint(name) {
    const a = anims.hint;
    if (!a) return;
    if (name === 'play' && mode === 'slash' && cfg.hintMs > 0) {
      if (!hintDone) {
        hintDone = true;
        replay(a);
      } else if (a.playState === 'paused') {
        a.play();
      }
    } else if (name === 'pause') {
      if (a.playState === 'running' && typeof a.pause === 'function') a.pause();
    } else {
      a.cancel(); // any other screen ends it; the next countdown arms it again
      hintDone = false;
    }
  }

  function focusPrimary() {
    const host = root.querySelector('.screen--' + screen);
    if (!host) return;
    let target = null;
    if (screen === 'camera') target = camError ? host.querySelector('.cam__error .btn--primary') : null;
    else if (screen === 'title') target = host.querySelector('.title__actions.pick-' + pick + ' .btn--primary');
    else target = host.querySelector('.btn--primary');
    if (target && typeof target.focus === 'function') {
      try {
        target.focus({ preventScroll: true });
      } catch (e) {
        /* focus is a convenience only */
      }
    }
  }

  /**
   * showScreen(name, data?)
   *   data.players  1 | 2 on any screen ('camera' | 'countdown' | 'play' are where main passes it)
   *   data.mode     'dance' | 'slash' on any screen: same as setMode() before the switch
   *   countdown     a number or { count } shows that numeral; { seconds, interval } or nothing runs 3-2-1
   *   results       a stats object or [stats0, stats1] is forwarded to showResults()
   */
  function showScreen(name, data) {
    if (SCREENS.indexOf(name) < 0) {
      console.warn('[hud] unknown screen "' + name + '"');
      return;
    }
    const prev = screen;
    const active = document.activeElement;
    if (active && root.contains(active) && typeof active.blur === 'function') active.blur();
    if (name !== 'countdown' || prev !== 'countdown') clearTimers();

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.mode === 'dance' || data.mode === 'slash') setMode(data.mode);
      // (an explicit STAR SLASH is always one player, whatever `players` says)
      if ((data.players === 1 || data.players === 2) && data.mode !== 'slash') setPlayers(data.players);
    }

    const inRun = name === 'play' || name === 'countdown' || name === 'pause';
    if (inRun && !runActive) resetRun();
    runActive = inRun;

    screen = name;
    root.setAttribute('data-screen', name);

    if (name === 'camera') {
      if (!(data && data.keepError)) setCameraError(null);
      if (prev !== 'camera') resetCamera();
    }
    if (name === 'title') {
      updateBestLabel();
      if (prev !== 'title') refs.titleSection.classList.remove('is-picked');
    }
    syncHint(name);
    if (name === 'countdown') runCountdown(data);
    if (name === 'results' && isStatsLike(data)) showResults(data);
    if (!canvasesReady()) layout();
    if (name !== 'play' && name !== 'countdown') focusPrimary();
    kick();
  }

  function pauseNow() {
    if (screen !== 'play') return;
    showScreen('pause');
    emit('pause');
  }

  function resumeNow() {
    if (screen !== 'pause') return;
    showScreen('play');
    emit('resume');
  }

  // ---- input -----------------------------------------------------------------------------------------

  // title buttons: the HUD switches its own layout right away, then tells the game. The layout
  // only changes when the event really goes out, so the HUD and the game never disagree about
  // the mode after a debounced double press.
  // The game mode travels with the event. The dance side switches the HUD back to the dance
  // layout right away; the STAR SLASH layout is only ever put up by the game (setMode /
  // showScreen(name, { mode })), so a game that ignores the new field still gets a working HUD.
  function startMode(n) {
    const slash = pick === 'slash';
    const count = !slash && n === 2 ? 2 : 1;
    if (!gate('start')) return;
    if (!slash) applyMode('dance');
    setPlayers(count);
    emit('start', { players: count, mode: pick, difficulty: level, song });
  }

  function startDemoNow() {
    // from the title the demo is a solo show; from the camera error panel it keeps the chosen mode
    const onCamera = screen === 'camera';
    const count = onCamera ? playerCount : 1;
    const m = onCamera ? mode : pick;
    if (!gate('startDemo')) return;
    if (m === 'dance') applyMode('dance');
    setPlayers(count);
    emit('startDemo', { players: count, mode: m, difficulty: level, song });
  }

  // STAR SLASH on the keyboard: no camera screen, the game goes straight to the countdown
  function startKeysNow() {
    if (DEMO_ONLY || !gate('startKeys')) return;
    setPlayers(1);
    emit('startKeys', { players: 1, mode: 'slash', difficulty: level, song });
  }

  function doAct(act, el) {
    switch (act) {
      case 'start': startMode(el && el.getAttribute('data-players') === '2' ? 2 : 1); break;
      case 'startDemo': startDemoNow(); break;
      case 'startKeys': startKeysNow(); break;
      case 'openExternal': openExternal(); break;
      case 'copyLink': copyLink(); break;
      case 'retry': fire('retry'); break;
      case 'menu': fire('menu'); break;
      case 'pause': pauseNow(); break;
      case 'resume': resumeNow(); break;
      case 'skipCamera': cameraReadyNow(); break;
      case 'retryCamera':
        setCameraError(null);
        resetCamera();
        fire('start', { players: playerCount, mode, difficulty: level, song });
        break;
      case 'pickMode': setPick(el ? el.getAttribute('data-value') : '', true); break;
      case 'pickSong': setSongPick(el ? el.getAttribute('data-value') : '', true); break;
      default: break;
    }
  }

  function onClick(e) {
    const t = e.target;
    const b = t && typeof t.closest === 'function' ? t.closest('[data-act]') : null;
    if (!b || !root.contains(b)) return;
    const host = b.closest('.screen');
    if (host && host.getAttribute('data-name') !== screen) return; // stale click on a hidden screen
    const act = b.getAttribute('data-act');
    doAct(act, b);
    // a pointer press on the mode switch or a song leaves SPACE on the start button
    // (a press made with the keyboard keeps the focus where it is)
    if ((act === 'pickMode' || act === 'pickSong') && e.detail > 0) focusPrimary();
  }

  function onKey(e) {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape' || k === 'Esc') {
      if (screen === 'play') pauseNow();
      else if (screen === 'pause') resumeNow();
      else if (screen === 'camera') fire('menu');
      else return;
      e.preventDefault();
      return;
    }
    const tag = e.target && e.target.tagName;
    if (screen === 'title') {
      // Tab and the left / right arrows work the mode switch (Shift+Tab still walks the focus)
      if (k === 'Tab' && !e.shiftKey) {
        setPick(pick === 'slash' ? 'dance' : 'slash', true);
        focusPrimary();
        e.preventDefault();
        return;
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        const dir = k === 'ArrowRight' ? 1 : -1;
        const at = e.target ? levelEls.indexOf(e.target) : -1;
        if (at >= 0) {
          // inside the song picker the arrows move within it, as in any radio group
          const i = SONG_IDS.indexOf(song) + dir;
          if (i >= 0 && i < SONG_IDS.length) {
            setSongPick(SONG_IDS[i], true);
            if (levelEls[i] && typeof levelEls[i].focus === 'function') levelEls[i].focus();
          }
        } else {
          setPick(dir > 0 ? 'slash' : 'dance', true);
          focusPrimary();
        }
        e.preventDefault();
        return;
      }
      // up / down: the previous / next song (easiest first)
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        const i = SONG_IDS.indexOf(song) + (k === 'ArrowDown' ? 1 : -1);
        if (i >= 0 && i < SONG_IDS.length) setSongPick(SONG_IDS[i], true);
        e.preventDefault();
        return;
      }
    }
    // K: STAR SLASH on the keyboard (read by position, so it works with 한/영 either way)
    if (e.code === 'KeyK' && screen === 'title' && pick === 'slash') {
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      startKeysNow();
      e.preventDefault();
      return;
    }
    if ((k === '1' || k === '2' || k === '3') && screen === 'title') {
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (pick === 'slash') setSongPick(SONG_IDS[+k - 1], true); // 1 · 2 · 3: the song (easy, normal, hard)
      else if (DEMO_ONLY || k === '3') return;
      else startMode(k === '2' ? 2 : 1);
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'Spacebar' || k === 'Enter') {
      // a focused control handles its own activation
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (screen === 'title') {
        if (DEMO_ONLY) startDemoNow();
        else startMode(1);
      } else if (screen === 'results') fire('retry');
      else if (screen === 'pause') resumeNow();
      else if (screen === 'camera' && camError) doAct('retryCamera', null);
      else return;
      e.preventDefault();
    }
  }

  root.addEventListener('click', onClick);
  if (cfg.keyboard) window.addEventListener('keydown', onKey);
  window.addEventListener('resize', queueLayout);
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(queueLayout);
    ro.observe(root);
  }
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
    // card labels are baked into sprites and the burst word is fitted to the display face:
    // redo both once the web fonts are in
    document.fonts.ready.then(() => {
      if (destroyed) return;
      clearSprites();
      fitRatingWord();
      drawHowto(); // one of the how-to icons carries a numeral in the display face
    });
  }

  function destroy() {
    destroyed = true;
    clearTimers();
    if (tickId) cancelAnimationFrame(tickId);
    root.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('touchstart', onFirstTouch);
    window.removeEventListener('resize', queueLayout);
    if (ro) ro.disconnect();
    listeners.clear();
    clearSprites();
  }

  // ---- boot ------------------------------------------------------------------------------------------

  refs.meterGoal.style.left = cfg.readyThreshold * 100 + '%';
  refs.camMode.textContent = modeLabel();
  syncPick();
  syncLevel();
  syncSongText();
  updateBestLabel();
  setProgress(0);
  layout();
  kick();

  // v2 API at a glance (every `player` is 0 | 1 and defaults to 0, so v1 callers work unchanged):
  //   on('start' | 'startDemo', ({ players, mode, difficulty, song }) => …)   on('cameraReady', ({ players, mode }) => …)
  //   on('startKeys', ({ players: 1, mode: 'slash', difficulty, song }) => …)   STAR SLASH on the keyboard (no camera screen)
  //   on('modeChange', ({ mode, difficulty, song }) => …)   the title's mode switch / song picker was used
  //   'retry' | 'menu' | 'pause' | 'resume' · on('countdownTick', n) · on('countdownDone') · on('resultsStars', stars)
  //   per frame: updateTimeline · setSync (each player) · drawPlayer   (no allocation, no layout)
  // STAR SLASH (mode 'slash', one player): setMode / showScreen(name, { mode }) put the mode up;
  //   setSlashScore (any time, also every frame) · slashPop (per judged shard) · showResults(stats, { mode })
  //   setProgress / setSection / drawPlayer as in the dance mode; updateTimeline, setSync and
  //   showRating are dance-only and do nothing visible in this mode
  return {
    showScreen, // (name, { players, mode }?)
    setLoading, // (progress01, text?)
    on, // (event, cb) -> unsubscribe
    setScore, // (score, combo, multiplier, player?)
    showRating, // (rating, { gold, points, player, combo }?)
    showCombo, // (player, combo) | (combo)
    setSync, // (player, score01, perSegment?)
    updateTimeline, // (beat, moves)
    setProgress, // (p01)
    setSection, // (name)
    drawPlayer, // (videoEl | null, [r0, r1] | result | null)
    showResults, // (stats | [stats0, stats1], { mode }?)
    setCameraError, // (kind | Error | null)
    setMode, // ('dance' | 'slash')
    setSlashScore, // (score, combo, multiplier, accuracy01, multProgress01)
    slashPop, // (rating, xCss, yCss, { points, gold }?)
    // extras (not required by the contract)
    setPlayers,
    setDifficulty, // ('easy' | 'normal' | 'hard')
    setSong, // (songId)  the title's song picker
    setInput, // ('camera' | 'keys' | 'demo')  who plays the run
    keyTap, // (KeyboardEvent.code)  a key of the legend lights up
    setPads, // (eightWay)  the touch pads of a keyboard run: four directions, or eight; on('padDown', { hand, dir })
    setCameraInfo, // (text)  small status line of the camera screen
    device, // { ios, android, mobile, inApp, kakao, touch }
    get touch() {
      return touch;
    },
    layout,
    destroy,
    get screen() {
      return screen;
    },
    get players() {
      return playerCount;
    },
    get mode() {
      return mode;
    },
    get titleMode() {
      return pick;
    },
    get difficulty() {
      return level;
    },
    get song() {
      return song;
    },
    root,
  };
}
