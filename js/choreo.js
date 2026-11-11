// STARFALL — choreography: pose library, scored moves, keyframes and time sampling.
// Pure data + math. No DOM, no three.js; imports only ./song.js so it runs in Node.
//
// Conventions (see CONTRACT.md):
//   stage space  +x = screen right, +y = up, +z = toward the viewer
//   limb names are SCREEN-side: l* is the limb on the screen-left.
//   every segment is a unit direction parent joint -> child joint.
//
// v2 (see CONTRACT-v2.md): the routine is real dance vocabulary. The upper arms stay low and
// the shapes come from the forearms; overhead moves are short accents. Arms and body are two
// animation channels: the arms hit a shape on the beat and HOLD it long enough to be copied,
// while the body (legs, hips, spine, head) keeps stepping, swaying and bouncing underneath.
import { SONG, TOTAL_BEATS, sectionAtBeat } from './song.js';

export const SEGMENTS = [
  'spine', 'head',
  'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm',
  'lThigh', 'lShin', 'rThigh', 'rShin',
];

const ARM_SEGMENTS = ['lUpperArm', 'lForearm', 'rUpperArm', 'rForearm'];
const BODY_SEGMENTS = ['spine', 'head', 'lThigh', 'lShin', 'rThigh', 'rShin'];

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
// Kept well inside the 12 degree "held pose" tolerance of the contract.
const MAX_EXTRA_ANGLE = 0.11;

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
//
// Arm ergonomics: an arm is "raised" when its upper arm points above horizontal or its hand
// is above the shoulder. Only the shapes in the last group are raised; everything else keeps
// the elbow below the shoulder and builds the picture with the forearm.
// ---------------------------------------------------------------------------
const ARM = {
  // --- resting -------------------------------------------------------------
  down:     [[0.20, -1.00, 0.00], [0.10, -1.00, 0.10]],    // hanging naturally (idle)
  relaxed:  [[0.28, -0.95, 0.00], [0.05, -0.90, 0.40]],    // loose, forearm drifting forward
  swingOut: [[0.46, -0.88, -0.10], [0.54, -0.83, 0.14]],   // low swing, arm on the swing side
  swingIn:  [[-0.06, -0.93, 0.36], [-0.40, -0.85, 0.34]],  // low swing, arm crossing in front
  hip:      [[0.80, -0.58, -0.15], [-0.575, -0.755, 0.315]], // hand on hip, elbow pushed well out
  // --- elbow at the ribs, the forearm draws the shape (no shoulder load) ----
  open:     [[0.16, -0.98, 0.04], [0.88, -0.06, 0.47]],    // forearm out to the side, palm up
  w:        [[0.22, -0.97, 0.02], [0.64, 0.62, 0.45]],     // hand up and out beside the shoulder
  pump:     [[0.24, -0.96, 0.10], [0.10, 0.86, 0.50]],     // fist up in front of the shoulder
  chest:    [[0.45, -0.88, 0.16], [-0.74, 0.48, 0.50]],    // hand over the heart
  clap:     [[0.18, -0.90, 0.40], [-0.59, 0.45, 0.67]],    // hand to the centre line, chest height
  clapPre:  [[0.24, -0.93, 0.28], [-0.20, 0.52, 0.83]],    // hands apart, about to clap
  crossHi:  [[0.02, -0.86, 0.51], [-0.75, 0.55, 0.36]],    // forearm crossing the chest (front arm)
  crossHiB: [[0.05, -0.88, 0.45], [-0.74, 0.56, 0.22]],    // ... the arm underneath
  crossLo:  [[0.12, -0.93, 0.35], [-0.78, -0.50, 0.38]],   // forearm crossing low (front arm)
  crossLoB: [[0.15, -0.94, 0.30], [-0.77, -0.52, 0.26]],   // ... the arm underneath
  fold:     [[0.30, -0.92, 0.20], [-0.75, -0.50, 0.45]],   // gathered low in front (wind-up)
  rollHi:   [[0.52, -0.76, 0.38], [-0.80, 0.42, 0.42]],    // rolling arms: forearm on top
  rollLo:   [[0.40, -0.85, 0.34], [-0.78, -0.40, 0.48]],   // rolling arms: forearm underneath
  // --- arm away from the body, still below the shoulder ----------------------
  lowPt:    [[0.82, -0.57, 0.00], [0.84, -0.54, 0.06]],    // low diagonal point
  across:   [[-0.40, -0.72, 0.56], [-0.50, -0.80, 0.33]],  // reaching across to the far low corner
  elbow:    [[0.86, -0.50, 0.06], [-0.88, 0.18, 0.44]],    // elbow out, fist at the chest
  fall:     [[0.93, -0.36, 0.04], [0.90, -0.42, 0.10]],    // arm dropping wide out of a high shape
  // --- raised accents (short, never held longer than a beat) ----------------
  side:     [[1.00, 0.03, 0.00], [1.00, 0.06, 0.00]],      // shoulder-height reach to the side
  hiPt:     [[0.62, 0.78, 0.00], [0.64, 0.77, 0.00]],      // high diagonal point
  vWide:    [[0.74, 0.67, 0.00], [0.70, 0.72, 0.00]],      // wide open burst
  vNarrow:  [[0.52, 0.85, 0.00], [0.54, 0.84, 0.00]],      // steep V
  up:       [[0.14, 1.00, 0.00], [0.04, 1.00, 0.00]],      // straight up
};

const LEG = {
  stand:   [[0.08, -1.00, 0.00], [0.00, -1.00, 0.00]],     // straight, feet together (idle)
  soft:    [[0.16, -0.98, 0.14], [0.03, -0.99, -0.13]],    // shoulder width, knees soft
  deep:    [[0.24, -0.92, 0.30], [-0.05, -0.95, -0.30]],   // dip (knees over the toes, feet stay put)
  crouch:  [[0.28, -0.86, 0.42], [-0.09, -0.90, -0.43]],   // deep wind-up
  wide:    [[0.30, -0.95, 0.08], [0.12, -0.99, -0.06]],    // wide and tall
  tall:    [[0.10, -1.00, 0.04], [0.00, -1.00, -0.03]],    // feet together, standing tall
  // weight on this leg
  under:   [[0.035, -0.97, 0.24], [0.018, -0.975, -0.22]], // under a shifted hip, knee soft
  pivot:   [[0.00, -0.98, 0.20], [0.00, -0.98, -0.18]],    // under a popped hip
  support: [[0.03, -0.96, 0.27], [0.00, -0.97, -0.25]],    // carrying a step
  lunge:   [[0.36, -0.90, 0.26], [-0.02, -0.99, -0.12]],   // stepped out and bent (lunge-lite)
  // free leg
  reach:   [[0.17, -0.97, 0.17], [0.16, -0.975, -0.15]],   // left behind by a sway
  release: [[0.20, -0.95, 0.24], [0.185, -0.96, -0.20]],   // knee let go by a hip pop
  trailS:  [[0.215, -0.955, 0.20], [0.205, -0.96, -0.18]], // trailing a side step
  tapIn:   [[-0.01, -0.94, 0.33], [-0.03, -0.93, -0.36]],  // closed next to the other foot, on the toe
  tap:     [[0.28, -0.96, 0.02], [0.28, -0.96, -0.02]],    // long line out to the side, toe on the floor
  post:    [[0.17, -0.96, 0.18], [0.17, -0.965, -0.16]],   // the standing leg opposite a tap, wide stance
  trail:   [[0.325, -0.945, 0.00], [0.325, -0.945, 0.00]], // straight leg trailing a lunge
};

// Body = everything that is not an arm. Sided bodies are written acting toward the SCREEN-LEFT
// (weight / lean to the left) and mirrored for the right-hand twin.
const BODY = {
  stand:  { legL: 'stand', legR: 'stand' },
  soft:   { legL: 'soft', legR: 'soft', spine: [0, 1, 0.02], head: [0, 1, 0.03] },
  dip:    { legL: 'deep', legR: 'deep', spine: [0, 1, 0.07], head: [0, 1, 0.03] },
  crouch: { legL: 'crouch', legR: 'crouch', spine: [0, 1, 0.16], head: [0, 0.95, 0.32] },
  wide:   { legL: 'wide', legR: 'wide', spine: [0, 1, -0.02], head: [0, 1, 0.05] },
  star:   { legL: 'wide', legR: 'wide', spine: [0, 1, -0.04], head: [0, 1, 0.14] },
  rise:   { legL: 'tall', legR: 'tall', spine: [0, 1, -0.03], head: [0, 1, 0.12] },
  // sided (toward the screen-left)
  sway:   { legL: 'under', legR: 'reach', hipX: -0.06, spine: [0.06, 1, 0.02], head: [-0.03, 1, 0.03] },
  pop:    { legL: 'pivot', legR: 'release', hipX: -0.085, spine: [0.11, 1, 0.01], head: [-0.05, 1, 0.02], yaw: 0.05 },
  step:   { legL: 'support', legR: 'trailS', hipX: -0.11, spine: [-0.03, 1, 0.02], head: [-0.08, 1, 0.03], yaw: -0.06 },
  close:  { legL: 'support', legR: 'tapIn', hipX: -0.10, spine: [0.03, 1, 0.02], head: [0.02, 1, 0.03] },
  lean:   { legL: 'lunge', legR: 'trail', hipX: -0.10, spine: [-0.10, 1, 0.04], head: [-0.17, 1, 0.05], yaw: -0.14 },
  tap:    { legL: 'tap', legR: 'post', hipX: 0.05, spine: [-0.05, 1, 0.00], head: [-0.11, 1, 0.03], yaw: -0.06 },
};

const flipX = (v) => [-v[0], v[1], v[2]];

// Build a raw pose. spec: { l, r (ARM keys), body (BODY key) }
function build(spec) {
  const armL = ARM[spec.l || 'relaxed'], armR = ARM[spec.r || 'relaxed'];
  const body = BODY[spec.body || 'soft'];
  if (!armL || !armR || !body) throw new Error(`choreo: bad pose spec ${JSON.stringify(spec)}`);
  const legL = LEG[body.legL], legR = LEG[body.legR];
  const spine = spec.spine || body.spine || [0, 1, 0];
  return {
    spine,
    head: spec.head || body.head || [spine[0] * 1.3, 1, spine[2] * 1.3],
    lUpperArm: flipX(armL[0]), lForearm: flipX(armL[1]),
    rUpperArm: armR[0], rForearm: armR[1],
    lThigh: flipX(legL[0]), lShin: flipX(legL[1]),
    rThigh: legR[0], rShin: legR[1],
    hipX: body.hipX || 0,
    yaw: body.yaw || 0,
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
  // --- scored vocabulary -----------------------------------------------------
  // verse A: one arm flicks out low, the other hand stays on the hip, step to that side
  flick:  { l: 'lowPt', r: 'hip', body: 'step' },
  // chorus: both arms thrown to one low corner with a lean
  sweep:  { l: 'lowPt', r: 'across', body: 'lean' },
  // chorus accent: one long diagonal line, high arm on the named side (raised, one beat)
  sky:    { l: 'hiPt', r: 'lowPt', body: 'tap' },
  // verse B accent: shoulder-height point to the side, other hand on the hip (raised, one beat)
  point:  { l: 'side', r: 'hip', body: 'tap' },
  // verse B: hand over the heart, the other arm opens low
  chest:  { l: 'chest', r: 'lowPt', body: 'sway' },
  // verse B: little wave beside the shoulder, other hand on the hip
  wave:   { l: 'w', r: 'hip', body: 'step' },
  // hands on hips, hip popped to the side
  pop:    { l: 'hip', r: 'hip', body: 'pop' },
  // --- unscored grooves and in-betweens --------------------------------------
  swing:  { l: 'swingOut', r: 'swingIn', body: 'sway' },   // low arm swing with the weight shift
  sway:   { body: 'sway' },
  step:   { body: 'step' },
  close:  { body: 'close' },
  roll:   { l: 'rollHi', r: 'rollLo', body: 'soft' },       // rolling arms, this forearm on top
  // outro: point to the sky, then the arm falls like a shooting star into `flick`
  finale: { l: 'up', r: 'hip', body: 'tap', head: [-0.08, 1, 0.12] },
};

const CENTRED = {
  idle:       { l: 'down', r: 'down', body: 'stand' },
  // --- scored vocabulary -----------------------------------------------------
  hipsBoth:   { l: 'hip', r: 'hip', body: 'soft' },
  openBoth:   { l: 'open', r: 'open', body: 'soft' },
  wBoth:      { l: 'w', r: 'w', body: 'soft', head: [0, 1, 0.07] },
  pumpBoth:   { l: 'pump', r: 'pump', body: 'dip' },
  clap:       { l: 'clap', r: 'clap', body: 'dip' },
  heart:      { l: 'chest', r: 'chest', body: 'soft', head: [0, 1, 0.08] },
  crossChest: { l: 'crossHiB', r: 'crossHi', body: 'dip' },
  crossLow:   { l: 'crossLoB', r: 'crossLo', body: 'dip' },
  lowV:       { l: 'lowPt', r: 'lowPt', body: 'wide' },
  elbowsOut:  { l: 'elbow', r: 'elbow', body: 'dip' },
  tBoth:      { l: 'side', r: 'side', body: 'wide' },
  // signature gold pose: wide star burst overhead
  starburst:  { l: 'vWide', r: 'vWide', body: 'star' },
  // bridge peak: both arms reach for the sky
  vHigh:      { l: 'vNarrow', r: 'vNarrow', body: 'rise' },
  // --- unscored grooves and in-betweens --------------------------------------
  bounce:     { body: 'soft' },                              // arms resting, knees soft
  dipC:       { body: 'dip' },
  wideC:      { body: 'wide' },                              // wide stance between two lunges
  crouch:     { body: 'crouch' },
  gather:     { l: 'fold', r: 'fold', body: 'crouch' },      // wind-up before a burst
  fallBoth:   { l: 'fall', r: 'fall', body: 'dip' },         // arms dropping out of a high shape
  clapOpen:   { l: 'clapPre', r: 'clapPre', body: 'soft' },  // hands apart, about to clap
};

/** Korean display names per pose (used for MOVES labels): short, and they say what to do. */
export const POSE_LABELS = {
  idle: '준비', bounce: '리듬 타기', dipC: '리듬 타기', wideC: '리듬 타기', crouch: '모으기', gather: '모으기',
  fallBoth: '팔 내리기', clapOpen: '박수 준비',
  swayL: '리듬 타기', swayR: '리듬 타기', stepL: '왼쪽 스텝', stepR: '오른쪽 스텝',
  closeL: '발 모으기', closeR: '발 모으기', swingL: '팔 흔들기', swingR: '팔 흔들기',
  rollL: '팔 돌리기', rollR: '팔 돌리기', finaleL: '스타폴', finaleR: '스타폴',
  hipsBoth: '허리에 손', popL: '허리에 손', popR: '허리에 손',
  flickL: '왼쪽 아래 찌르기', flickR: '오른쪽 아래 찌르기',
  clap: '가슴 앞 박수', openBoth: '양손 펼치기', wBoth: '어깨 옆 반짝',
  crossChest: '가슴 앞 엑스', crossLow: '아래로 엑스', lowV: '아래로 활짝',
  pumpBoth: '두 주먹 불끈', elbowsOut: '팔꿈치 활짝', tBoth: '양팔 쫙',
  sweepL: '왼쪽으로 쓸기', sweepR: '오른쪽으로 쓸기',
  skyL: '왼쪽 위 찌르기', skyR: '오른쪽 위 찌르기',
  pointL: '왼쪽 찌르기', pointR: '오른쪽 찌르기',
  chestL: '왼손 가슴에', chestR: '오른손 가슴에',
  waveL: '왼손 안녕', waveR: '오른손 안녕',
  heart: '가슴에 두 손', starburst: '위로 활짝', vHigh: '하늘 위로',
};

/** Poses for the results screen, by outcome. All names exist in POSES. */
export const HERO_POSES = { win: 'starburst', good: 'skyL', low: 'hipsBoth' };

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
//
// Entry: [beat, pose, flags]. No flags = a SCORED move (arms and body hit the pose on the beat).
//   'u'  unscored keyframe for arms and body       'g'  gold ("스타 무브")
//   'a'  unscored, arms only (body keeps going)    'b'  unscored, body only (arms keep holding)
//   'hN' the arms hold this pose N beats           'tN' the arms take N beats to travel here
//
// Counts, per 8 (scored counts in capitals):
//   verse A   "flick, flick, clap"      ONE THREE FIVE . | ONE . FIVE .   then mirrored
//   build     "pump, throw, throw"      ONE THREE FIVE roll | ONE THREE FIVE gather
//   chorus    "burst, catch, throw, throw" ONE THREE FIVE SEVEN | ONE THREE FIVE . | ... | ONE THREE FIVE .
//   verse B   "heart, heart, elbows"    ONE THREE FIVE . | ONE . FIVE .   then mirrored
//   bridge    slow breath               ONE . FIVE . | ONE . FIVE .
// Arms rest (hang, swing low, or sit on the hips) on every '.' pair.
// ---------------------------------------------------------------------------
const ROUTINE = [
  // --- intro: find the pulse — sway, low arm swing, then hands on hips (unscored) ----------
  { ease: 'smooth', steps: [
    [0, 'idle', 'u'], [1, 'bounce', 'u'],
    [2, 'swingL', 'u t1.6'], [3, 'bounce', 'b'], [4, 'swingR', 'u t1.6'], [5, 'bounce', 'b'],
    [6, 'swingL', 'u t1.6'], [7, 'bounce', 'b'], [8, 'swingR', 'u t1.6'], [9, 'bounce', 'b'],
  ] },
  { ease: 'swing', steps: [
    [10, 'hipsBoth', 'u'], [11, 'popL', 'b'], [12, 'popR', 'b'], [13, 'popL', 'b'],
    [14, 'popR', 'b'], [15, 'bounce', 'b'],
  ] },

  // --- verse A: "flick, flick, clap" with a step-touch, answered by open / cross -----------
  { ease: 'swing', steps: [
    // A1  left, right, clap | rest
    [16, 'flickL'], [17, 'closeL', 'b'], [17.4, 'hipsBoth', 'a'],
    [18, 'flickR'], [19, 'closeR', 'b'], [19.45, 'clapOpen', 'a'],
    [20, 'clap'], [21, 'bounce', 'b'],
    [22, 'swingL', 'u'], [23, 'swingR', 'u'],
    // A2  open ... cross low | rest on the hips, then swing
    [24, 'openBoth'], [25, 'dipC', 'b'],
    [26, 'popL', 'u'], [27, 'popR', 'b'],
    [28, 'crossLow'], [29, 'bounce', 'b'],
    [30, 'swingR', 'u'], [31, 'swingL', 'u'],
    // A3  = A1 mirrored
    [32, 'flickR'], [33, 'closeR', 'b'], [33.4, 'hipsBoth', 'a'],
    [34, 'flickL'], [35, 'closeL', 'b'], [35.45, 'clapOpen', 'a'],
    [36, 'clap'], [37, 'bounce', 'b'],
    [38, 'swingR', 'u'], [39, 'swingL', 'u'],
    // A4  sparkle ... open low | rest on the hips, then the roll that starts the build
    [40, 'wBoth'], [41, 'dipC', 'b'],
    [42, 'popR', 'u'], [43, 'popL', 'b'],
    [44, 'lowV'], [45, 'bounce', 'b'],
  ] },
  { ease: 'snap', steps: [
    [45.5, 'rollL', 'a'], [46, 'rollR', 'a'], [46, 'dipC', 'b'], [46.5, 'rollL', 'a'],
    [47, 'rollR', 'a'], [47, 'bounce', 'b'], [47.5, 'rollL', 'a'],
  ] },

  // --- build: "pump, throw, throw", a long roll, then open - cross - wide - gather ----------
  { ease: 'snap', steps: [
    [48, 'pumpBoth'], [49, 'bounce', 'b'], [49.4, 'rollR', 'a'],
    [50, 'sweepL'], [51, 'wideC', 'b'], [51.4, 'rollL', 'a'],
    [52, 'sweepR'], [53, 'bounce', 'b'],
    [53.5, 'rollR', 'a'], [54, 'rollL', 'a'], [54, 'dipC', 'b'], [54.5, 'rollR', 'a'],
    [55, 'rollL', 'a'], [55, 'bounce', 'b'], [55.5, 'rollR', 'a'],
    [56, 'openBoth'], [57, 'dipC', 'b'],
    [58, 'crossChest'], [59, 'bounce', 'b'],
    [60, 'tBoth', 't0.6'], [61, 'dipC', 'b'], [61.25, 'fallBoth', 'a t0.45'],
    [62, 'gather', 'u'], [63, 'crouch', 'b'],
  ] },

  // --- chorus 1: the hook — burst, catch, throw left, throw right ---------------------------
  { ease: 'snap', steps: [
    // H1
    [64, 'starburst', 'g t0.6'], [65, 'dipC', 'b'], [65.2, 'fallBoth', 'a t0.4'],
    [66, 'heart', 't0.65'], [67, 'bounce', 'b'], [67.45, 'swingR', 'a'],
    [68, 'sweepL'], [69, 'wideC', 'b'],
    [70, 'sweepR'], [71, 'wideC', 'b'],
    // H2  diagonal, hips, diagonal | rest on the hips
    [72, 'skyL', 't0.6'], [73, 'bounce', 'b'], [73.2, 'lowV', 'a t0.4'],
    [74, 'popR'], [75, 'popL', 'b'],
    [76, 'skyR', 't0.6'], [77, 'bounce', 'b'], [77.2, 'lowV', 'a t0.4'],
    [78, 'popL', 'u'], [79, 'popR', 'b'],
    // H1' the hook again, small burst, throws answered the other way round
    [80, 'wBoth'], [81, 'dipC', 'b'],
    [82, 'heart'], [83, 'bounce', 'b'], [83.45, 'swingL', 'a'],
    [84, 'sweepR'], [85, 'wideC', 'b'],
    [86, 'sweepL'], [87, 'bounce', 'b'],
    // H3  pump, cross, BURST | arms rest
    [88, 'pumpBoth'], [89, 'bounce', 'b'],
    [90, 'crossLow'], [91, 'crouch', 'b'],
    [92, 'starburst', 'g t0.6'], [93, 'dipC', 'b'], [93.2, 'fallBoth', 'a t0.4'],
  ] },
  { ease: 'swing', steps: [[94, 'swingR', 'u'], [95, 'swingL', 'u']] },

  // --- verse B: "heart, heart, elbows", a wave each side, two points -----------------------
  { ease: 'swing', steps: [
    // B1
    [96, 'chestL'], [97, 'bounce', 'b'],
    [98, 'chestR'], [99, 'bounce', 'b'],
    [100, 'elbowsOut'], [101, 'bounce', 'b'],
    [102, 'swingL', 'u'], [103, 'swingR', 'u'],
    // B2  wave ... wave | step-touch, rest on the hips
    [104, 'waveL'], [105, 'closeL', 'b'],
    [106, 'popR', 'u'], [107, 'popL', 'b'],
    [108, 'waveR'], [109, 'closeR', 'b'],
    [110, 'swingL', 'u'], [111, 'swingR', 'u'],
    // B3  = B1 mirrored, fists instead of elbows
    [112, 'chestR'], [113, 'bounce', 'b'],
    [114, 'chestL'], [115, 'bounce', 'b'],
    [116, 'pumpBoth'], [117, 'bounce', 'b'],
    [118, 'swingR', 'u'], [119, 'swingL', 'u'],
    // B4  point ... point | hand straight back to the hip
    [120, 'pointL'], [121, 'bounce', 'b'], [121.25, 'hipsBoth', 'a t0.45'],
    [122, 'popR', 'b'], [123, 'popL', 'b'],
    [124, 'pointR'], [125, 'bounce', 'b'], [125.25, 'hipsBoth', 'a t0.45'],
    [126, 'popL', 'b'], [127, 'bounce', 'u'],
  ] },

  // --- bridge: slow breath — heart, open low, reach for the sky, hug -----------------------
  { ease: 'smooth', steps: [
    [128, 'heart'], [130, 'swayR', 'b'],
    [132, 'lowV'], [134, 'swayL', 'u'],
    [136, 'vHigh', 'g t1.1'], [137.3, 'fallBoth', 'a t0.5'], [138, 'swayR', 'u'],
    [140, 'crossChest'],
    [142, 'gather', 'u'], [143, 'crouch', 'b'],
  ] },

  // --- chorus 2: the hook mirrored, new answers, bigger ending ------------------------------
  { ease: 'snap', steps: [
    // H1 mirrored
    [144, 'starburst', 'g t0.6'], [145, 'dipC', 'b'], [145.2, 'fallBoth', 'a t0.4'],
    [146, 'heart', 't0.65'], [147, 'bounce', 'b'], [147.45, 'swingL', 'a'],
    [148, 'sweepR'], [149, 'wideC', 'b'],
    [150, 'sweepL'], [151, 'wideC', 'b'],
    // H2 mirrored, elbows instead of hips
    [152, 'skyR', 't0.6'], [153, 'bounce', 'b'], [153.2, 'lowV', 'a t0.4'],
    [154, 'elbowsOut', 't0.7'], [155, 'bounce', 'b'],
    [156, 'skyL', 't0.6'], [157, 'bounce', 'b'], [157.2, 'lowV', 'a t0.4'],
    [158, 'popR', 'u'], [159, 'popL', 'b'],
    // H1'
    [160, 'wBoth'], [161, 'dipC', 'b'],
    [162, 'heart'], [163, 'bounce', 'b'], [163.45, 'swingR', 'a'],
    [164, 'sweepL'], [165, 'wideC', 'b'],
    [166, 'sweepR'], [167, 'wideC', 'b'],
    // H3  wide, cross, BURST
    [168, 'tBoth', 't0.6'], [169, 'dipC', 'b'], [169.25, 'fallBoth', 'a t0.45'],
    [170, 'crossLow'], [171, 'crouch', 'b'],
    [172, 'starburst', 'g t0.6'], [173, 'dipC', 'b'], [173.2, 'fallBoth', 'a t0.4'],
  ] },
  { ease: 'swing', steps: [[174, 'swingL', 'u'], [175, 'swingR', 'u']] },

  // --- outro: hips, the intro sway again, then point to the sky and let the star fall ---------
  { ease: 'swing', steps: [
    [176, 'popL', 'u'], [177, 'popR', 'b'], [178, 'popL', 'b'], [179, 'popR', 'b'],
  ] },
  { ease: 'smooth', steps: [
    [180, 'swingL', 'u t1.6'], [181, 'bounce', 'b'], [182, 'swingR', 'u t1.6'], [183, 'bounce', 'b'],
    [184, 'heart', 'u'], [186, 'gather', 'u'],
  ] },
  { ease: 'snap', steps: [[188, 'finaleL', 'u t0.6 h0.9']] },
  { ease: 'swing', steps: [[189.8, 'flickL', 'u t0.9'], [TOTAL_BEATS + 4, 'flickL', 'u']] },
  { ease: 'smooth', steps: [[TOTAL_BEATS + 8, 'idle', 'u']] },
];

// ---------------------------------------------------------------------------
// Timing model
// ---------------------------------------------------------------------------
// Per-ease tuning. `window(D)` = beats of travel time at the END of an interval of D beats,
// `overshoot` = fraction of the travelled arc the limb swings past the pose just after the beat,
// `anticipation` = wind-up fraction in the opposite direction at the start of the travel.
export const TIMING = {
  // arms
  snap:   { frac: 0.40, min: 0.50, max: 0.90, overshoot: 0.070, anticipation: 0.05 },
  swing:  { frac: 0.55, min: 0.50, max: 1.10, overshoot: 0.050, anticipation: 0.10 },
  smooth: { frac: 0.60, min: 0.70, max: 2.00, overshoot: 0.020, anticipation: 0.00 },
  // body (legs, hips, spine, head): weight shifts take most of the interval and land on the beat
  body:       { frac: 0.80, min: 0.40, max: 1.60, overshoot: 0.030, anticipation: 0.00 },
  bodySmooth: { frac: 0.90, min: 0.60, max: 2.40, overshoot: 0.000, anticipation: 0.00 },
  settleBeats: 0.40,  // length of the overshoot/settle wobble after arriving
  scoredHold: 0.80,   // beats the arms stay on a scored pose before they may start to leave
  minTravel: 0.20,    // shortest allowed arm travel into a keyframe (authoring guard)
};

// Groove layer amplitudes at full section intensity.
export const GROOVE = {
  knee: 0.15,      // knee bounce (thigh forward / shin back, in direction-vector units)
  rise: 0.42,      // share of a pose's knee bend the up-beat may straighten out
  flexFull: 0.25,  // knee bend (thigh z - shin z) at which the bounce is a full down-up wave
  sway: 0.022,     // spine side sway, alternating every beat
  hipSway: 0.010,  // metres of lateral hip drift with the sway
  twist: 0.05,     // radians of shoulder twist, alternating every beat
  nod: 0.10,       // head nod
  arm: 0.035,      // forearm give with the bounce (z only, invisible to 2D scoring)
  elbow: 0.03,     // elbows breathing out with the bounce (about 1.5 degrees)
  floor: 0.35,     // share of groove that remains at intensity 0
};

function travelWindow(cfg, D) {
  return Math.min(clamp(cfg.frac * D, cfg.min, cfg.max), D * 0.9);
}

function easeTravel(ease, u) {
  const cfg = TIMING[ease] || TIMING.smooth;
  let f;
  if (ease === 'snap') f = smoothstep(Math.pow(u, 1.35));        // late, fast, lands hard
  else if (ease === 'swing') f = smoothstep(Math.pow(u, 1.15));  // loose pendulum
  else if (ease === 'body') f = smoothstep(u);                   // weight transfer
  else f = smootherstep(u);                                      // slow and even
  // wind-up: dips below 0 early in the travel, vanishes by the end
  return f - cfg.anticipation * Math.sin(Math.PI * u) * (1 - u) * (1 - u);
}

const SECTION_CODE = {
  verseA: 'va', build: 'bd', chorus1: 'c1', verseB: 'vb', bridge: 'br', chorus2: 'c2',
};

function parseFlags(flags) {
  const f = { scored: true, gold: false, part: 'all', hold: undefined, travel: undefined };
  for (const tok of String(flags || '').split(/\s+/)) {
    if (!tok) continue;
    if (tok === 'u') f.scored = false;
    else if (tok === 'g') f.gold = true;
    else if (tok === 'a') { f.part = 'arms'; f.scored = false; }
    else if (tok === 'b') { f.part = 'body'; f.scored = false; }
    else if (/^h\d+(\.\d+)?$/.test(tok)) f.hold = parseFloat(tok.slice(1));
    else if (/^t\d+(\.\d+)?$/.test(tok)) f.travel = parseFloat(tok.slice(1));
    else throw new Error(`choreo: unknown routine flag "${tok}"`);
  }
  if (f.gold && !f.scored) throw new Error('choreo: a gold step must be scored');
  return f;
}

// One animation channel (arms or body): keys with the beat each travel starts.
function compileChannel(keys, kind) {
  const out = [];
  let prev = null;
  for (const k of keys) {
    if (prev && !(k.beat > prev.beat)) {
      throw new Error(`choreo: two ${kind} keyframes at beat ${k.beat}`);
    }
    const ease = kind === 'body' ? (k.ease === 'smooth' ? 'bodySmooth' : 'body') : k.ease;
    const key = { beat: k.beat, pose: POSES[k.pose], src: k, ease, start: k.beat, hold: 0 };
    if (kind === 'arms') key.hold = k.hold !== undefined ? k.hold : (k.scored ? TIMING.scoredHold : 0);
    if (prev) {
      const D = k.beat - prev.beat;
      const win = kind === 'arms' && k.travel !== undefined
        ? Math.min(k.travel, D)
        : travelWindow(TIMING[ease], D);
      key.start = Math.max(k.beat - win, prev.beat + prev.hold);
      if (kind === 'arms' && k.beat - key.start < TIMING.minTravel - 1e-9) {
        throw new Error(`choreo: arms cannot reach "${k.pose}" at beat ${k.beat} `
          + `(previous pose is held until ${prev.beat + prev.hold})`);
      }
    }
    out.push(key);
    prev = key;
  }
  return out;
}

const built = (() => {
  const keyframes = [];
  for (const block of ROUTINE) {
    for (const [beat, pose, flags] of block.steps) {
      if (!POSES[pose]) throw new Error(`choreo: routine references unknown pose "${pose}"`);
      keyframes.push({ beat, pose, ease: block.ease, ...parseFlags(flags) });
    }
  }
  // sorted by beat; where an arms key and a body key share a beat the arms key comes first
  const order = { all: 0, arms: 1, body: 2 };
  keyframes.sort((a, b) => a.beat - b.beat || order[a.part] - order[b.part]);

  const arms = compileChannel(keyframes.filter((k) => k.part !== 'body'), 'arms');
  const body = compileChannel(keyframes.filter((k) => k.part !== 'arms'), 'body');

  const counters = {};
  const moves = [];
  for (let i = 0; i < arms.length; i++) {
    const src = arms[i].src;
    if (!src.scored) continue;
    const section = sectionAtBeat(src.beat);
    if (!section.scored) {
      throw new Error(`choreo: scored move at beat ${src.beat} in unscored section ${section.name}`);
    }
    const code = SECTION_CODE[section.name] || section.name;
    counters[code] = (counters[code] || 0) + 1;
    // how long the arms really stay on the pose: until the next arm keyframe starts travelling
    const leave = i + 1 < arms.length ? arms[i + 1].start : src.beat + 2;
    moves.push({
      id: `${code}-${String(counters[code]).padStart(2, '0')}`,
      beat: src.beat,
      pose: src.pose,
      label: POSE_LABELS[src.pose] || src.pose,
      gold: src.gold,
      hold: Math.round((leave - src.beat) * 100) / 100,
      section: section.name,
    });
  }

  const publicKeys = keyframes.map((k) => ({
    beat: k.beat, pose: k.pose, ease: k.ease, part: k.part, scored: k.scored,
  }));
  return { keyframes: publicKeys, moves, arms, body };
})();

/** Scored targets, sorted by beat. */
export const MOVES = built.moves;
/**
 * Dancer animation keys, sorted by beat: { beat, pose, ease, part, scored }.
 * `part` says which channel the key drives: 'all' (arms + body, every scored move),
 * 'arms' (in-between arm shape; the body keeps moving) or 'body' (step / sway / pop; the
 * arms keep holding). `pose` always names an entry of POSES.
 */
export const KEYFRAMES = built.keyframes;

const ARM_KEYS = built.arms;
const BODY_KEYS = built.body;
const FIRST_BEAT = KEYFRAMES[0].beat;
const LAST_BEAT = KEYFRAMES[KEYFRAMES.length - 1].beat;

function keyIndex(keys, beat) {
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].beat <= beat) lo = mid; else hi = mid - 1;
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

/** Groove gain 0..1 at a beat (GROOVE.floor at intensity 0, 1 in the choruses). */
export function grooveLevel(beat) {
  const b = Number.isFinite(beat) ? beat : 0;
  return GROOVE.floor + (1 - GROOVE.floor) * clamp(intensityAt(b), 0, 1);
}

// Writes one channel's segments (and, for the body, hipX / yaw) at `beat` into `out`.
function sampleChannel(keys, segs, scalars, beat, out) {
  const i = keyIndex(keys, beat);
  const cur = keys[i];
  const next = keys[i + 1];
  let a = cur.pose, b = cur.pose, t = 1;
  if (next && beat >= next.start) {
    // travelling: arrives exactly on next.beat
    a = cur.pose; b = next.pose;
    t = easeTravel(next.ease, (beat - next.start) / (next.beat - next.start));
  } else if (i > 0) {
    // holding: decaying overshoot right after the hit, exact on the beat itself
    const dt = beat - cur.beat;
    const settle = Math.min(TIMING.settleBeats, (next ? next.start : Infinity) - cur.beat);
    if (dt > 0 && dt < settle) {
      const x = dt / settle;
      const e = TIMING[cur.ease].overshoot * Math.sin(Math.PI * x) * (1 - x) * 1.6;
      if (e > 1e-6) { a = keys[i - 1].pose; b = cur.pose; t = 1 + e; }
    }
  }
  if (a === b) {
    for (const seg of segs) { const v = b[seg]; out[seg] = [v[0], v[1], v[2]]; }
    if (scalars) { out.hipX = b.hipX; out.yaw = b.yaw; }
    return;
  }
  for (const seg of segs) out[seg] = slerpVec(a[seg], b[seg], t);
  if (scalars) {
    const tl = clamp(t, -0.1, 1.1);
    out.hipX = lerp(a.hipX, b.hipX, tl);
    out.yaw = lerp(a.yaw, b.yaw, tl);
  }
}

function baseAt(beat) {
  const out = {};
  if (beat <= FIRST_BEAT || beat >= LAST_BEAT) {
    for (const seg of SEGMENTS) { const v = IDLE[seg]; out[seg] = [v[0], v[1], v[2]]; }
    out.hipX = IDLE.hipX; out.yaw = IDLE.yaw;
    return out;
  }
  sampleChannel(BODY_KEYS, BODY_SEGMENTS, true, beat, out);
  sampleChannel(ARM_KEYS, ARM_SEGMENTS, false, beat, out);
  return out;
}

// Continuous groove. Every term is exactly zero on integer beats, so a scored pose is
// untouched at the instant it is judged. With soft knees the bounce is a real down-up wave
// (the body drops into the beat, sinks just after it and rises through the off-beat); with
// straight legs there is nothing to straighten, so it is a plain give after the beat.
function applyGroove(p, beat) {
  const g = grooveLevel(beat);
  const phase = beat - Math.floor(beat);
  const s = Math.sin(Math.PI * Math.pow(phase, 0.65));
  const give = s * s;                                   // 0 on the beat, deepest ~0.3 beats later
  const a = 2 * Math.PI * phase;
  const wave = (Math.sin(a) + 0.25 * Math.sin(2 * a)) / 1.1;  // + sink (0.2), - rise (0.8)
  const sway = Math.sin(Math.PI * beat);                // alternates side every beat

  for (const side of ['l', 'r']) {
    const out = side === 'l' ? -1 : 1;
    const th = p[side + 'Thigh'], sh = p[side + 'Shin'];
    const flex = Math.max(0, th[2] - sh[2]);
    const soft = clamp(flex / GROOVE.flexFull, 0, 1);
    let k = GROOVE.knee * g * lerp(give, wave, soft);
    if (k < 0) k = Math.max(k, -flex * GROOVE.rise);
    th[2] += k; sh[2] -= k * 1.1;
    p[side + 'Thigh'] = norm(th, IDLE[side + 'Thigh']);
    p[side + 'Shin'] = norm(sh, IDLE[side + 'Shin']);
    const ua = p[side + 'UpperArm'], fa = p[side + 'Forearm'];
    ua[0] += out * GROOVE.elbow * g * give;
    fa[2] += GROOVE.arm * g * give;
    p[side + 'UpperArm'] = norm(ua, IDLE[side + 'UpperArm']);
    p[side + 'Forearm'] = norm(fa, IDLE[side + 'Forearm']);
  }
  const sp = p.spine;
  sp[0] += GROOVE.sway * g * sway;
  sp[2] += 0.03 * g * give;
  p.spine = norm(sp, IDLE.spine);
  const hd = p.head;
  hd[0] -= GROOVE.sway * 0.6 * g * sway;
  hd[2] += GROOVE.nod * g * give;
  p.head = norm(hd, IDLE.head);
  p.hipX += GROOVE.hipSway * g * sway;
  p.yaw += GROOVE.twist * g * sway;
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
