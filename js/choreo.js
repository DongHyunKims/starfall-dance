// STARFALL — choreography: pose library, scored moves, keyframes and time sampling.
// Pure data + math. No DOM, no three.js; imports only ./song.js so it runs in Node.
//
// Conventions (see CONTRACT.md):
//   stage space  +x = screen right, +y = up, +z = toward the viewer
//   limb names are SCREEN-side: l* is the limb on the screen-left.
//   every segment is a unit direction parent joint -> child joint.
import { SONG, TOTAL_BEATS, sectionAtBeat } from './song.js';

export const SEGMENTS = [
  'spine', 'head',
  'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm',
  'lThigh', 'lShin', 'rThigh', 'rShin',
];

// ---------------------------------------------------------------------------
// vector helpers
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (u) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const smootherstep = (u) => { const x = clamp(u, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); };

function norm(v, fallback) {
  const x = +v[0] || 0, y = +v[1] || 0, z = +v[2] || 0;
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-9)) return fallback ? [fallback[0], fallback[1], fallback[2]] : [0, 1, 0];
  return [x / len, y / len, z / len];
}

// Largest angle (rad) a blend may travel beyond either endpoint (anticipation / overshoot).
const MAX_EXTRA_ANGLE = 0.15;

// Spherical interpolation between unit vectors. t may leave [0,1] slightly:
// t < 0 winds up away from b, t > 1 overshoots past b (both angle-capped).
function slerpVec(a, b, t) {
  const d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const theta = Math.acos(d);
  if (theta < 1e-5) return [b[0], b[1], b[2]];
  let ox, oy, oz;
  if (theta > Math.PI - 1e-3) {
    // Antipodal: no unique great circle. Swing through the front (+z), or +x if a is along z.
    const ref = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k = a[0] * ref[0] + a[1] * ref[1] + a[2] * ref[2];
    ox = ref[0] - a[0] * k; oy = ref[1] - a[1] * k; oz = ref[2] - a[2] * k;
  } else {
    ox = b[0] - a[0] * d; oy = b[1] - a[1] * d; oz = b[2] - a[2] * d;
  }
  const ol = Math.hypot(ox, oy, oz) || 1;
  ox /= ol; oy /= ol; oz /= ol;
  const ang = clamp(t * theta, -MAX_EXTRA_ANGLE, theta + MAX_EXTRA_ANGLE);
  const c = Math.cos(ang), s = Math.sin(ang);
  return norm([a[0] * c + ox * s, a[1] * c + oy * s, a[2] * c + oz * s], b);
}

// ---------------------------------------------------------------------------
// pose authoring vocabulary
// Shapes are written for the SCREEN-RIGHT limb (+x = outward) and mirrored for the left.
// Each entry is [upper, lower] = [shoulder->elbow, elbow->wrist] or [hip->knee, knee->ankle].
// ---------------------------------------------------------------------------
const ARM = {
  down:    [[0.20, -1.00, 0.00], [0.10, -1.00, 0.10]],   // hanging naturally
  relaxed: [[0.28, -0.95, 0.00], [0.05, -0.90, 0.40]],   // loose, forearm drifting forward
  out:     [[1.00, 0.00, 0.00], [1.00, 0.02, 0.00]],     // straight out to the side (T)
  up:      [[0.14, 1.00, 0.00], [0.04, 1.00, 0.00]],     // straight up
  vUp:     [[0.60, 0.80, 0.00], [0.62, 0.78, 0.00]],     // high diagonal
  vNarrow: [[0.52, 0.85, 0.00], [0.54, 0.84, 0.00]],     // steep V (clearly wider than 'up')
  vWide:   [[0.82, 0.57, 0.00], [0.78, 0.63, 0.00]],     // wide open burst
  vLow:    [[0.755, -0.655, 0.00], [0.775, -0.63, 0.05]],   // low diagonal, well clear of a hanging arm
  slash:   [[0.62, -0.78, 0.00], [0.62, -0.78, 0.05]],   // low end of the chorus diagonal (in line with vUp)
  hip:     [[0.76, -0.65, -0.10], [-0.70, -0.68, 0.22]], // hand on hip, elbow pushed well out
  goal:    [[1.00, 0.00, 0.00], [0.00, 1.00, 0.05]],     // elbow out, forearm up
  lDown:   [[1.00, 0.00, 0.00], [0.05, -1.00, 0.10]],    // elbow out, forearm down
  flex:    [[0.98, 0.15, 0.00], [-0.50, 0.85, 0.12]],    // bicep flex
  w:       [[0.72, -0.68, 0.00], [0.30, 0.95, 0.10]],    // elbow low, hand up
  cross:   [[-0.60, -0.15, 0.75], [-0.92, 0.12, 0.36]],  // reach across the chest
  crossUp: [[-0.30, 0.55, 0.78], [-0.60, 0.76, 0.25]],   // reach across and up
  chest:   [[0.45, -0.88, 0.10], [-0.80, 0.50, 0.35]],   // hand over heart
  crown:   [[0.82, 0.55, 0.00], [-0.72, 0.66, -0.15]],   // hand behind head, elbow high
  draw:    [[1.00, 0.04, 0.00], [-0.80, 0.25, 0.55]],    // elbow out, hand pulled to chest (archer)
  fold:    [[0.30, -0.92, 0.20], [-0.75, -0.50, 0.45]],  // gathered low in front
  arcNear: [[0.50, 0.87, 0.00], [0.62, 0.78, 0.00]],     // side-bend, arm on the bend side
  arcFar:  [[-0.15, 1.00, 0.00], [-0.40, 0.92, 0.00]],   // side-bend, arm arching overhead
};

const LEG = {
  stand:    [[0.08, -1.00, 0.00], [0.00, -1.00, 0.00]],
  soft:     [[0.20, -0.98, 0.00], [0.04, -1.00, 0.00]],   // shoulder-width
  wide:     [[0.34, -0.94, 0.00], [0.10, -1.00, 0.00]],   // wide stance
  softBend: [[0.06, -0.96, 0.26], [0.00, -0.97, -0.24]],  // supporting leg, knee soft
  tap:      [[0.38, -0.925, 0.00], [0.36, -0.93, 0.00]],  // straight leg tapped to the side
  bent:     [[0.68, -0.70, 0.25], [-0.12, -1.00, -0.10]], // lunge-lite, weight on this leg
  trail:    [[0.54, -0.84, 0.00], [0.54, -0.84, 0.00]],   // straight leg trailing a lunge
  knee:     [[0.72, -0.40, 0.56], [-0.20, -0.97, -0.10]], // knee lifted out to the side
};

const flipX = (v) => [-v[0], v[1], v[2]];

// Build a raw pose. spec: { l, r (ARM keys), legL, legR (LEG keys), spine, head, hipX, yaw }
function build(spec) {
  const armL = ARM[spec.l || 'down'], armR = ARM[spec.r || 'down'];
  const legL = LEG[spec.legL || 'stand'], legR = LEG[spec.legR || 'stand'];
  const spine = spec.spine || [0, 1, 0];
  return {
    spine,
    head: spec.head || [spine[0] * 1.3, 1, spine[2] * 1.3],
    lUpperArm: flipX(armL[0]), lForearm: flipX(armL[1]),
    rUpperArm: armR[0], rForearm: armR[1],
    lThigh: flipX(legL[0]), lShin: flipX(legL[1]),
    rThigh: legR[0], rShin: legR[1],
    hipX: spec.hipX || 0,
    yaw: spec.yaw || 0,
  };
}

/** Left/right mirror of a pose (swaps screen sides). */
export function mirrorPose(p) {
  const out = {
    spine: flipX(p.spine), head: flipX(p.head),
    lUpperArm: flipX(p.rUpperArm), lForearm: flipX(p.rForearm),
    rUpperArm: flipX(p.lUpperArm), rForearm: flipX(p.lForearm),
    lThigh: flipX(p.rThigh), lShin: flipX(p.rShin),
    rThigh: flipX(p.lThigh), rShin: flipX(p.lShin),
    hipX: -(p.hipX || 0), yaw: -(p.yaw || 0),
  };
  return out;
}

// ---------------------------------------------------------------------------
// POSES — the library. "L" poses act toward the SCREEN-LEFT; "R" twins are mirrored.
// ---------------------------------------------------------------------------
const SIDED = {
  // intro sway
  groove:    { l: 'relaxed', r: 'relaxed', legL: 'soft', legR: 'soft', hipX: -0.04, spine: [0.04, 1, 0], head: [-0.05, 1, 0.04] },
  // one hand on hip, other arm low diagonal, hips pushed to the side
  hipPop:    { l: 'hip', r: 'vLow', legL: 'softBend', legR: 'tap', hipX: -0.08, spine: [0.10, 1, 0], head: [-0.06, 1, 0] },
  // verse motif: point to the upper corner, other hand on hip
  pointUp:   { l: 'vUp', r: 'hip', legL: 'tap', legR: 'softBend', hipX: 0.05, spine: [-0.05, 1, 0], head: [-0.10, 1, 0] },
  // bicep flex one side, other hand on hip
  flex:      { l: 'flex', r: 'hip', legL: 'soft', legR: 'soft', hipX: -0.05, spine: [0.03, 1, 0], head: [-0.08, 1, 0] },
  // chorus hook: one long diagonal line through both arms with a lunge
  diag:      { l: 'vUp', r: 'slash', legL: 'bent', legR: 'trail', hipX: -0.10, spine: [-0.08, 1, 0], head: [-0.12, 1, 0] },
  // one arm straight up, the other straight out
  upOut:     { l: 'up', r: 'out', legL: 'softBend', legR: 'tap', hipX: -0.03, spine: [0, 1, 0], head: [0.04, 1, 0] },
  // both arms sweep to one side at shoulder height
  reach:     { l: 'out', r: 'cross', legL: 'tap', legR: 'softBend', hipX: -0.06, spine: [-0.07, 1, 0], head: [-0.12, 1, 0], yaw: -0.18 },
  // both arms reach to one upper corner
  highReach: { l: 'vUp', r: 'crossUp', legL: 'wide', legR: 'wide', hipX: -0.05, spine: [-0.10, 1, 0], head: [-0.14, 1, 0.05], yaw: -0.12 },
  // L-shape arm, other hand on hip
  lShape:    { l: 'goal', r: 'hip', legL: 'soft', legR: 'soft', hipX: 0.04, spine: [0, 1, 0], head: [-0.05, 1, 0] },
  // zig-zag: one forearm up, the other down
  s:         { l: 'goal', r: 'lDown', legL: 'wide', legR: 'wide', spine: [0, 1, 0], head: [-0.06, 1, 0] },
  // side knee lift, same-side hand up at the shoulder, far arm straight up
  knee:      { l: 'w', r: 'up', legL: 'knee', legR: 'stand', hipX: 0.04, spine: [0.03, 1, 0], head: [0, 1, 0] },
  // archer: front arm aims to the side, back hand draws the string, lunge toward the aim
  archer:    { l: 'out', r: 'draw', legL: 'bent', legR: 'trail', hipX: -0.12, spine: [-0.04, 1, 0], head: [-0.16, 1, 0], yaw: -0.10 },
  // bridge: tall side bend, both arms arching over
  arc:       { l: 'arcNear', r: 'arcFar', legL: 'wide', legR: 'wide', hipX: 0.07, spine: [-0.22, 1, 0], head: [-0.30, 1, 0] },
};

const CENTRED = {
  idle:      { l: 'down', r: 'down', legL: 'stand', legR: 'stand' },
  hipsBoth:  { l: 'hip', r: 'hip', legL: 'soft', legR: 'soft' },
  tPose:     { l: 'out', r: 'out', legL: 'wide', legR: 'wide' },
  vHigh:     { l: 'vNarrow', r: 'vNarrow', legL: 'stand', legR: 'stand', head: [0, 1, 0.06] },
  vLow:      { l: 'vLow', r: 'vLow', legL: 'stand', legR: 'stand' },
  upBoth:    { l: 'up', r: 'up', legL: 'stand', legR: 'stand', head: [0, 1, 0.10] },
  goalpost:  { l: 'goal', r: 'goal', legL: 'wide', legR: 'wide' },
  flexBoth:  { l: 'flex', r: 'flex', legL: 'wide', legR: 'wide' },
  wBoth:     { l: 'w', r: 'w', legL: 'wide', legR: 'wide' },
  heart:     { l: 'chest', r: 'chest', legL: 'stand', legR: 'stand', head: [0, 1, 0.08] },
  crown:     { l: 'crown', r: 'crown', legL: 'soft', legR: 'soft', head: [0, 1, 0.05] },
  // signature gold pose: wide star burst
  starburst: { l: 'vWide', r: 'vWide', legL: 'wide', legR: 'wide', head: [0, 1, 0.14] },
  // unscored wind-up before a drop
  gather:    { l: 'fold', r: 'fold', legL: 'softBend', legR: 'softBend', spine: [0, 1, 0.12], head: [0, 0.95, 0.30] },
  // final pose: one arm to the sky, the other trailing low like a falling star
  finale:    { l: 'up', r: 'vLow', legL: 'softBend', legR: 'tap', hipX: -0.04, spine: [0.03, 1, 0], head: [-0.10, 1, 0.10] },
};

/** Korean display names per pose (used for MOVES labels). */
export const POSE_LABELS = {
  idle: '준비', grooveL: '리듬', grooveR: '리듬', gather: '모으기',
  hipsBoth: '허리 손', hipPopL: '왼쪽 힙', hipPopR: '오른쪽 힙',
  pointUpL: '왼쪽 찌르기', pointUpR: '오른쪽 찌르기',
  tPose: '양팔 쫙', vHigh: '브이', vLow: '아래로 활짝', upBoth: '하늘 위로',
  goalpost: '골대', flexBoth: '불끈', wBoth: '더블유',
  flexL: '왼팔 불끈', flexR: '오른팔 불끈',
  diagL: '왼쪽 사선', diagR: '오른쪽 사선',
  upOutL: '왼팔 위로', upOutR: '오른팔 위로',
  reachL: '왼쪽 쓸기', reachR: '오른쪽 쓸기',
  highReachL: '왼쪽 별 잡기', highReachR: '오른쪽 별 잡기',
  lShapeL: '왼쪽 엘', lShapeR: '오른쪽 엘',
  sL: '지그재그', sR: '재그지그',
  kneeL: '왼 무릎', kneeR: '오른 무릎',
  archerL: '왼쪽 활쏘기', archerR: '오른쪽 활쏘기',
  arcL: '왼쪽 초승달', arcR: '오른쪽 초승달',
  heart: '하트', crown: '왕관', starburst: '스타버스트', finale: '스타폴',
};

function normalisePose(p, base) {
  const out = {};
  for (const seg of SEGMENTS) {
    const v = p && Array.isArray(p[seg]) ? p[seg] : (base ? base[seg] : null);
    out[seg] = norm(v || [0, 1, 0], base ? base[seg] : undefined);
  }
  out.hipX = p && Number.isFinite(p.hipX) ? p.hipX : 0;
  out.yaw = p && Number.isFinite(p.yaw) ? p.yaw : 0;
  return out;
}

function clonePose(p) {
  const out = {};
  for (const seg of SEGMENTS) out[seg] = [p[seg][0], p[seg][1], p[seg][2]];
  out.hipX = p.hipX; out.yaw = p.yaw;
  return out;
}

export const POSES = (() => {
  const lib = {};
  const idle = normalisePose(build(CENTRED.idle), null);
  lib.idle = idle;
  for (const [name, spec] of Object.entries(CENTRED)) {
    if (name !== 'idle') lib[name] = normalisePose(build(spec), idle);
  }
  for (const [name, spec] of Object.entries(SIDED)) {
    const left = normalisePose(build(spec), idle);
    lib[name + 'L'] = left;
    lib[name + 'R'] = normalisePose(mirrorPose(left), idle);
  }
  return lib;
})();

const IDLE = POSES.idle;

/** Normalised full pose by name (fresh copy; missing segments filled from idle). */
export function getPose(name) {
  const p = POSES[name];
  if (!p) throw new Error(`choreo: unknown pose "${name}"`);
  return normalisePose(p, IDLE);
}

function blend(a, b, t) {
  const out = {};
  for (const seg of SEGMENTS) out[seg] = slerpVec(a[seg], b[seg], t);
  const tl = clamp(t, -0.1, 1.1);
  out.hipX = lerp(a.hipX, b.hipX, tl);
  out.yaw = lerp(a.yaw, b.yaw, tl);
  return out;
}

/** Normalised per-segment blend of two poses (partial poses are completed from idle). */
export function lerpPose(a, b, t) {
  return blend(normalisePose(a, IDLE), normalisePose(b, IDLE), Number.isFinite(t) ? t : 0);
}

// ---------------------------------------------------------------------------
// The routine. Beats are absolute song beats (4 per bar).
//   intro 0-16 · verseA 16-48 · build 48-64 · chorus1 64-96
//   verseB 96-128 · bridge 128-144 · chorus2 144-176 · outro 176-192
// Entry: [beat, pose, flags]  flags: 'g' = gold, 'u' = unscored (keyframe only), 'hN' = hold N beats
// ---------------------------------------------------------------------------
const ROUTINE = [
  // --- intro: find the pulse (unscored) -----------------------------------
  { ease: 'smooth', steps: [
    [0, 'idle', 'u'], [2, 'grooveL', 'u'], [4, 'grooveR', 'u'], [6, 'grooveL', 'u'], [8, 'grooveR', 'u'],
    [10, 'hipsBoth', 'u'], [12, 'hipPopL', 'u'], [13, 'hipPopR', 'u'], [14, 'hipsBoth', 'u'],
  ] },
  // --- verse A: "point, point, open, hips" motif + a left/right tail ---------
  { ease: 'swing', steps: [
    [16, 'pointUpL'], [18, 'pointUpR'], [20, 'tPose'], [22, 'hipsBoth'],
    [24, 'reachL'], [26, 'reachR'], [28, 'goalpost'], [30, 'vLow'],
    [32, 'pointUpL'], [34, 'pointUpR'], [36, 'upOutL'], [38, 'upOutR'],
    [40, 'lShapeL'], [42, 'lShapeR'], [44, 'flexBoth'], [46, 'hipPopL'],
  ] },
  // --- build: arms climb twice, the second climb ends higher -----------------
  // (no two neighbouring shapes look alike from the front: holding one never scores the next)
  { ease: 'snap', steps: [
    [48, 'vLow'], [50, 'tPose'], [52, 'goalpost'], [54, 'vHigh'],
    [56, 'wBoth'], [58, 'tPose'], [60, 'flexBoth'], [62, 'upBoth'],
  ] },
  // --- chorus 1: the hook (burst, slash, slash, flex | up, up, goal, pop) ----
  { ease: 'snap', steps: [
    [64, 'starburst', 'g'], [65, 'diagL'], [66, 'diagR'], [67, 'flexBoth'],
    [68, 'upOutL'], [69, 'upOutR'], [70, 'goalpost'], [71, 'hipPopL'],
    [72, 'highReachL'], [74, 'highReachR'], [76, 'archerL'], [78, 'archerR'],
    [80, 'vHigh'], [81, 'diagL'], [82, 'diagR'], [83, 'flexBoth'],
    [84, 'upOutL'], [86, 'upOutR'],
    [88, 'tPose'], [90, 'upBoth'], [92, 'starburst', 'g h4'],
  ] },
  // --- verse B: motif recall, then strict left/right answers -----------------
  { ease: 'swing', steps: [
    [96, 'pointUpL'], [98, 'pointUpR'], [100, 'sL'], [102, 'sR'],
    [104, 'kneeL'], [106, 'kneeR'], [108, 'flexL'], [110, 'flexR'],
    [112, 'reachL'], [114, 'reachR'], [116, 'lShapeL'], [118, 'lShapeR'],
    [120, 'hipPopL'], [122, 'hipPopR'], [124, 'crown'], [126, 'hipsBoth'],
  ] },
  // --- bridge: slow, big shapes ------------------------------------------------
  { ease: 'smooth', steps: [
    [128, 'heart'], [130, 'arcL'], [132, 'arcR'], [134, 'vLow'],
    [136, 'upBoth', 'g'], [138, 'tPose'], [140, 'heart'], [142, 'gather', 'u'],
  ] },
  // --- chorus 2: the hook mirrored, new answers, bigger ending ---------------
  { ease: 'snap', steps: [
    [144, 'starburst', 'g'], [145, 'diagR'], [146, 'diagL'], [147, 'flexBoth'],
    [148, 'upOutR'], [149, 'upOutL'], [150, 'goalpost'], [151, 'hipPopR'],
    [152, 'archerR'], [154, 'archerL'], [156, 'highReachR'], [158, 'highReachL'],
    [160, 'vHigh'], [161, 'diagR'], [162, 'diagL'], [163, 'crown'],
    [164, 'upOutR'], [166, 'upOutL'],
    [168, 'wBoth'], [170, 'upBoth'], [172, 'starburst', 'g h4'],
  ] },
  // --- outro: wind down into the final pose (unscored) ------------------------
  { ease: 'smooth', steps: [
    [176, 'vLow', 'u'], [178, 'hipsBoth', 'u'], [180, 'grooveL', 'u'], [182, 'grooveR', 'u'],
    [184, 'heart', 'u'], [186, 'gather', 'u'],
  ] },
  { ease: 'snap', steps: [[188, 'finale', 'u'], [TOTAL_BEATS + 4, 'finale', 'u']] },
  { ease: 'smooth', steps: [[TOTAL_BEATS + 8, 'idle', 'u']] },
];

const SECTION_CODE = {
  verseA: 'va', build: 'bd', chorus1: 'c1', verseB: 'vb', bridge: 'br', chorus2: 'c2',
};

const built = (() => {
  const keyframes = [];
  const scoredSteps = [];
  for (const block of ROUTINE) {
    for (const [beat, pose, flags = ''] of block.steps) {
      if (!POSES[pose]) throw new Error(`choreo: routine references unknown pose "${pose}"`);
      keyframes.push({ beat, pose, ease: block.ease });
      if (!flags.includes('u')) scoredSteps.push({ beat, pose, flags });
    }
  }
  keyframes.sort((a, b) => a.beat - b.beat);
  scoredSteps.sort((a, b) => a.beat - b.beat);

  const counters = {};
  const moves = scoredSteps.map((s, i) => {
    const section = sectionAtBeat(s.beat);
    if (!section.scored) throw new Error(`choreo: scored move at beat ${s.beat} in unscored section ${section.name}`);
    const next = scoredSteps[i + 1];
    const gap = next ? next.beat - s.beat : 4;
    const explicit = /h(\d+(?:\.\d+)?)/.exec(s.flags);
    const hold = explicit ? parseFloat(explicit[1]) : Math.min(gap, 2);
    const code = SECTION_CODE[section.name] || section.name;
    counters[code] = (counters[code] || 0) + 1;
    return {
      id: `${code}-${String(counters[code]).padStart(2, '0')}`,
      beat: s.beat,
      pose: s.pose,
      label: POSE_LABELS[s.pose] || s.pose,
      gold: s.flags.includes('g'),
      hold,
      section: section.name,
    };
  });
  return { keyframes, moves };
})();

/** Scored targets, sorted by beat. */
export const MOVES = built.moves;
/** Continuous dancer animation keys, sorted by beat. */
export const KEYFRAMES = built.keyframes;

// ---------------------------------------------------------------------------
// Timing model
// ---------------------------------------------------------------------------
// Per-ease tuning. `window(D)` = beats of travel time at the END of an interval of D beats,
// `overshoot` = fraction of the travelled arc the limb swings past the pose just after the beat,
// `anticipation` = wind-up fraction in the opposite direction at the start of the travel.
export const TIMING = {
  snap:   { frac: 0.40, min: 0.60, max: 1.00, overshoot: 0.075, anticipation: 0.05 },
  swing:  { frac: 0.45, min: 0.70, max: 1.20, overshoot: 0.055, anticipation: 0.11 },
  smooth: { frac: 0.70, min: 0.80, max: 3.00, overshoot: 0.020, anticipation: 0.00 },
  settleBeats: 0.40, // length of the overshoot/settle wobble after arriving
};

// Groove layer amplitudes at full section intensity.
export const GROOVE = {
  knee: 0.17,      // knee bounce (thigh forward / shin back, in direction-vector units)
  sway: 0.035,     // spine side sway, alternating every beat
  hipSway: 0.014,  // metres of lateral hip drift with the sway
  nod: 0.10,       // head nod
  arm: 0.035,      // elbow give with the bounce (z only, invisible to 2D scoring)
  floor: 0.35,     // share of groove that remains at intensity 0
};

function travelWindow(ease, D) {
  const cfg = TIMING[ease] || TIMING.smooth;
  return Math.min(clamp(cfg.frac * D, cfg.min, cfg.max), D * 0.9);
}

function easeTravel(ease, u) {
  const cfg = TIMING[ease] || TIMING.smooth;
  let f;
  if (ease === 'snap') f = smoothstep(Math.pow(u, 1.35));        // late, fast, lands hard
  else if (ease === 'swing') f = smoothstep(Math.pow(u, 1.15));  // loose pendulum
  else f = smootherstep(u);                                      // slow and even
  // wind-up: dips below 0 early in the travel, vanishes by the end
  return f - cfg.anticipation * Math.sin(Math.PI * u) * (1 - u) * (1 - u);
}

const POSE_AT = KEYFRAMES.map((k) => POSES[k.pose]);
const FIRST_BEAT = KEYFRAMES[0].beat;
const LAST_BEAT = KEYFRAMES[KEYFRAMES.length - 1].beat;

function keyframeIndex(beat) {
  let lo = 0, hi = KEYFRAMES.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (KEYFRAMES[mid].beat <= beat) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Section intensity, cross-faded over one beat around section boundaries.
function intensityAt(beat) {
  const a = sectionAtBeat(beat - 0.5).intensity;
  const b = sectionAtBeat(beat + 0.5).intensity;
  if (a === b) return a;
  const boundary = Math.round(beat / SONG.beatsPerBar) * SONG.beatsPerBar;
  return lerp(a, b, smoothstep(beat - boundary + 0.5));
}

function baseAt(beat) {
  if (beat <= FIRST_BEAT || beat >= LAST_BEAT) return clonePose(IDLE);
  const i = keyframeIndex(beat);
  const cur = KEYFRAMES[i], next = KEYFRAMES[i + 1];
  const D = next.beat - cur.beat;
  const win = travelWindow(next.ease, D);
  const start = next.beat - win;
  if (beat >= start) {
    return blend(POSE_AT[i], POSE_AT[i + 1], easeTravel(next.ease, (beat - start) / win));
  }
  // Holding the current pose: decaying overshoot right after the hit, exact on the beat itself.
  const dt = beat - cur.beat;
  const settle = Math.min(TIMING.settleBeats, D - win);
  if (i > 0 && dt > 0 && dt < settle) {
    const cfg = TIMING[cur.ease] || TIMING.smooth;
    const x = dt / settle;
    const e = cfg.overshoot * Math.sin(Math.PI * x) * (1 - x) * 1.6;
    if (e > 1e-6) return blend(POSE_AT[i - 1], POSE_AT[i], 1 + e);
  }
  return clonePose(POSE_AT[i]);
}

// Continuous groove. Every term is exactly zero on integer beats, so a scored pose is
// untouched at the instant it is judged: the body "lands" on the beat and gives right after.
function applyGroove(p, beat) {
  const g = GROOVE.floor + (1 - GROOVE.floor) * clamp(intensityAt(beat), 0, 1);
  const phase = beat - Math.floor(beat);
  const s = Math.sin(Math.PI * Math.pow(phase, 0.65));
  const bounce = s * s;                       // 0 on the beat, deepest ~0.3 beats later
  const sway = Math.sin(Math.PI * beat);      // alternates side every beat

  const k = GROOVE.knee * g * bounce;
  for (const side of ['l', 'r']) {
    const th = p[side + 'Thigh'], sh = p[side + 'Shin'];
    th[2] += k; sh[2] -= k * 1.1;
    p[side + 'Thigh'] = norm(th, IDLE[side + 'Thigh']);
    p[side + 'Shin'] = norm(sh, IDLE[side + 'Shin']);
    const fa = p[side + 'Forearm'];
    fa[2] += GROOVE.arm * g * bounce;
    p[side + 'Forearm'] = norm(fa, IDLE[side + 'Forearm']);
  }
  const sp = p.spine;
  sp[0] += GROOVE.sway * g * sway;
  sp[2] += 0.03 * g * bounce;
  p.spine = norm(sp, IDLE.spine);
  const hd = p.head;
  hd[0] -= GROOVE.sway * 0.6 * g * sway;
  hd[2] += GROOVE.nod * g * bounce;
  p.head = norm(hd, IDLE.head);
  p.hipX += GROOVE.hipSway * g * sway;
  return p;
}

/**
 * Full dancer pose at a (fractional) song beat.
 * Always returns every SEGMENT as a unit vector, plus hipX (m) and yaw (rad).
 */
export function samplePose(beat) {
  const b = Number.isFinite(beat) ? beat : 0;
  return applyGroove(baseAt(b), b);
}
