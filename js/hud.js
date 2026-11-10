// STARFALL — HUD / 2D presentation layer.
// DOM + CSS for screens, 2D canvases for everything that updates per frame
// (pictogram lane, camera views). No dependency on other game modules at
// import time; ./choreo.js is imported lazily only when a timeline move
// arrives without a resolved `poseData`.

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const RATING_ORDER = ['perfect', 'super', 'good', 'ok', 'miss'];

const RATING_INFO = {
  perfect: { word: 'PERFECT', ko: '완벽해요!', color: '#ffe08a' },
  super: { word: 'SUPER', ko: '멋져요!', color: '#19e3d2' },
  good: { word: 'GOOD', ko: '좋아요', color: '#a98bff' },
  ok: { word: 'OK', ko: '조금만 더!', color: '#d5d8ff' },
  miss: { word: 'MISS', ko: '놓쳤어요', color: '#ff5a6e' },
};

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
  searching: '아직 몸이 보이지 않아요. 카메라 앞에 서 주세요',
  almost: '조금만 더 뒤로! 발끝까지 보여 주세요',
  ready: '좋아요! 그대로 잠깐만 계세요',
  go: '준비 완료! 곧 시작합니다',
};

const CAMERA_ERRORS = {
  denied: {
    title: '카메라 권한이 필요해요',
    desc: '주소창의 카메라 아이콘에서 권한을 허용한 뒤 다시 시도해 주세요. 카메라 없이 데모로도 즐길 수 있어요.',
  },
  nodevice: {
    title: '카메라를 찾을 수 없어요',
    desc: '웹캠이 연결되어 있는지 확인해 주세요. 카메라가 없다면 데모로 무대를 감상할 수 있어요.',
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

const BEST_KEY = 'starfall.best';
const DEMO_ONLY = typeof window !== 'undefined' && window.STARFALL_DEMO_ONLY === true;

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
let _dx = 0;
let _dy = 0;
let _minY = 0;

const NO_OPTS = Object.freeze({});

function segDir(v, defX, defY) {
  let x = defX;
  let y = defY;
  let z = 0;
  if (v) {
    x = +v[0] || 0;
    y = +v[1] || 0;
    z = +v[2] || 0;
  }
  const l2 = Math.sqrt(x * x + y * y);
  const l3 = Math.sqrt(x * x + y * y + z * z);
  if (l3 < 1e-6 || l2 < 1e-4) {
    _dx = defX * FIG.foreshortenMin;
    _dy = defY * FIG.foreshortenMin;
    return;
  }
  const f = FIG.foreshortenMin + (1 - FIG.foreshortenMin) * (l2 / l3);
  _dx = (x / l2) * f;
  _dy = (y / l2) * f;
}

function setJ(i, x, y) {
  J[i * 2] = x;
  J[i * 2 + 1] = y;
}

function chain(from, to, v, defX, defY, len) {
  segDir(v, defX, defY);
  J[to * 2] = J[from * 2] + _dx * len;
  J[to * 2 + 1] = J[from * 2 + 1] + _dy * len;
}

// Fills J with joints in figure units (y up, origin at the un-shifted hip centre).
function solveFigure(pose) {
  const hipX = (+pose.hipX || 0) / 1.7;
  const turn = Math.max(0.5, Math.abs(Math.cos(+pose.yaw || 0)));

  segDir(pose.spine, 0, 1);
  const sx = _dx;
  const sy = _dy;
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

  chain(J_NECK, J_HEAD, pose.head, 0, 1, FIG.headOff);
  chain(J_LSH, J_LEL, pose.lUpperArm, 0, -1, FIG.upperArm);
  chain(J_LEL, J_LWR, pose.lForearm, 0, -1, FIG.forearm);
  chain(J_RSH, J_REL, pose.rUpperArm, 0, -1, FIG.upperArm);
  chain(J_REL, J_RWR, pose.rForearm, 0, -1, FIG.forearm);
  chain(J_LHP, J_LKN, pose.lThigh, 0, -1, FIG.thigh);
  chain(J_LKN, J_LAN, pose.lShin, 0, -1, FIG.shin);
  chain(J_RHP, J_RKN, pose.rThigh, 0, -1, FIG.thigh);
  chain(J_RKN, J_RAN, pose.rShin, 0, -1, FIG.shin);
  setJ(J_LTO, J[J_LAN * 2] - FIG.foot, J[J_LAN * 2 + 1]);
  setJ(J_RTO, J[J_RAN * 2] + FIG.foot, J[J_RAN * 2 + 1]);

  _minY = Math.min(J[J_LAN * 2 + 1], J[J_RAN * 2 + 1], J[J_LKN * 2 + 1], J[J_RKN * 2 + 1]);
}

function pathLimb(ctx, a, b, c, d) {
  ctx.beginPath();
  ctx.moveTo(J[a * 2], J[a * 2 + 1]);
  ctx.lineTo(J[b * 2], J[b * 2 + 1]);
  ctx.lineTo(J[c * 2], J[c * 2 + 1]);
  if (d >= 0) ctx.lineTo(J[d * 2], J[d * 2 + 1]);
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
 * opts: { gold, color, accent, outline, alpha, glow (px), glowColor }
 * The call allocates nothing; it is safe to use every frame.
 */
export function drawPictogram(ctx, pose, x, y, size, opts) {
  if (!ctx || !pose || !(size > 0)) return;
  const o = opts || NO_OPTS;
  solveFigure(pose);

  // figure units -> canvas pixels
  const s = size * FIG.scale;
  const oy = y + size * FIG.baseline + _minY * s;
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
  ctx.strokeStyle = body;
  ctx.lineWidth = legW;
  pathLimb(ctx, J_LHP, J_LKN, J_LAN, J_LTO);
  ctx.stroke();
  pathLimb(ctx, J_RHP, J_RKN, J_RAN, J_RTO);
  ctx.stroke();

  // torso
  pathTorso(ctx);
  ctx.strokeStyle = outline;
  ctx.fillStyle = outline;
  ctx.lineWidth = torsoW + ol;
  ctx.stroke();
  ctx.fill();
  ctx.strokeStyle = body;
  ctx.fillStyle = body;
  ctx.lineWidth = torsoW;
  ctx.stroke();
  ctx.fill();

  // neck + head
  ctx.fillStyle = outline;
  dot(ctx, J_HEAD, headR + ol * 0.5);
  ctx.strokeStyle = body;
  ctx.lineWidth = armW * 0.8;
  ctx.beginPath();
  ctx.moveTo(J[J_NECK * 2], J[J_NECK * 2 + 1]);
  ctx.lineTo(J[J_HEAD * 2], J[J_HEAD * 2 + 1]);
  ctx.stroke();
  ctx.fillStyle = body;
  dot(ctx, J_HEAD, headR);

  // arms last, each with its own outline so they read when crossing the body
  ctx.strokeStyle = outline;
  ctx.lineWidth = armW + ol;
  pathLimb(ctx, J_LSH, J_LEL, J_LWR, -1);
  ctx.stroke();
  ctx.strokeStyle = body;
  ctx.lineWidth = armW;
  pathLimb(ctx, J_LSH, J_LEL, J_LWR, -1);
  ctx.stroke();
  ctx.strokeStyle = outline;
  ctx.lineWidth = armW + ol;
  pathLimb(ctx, J_RSH, J_REL, J_RWR, -1);
  ctx.stroke();
  ctx.strokeStyle = body;
  ctx.lineWidth = armW;
  pathLimb(ctx, J_RSH, J_REL, J_RWR, -1);
  ctx.stroke();

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
};

const LOADING_SEQ = [DECO.idle, DECO.vee, DECO.point, DECO.star, DECO.flag, DECO.reach];

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

function readBest() {
  try {
    const v = parseInt(window.localStorage.getItem(BEST_KEY), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (e) {
    return 0;
  }
}

function writeBest(v) {
  try {
    window.localStorage.setItem(BEST_KEY, String(Math.round(v)));
  } catch (e) {
    /* storage unavailable: best score simply is not persisted */
  }
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0C12.9 7.6 16.4 11.1 24 12 16.4 12.9 12.9 16.4 12 24 11.1 16.4 7.6 12.9 0 12 7.6 11.1 11.1 7.6 12 0Z"/></svg>';
const CAM_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h8A2.5 2.5 0 0 1 16 7.5v1.3l3.6-2.3A1 1 0 0 1 21 7.4v9.2a1 1 0 0 1-1.4.9L16 15.2v1.3a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 16.5Z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.6a1 1 0 0 1 1.5-.86l12 7.4a1 1 0 0 1 0 1.72l-12 7.4A1 1 0 0 1 7 19.4Z"/></svg>';
const RETRY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-7.4 5h2.2A6 6 0 1 0 12 6v3L7 5.5 12 2Z"/></svg>';
const WARN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 22.5 21h-21Zm-1 6.5v6h2V9Zm0 8v2h2v-2Z"/></svg>';

function btn(kind, act, inner, extra) {
  return `<button type="button" class="btn btn--${kind}${extra ? ' ' + extra : ''}" data-act="${act}"><i class="btn__bg"><i class="btn__shine"></i></i><span class="btn__label">${inner}</span></button>`;
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

function breakdownRows() {
  let h = '';
  RATING_ORDER.forEach((r, i) => {
    h += `<div class="brow" data-rating="${r}" style="--i:${i}">
      <span class="brow__name">${RATING_INFO[r].word}</span>
      <span class="brow__track"><i class="brow__fill" data-ref="bar-${r}"></i></span>
      <b class="brow__count" data-ref="cnt-${r}">0</b>
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
  for (let i = 0; i < n; i++) h += `<i style="--a:${(360 / n) * i}deg"></i>`;
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

<section class="screen screen--title" data-name="title">
  <div class="title__scrim"></div>
  <div class="title__col">
    <div class="eyebrow" style="--i:0">${STAR_SVG}<span>NOVA LIVE · 카메라 댄스 스테이지</span></div>
    <div class="title__logo" style="--i:1">${logo('')}</div>
    <div class="songcard" style="--i:2">
      <div class="songcard__disc"><span class="eq"><i></i><i></i><i></i><i></i></span></div>
      <div class="songcard__meta">
        <span class="songcard__label">오늘의 곡</span>
        <strong class="songcard__title">STARFALL — NOVA · 124 BPM</strong>
        <span class="songcard__sub">일렉트로 팝 · 1분 35초 · <span data-ref="best">첫 무대에 도전해 보세요</span></span>
      </div>
    </div>
    <div class="title__actions" style="--i:3">
      ${DEMO_ONLY
        ? btn('primary', 'startDemo', `${PLAY_SVG}<span>데모 보기</span><kbd>SPACE</kbd>`)
        : btn('primary', 'start', `${CAM_SVG}<span>카메라로 시작</span><kbd>SPACE</kbd>`) + btn('ghost', 'startDemo', `${PLAY_SVG}<span>데모 보기 <small>(카메라 없이)</small></span>`)}
    </div>
    <p class="title__privacy" style="--i:4">${DEMO_ONLY ? '이 페이지는 데모 버전이에요. NOVA의 무대를 감상해 보세요. 버튼을 누르면 음악이 재생돼요.' : '카메라 영상은 이 기기 안에서만 처리되고, 저장되거나 전송되지 않아요.'}</p>
  </div>
  <ol class="howto">
    <li style="--i:5"><canvas data-ref="how0"></canvas><div><em>01</em><strong>전신이 보이게 2~3m 뒤로</strong><span>머리부터 발끝까지 화면에 담아 주세요</span></div></li>
    <li style="--i:6"><canvas data-ref="how1"></canvas><div><em>02</em><strong>거울처럼 따라하기</strong><span>NOVA가 화면 왼쪽 팔을 들면 나도 왼팔!</span></div></li>
    <li style="--i:7"><canvas data-ref="how2"></canvas><div><em>03</em><strong>박자에 맞춰 포즈 완성</strong><span>금빛 스타 무브는 점수가 2배</span></div></li>
  </ol>
</section>

<section class="screen screen--camera" data-name="camera" data-ref="camSection" data-state="requesting">
  <div class="cam">
    <div class="cam__frame">
      <canvas class="cam__canvas" data-ref="camCanvas"></canvas>
      <i class="corner corner--tl"></i><i class="corner corner--tr"></i><i class="corner corner--bl"></i><i class="corner corner--br"></i>
      <span class="cam__badge">거울 모드</span>
      <div class="cam__hold"><div class="cam__holdfill" data-ref="holdFill"></div></div>
      <div class="cam__error" role="alert">
        <span class="cam__erricon">${WARN_SVG}</span>
        <h3 data-ref="errTitle"></h3>
        <p data-ref="errDesc"></p>
        <div class="cam__erractions">
          ${btn('primary', 'startDemo', `${PLAY_SVG}<span>데모로 플레이</span>`, 'btn--sm')}
          ${btn('ghost', 'retryCamera', `${RETRY_SVG}<span>다시 시도</span>`, 'btn--sm')}
        </div>
      </div>
    </div>
    <div class="cam__side">
      <div class="eyebrow">${STAR_SVG}<span>STEP 1 · 카메라 설정</span></div>
      <h2 class="cam__headline">
        <span class="cam__h cam__h--search">전신이 보이게<br>뒤로 물러나 주세요</span>
        <span class="cam__h cam__h--ready">좋아요!<br>그대로 계세요</span>
        <span class="cam__h cam__h--error">카메라 없이도<br>즐길 수 있어요</span>
      </h2>
      <p class="cam__status" data-ref="camStatus">${CAMERA_STATUS.requesting}</p>
      <div class="meter">
        <div class="meter__head"><span>전신 인식</span><b data-ref="meterPct">0%</b></div>
        <div class="meter__track"><div class="meter__fill" data-ref="meterFill"></div><i class="meter__goal" data-ref="meterGoal"></i></div>
      </div>
      <ul class="cam__tips">
        <li>${STAR_SVG}카메라에서 2~3m 떨어지기</li>
        <li>${STAR_SVG}머리부터 발끝까지 보이기</li>
        <li>${STAR_SVG}밝은 곳에서, 주변은 넓게</li>
      </ul>
      <div class="cam__actions">
        ${btn('ghost', 'skipCamera', '<span>바로 시작</span>', 'btn--sm cam__skip')}
        <button type="button" class="linkbtn" data-act="menu">메뉴로 돌아가기</button>
      </div>
    </div>
  </div>
</section>

<section class="screen screen--play" data-name="play">
  <div class="scorebox" data-ref="scoreBox">
    <span class="scorebox__label">SCORE</span>
    <div class="digits" data-ref="digits">${digitCols()}</div>
    <div class="combo" data-ref="combo">
      <b class="combo__num" data-ref="comboNum">0</b>
      <span class="combo__label">COMBO</span>
      <i class="combo__mult" data-ref="comboMult">×1.0</i>
    </div>
  </div>
  <div class="songbar">
    <div class="songbar__row">
      <div class="chip" data-ref="sectionChip"><i class="chip__dot"></i><span data-ref="sectionText">인트로</span></div>
      <span class="songbar__title">STARFALL — NOVA</span>
      <button type="button" class="pausebtn" data-act="pause" aria-label="일시정지"><i></i><i></i></button>
    </div>
    <div class="progress">
      <div class="progress__fill" data-ref="progFill"></div>
      <div class="progress__runner" data-ref="progRunner"><i class="progress__head"></i></div>
    </div>
  </div>
  <div class="tile" data-ref="tile">
    <canvas class="tile__canvas" data-ref="tileCanvas"></canvas>
    <span class="tile__tag" data-ref="tileTag">PLAYER</span>
    <span class="tile__warn">전신이 보이게 뒤로!</span>
  </div>
  <div class="rating" data-ref="rating" data-rating="perfect">
    <div class="rating__rays" data-ref="ratingRays">${raySpans(12)}</div>
    <div class="rating__gold">${STAR_SVG}<span>STAR MOVE</span>${STAR_SVG}</div>
    <div class="rating__word" data-ref="ratingWord">PERFECT</div>
    <div class="rating__sub"><span data-ref="ratingKo">완벽해요!</span><b data-ref="ratingPts"></b></div>
  </div>
  <div class="lane">
    <span class="lane__label">NEXT</span>
    <canvas class="lane__canvas" data-ref="laneCanvas"></canvas>
  </div>
</section>

<section class="screen screen--countdown" data-name="countdown">
  <div class="count">
    <div class="count__ring" data-ref="countRing"></div>
    <div class="count__num" data-ref="countNum">3</div>
    <p class="count__hint">NOVA를 거울처럼 따라 하세요</p>
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

<section class="screen screen--results" data-name="results">
  <div class="results">
    <div class="eyebrow">${STAR_SVG}<span>STAGE CLEAR · STARFALL — NOVA</span></div>
    <h2 class="results__title" data-ref="resTitle">빛나는 무대</h2>
    <div class="stars" data-ref="stars">${starSlots()}</div>
    <div class="results__score">
      <span class="results__scorelabel">SCORE</span>
      <b class="results__scorenum" data-ref="resScore">0</b>
      <span class="results__best"><i class="results__new" data-ref="resNew">신기록!</i><span data-ref="resBest">최고 기록 0</span></span>
    </div>
    <div class="results__grid">
      <div class="breakdown">${breakdownRows()}</div>
      <div class="statcol">
        <div class="stat"><span>최대 콤보</span><b data-ref="resCombo">0</b></div>
        <div class="stat"><span>정확도</span><b data-ref="resAcc">0%</b><span class="stat__bar"><i data-ref="resAccBar"></i></span></div>
      </div>
    </div>
    <div class="results__actions">
      ${btn('primary', 'retry', `${RETRY_SVG}<span>다시 하기</span><kbd>SPACE</kbd>`)}
      ${btn('ghost', 'menu', '<span>메뉴로</span>')}
    </div>
  </div>
</section>
`;

// ---------------------------------------------------------------------------
// MediaPipe landmark skeleton
// ---------------------------------------------------------------------------

const LM_BONES = new Uint8Array([11, 12, 11, 13, 13, 15, 12, 14, 14, 16, 11, 23, 12, 24, 23, 24, 23, 25, 25, 27, 24, 26, 26, 28]);
const LM_JOINTS = new Uint8Array([11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);
const LM_XY = new Float32Array(33 * 2);
const LM_VIS = new Float32Array(33);

const DIGIT_T = [];
for (let d = 0; d < 10; d++) DIGIT_T.push(`translateY(${-d * 10}%)`);

const SCREENS = ['loading', 'title', 'camera', 'countdown', 'play', 'pause', 'results'];

// ---------------------------------------------------------------------------
// createHud
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} root  the #hud element
 * @param {object} [options]
 *   landmarksMirrored  true (default): landmark x is already mirrored, 0 = screen left, as js/pose-tracker.js
 *                      emits them / false: raw MediaPipe image coordinates
 *   readyThreshold     bodyVisible needed on the camera screen (default 0.72)
 *   readyHoldMs        how long it has to stay above the threshold (default 1100)
 *   beatsAhead         how many beats of upcoming moves the lane shows (default 7)
 *   maxDpr             canvas pixel-ratio cap (default 2)
 *   keyboard           false disables the built-in Space/Enter/Esc handling
 */
export function createHud(root, options) {
  if (!root) throw new Error('createHud(root): root element is required');

  const cfg = Object.assign(
    { landmarksMirrored: true, readyThreshold: 0.72, readyHoldMs: 1100, beatsAhead: 7, maxDpr: 2, keyboard: true },
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
  function fire(event) {
    const now = performance.now();
    if (event === lastEmitName && now - lastEmitAt < 350) return;
    lastEmitName = event;
    lastEmitAt = now;
    emit(event);
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

  const RT = 'translate(-50%, -50%) ';
  const anims = {
    rating: makeAnim(refs.rating, [
      { opacity: 0, transform: RT + 'scale(0.55)' },
      { opacity: 1, transform: RT + 'scale(1.14)', offset: 0.18 },
      { opacity: 1, transform: RT + 'scale(1)', offset: 0.34 },
      { opacity: 1, transform: RT + 'scale(1)', offset: 0.78 },
      { opacity: 0, transform: RT + 'translateY(-18%) scale(0.96)' },
    ], { duration: 540, easing: 'linear' }), // gone before the next beat's verdict (a beat is 484 ms)
    ratingMiss: makeAnim(refs.rating, [
      { opacity: 0, transform: RT + 'translateX(0) scale(0.9)' },
      { opacity: 1, transform: RT + 'translateX(-2.2%) scale(1)', offset: 0.12 },
      { opacity: 1, transform: RT + 'translateX(2%) scale(1)', offset: 0.24 },
      { opacity: 1, transform: RT + 'translateX(-1%) scale(1)', offset: 0.36 },
      { opacity: 0.9, transform: RT + 'translateX(0) scale(1)', offset: 0.7 },
      { opacity: 0, transform: RT + 'translateY(10%) scale(0.98)' },
    ], { duration: 500, easing: 'ease-out' }),
    rays: makeAnim(refs.ratingRays, [
      { opacity: 0, transform: 'scale(0.25) rotate(0deg)' },
      { opacity: 1, transform: 'scale(0.8) rotate(6deg)', offset: 0.25 },
      { opacity: 0, transform: 'scale(1.35) rotate(14deg)' },
    ], { duration: 620, easing: 'cubic-bezier(.1,.7,.2,1)' }),
    combo: makeAnim(refs.comboNum, [
      { transform: 'scale(1.45)' },
      { transform: 'scale(1)' },
    ], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1)' }),
    comboBreak: makeAnim(refs.combo, [
      { opacity: 1, transform: 'translateX(0)' },
      { opacity: 0.9, transform: 'translateX(-4%)', offset: 0.2 },
      { opacity: 0.7, transform: 'translateX(3%)', offset: 0.45 },
      { opacity: 0, transform: 'translateY(30%)' },
    ], { duration: 420, easing: 'ease-in' }),
    score: makeAnim(refs.digits, [
      { transform: 'scale(1.07)' },
      { transform: 'scale(1)' },
    ], { duration: 300, easing: 'cubic-bezier(.2,.9,.3,1)' }),
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
  };

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
  let tlBeat = 0;
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
      if (moves !== tlMoves || b < tlBeat - 0.5) {
        tlMoves = moves;
        tlCursor = 0;
      }
      tlBeat = b;
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
    return { canvas, ctx: canvas.getContext('2d'), ok: false, W: 0, H: 0, bg: null, vignette: null };
  }

  const tileView = makeView(refs.tileCanvas);
  const camView = makeView(refs.camCanvas);

  function layoutView(v) {
    v.ok = false;
    if (!sizeCanvas(v.canvas)) return false;
    const W = v.canvas.width;
    const H = v.canvas.height;
    v.W = W;
    v.H = H;
    const bg = v.ctx.createLinearGradient(0, 0, W * 0.4, H);
    bg.addColorStop(0, '#1d1150');
    bg.addColorStop(0.6, '#120a34');
    bg.addColorStop(1, '#0b0620');
    v.bg = bg;
    const vg = v.ctx.createRadialGradient(W / 2, H * 0.5, Math.min(W, H) * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(11,6,32,0)');
    vg.addColorStop(1, 'rgba(11,6,32,0.62)');
    v.vignette = vg;
    v.ok = true;
    return true;
  }

  const PLAYER_OPTS = { color: C_WHITE, accent: C_TEAL };
  const PLAYER_LOW_OPTS = { color: '#ffd0d6', accent: C_CORAL };
  const GUIDE_OPTS = { color: '#bfb4ff', accent: '#bfb4ff', outline: 'rgba(11,6,32,0.2)', alpha: 0.2 };

  function isLive(video) {
    return !!video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  }

  function paintView(v, video, res, vis, big) {
    const ctx = v.ctx;
    const W = v.W;
    const H = v.H;
    const live = isLive(video);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    // cover-crop source rect
    let sx = 0;
    let sy = 0;
    let sw = 1;
    let sh = 1;
    let vw = 4;
    let vh = 3;
    if (live) {
      vw = video.videoWidth;
      vh = video.videoHeight;
    }
    const va = vw / vh;
    const ca = W / H;
    if (va > ca) {
      sh = vh;
      sw = vh * ca;
      sx = (vw - sw) * 0.5;
    } else {
      sw = vw;
      sh = vw / ca;
      sy = (vh - sh) * 0.5;
    }

    if (live) {
      ctx.setTransform(-1, 0, 0, 1, W, 0); // mirror, like looking into a mirror
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(20,8,60,0.2)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = v.bg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = v.vignette;
    ctx.fillRect(0, 0, W, H);

    const lms = res ? res.landmarks : null;
    const low = vis < 0.45;
    if (lms && lms.length >= 29) {
      // project landmarks into the (mirrored, cropped) view
      const n = lms.length < 33 ? lms.length : 33;
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
        const fx = (u * vw - sx) / sw;
        LM_XY[i * 2] = (cfg.landmarksMirrored ? fx : 1 - fx) * W;
        LM_XY[i * 2 + 1] = ((w * vh - sy) / sh) * H;
        LM_VIS[i] = c;
      }
      const lw = Math.max(2, W * (big ? 0.009 : 0.016));
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // dark underlay, then colour
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? 'rgba(11,6,32,0.75)' : low ? C_CORAL : C_TEAL;
        ctx.lineWidth = pass === 0 ? lw * 2 : lw;
        ctx.beginPath();
        for (let k = 0; k < LM_BONES.length; k += 2) {
          const a = LM_BONES[k];
          const c = LM_BONES[k + 1];
          if (LM_VIS[a] < 0.35 || LM_VIS[c] < 0.35) continue;
          ctx.moveTo(LM_XY[a * 2], LM_XY[a * 2 + 1]);
          ctx.lineTo(LM_XY[c * 2], LM_XY[c * 2 + 1]);
        }
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      for (let k = 0; k < LM_JOINTS.length; k++) {
        const j = LM_JOINTS[k];
        if (LM_VIS[j] < 0.35) continue;
        ctx.beginPath();
        ctx.arc(LM_XY[j * 2], LM_XY[j * 2 + 1], lw * 0.95, 0, 6.283185307179586);
        ctx.fill();
      }
      // head ring from the nose and the shoulder width
      if (LM_VIS[0] >= 0.35) {
        const dxs = LM_XY[22] - LM_XY[24];
        const dys = LM_XY[23] - LM_XY[25];
        const hr = Math.max(lw * 2, Math.sqrt(dxs * dxs + dys * dys) * 0.3);
        ctx.strokeStyle = low ? C_CORAL : C_TEAL;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(LM_XY[0], LM_XY[1], hr, 0, 6.283185307179586);
        ctx.stroke();
      }
    } else if (res && res.pose) {
      drawPictogram(ctx, res.pose, W / 2, H / 2, H * 0.92, low ? PLAYER_LOW_OPTS : PLAYER_OPTS);
    } else if (big) {
      // "stand here" guide silhouette
      drawPictogram(ctx, DECO.idle, W / 2, H / 2, H * 0.86, GUIDE_OPTS);
    }
  }

  // camera-screen state machine
  let camState = 'requesting';
  let camError = '';
  let camVis = 0;
  let camHold = 0;
  let camFired = false;
  let camLastT = 0;
  let meterQ = -1;
  let holdQ = -1;
  let meterPctShown = -1;

  function setCamState(s) {
    if (s === camState) return;
    camState = s;
    refs.camSection.setAttribute('data-state', s);
    refs.camStatus.textContent = CAMERA_STATUS[s] || '';
  }

  function resetCamera() {
    camVis = 0;
    camHold = 0;
    camFired = false;
    camLastT = 0;
    meterQ = -1;
    holdQ = -1;
    meterPctShown = -1;
    camState = '';
    setCamState('requesting');
    refs.meterFill.style.transform = 'scaleX(0)';
    refs.holdFill.style.transform = 'scaleX(0)';
    refs.meterPct.textContent = '0%';
  }

  function cameraReadyNow() {
    if (camFired) return;
    camFired = true;
    setCamState('go');
    emit('cameraReady');
  }

  function updateCameraScreen(video, res) {
    const now = performance.now();
    const dt = camLastT ? Math.min(100, now - camLastT) : 16;
    camLastT = now;
    const live = isLive(video);
    let vis = 0;
    if (res) vis = res.bodyVisible !== undefined ? clamp01(+res.bodyVisible || 0) : res.pose ? 1 : 0;
    camVis += (vis - camVis) * Math.min(1, dt / 140);
    if (camView.ok) paintView(camView, video, res, camVis, true);
    if (camError || camFired) return;

    if (!live && !res) {
      setCamState('requesting');
    } else if (camVis >= cfg.readyThreshold) {
      setCamState('ready');
      camHold += dt;
    } else {
      setCamState(camVis > 0.3 ? 'almost' : 'searching');
      camHold = Math.max(0, camHold - dt * 2);
    }

    const mq = Math.round(camVis * 200);
    if (mq !== meterQ) {
      meterQ = mq;
      refs.meterFill.style.transform = 'scaleX(' + mq / 200 + ')';
    }
    const pct = Math.round(camVis * 100);
    if (pct !== meterPctShown) {
      meterPctShown = pct;
      refs.meterPct.textContent = pct + '%';
    }
    const hq = Math.round(clamp01(camHold / cfg.readyHoldMs) * 100);
    if (hq !== holdQ) {
      holdQ = hq;
      refs.holdFill.style.transform = 'scaleX(' + hq / 100 + ')';
    }
    if (camHold >= cfg.readyHoldMs) cameraReadyNow();
  }

  // play tile
  let tileDemo = null;
  let tileWarn = false;
  let tileLowSince = 0;

  function updateTile(video, res) {
    if (!tileView.ok) return;
    const live = isLive(video);
    let vis = 1;
    if (res && res.bodyVisible !== undefined) vis = clamp01(+res.bodyVisible || 0);
    else if (!res && live) vis = 0;
    paintView(tileView, video, res, vis, false);

    const demo = !live;
    if (demo !== tileDemo) {
      tileDemo = demo;
      refs.tileTag.textContent = demo ? 'DEMO' : 'PLAYER';
      refs.tile.classList.toggle('is-demo', demo);
    }
    let warn = false;
    if (live && vis < 0.45) {
      const now = performance.now();
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

  // Called every frame by the game loop on the camera and play screens.
  function drawPlayer(videoEl, playerPoseResult) {
    if (screen === 'camera') updateCameraScreen(videoEl, playerPoseResult || null);
    else if (screen === 'play' || screen === 'countdown' || screen === 'pause') updateTile(videoEl, playerPoseResult || null);
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

  function drawHowto() {
    const dim = { color: '#cfc6ff', accent: '#cfc6ff' };
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
        // full body inside a viewfinder
        const m = H * 0.1;
        const k = H * 0.2;
        g.strokeStyle = C_TEAL;
        g.lineWidth = Math.max(2, H * 0.045);
        g.beginPath();
        g.moveTo(m, m + k); g.lineTo(m, m); g.lineTo(m + k, m);
        g.moveTo(W - m - k, m); g.lineTo(W - m, m); g.lineTo(W - m, m + k);
        g.moveTo(W - m, H - m - k); g.lineTo(W - m, H - m); g.lineTo(W - m - k, H - m);
        g.moveTo(m + k, H - m); g.lineTo(m, H - m); g.lineTo(m, H - m - k);
        g.stroke();
        drawPictogram(g, DECO.vee, W / 2, H / 2, H * 0.68, CARD_OPTS);
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
        drawPictogram(g, DECO.point, W * 0.27, H / 2, H * 0.74, GOLD_OPTS);
        mirrorPose(tmpPose, DECO.point);
        drawPictogram(g, tmpPose, W * 0.73, H / 2, H * 0.74, dim);
      } else {
        // gold pose locking into the hit marker
        const s = H * 0.8;
        g.save();
        g.shadowColor = C_GOLD;
        g.shadowBlur = H * 0.12;
        g.strokeStyle = C_GOLD;
        g.lineWidth = Math.max(2, H * 0.04);
        roundRectPath(g, W / 2 - s * 0.42, H / 2 - s / 2, s * 0.84, s, s * 0.14);
        g.stroke();
        g.restore();
        drawPictogram(g, DECO.flag, W / 2, H / 2, H * 0.66, GOLD_OPTS);
      }
    }
  }

  function layout() {
    if (destroyed) return;
    dpr = Math.min(cfg.maxDpr, window.devicePixelRatio || 1);
    layoutLane();
    layoutView(tileView);
    layoutView(camView);
    fig.ok = sizeCanvas(fig.canvas);
    drawHowto();
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

  const digitEls = Array.prototype.slice.call(refs.digits.querySelectorAll('.digit'));
  const stripEls = digitEls.map((d) => d.firstElementChild);
  const digitCur = [0, 0, 0, 0, 0, 0, 0];
  const digitDim = [true, true, true, true, true, true, true];
  const POW10 = [1000000, 100000, 10000, 1000, 100, 10, 1];
  let lastScore = 0;
  let lastCombo = 0;
  let lastMult = -1;
  let comboOn = false;

  function setScore(score, combo, multiplier) {
    let s = Math.round(+score || 0);
    if (s < 0) s = 0;
    if (s > 9999999) s = 9999999;
    if (s !== lastScore) {
      for (let i = 0; i < 7; i++) {
        const d = Math.floor(s / POW10[i]) % 10;
        if (d !== digitCur[i]) {
          digitCur[i] = d;
          stripEls[i].style.transform = DIGIT_T[d];
        }
        const dim = s < POW10[i] && i !== 6;
        if (dim !== digitDim[i]) {
          digitDim[i] = dim;
          digitEls[i].classList.toggle('is-dim', dim);
        }
      }
      if (s > lastScore) replay(anims.score);
      lastScore = s;
    }

    const c = Math.max(0, Math.round(+combo || 0));
    if (c !== lastCombo) {
      const show = c >= 2;
      if (show) {
        refs.comboNum.textContent = String(c);
        if (anims.comboBreak) anims.comboBreak.cancel();
        if (c > lastCombo) replay(anims.combo);
      } else if (comboOn) {
        refs.comboNum.textContent = String(c); // never leave the old streak on screen while it fades
        replay(anims.comboBreak);
      }
      if (show !== comboOn) {
        comboOn = show;
        refs.combo.classList.toggle('is-on', show);
      }
      refs.combo.classList.toggle('is-hot', c >= 10);
      lastCombo = c;
    }

    const m = multiplier == null ? 1 : Math.round(+multiplier * 100) / 100;
    if (m !== lastMult) {
      lastMult = m;
      refs.comboMult.textContent = '×' + (Number.isInteger(m * 10) ? m.toFixed(1) : m.toFixed(2));
      refs.comboMult.classList.toggle('is-boost', m > 1.001);
    }
  }

  // ---- rating burst ------------------------------------------------------------

  let ratingShown = '';
  let ratingGold = null;

  function showRating(rating, info) {
    const key = RATING_INFO[String(rating).toLowerCase()] ? String(rating).toLowerCase() : 'miss';
    const def = RATING_INFO[key];
    const gold = !!(info && info.gold) && key !== 'miss';
    const points = info && info.points != null ? Math.round(+info.points || 0) : 0;

    if (key !== ratingShown) {
      ratingShown = key;
      refs.rating.setAttribute('data-rating', key);
      refs.ratingWord.textContent = def.word;
      refs.ratingKo.textContent = def.ko;
    }
    if (gold !== ratingGold) {
      ratingGold = gold;
      refs.rating.classList.toggle('is-gold', gold);
    }
    refs.ratingPts.textContent = points > 0 ? '+' + fmt(points) : '';

    if (anims.rating) anims.rating.cancel();
    if (anims.ratingMiss) anims.ratingMiss.cancel();
    replay(key === 'miss' ? anims.ratingMiss : anims.rating);
    if (key === 'perfect' || key === 'super' || gold) replay(anims.rays);
    else if (anims.rays) anims.rays.cancel();

    flashKind = gold ? 'gold' : key;
    flashAt = performance.now();
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

  const starEls = Array.prototype.slice.call(refs.stars.querySelectorAll('.star'));
  const starAnims = [];
  const res = { active: false, t0: 0, dur: 1700, score: 0, acc: 0, combo: 0, shown: -1 };

  function showResults(stats) {
    if (screen !== 'results') showScreen('results');
    clearTimers();
    const st = stats || {};
    const counts = st.counts || {};
    const score = Math.max(0, Math.round(+st.score || 0));
    const maxScore = +st.maxScore || 0;
    let acc = st.accuracy != null ? +st.accuracy : maxScore > 0 ? score / maxScore : 0;
    if (acc > 1.0001) acc /= 100;
    acc = clamp01(acc || 0);
    const stars = Math.max(0, Math.min(5, Math.round(+st.stars || 0)));
    const maxCombo = Math.max(0, Math.round(+(st.maxCombo != null ? st.maxCombo : st.combo) || 0));

    let total = 0;
    for (const r of RATING_ORDER) total += Math.max(0, +counts[r] || 0);

    refs.resTitle.textContent = RESULT_TITLES[stars];
    const isNew = score > best && score > 0;
    if (isNew) {
      best = score;
      writeBest(best);
    }
    refs.resNew.classList.toggle('is-on', isNew);
    refs.resBest.textContent = '최고 기록 ' + fmt(best);
    updateBestLabel();

    // stars
    starAnims.forEach((a) => a.cancel());
    starAnims.length = 0;
    starEls.forEach((el, i) => {
      const onStar = i < stars;
      el.classList.toggle('is-on', onStar);
      const fill = el.lastElementChild;
      if (onStar && typeof fill.animate === 'function') {
        starAnims.push(fill.animate([
          { opacity: 0, transform: 'scale(0) rotate(-50deg)' },
          { opacity: 1, transform: 'scale(1.4) rotate(10deg)', offset: 0.6 },
          { opacity: 1, transform: 'scale(1) rotate(0deg)' },
        ], { duration: 560, delay: 450 + i * 240, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'backwards' }));
      }
    });
    later(() => {
      if (screen === 'results') emit('resultsStars', stars);
    }, 450 + stars * 240);

    // breakdown bars: reset, then grow on the next frames
    for (const r of RATING_ORDER) {
      const bar = refs['bar-' + r];
      bar.style.transition = 'none';
      bar.style.transform = 'scaleX(0)';
      refs['cnt-' + r].textContent = String(Math.max(0, Math.round(+counts[r] || 0)));
    }
    refs.resAccBar.style.transition = 'none';
    refs.resAccBar.style.transform = 'scaleX(0)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const r of RATING_ORDER) {
          const bar = refs['bar-' + r];
          const v = total > 0 ? Math.max(0, +counts[r] || 0) / total : 0;
          bar.style.transition = '';
          bar.style.transform = 'scaleX(' + (v > 0 ? Math.max(0.02, v) : 0) + ')';
        }
        refs.resAccBar.style.transition = '';
        refs.resAccBar.style.transform = 'scaleX(' + acc + ')';
      });
    });

    res.score = score;
    res.acc = acc;
    res.combo = maxCombo;
    res.shown = -1;
    res.t0 = performance.now() + 350;
    res.active = true;
    refs.resScore.textContent = '0';
    refs.resAcc.textContent = '0%';
    refs.resCombo.textContent = '0';
    kick();
  }

  function stepResults(now) {
    const t = clamp01((now - res.t0) / res.dur);
    const e = easeOutCubic(t);
    const v = Math.round(res.score * e);
    if (v !== res.shown) {
      res.shown = v;
      refs.resScore.textContent = fmt(v);
      refs.resAcc.textContent = Math.round(res.acc * 100 * e) + '%';
      refs.resCombo.textContent = String(Math.round(res.combo * e));
    }
    if (t >= 1) {
      res.active = false;
      refs.resScore.textContent = fmt(res.score);
      refs.resAcc.textContent = Math.round(res.acc * 100) + '%';
      refs.resCombo.textContent = String(res.combo);
    }
  }

  function updateBestLabel() {
    refs.best.textContent = best > 0 ? '최고 기록 ' + fmt(best) : '첫 무대에 도전해 보세요';
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
    const def = CAMERA_ERRORS[k];
    refs.errTitle.textContent = def.title;
    refs.errDesc.textContent = def.desc;
    refs.camSection.setAttribute('data-error', k);
    if (screen !== 'camera') showScreen('camera', { keepError: true });
    focusPrimary();
  }

  // ---- screens ------------------------------------------------------------------------------------

  function resetRun() {
    setScore(0, 0, 1);
    if (anims.rating) anims.rating.cancel();
    if (anims.ratingMiss) anims.ratingMiss.cancel();
    if (anims.rays) anims.rays.cancel();
    if (anims.comboBreak) anims.comboBreak.cancel();
    flashAt = -1e9;
    tlMoves = null;
    tlCursor = 0;
    progQ = -1;
    setProgress(0);
    tileLowSince = 0;
  }

  function focusPrimary() {
    const host = root.querySelector('.screen--' + screen);
    if (!host) return;
    let target = null;
    if (screen === 'camera') target = camError ? host.querySelector('.cam__error .btn--primary') : null;
    else target = host.querySelector('.btn--primary');
    if (target && typeof target.focus === 'function') {
      try {
        target.focus({ preventScroll: true });
      } catch (e) {
        /* focus is a convenience only */
      }
    }
  }

  function showScreen(name, data) {
    if (SCREENS.indexOf(name) < 0) {
      console.warn('[hud] unknown screen "' + name + '"');
      return;
    }
    const prev = screen;
    const active = document.activeElement;
    if (active && root.contains(active) && typeof active.blur === 'function') active.blur();
    if (name !== 'countdown' || prev !== 'countdown') clearTimers();

    const inRun = name === 'play' || name === 'countdown' || name === 'pause';
    if (inRun && !runActive) resetRun();
    runActive = inRun;

    screen = name;
    root.setAttribute('data-screen', name);

    if (name === 'camera') {
      if (!(data && data.keepError)) setCameraError(null);
      if (prev !== 'camera') resetCamera();
    }
    if (name === 'title') updateBestLabel();
    if (name === 'countdown') runCountdown(data);
    if (name === 'results' && data && typeof data === 'object') showResults(data);
    if (!L.ok || !tileView.ok || !camView.ok || !fig.ok) layout();
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

  function doAct(act) {
    switch (act) {
      case 'start': fire('start'); break;
      case 'startDemo': fire('startDemo'); break;
      case 'retry': fire('retry'); break;
      case 'menu': fire('menu'); break;
      case 'pause': pauseNow(); break;
      case 'resume': resumeNow(); break;
      case 'skipCamera': cameraReadyNow(); break;
      case 'retryCamera':
        setCameraError(null);
        resetCamera();
        fire('start');
        break;
      default: break;
    }
  }

  function onClick(e) {
    const t = e.target;
    const b = t && typeof t.closest === 'function' ? t.closest('[data-act]') : null;
    if (!b || !root.contains(b)) return;
    const host = b.closest('.screen');
    if (host && host.getAttribute('data-name') !== screen) return; // stale click on a hidden screen
    doAct(b.getAttribute('data-act'));
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
    if (k === ' ' || k === 'Spacebar' || k === 'Enter') {
      const tag = e.target && e.target.tagName;
      // a focused control handles its own activation
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (screen === 'title') fire('start');
      else if (screen === 'results') fire('retry');
      else if (screen === 'pause') resumeNow();
      else if (screen === 'camera' && camError) doAct('retryCamera');
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
    // card labels are baked into sprites: rebuild them once the web fonts are in
    document.fonts.ready.then(() => {
      if (!destroyed) clearSprites();
    });
  }

  function destroy() {
    destroyed = true;
    clearTimers();
    if (tickId) cancelAnimationFrame(tickId);
    root.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', queueLayout);
    if (ro) ro.disconnect();
    listeners.clear();
    clearSprites();
  }

  // ---- boot ------------------------------------------------------------------------------------------

  refs.meterGoal.style.left = cfg.readyThreshold * 100 + '%';
  updateBestLabel();
  setProgress(0);
  layout();
  kick();

  return {
    showScreen,
    setLoading,
    on,
    setScore,
    showRating,
    updateTimeline,
    setProgress,
    setSection,
    drawPlayer,
    showResults,
    setCameraError,
    // extras (not required by the contract)
    layout,
    destroy,
    get screen() {
      return screen;
    },
    root,
  };
}
