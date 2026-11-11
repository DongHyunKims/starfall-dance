// STARFALL — webcam pose tracking (MediaPipe PoseLandmarker -> contract pose), one or two people.
//
// Mirror convention (CONTRACT.md): limb names are SCREEN-side names and the player sees
// themself mirrored. MediaPipe landmark 11 is the person's anatomical LEFT shoulder; in the raw
// (un-mirrored) camera image a person facing the camera has their left side at large x. After
// mirroring x -> 1 - x that side sits on the screen-left, which is our `l*` side. So:
//   MediaPipe LEFT_* landmarks  -> l* segments,  MediaPipe RIGHT_* landmarks -> r* segments,
// and only the x axis is flipped. Image y grows downwards, stage y grows upwards, so y is negated
// for directions. z is ignored (0): one RGB camera cannot measure depth well enough to judge on.
//
// Players (CONTRACT-v2.md): the tracker follows up to `maxPlayers` people (1 or 2) and keeps each
// of them in a SLOT — slot 0 = P1, slot 1 = P2. In 2P the person further screen-left is slot 0.
// Identity is sticky (nearest shoulder centroid from frame to frame); two people only trade
// slots after they have clearly stood crossed over for about a second; when one leaves, the
// other keeps their slot. In 1P the most prominent person is followed and kept. All of that is
// the pure function assignSlots() below. Each slot has its own One-Euro filter bank, reset
// whenever the slot's person changes, and its own result object that is updated in place:
// update() / getPlayers() allocate nothing per frame.
//
// This module touches the DOM only inside the functions of createPoseTracker, so the pure
// helpers (poseFromLandmarks, assignSlots, completePose, createOneEuro) import fine in Node
// (see test/tracker.test.mjs).

const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// MediaPipe pose landmark indices.
const LM = Object.freeze({
  NOSE: 0, L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
});
const LANDMARK_COUNT = 33;
const SEGMENTS = Object.freeze([
  'spine', 'head',
  'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm',
  'lThigh', 'lShin', 'rThigh', 'rShin',
]);
const ARM_FROM = 2; // SEGMENTS[2..5] are the arms, SEGMENTS[6..9] the legs
const ARM_TO = 5;
/** At most this many detections of one frame are looked at (the detector returns 1 or 2). */
const MAX_DETECTIONS = 6;

/** Bones of the mirrored landmark set, for the HUD skeleton overlay. */
export const SKELETON_EDGES = Object.freeze([
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
]);

/** Tuning knobs; override any of them through createPoseTracker(videoEl, options). */
export const TRACKER_DEFAULTS = Object.freeze({
  // One-Euro filter on landmark positions (normalised image units, seconds).
  minCutoff: 1.7,   // Hz. Lower = steadier when still, more lag on slow moves.
  beta: 6.0,        // Speed coefficient. Higher = less lag on fast moves, more jitter.
  dCutoff: 1.0,     // Hz, derivative low-pass.
  visibilityTau: 0.08, // s, smoothing of per-landmark visibility.
  // Detector thresholds.
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  // A result older than this (ms) is treated as "no player".
  staleMs: 400,
  // How many people are tracked: 1 or 2 (tracker.setMaxPlayers changes it at any time).
  maxPlayers: 1,
  // --- slotting (assignSlots); distances are fractions of the image width ---
  // A person is recognised from one detection to the next when their shoulder centroid is
  // within matchRadius (plus matchSpeed for every second they were not seen, capped at
  // matchRadiusMax) of where they were — or of where they were heading: their sideways speed
  // is followed, looking at most matchPredictSec ahead. Deliberately tight: somebody else
  // standing a quarter of the picture away is never taken for the player.
  matchRadius: 0.15,
  matchSpeed: 0.1,
  matchRadiusMax: 0.25,
  matchPredictSec: 0.25,
  // Telling two people apart when they pass each other: half of the matching cost is the
  // distance to where the person was, half the distance to where they were heading, plus
  // matchSizeWeight for a completely different shoulder width (somebody nearer or further away).
  matchSizeWeight: 0.06,
  // A slot whose person has not been seen for this long (ms) is freed for whoever comes next.
  holdMs: 700,
  // 2P: slots swap once slot 0's person has stood at least swapMargin to the RIGHT of slot 1's
  // for swapMs without ever being back on the left in between (a sustained crossover).
  swapMs: 1000,
  swapMargin: 0.06,
  // Two detections of the same size (within duplicateSize, relative) whose centroids are closer
  // than duplicateRadius shoulder widths are one person seen twice (multi-pose detectors do
  // that now and then); the smaller one is ignored. Two real people passing each other are
  // not the same size on screen: one of them is in front.
  duplicateRadius: 0.35,
  duplicateSize: 0.2,
  // 1P / newcomers: shoulder widths within this relative margin are a tie -> more central wins.
  prominenceTie: 0.1,
  // --- completePose ---
  // Segment confidence -> how much of the tracked direction is used (0 below, 1 above).
  completeConfLow: 0.2,
  completeConfHigh: 0.6,
  // Forward z given to a flat (2D) arm segment, per unit of its on-screen length.
  armForwardZ: 0.12,
  // Consecutive detector failures before the GPU delegate is swapped for CPU.
  maxErrors: 3,
  // Camera request.
  width: 640,
  height: 480,
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
// Not Math.hypot: V8 allocates an array on every call of it, and update() must not allocate.
const len2 = (x, y) => Math.sqrt(x * x + y * y);
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

/** One-Euro filter bank over `n` scalar channels. */
export function createOneEuro(n, { minCutoff = 1.7, beta = 6, dCutoff = 1 } = {}) {
  const x = new Float64Array(n);
  const dx = new Float64Array(n);
  let primed = false;
  return {
    reset() { primed = false; },
    /** Filters `values` (length n) in place given the seconds since the previous call. */
    apply(values, dt) {
      if (!primed || !(dt > 0) || dt > 0.5) {
        for (let i = 0; i < n; i++) { x[i] = values[i]; dx[i] = 0; }
        primed = true;
        return values;
      }
      // Low-pass weight for a cutoff f: 1 / (1 + tau / dt) with tau = 1 / (2 pi f), written
      // out as w / (1 + w), w = 2 pi f dt (no helper call per channel: nothing to allocate).
      const k = 2 * Math.PI * dt;
      const wd = k * dCutoff;
      const ad = wd / (1 + wd);
      for (let i = 0; i < n; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) { values[i] = x[i]; continue; }
        if (!Number.isFinite(x[i])) { x[i] = v; dx[i] = 0; continue; } // channel had no value yet
        const rawD = (v - x[i]) / dt;
        dx[i] += (rawD - dx[i]) * ad;
        const w = k * (minCutoff + beta * Math.abs(dx[i]));
        x[i] += (v - x[i]) * (w / (1 + w));
        values[i] = x[i];
      }
      return values;
    },
  };
}

// Scratch for poseFromLandmarks: position and usable visibility of the 33 landmarks plus three
// derived points — 33 = shoulder midpoint, 34 = hip midpoint, 35 = head (between ears and nose).
const PT_SHOULDERS = 33;
const PT_HIPS = 34;
const PT_HEAD = 35;
const PX = new Float64Array(LANDMARK_COUNT + 3);
const PY = new Float64Array(LANDMARK_COUNT + 3);
const VIS = new Float64Array(LANDMARK_COUNT + 3);
const SEG_CONF = new Float64Array(SEGMENTS.length);
// Segment i runs from point SEG_FROM[i] to point SEG_TO[i] (same order as SEGMENTS).
const SEG_FROM = Int8Array.of(PT_HIPS, PT_SHOULDERS, LM.L_SHOULDER, LM.L_ELBOW, LM.R_SHOULDER, LM.R_ELBOW,
  LM.L_HIP, LM.L_KNEE, LM.R_HIP, LM.R_KNEE);
const SEG_TO = Int8Array.of(PT_SHOULDERS, PT_HEAD, LM.L_ELBOW, LM.L_WRIST, LM.R_ELBOW, LM.R_WRIST,
  LM.L_KNEE, LM.L_ANKLE, LM.R_KNEE, LM.R_ANKLE);

/** A blank result of poseFromLandmarks (every vector and field present, ready to be filled in place). */
function makePoseResult() {
  const pose = { hipX: 0, yaw: 0 };
  const confidence = {};
  for (let i = 0; i < SEGMENTS.length; i++) {
    pose[SEGMENTS[i]] = [0, i < 2 ? 1 : -1, 0];
    confidence[SEGMENTS[i]] = 0;
  }
  return { pose, confidence, bodyVisible: 0, upperVisible: 0, cx: 0.5, cy: 0.5, size: 0 };
}

/**
 * Convert MIRRORED, normalised image landmarks into the contract pose.
 * @param {Array<{x:number,y:number,v:number}>} lm  33 landmarks, x already mirrored (0 = screen
 *        left), y image-down (0 = top), v = visibility 0..1
 * @param {number} aspect  video width / height, so that directions are true on-screen angles
 * @param {object} [out]  a previous return value to fill in place (nothing is allocated then)
 * @returns {{pose:object, confidence:object, bodyVisible:number, upperVisible:number,
 *            cx:number, cy:number, size:number}}
 *   upperVisible  0..1, how much of shoulders + elbows + wrists is seen (what play needs);
 *   cx, cy        shoulder midpoint: mirrored x (0 = screen left) and y (0 = top), 0..1;
 *   size          shoulder width as a fraction of the image width (how prominent the person is).
 */
export function poseFromLandmarks(lm, aspect = 4 / 3, out) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
  const res = out && out.pose && out.confidence ? out : makePoseResult();

  // Landmarks -> scratch. Visibility counts fully inside the frame and fades to 0 a little
  // outside it (MediaPipe extrapolates off-screen joints).
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = lm[i];
    const x = +p.x; // unary plus: keeps the numbers unboxed in V8 (see ingest() below)
    const y = +p.y;
    PX[i] = x;
    PY[i] = y;
    const ox = x < 0 ? -x : x > 1 ? x - 1 : 0;
    const oy = y < 0 ? -y : y > 1 ? y - 1 : 0;
    let u = ((ox > oy ? ox : oy) - 0.02) / 0.1;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const v = +p.v;
    VIS[i] = (v < 0 ? 0 : v > 1 ? 1 : v) * (1 - u * u * (3 - 2 * u));
  }
  const LS = LM.L_SHOULDER, RS = LM.R_SHOULDER, LH = LM.L_HIP, RH = LM.R_HIP;
  PX[PT_SHOULDERS] = (PX[LS] + PX[RS]) / 2;
  PY[PT_SHOULDERS] = (PY[LS] + PY[RS]) / 2;
  VIS[PT_SHOULDERS] = Math.min(VIS[LS], VIS[RS]);
  PX[PT_HIPS] = (PX[LH] + PX[RH]) / 2;
  PY[PT_HIPS] = (PY[LH] + PY[RH]) / 2;
  VIS[PT_HIPS] = Math.min(VIS[LH], VIS[RH]);
  PX[PT_HEAD] = ((PX[LM.L_EAR] + PX[LM.R_EAR]) / 2 + PX[LM.NOSE]) / 2;
  PY[PT_HEAD] = ((PY[LM.L_EAR] + PY[LM.R_EAR]) / 2 + PY[LM.NOSE]) / 2;
  VIS[PT_HEAD] = Math.max(VIS[LM.NOSE], Math.min(VIS[LM.L_EAR], VIS[LM.R_EAR]));

  // Body scale in aspect-corrected units: torso length, or shoulder width when hips are unseen.
  const torso = len2((PX[PT_SHOULDERS] - PX[PT_HIPS]) * a, PY[PT_SHOULDERS] - PY[PT_HIPS]);
  const shoulderW = len2((PX[LS] - PX[RS]) * a, PY[LS] - PY[RS]);
  const scale = Math.max(torso, shoulderW * 1.3, 1e-4);

  // Segment directions: from -> to in image space, x aspect-corrected, y flipped to up.
  // conf = the weaker end point, reduced when the segment is so foreshortened (pointing at
  // the camera) that its 2D direction is mostly noise.
  const pose = res.pose;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const f = SEG_FROM[i];
    const t = SEG_TO[i];
    const dx = (PX[t] - PX[f]) * a;
    const dy = -(PY[t] - PY[f]);
    const len = Math.sqrt(dx * dx + dy * dy);
    const v = pose[SEGMENTS[i]];
    if (!(len > 1e-6)) {
      v[0] = 0; v[1] = i < 2 ? 1 : -1; v[2] = 0;
      SEG_CONF[i] = 0;
      continue;
    }
    v[0] = dx / len; v[1] = dy / len; v[2] = 0;
    let u = (len / scale - 0.06) / 0.14;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const c = (VIS[f] < VIS[t] ? VIS[f] : VIS[t]) * (u * u * (3 - 2 * u));
    SEG_CONF[i] = c < 0 ? 0 : c > 1 ? 1 : c;
  }
  pose.hipX = 0;
  pose.yaw = 0;
  const conf = res.confidence; // named stores: a keyed store would box every number
  conf.spine = SEG_CONF[0]; conf.head = SEG_CONF[1];
  conf.lUpperArm = SEG_CONF[2]; conf.lForearm = SEG_CONF[3];
  conf.rUpperArm = SEG_CONF[4]; conf.rForearm = SEG_CONF[5];
  conf.lThigh = SEG_CONF[6]; conf.lShin = SEG_CONF[7];
  conf.rThigh = SEG_CONF[8]; conf.rShin = SEG_CONF[9];

  // How much of the body is usable: torso and arms matter most, feet least.
  const upper = VIS[LS] + VIS[RS] + VIS[LM.L_ELBOW] + VIS[LM.R_ELBOW] + VIS[LM.L_WRIST] + VIS[LM.R_WRIST];
  res.bodyVisible = clamp01(
    ((VIS[LS] + VIS[RS]) * 2 + (VIS[LH] + VIS[RH]) * 2
      + (VIS[LM.L_ELBOW] + VIS[LM.R_ELBOW]) * 1.5 + (VIS[LM.L_WRIST] + VIS[LM.R_WRIST]) * 1.5
      + (VIS[LM.L_KNEE] + VIS[LM.R_KNEE]) * 1 + (VIS[LM.L_ANKLE] + VIS[LM.R_ANKLE]) * 0.5) / 17);
  // What upper-body play needs: shoulders, elbows, wrists.
  res.upperVisible = clamp01(upper / 6);
  const smx = PX[PT_SHOULDERS];
  const smy = PY[PT_SHOULDERS];
  res.cx = Number.isFinite(smx) ? clamp01(smx) : 0.5;
  res.cy = Number.isFinite(smy) ? clamp01(smy) : 0.5;
  const size = len2(PX[LS] - PX[RS], (PY[LS] - PY[RS]) / a);
  res.size = Number.isFinite(size) ? size : 0;
  return res;
}

// ---------------------------------------------------------------------------
// Slotting: who is P1, who is P2 (pure; exercised in test/tracker.test.mjs)
// ---------------------------------------------------------------------------
const emptySlot = () => ({ id: 0, cx: 0.5, cy: 0.5, size: 0, vx: 0, seenT: NaN, det: -1 });

/**
 * A blank slot state: nobody tracked.
 *   slots[k]      { id, cx, cy, size, vx, seenT, det } — id 0 = empty, otherwise the id of the
 *                 person in the slot (a new number for every new person; a person keeps their
 *                 id when they change slot); cx / cy / size as last seen; vx = sideways speed
 *                 (image widths per second); seenT = when they were last seen (ms);
 *                 det = index of this person in the `detections` of the latest call, -1 = not seen;
 *   crossedSince  2P: since when (ms) the two have been standing crossed over, NaN = they are not;
 *   swapped       the latest call swapped the two slots;
 *   people        usable detections in the latest call (duplicates and garbage left out).
 */
export function createSlotState() {
  return { t: NaN, nextId: 1, crossedSince: NaN, swapped: false, people: 0, slots: [emptySlot(), emptySlot()] };
}

function copySlot(from, to) {
  to.id = from.id; to.cx = from.cx; to.cy = from.cy; to.size = from.size; to.vx = from.vx;
  to.seenT = from.seenT; to.det = from.det;
}
function clearSlot(slot) {
  slot.id = 0; slot.cx = 0.5; slot.cy = 0.5; slot.size = 0; slot.vx = 0; slot.seenT = NaN; slot.det = -1;
}
/** A newcomer moves into an empty slot. */
function occupySlot(slot, id, d, index, now) {
  slot.id = id;
  slot.cx = d.cx;
  slot.cy = Number.isFinite(d.cy) ? d.cy : 0.5;
  slot.size = d.size;
  slot.vx = 0;
  slot.seenT = now;
  slot.det = index;
}
/** The slot's person was found again: follow them (and their sideways speed). */
function seeSlot(slot, d, index, now) {
  const dt = (now - slot.seenT) / 1000;
  if (dt > 0 && dt <= 0.3) slot.vx += ((d.cx - slot.cx) / dt - slot.vx) * 0.6;
  else if (dt > 0.3) slot.vx = 0;
  slot.cx = d.cx;
  if (Number.isFinite(d.cy)) slot.cy = d.cy;
  slot.size += (d.size - slot.size) * 0.5;
  slot.seenT = now;
  slot.det = index;
}
/**
 * Matching cost of detection d for the slot's person (distance from where they were, from
 * where they were heading, and a size cue), or -1 when d is out of their reach.
 */
function slotCost(slot, d, now, cfg) {
  const unseen = Math.max(0, (now - slot.seenT) / 1000);
  const reach = Math.min(cfg.matchRadiusMax, cfg.matchRadius + cfg.matchSpeed * unseen);
  const dy = Number.isFinite(d.cy) ? (d.cy - slot.cy) * 0.5 : 0; // people move sideways, rarely up
  const dist = len2(d.cx - slot.cx, dy);
  const ahead = slot.cx + slot.vx * Math.min(cfg.matchPredictSec, unseen);
  const predicted = len2(d.cx - ahead, dy);
  if (dist > reach && predicted > reach) return -1;
  const big = Math.max(slot.size, d.size);
  const sizeOff = big > 0 ? Math.abs(slot.size - d.size) / big : 0;
  return 0.5 * dist + 0.5 * predicted + cfg.matchSizeWeight * sizeOff;
}
/** Should detection a be preferred over b? Larger shoulder width; within the tie margin, more central. */
function moreProminent(a, b, tie) {
  if (a.size > b.size * (1 + tie)) return true;
  if (b.size > a.size * (1 + tie)) return false;
  const ca = Math.abs(a.cx - 0.5);
  const cb = Math.abs(b.cx - 0.5);
  return ca !== cb ? ca < cb : a.size > b.size;
}

// Scratch for assignSlots: 0 = free, 1 = taken by a slot, 2 = ignored (garbage or duplicate).
const DET_FLAG = new Int8Array(MAX_DETECTIONS);
const MISS_COST = 10;

function pickProminent(detections, n, tie) {
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (DET_FLAG[i] !== 0) continue;
    if (best < 0 || moreProminent(detections[i], detections[best], tie)) best = i;
  }
  return best;
}

/**
 * Decide which detected person is in which slot. Pure: `prev` and `detections` are not
 * modified and the result depends on the arguments only.
 *
 * Rules (CONTRACT-v2.md):
 *   * a person stays in their slot (nearest centroid within reach) — whoever else shows up;
 *   * 2P: two people appearing together are ordered by screen position, left = slot 0; a person
 *     alone takes the slot of the screen half they stand in; a newcomer takes the free slot
 *     (once the other player is in view, or gone for good);
 *     if that leaves slot 0's person standing to the RIGHT of slot 1's, the slots swap once the
 *     crossover has lasted swapMs (people leaning past each other for a moment change nothing);
 *     when one leaves, the other keeps their slot;
 *   * 1P: the most prominent person (largest shoulder width, tie -> most central) is slot 0 and
 *     is kept even if someone more prominent walks in; slot 1 is always empty;
 *   * a slot whose person has not been seen for holdMs is freed.
 *
 * @param {object|null} prev  the state returned by the previous call (null / undefined = nobody)
 * @param {Array<{cx:number, cy?:number, size:number}>} detections  the people in this frame:
 *        cx = mirrored x of the shoulder midpoint (0 = screen left .. 1), cy = its y (0 = top),
 *        size = shoulder width as a fraction of the image width
 * @param {number} maxPlayers  1 or 2
 * @param {number} [nowMs]  time of this frame (default: 45 ms after prev)
 * @param {object} [out]  state object to write into (default: a new one; may be `prev` itself
 *        to update in place without allocating)
 * @param {object} [tuning]  overrides of the slotting knobs in TRACKER_DEFAULTS
 * @returns {object} the new state, see createSlotState()
 */
export function assignSlots(prev, detections, maxPlayers, nowMs, out, tuning) {
  const cfg = tuning || TRACKER_DEFAULTS;
  const next = out || createSlotState();
  if (prev && prev !== next) {
    next.nextId = prev.nextId;
    next.crossedSince = prev.crossedSince;
    copySlot(prev.slots[0], next.slots[0]);
    copySlot(prev.slots[1], next.slots[1]);
  } else if (!prev) {
    next.nextId = 1;
    next.crossedSince = NaN;
    clearSlot(next.slots[0]);
    clearSlot(next.slots[1]);
  }
  const now = Number.isFinite(nowMs) ? nowMs : (prev && Number.isFinite(prev.t) ? prev.t + 45 : 0);
  next.t = now;
  next.swapped = false;
  const S = next.slots;
  const two = maxPlayers === 2;
  S[0].det = -1;
  S[1].det = -1;

  // 1P has one slot. Coming from 2P, whoever is left moves into it (slot 0's person stays).
  if (!two) {
    if (S[0].id === 0 && S[1].id !== 0) copySlot(S[1], S[0]);
    clearSlot(S[1]);
    next.crossedSince = NaN;
  }

  // Usable detections; a person seen twice counts once.
  const n = detections ? Math.min(detections.length, MAX_DETECTIONS) : 0;
  let people = 0;
  for (let i = 0; i < n; i++) {
    const d = detections[i];
    DET_FLAG[i] = d && Number.isFinite(d.cx) && d.size > 0 && Number.isFinite(d.size) ? 0 : 2;
  }
  for (let i = 0; i < n; i++) {
    if (DET_FLAG[i] !== 0) continue;
    for (let j = i + 1; j < n; j++) {
      if (DET_FLAG[j] !== 0) continue;
      const a = detections[i];
      const b = detections[j];
      const big = Math.max(a.size, b.size);
      const reach = cfg.duplicateRadius * big;
      const dy = Number.isFinite(a.cy) && Number.isFinite(b.cy) ? Math.abs(a.cy - b.cy) : 0;
      if (Math.abs(a.cx - b.cx) < reach && dy < reach * 2
        && Math.abs(a.size - b.size) <= cfg.duplicateSize * big) {
        if (moreProminent(a, b, 0)) DET_FLAG[j] = 2; else { DET_FLAG[i] = 2; break; }
      }
    }
  }
  for (let i = 0; i < n; i++) if (DET_FLAG[i] === 0) people++;
  next.people = people;

  // Forget people who have been gone for too long.
  for (let k = 0; k < 2; k++) {
    if (S[k].id !== 0 && !(now - S[k].seenT <= cfg.holdMs)) clearSlot(S[k]);
  }

  // Sticky identity: the pairing of tracked people and detections with the most matches and,
  // among those, the least total cost (a greedy nearest-first pairing can swap two people who
  // both stepped the same way; position alone cannot follow two people passing each other).
  const occ0 = S[0].id !== 0;
  const occ1 = two && S[1].id !== 0;
  if (occ0 || occ1) {
    let bestA = -1;
    let bestB = -1;
    let bestCost = Infinity;
    for (let a = -1; a < n; a++) {
      let ca = occ0 ? MISS_COST : 0;
      if (a >= 0) {
        if (!occ0 || DET_FLAG[a] !== 0) continue;
        ca = slotCost(S[0], detections[a], now, cfg);
        if (ca < 0) continue;
      }
      for (let b = -1; b < n; b++) {
        let cb = occ1 ? MISS_COST : 0;
        if (b >= 0) {
          if (!occ1 || b === a || DET_FLAG[b] !== 0) continue;
          cb = slotCost(S[1], detections[b], now, cfg);
          if (cb < 0) continue;
        }
        if (ca + cb < bestCost) { bestCost = ca + cb; bestA = a; bestB = b; }
      }
    }
    if (bestA >= 0) { seeSlot(S[0], detections[bestA], bestA, now); DET_FLAG[bestA] = 1; }
    if (bestB >= 0) { seeSlot(S[1], detections[bestB], bestB, now); DET_FLAG[bestB] = 1; }
  }

  // Newcomers take the free slots.
  const tie = cfg.prominenceTie;
  if (!two) {
    if (S[0].id === 0) {
      const i = pickProminent(detections, n, tie);
      if (i >= 0) { occupySlot(S[0], next.nextId++, detections[i], i, now); DET_FLAG[i] = 1; }
    }
  } else if (S[0].id === 0 && S[1].id === 0) {
    const i = pickProminent(detections, n, tie);
    if (i >= 0) {
      DET_FLAG[i] = 1;
      const j = pickProminent(detections, n, tie);
      if (j >= 0) {
        DET_FLAG[j] = 1;
        const left = detections[i].cx <= detections[j].cx ? i : j;
        const right = left === i ? j : i;
        occupySlot(S[0], next.nextId++, detections[left], left, now);
        occupySlot(S[1], next.nextId++, detections[right], right, now);
      } else {
        const k = detections[i].cx < 0.5 ? 0 : 1; // alone: the slot of the half they stand in
        occupySlot(S[k], next.nextId++, detections[i], i, now);
      }
    }
  } else if (S[0].id === 0 || S[1].id === 0) {
    // One slot is free. While the other slot's person is merely not seen for a moment, an
    // unmatched detection is more likely that same person re-found out of reach than somebody
    // new — it waits until they are seen again or their slot is freed.
    const k = S[0].id === 0 ? 0 : 1;
    if (S[1 - k].det >= 0) {
      const i = pickProminent(detections, n, tie);
      if (i >= 0) { occupySlot(S[k], next.nextId++, detections[i], i, now); DET_FLAG[i] = 1; }
    }
  }

  // 2P: left is slot 0. A sustained crossover swaps the slots; a brief one does not.
  if (two && S[0].id !== 0 && S[1].id !== 0) {
    const over = S[0].cx - S[1].cx; // > 0: slot 0's person stands to the right of slot 1's
    if (!(over > 0)) {
      next.crossedSince = NaN;
    } else if (over > cfg.swapMargin) {
      if (!(next.crossedSince <= now)) {
        next.crossedSince = now;
      } else if (now - next.crossedSince >= cfg.swapMs && S[0].det >= 0 && S[1].det >= 0) {
        const id = S[0].id, cx = S[0].cx, cy = S[0].cy, size = S[0].size, vx = S[0].vx;
        const seenT = S[0].seenT, det = S[0].det;
        copySlot(S[1], S[0]);
        S[1].id = id; S[1].cx = cx; S[1].cy = cy; S[1].size = size; S[1].vx = vx;
        S[1].seenT = seenT; S[1].det = det;
        next.crossedSince = NaN;
        next.swapped = true;
      }
    } // 0 < over <= swapMargin: side by side / overlapping — the clock keeps what it had
  } else {
    next.crossedSince = NaN;
  }
  return next;
}

// ---------------------------------------------------------------------------
// completePose: a full pose for driving an avatar from a (partly seen) tracked player
// ---------------------------------------------------------------------------
const REST_POSE = Object.freeze({
  spine: [0, 1, 0], head: [0, 1, 0],
  lUpperArm: [-0.2, -1, 0], lForearm: [-0.1, -1, 0.1],
  rUpperArm: [0.2, -1, 0], rForearm: [0.1, -1, 0.1],
  lThigh: [-0.08, -1, 0], lShin: [0, -1, 0],
  rThigh: [0.08, -1, 0], rShin: [0, -1, 0],
  hipX: 0, yaw: 0,
});
const isVec3 = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length >= 2
  && Number.isFinite(v[0]) && Number.isFinite(v[1]);

/**
 * A full, normalised pose for an avatar. Pure; allocates nothing when `out` is passed.
 *
 *   * every segment is blended between the tracked direction and `fallbackPose` by its
 *     confidence: at or below completeConfLow the fallback, at or above completeConfHigh the
 *     player, eased in between — so legs that are out of frame follow the fallback (the idle
 *     pose, or the coach's current pose) instead of snapping to noise;
 *   * tracked ARM segments are flat (z = 0, one camera sees no depth): they get a small forward
 *     z (armForwardZ per unit of on-screen length) so an arm folded across the chest lies in
 *     front of the avatar's torso instead of inside it. The on-screen direction is unchanged;
 *   * hipX / yaw come from the fallback to the extent the legs do.
 *
 * @param {object|null} result  a tracker result ({ pose, confidence }) or a bare pose; null = nobody
 * @param {object} [fallbackPose]  full pose in contract format (default: the neutral standing pose)
 * @param {object} [out]  pose object to write into (default: a new one)
 * @param {object} [tuning]  overrides of the completePose knobs in TRACKER_DEFAULTS
 * @returns {object} out — { spine: [x, y, z], ..., hipX, yaw }
 */
export function completePose(result, fallbackPose, out, tuning) {
  const cfg = tuning || TRACKER_DEFAULTS;
  const o = out || {};
  const fb = fallbackPose || REST_POSE;
  const pose = result && result.pose && typeof result.pose === 'object' ? result.pose
    : (result && isVec3(result.spine) ? result : null);
  const conf = pose && result.pose === pose && result.confidence && typeof result.confidence === 'object'
    ? result.confidence : null;
  const lo = cfg.completeConfLow;
  const span = cfg.completeConfHigh - lo;
  let legs = 0;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const s = SEGMENTS[i];
    const f = isVec3(fb[s]) ? fb[s] : REST_POSE[s];
    let fx = f[0], fy = f[1], fz = Number.isFinite(f[2]) ? f[2] : 0;
    const fl = len3(fx, fy, fz);
    if (fl > 1e-9) { fx /= fl; fy /= fl; fz /= fl; } else { fx = REST_POSE[s][0]; fy = REST_POSE[s][1]; fz = 0; }

    let w = 0;
    let px = 0, py = 0, pz = 0;
    const p = pose ? pose[s] : null;
    if (isVec3(p)) {
      px = p[0]; py = p[1]; pz = Number.isFinite(p[2]) ? p[2] : 0;
      const flat = len2(px, py);
      if (i >= ARM_FROM && i <= ARM_TO && Math.abs(pz) < 1e-3 * flat) pz = cfg.armForwardZ * flat;
      const pl = len3(px, py, pz);
      if (pl > 1e-9) {
        px /= pl; py /= pl; pz /= pl;
        const c = conf ? conf[s] : 1;
        w = Number.isFinite(c) ? (span > 0 ? smooth01((c - lo) / span) : (c >= lo ? 1 : 0)) : 1;
      }
    }
    let x = fx + (px - fx) * w;
    let y = fy + (py - fy) * w;
    let z = fz + (pz - fz) * w;
    const l = len3(x, y, z);
    if (l > 1e-4) { x /= l; y /= l; z /= l; } else if (w >= 0.5) { x = px; y = py; z = pz; } else { x = fx; y = fy; z = fz; }
    const v = o[s];
    if (Array.isArray(v) || ArrayBuffer.isView(v)) { v[0] = x; v[1] = y; v[2] = z; } else o[s] = [x, y, z];
    if (i > ARM_TO) legs += w;
  }
  legs /= 4;
  const fhx = Number.isFinite(fb.hipX) ? fb.hipX : 0;
  const fyaw = Number.isFinite(fb.yaw) ? fb.yaw : 0;
  const phx = pose && Number.isFinite(pose.hipX) ? pose.hipX : 0;
  const pyaw = pose && Number.isFinite(pose.yaw) ? pose.yaw : 0;
  o.hipX = fhx + (phx - fhx) * legs;
  o.yaw = fyaw + (pyaw - fyaw) * legs;
  return o;
}

function taggedError(kind, message, cause) {
  const err = new Error(message);
  err.name = 'CameraError';
  err.kind = kind;
  if (cause) err.cause = cause;
  return err;
}

function classifyCameraError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return taggedError('denied', '카메라 권한이 거부되었습니다.', e);
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return taggedError('nodevice', '사용할 수 있는 카메라를 찾지 못했습니다.', e);
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return taggedError('busy', '다른 앱이 카메라를 사용 중입니다.', e);
  }
  return taggedError('unknown', '카메라를 시작하지 못했습니다.', e);
}

/**
 * @param {HTMLVideoElement} videoEl
 * @param {Partial<typeof TRACKER_DEFAULTS>} [options]  tuning overrides, plus two seams used by
 *        test/tracker.test.mjs: loadVision() -> the MediaPipe vision module, and
 *        loadModel(onProgress) -> Uint8Array | null (null = let MediaPipe fetch the model).
 * @returns tracker:
 *   init(onProgress), startCamera(), stop(), resumeVideo(), update(nowMs), dispose()   as in v1
 *   setMaxPlayers(n)   1 | 2, before or after init; resolves once the detector follows
 *   getPlayers()       -> [r0, r1]: the SAME array on every call; a slot is null when nobody is
 *                         there (r1 is always null while maxPlayers is 1)
 *   getPlayerPose()    === getPlayers()[0]
 *   isReady, cameraActive, delegate, maxPlayers, debug
 * A result is { pose, confidence, landmarks, bodyVisible, upperVisible, cx, cy, size, t, aspect,
 * slot, id }: one object per slot, updated IN PLACE on every detection (read it in the same
 * frame; copy what you want to keep). `id` changes whenever a different person takes the slot.
 */
export function createPoseTracker(videoEl, options = {}) {
  const cfg = { ...TRACKER_DEFAULTS, ...options };
  const loadVision = typeof options.loadVision === 'function'
    ? options.loadVision : () => import(/* @vite-ignore */ VISION_URL);

  let vision = null;        // imported module
  let fileset = null;       // wasm fileset
  let modelBuffer = null;   // Uint8Array of the .task file (reused for the CPU fallback)
  let landmarker = null;
  let delegate = 'none';
  let initPromise = null;
  let rebuilding = false;
  let errorCount = 0;

  let maxPlayers = cfg.maxPlayers === 2 ? 2 : 1;
  let numPoses = 0;         // what the current landmarker is configured for (0 = none yet)
  let configuring = null;   // promise while numPoses is being changed
  let configFailed = 0;     // a numPoses value that could not be applied (not retried on its own)

  let stream = null;
  let cameraPromise = null;

  let lastVideoTime = -1;
  let lastTs = 0;           // last timestamp handed to MediaPipe (must strictly increase)
  let lastFrameMs = NaN;    // nowMs of the previous frame in which somebody was detected (fps)
  let lastNow = 0;          // most recent nowMs seen by update()
  let inferMs = 0;
  let fps = 0;

  // Everything a slot needs, allocated once: filter bank, scratch and the result object.
  const makeSlot = (index) => {
    const result = makePoseResult();
    result.landmarks = new Array(LANDMARK_COUNT);
    for (let i = 0; i < LANDMARK_COUNT; i++) result.landmarks[i] = { x: 0.5, y: 0.5, v: 0 };
    result.t = 0;
    result.aspect = cfg.width / cfg.height;
    result.slot = index;
    result.id = 0;
    return {
      filter: createOneEuro(LANDMARK_COUNT * 2, cfg),
      coords: new Float64Array(LANDMARK_COUNT * 2),
      vis: new Float64Array(LANDMARK_COUNT),
      visPrimed: false,
      lastDetectMs: NaN, // nowMs of this slot's previous detection (filter dt)
      id: 0,             // the person the filters currently belong to
      has: false,        // result holds a detection of that person
      result,
    };
  };
  const slotRT = [makeSlot(0), makeSlot(1)];
  const slotState = createSlotState();
  const players = [null, null];

  // Detections of one frame for assignSlots. One pooled object per detection and one fixed
  // array per possible count, so a frame allocates nothing.
  const detPool = [];
  const detViews = [[]];
  for (let i = 0; i < MAX_DETECTIONS; i++) {
    detPool.push({ cx: 0.5, cy: 0.5, size: 0, index: 0 });
    detViews.push(detPool.slice(0, i + 1));
  }

  const debugInfo = { delegate, fps: 0, inferMs: 0, errorCount: 0, maxPlayers, numPoses: 0, people: 0, ids: [0, 0] };

  const report = (cb, p, text) => {
    if (typeof cb !== 'function') return;
    try { cb(clamp01(p), text); } catch { /* a broken progress callback must not break loading */ }
  };

  async function fetchModel(onProgress) {
    const res = await fetch(MODEL_URL, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total) {
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress(1);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(Math.min(1, received / total));
    }
    const buf = new Uint8Array(received);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return buf;
  }
  const loadModel = typeof options.loadModel === 'function' ? options.loadModel : fetchModel;

  async function buildLandmarker(preferred) {
    const want = maxPlayers; // the detector is built for the player count of this moment
    const make = (which) => vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        ...(modelBuffer ? { modelAssetBuffer: modelBuffer } : { modelAssetPath: MODEL_URL }),
        delegate: which,
      },
      runningMode: 'VIDEO',
      numPoses: want,
      minPoseDetectionConfidence: cfg.minPoseDetectionConfidence,
      minPosePresenceConfidence: cfg.minPosePresenceConfidence,
      minTrackingConfidence: cfg.minTrackingConfidence,
      outputSegmentationMasks: false,
    });
    if (preferred === 'GPU') {
      try {
        const lmk = await make('GPU');
        delegate = 'GPU';
        numPoses = want;
        return lmk;
      } catch (e) {
        console.warn('[pose-tracker] GPU delegate unavailable, falling back to CPU.', e);
      }
    }
    const lmk = await make('CPU');
    delegate = 'CPU';
    numPoses = want;
    return lmk;
  }

  function closeQuietly(lmk) {
    try { if (lmk && typeof lmk.close === 'function') lmk.close(); } catch { /* ignore */ }
  }

  /**
   * Replace the landmarker by a freshly built one (CPU fallback, or a numPoses change that
   * could not be applied in place). Resolves true on success. The old one is dropped right
   * away unless `keepOld` (then it keeps running until the new one is ready, or for good if
   * the build fails).
   */
  function rebuild(preferred, keepOld) {
    if (rebuilding || !vision || !fileset) return Promise.resolve(false);
    rebuilding = true;
    const old = landmarker;
    if (!keepOld) landmarker = null;
    return buildLandmarker(preferred)
      .then((lmk) => {
        landmarker = lmk;
        errorCount = 0;
        closeQuietly(old);
        return true;
      })
      .catch((e) => {
        console.error('[pose-tracker] rebuilding the detector failed.', e);
        if (!keepOld) closeQuietly(old);
        return false;
      })
      .finally(() => {
        rebuilding = false;
        syncNumPoses(); // maxPlayers may have changed while the build was running
      });
  }

  /** Bring the detector's numPoses in line with maxPlayers. Never rejects. */
  function syncNumPoses() {
    if (configuring) return configuring;
    if (!landmarker || rebuilding || numPoses === maxPlayers || configFailed === maxPlayers) {
      return Promise.resolve();
    }
    const lmk = landmarker;
    const want = maxPlayers;
    configuring = (async () => {
      try {
        if (typeof lmk.setOptions !== 'function') throw new Error('setOptions is not available');
        await lmk.setOptions({ numPoses: want });
        if (landmarker === lmk) numPoses = want;
      } catch (e) {
        console.warn('[pose-tracker] numPoses could not be changed in place, rebuilding the detector.', e);
        const ok = landmarker === lmk
          && await rebuild(delegate === 'CPU' ? 'CPU' : 'GPU', true);
        if (!ok && numPoses !== want) configFailed = want;
      }
    })().catch(() => {}).then(() => {
      configuring = null;
      return syncNumPoses(); // a newer request may be waiting
    });
    return configuring;
  }

  /**
   * Track one or two people. May be called at any time: before init() (the detector is then
   * built for that count), while it loads, or during play (the running detector is
   * re-configured; detection pauses for the moment that takes).
   * @param {number} n  2 = two players; anything else = one
   * @returns {Promise<void>} resolves when the detector follows (never rejects)
   */
  function setMaxPlayers(n) {
    const want = Number(n) === 2 ? 2 : 1;
    if (want !== maxPlayers) {
      maxPlayers = want;
      configFailed = 0;
      if (want === 1) players[1] = null;
    }
    return syncNumPoses();
  }

  function init(onProgress) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      report(onProgress, 0.02, '동작 인식 엔진 불러오는 중');
      vision = await loadVision();
      report(onProgress, 0.15, '동작 인식 엔진 준비 중');
      fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
      report(onProgress, 0.3, '포즈 모델 내려받는 중');
      try {
        modelBuffer = await loadModel((p) => report(onProgress, 0.3 + 0.55 * p, '포즈 모델 내려받는 중'));
      } catch (e) {
        // Let MediaPipe fetch it by URL instead (no byte-level progress).
        console.warn('[pose-tracker] manual model download failed, delegating to MediaPipe.', e);
        modelBuffer = null;
      }
      report(onProgress, 0.88, '포즈 모델 시작하는 중');
      landmarker = await buildLandmarker('GPU');
      await syncNumPoses(); // setMaxPlayers may have been called while the model was loading
      report(onProgress, 1, '준비 완료');
    })().catch((e) => {
      initPromise = null; // allow a retry
      landmarker = null;
      numPoses = 0;
      throw e;
    });
    return initPromise;
  }

  function resetSlot(rt) {
    rt.filter.reset();
    rt.visPrimed = false;
    rt.lastDetectMs = NaN;
    rt.has = false;
  }

  function resetTracking() {
    resetSlot(slotRT[0]);
    resetSlot(slotRT[1]);
    slotRT[0].id = 0;
    slotRT[1].id = 0;
    const nextId = slotState.nextId;
    assignSlots(null, null, maxPlayers, 0, slotState, cfg); // forget everybody...
    slotState.nextId = nextId;                              // ...but never reuse a person id
    slotState.t = NaN;
    players[0] = null;
    players[1] = null;
    lastFrameMs = NaN;
  }

  function releaseStream() {
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
    }
    stream = null;
    if (videoEl) {
      try { videoEl.pause(); } catch { /* not playing */ }
      try { videoEl.srcObject = null; } catch { /* element gone */ }
    }
  }

  function startCamera() {
    if (stream && stream.active) return Promise.resolve();
    if (cameraPromise) return cameraPromise;
    cameraPromise = (async () => {
      const secure = typeof window === 'undefined' || window.isSecureContext !== false;
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
      if (!md || typeof md.getUserMedia !== 'function') {
        throw secure
          ? taggedError('nodevice', '이 브라우저에서는 카메라를 사용할 수 없습니다.')
          : taggedError('insecure', '카메라는 https 또는 localhost 에서만 사용할 수 있습니다.');
      }
      if (!secure) throw taggedError('insecure', '카메라는 https 또는 localhost 에서만 사용할 수 있습니다.');

      let s;
      try {
        s = await md.getUserMedia({
          audio: false,
          video: {
            width: { ideal: cfg.width },
            height: { ideal: cfg.height },
            facingMode: 'user',
            frameRate: { ideal: 30 },
          },
        });
      } catch (e) {
        if (e && e.name === 'OverconstrainedError') {
          try {
            s = await md.getUserMedia({ audio: false, video: true });
          } catch (e2) {
            throw classifyCameraError(e2);
          }
        } else {
          throw classifyCameraError(e);
        }
      }

      stream = s;
      for (const track of s.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (stream === s) { releaseStream(); resetTracking(); }
        });
      }

      try {
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.setAttribute('playsinline', '');
        videoEl.srcObject = s;
        if (videoEl.readyState < 1) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('camera metadata timeout')); }, 8000);
            const onMeta = () => { cleanup(); resolve(); };
            const onErr = () => { cleanup(); reject(new Error('video element error')); };
            function cleanup() {
              clearTimeout(timer);
              videoEl.removeEventListener('loadedmetadata', onMeta);
              videoEl.removeEventListener('error', onErr);
            }
            videoEl.addEventListener('loadedmetadata', onMeta);
            videoEl.addEventListener('error', onErr);
          });
        }
        await videoEl.play();
      } catch (e) {
        releaseStream();
        throw e && e.kind ? e : classifyCameraError(e);
      }
      lastVideoTime = -1;
      resetTracking();
    })().finally(() => { cameraPromise = null; });
    return cameraPromise;
  }

  /** Stops the camera. The loaded model is kept so a retry starts instantly. */
  function stop() {
    releaseStream();
    resetTracking();
    lastVideoTime = -1;
  }

  /**
   * Some browsers (Safari / iOS) pause a MediaStream <video> when the page goes to the
   * background and never resume it. Call after the page is visible again / on game resume.
   */
  function resumeVideo() {
    if (!stream || stream.active === false || !videoEl || !videoEl.paused) return;
    try {
      const p = videoEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* nothing to resume */ }
  }

  function swapToCpu() {
    if (rebuilding || delegate !== 'GPU' || !vision || !fileset) return;
    console.warn('[pose-tracker] repeated detector errors on GPU, rebuilding on CPU.');
    rebuild('CPU', false);
  }

  // One person's raw landmarks -> the slot's filters -> the slot's result (in place).
  function ingest(rt, raw, nowMs, aspect) {
    // Smooth in raw image space, then mirror.
    // (if / else rather than `p ? p.x : NaN`, and the unary plus further down: mixing a
    // property read with a constant in one expression makes V8 box the number — per landmark.)
    const coords = rt.coords;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const p = raw[i];
      if (p) {
        coords[i * 2] = +p.x;
        coords[i * 2 + 1] = +p.y;
      } else {
        coords[i * 2] = NaN;
        coords[i * 2 + 1] = NaN;
      }
    }
    const dt = (nowMs - rt.lastDetectMs) / 1000;
    rt.filter.apply(coords, dt);

    const va = rt.visPrimed && dt > 0 && dt < 0.5 ? 1 - Math.exp(-dt / cfg.visibilityTau) : 1;
    const vis = rt.vis;
    const res = rt.result;
    const landmarks = res.landmarks;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const p = raw[i];
      if (p) {
        const pv = +p.visibility; // a landmark without a visibility counts as seen
        vis[i] += ((pv === pv ? pv : 1) - vis[i]) * va;
      } else {
        vis[i] -= vis[i] * va;
      }
      const x = coords[i * 2];
      const y = coords[i * 2 + 1];
      const L = landmarks[i];
      L.x = Number.isFinite(x) ? 1 - x : 0.5; // mirrored: 0 = screen left
      L.y = Number.isFinite(y) ? y : 0.5;     // image-down: 0 = top
      L.v = Number.isFinite(x) && Number.isFinite(y) ? clamp01(vis[i]) : 0;
    }
    rt.visPrimed = true;
    rt.lastDetectMs = nowMs;

    poseFromLandmarks(landmarks, aspect, res);
    res.t = nowMs;
    res.aspect = aspect;
    res.id = rt.id;
    rt.has = true;
  }

  /** Call once per animation frame. Never throws. */
  function update(nowMs) {
    try {
      const now = Number.isFinite(nowMs) ? nowMs
        : (typeof performance !== 'undefined' ? performance.now() : Date.now());
      lastNow = now;
      if (!landmarker || rebuilding || configuring || !stream || !videoEl) return;
      if (videoEl.readyState < 2 || videoEl.paused || videoEl.ended) return;
      if (!(videoEl.videoWidth > 0)) return;
      const vt = videoEl.currentTime;
      if (vt === lastVideoTime) return; // same camera frame as last time
      lastVideoTime = vt;

      const ts = Math.max(lastTs + 1, Math.round(now));
      lastTs = ts;

      let out;
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      try {
        out = landmarker.detectForVideo(videoEl, ts);
        errorCount = 0;
      } catch (e) {
        errorCount++;
        if (errorCount === 1) console.warn('[pose-tracker] detection failed.', e);
        if (errorCount >= cfg.maxErrors) swapToCpu();
        return;
      }
      if (typeof performance !== 'undefined') inferMs += ((performance.now() - t0) - inferMs) * 0.1;

      const aspect = videoEl.videoWidth > 0 && videoEl.videoHeight > 0
        ? videoEl.videoWidth / videoEl.videoHeight : cfg.width / cfg.height;

      // Everybody in this frame: where they stand and how big they are (raw x is un-mirrored).
      const poses = out ? out.landmarks : null;
      let n = 0;
      if (poses) {
        for (let i = 0; i < poses.length && n < MAX_DETECTIONS; i++) {
          const raw = poses[i];
          if (!raw || raw.length < LANDMARK_COUNT) continue;
          const ls = raw[LM.L_SHOULDER];
          const rs = raw[LM.R_SHOULDER];
          if (!ls || !rs) continue;
          const d = detPool[n];
          d.cx = 1 - (ls.x + rs.x) / 2;
          d.cy = (ls.y + rs.y) / 2;
          d.size = len2(ls.x - rs.x, (ls.y - rs.y) / aspect);
          d.index = i;
          n++;
        }
      }
      if (n > 0) {
        const dt = (now - lastFrameMs) / 1000;
        if (Number.isFinite(dt) && dt > 0) fps += ((1 / dt) - fps) * 0.1;
        lastFrameMs = now;
      }

      const dets = detViews[n];
      assignSlots(slotState, dets, maxPlayers, now, slotState, cfg);
      for (let k = 0; k < 2; k++) {
        const slot = slotState.slots[k];
        const rt = slotRT[k];
        if (slot.id !== rt.id) { // somebody else (or nobody) in this slot: their filters start afresh
          resetSlot(rt);
          rt.id = slot.id;
        }
        if (slot.id !== 0 && slot.det >= 0) ingest(rt, poses[dets[slot.det].index], now, aspect);
      }
    } catch (e) {
      // The game loop must survive anything that goes wrong in here.
      console.warn('[pose-tracker] update error.', e);
    }
  }

  /**
   * The tracked players: [P1, P2]. Always the same array; an entry is null when nobody has
   * been seen in that slot recently (slot 1 is always null while maxPlayers is 1).
   */
  function getPlayers() {
    for (let k = 0; k < 2; k++) {
      const rt = slotRT[k];
      players[k] = k < maxPlayers && rt.has && !(lastNow - rt.result.t > cfg.staleMs) ? rt.result : null;
    }
    return players;
  }

  /** Latest pose of player 1, or null when nobody has been seen recently. */
  function getPlayerPose() {
    return getPlayers()[0];
  }

  /** Stops the camera and frees the model (the tracker can be init()-ed again). */
  function dispose() {
    stop();
    closeQuietly(landmarker);
    landmarker = null;
    initPromise = null;
    delegate = 'none';
    numPoses = 0;
    configFailed = 0;
  }

  return {
    init,
    startCamera,
    stop,
    resumeVideo,
    update,
    setMaxPlayers,
    getPlayers,
    getPlayerPose,
    dispose,
    get isReady() { return !!landmarker && !rebuilding; },
    get cameraActive() { return !!stream && stream.active !== false; },
    get delegate() { return delegate; },
    get maxPlayers() { return maxPlayers; },
    /** For the ?debug=1 overlay. The same object on every read. */
    get debug() {
      debugInfo.delegate = delegate;
      debugInfo.fps = fps;
      debugInfo.inferMs = inferMs;
      debugInfo.errorCount = errorCount;
      debugInfo.maxPlayers = maxPlayers;
      debugInfo.numPoses = numPoses;
      debugInfo.people = slotState.people;
      debugInfo.ids[0] = slotState.slots[0].id;
      debugInfo.ids[1] = slotState.slots[1].id;
      return debugInfo;
    },
  };
}
