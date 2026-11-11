// STARFALL — pose comparison and move judging (v2: generous, follow-friendly).
// Pure logic: no DOM, no three.js. Imports cleanly in Node (see test/scoring.test.mjs).
//
// Conventions (see CONTRACT.md): every pose segment is a [x, y, z] direction in stage space,
// +x = screen right, +y = up. Limb names are screen-side names. Comparison is done in the
// x/y plane only, because a single front-facing webcam cannot measure depth reliably.
//
// What v2 changes, and why (CONTRACT-v2.md; calibrated with test/replay-harness.mjs against the
// recorded camera session and synthetic players):
//   * People watch, then copy: the real player matched the dancer best about 0.6 s late, with
//     30–60° of arm error and the legs out of frame. v1 judged a ±0.4 s window with a 15–64°
//     tolerance and demanded both arms; that turned an honest attempt into OK / MISS.
//   * A move can now be matched from 0.10 s before its beat to 0.95 s after it (follow window),
//     the tolerance curve is 25–100° (forearms are where people are sloppy), unseen legs / hips
//     cost nothing, a sample only needs the upper body, and a player who visibly reacts and
//     gets at least OK-close is given GOOD (follow assist).
//   * What keeps it honest: a segment the move takes away from the rest pose only earns credit
//     once the player's own segment has left rest too (rest gate), so standing still scores
//     nothing on the limbs a move is about; the upper arms — where two different moves differ —
//     have a tighter curve (28–54°); and the assist needs real movement before or during the
//     window, a clear rise over the match just before the beat, and the pose held with both arms.
//   * Measured on the frozen v1 routine (node test/replay-harness.mjs): recorded session 64 %
//     GOOD-or-better / 16 % MISS (v1 judge: 15 % / 49 %), reactive human model 100 %, standing
//     still 0 %, right moves in the wrong order 28 %, left/right swapped 40 % against 100 % for
//     the correct player. `node test/replay-harness.mjs js/choreo.js` runs the synthetic players
//     on the current routine.

import { beatToSec } from './song.js';

const SEGMENTS = [
  'spine', 'head',
  'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm',
  'lThigh', 'lShin', 'rThigh', 'rShin',
];
const NSEG = SEGMENTS.length;
const ARM_FROM = 2; // segment indices 2..5 are the arms: 2,3 = screen-left, 4,5 = screen-right
const ARM_TO = 5;

/** Every tuning knob of the judge lives here. The object is frozen; edit the source to retune. */
export const TUNING = Object.freeze({
  // Base importance of each segment. Arms 75 %, legs 15 %, spine + head 10 %. Legs count for
  // little on purpose: most players are framed from the hips up, and someone who is fully in
  // frame must not be judged much harder than someone who is not. Upper arms weigh more than
  // forearms: people get the elbows right long before the hands (in the recorded session 80 %
  // of upper arms were within 40° of the target but only 66 % of forearms, and 18 % of forearms
  // were more than 100° off), so the elbows carry a little more of the verdict.
  weights: Object.freeze({
    spine: 0.06, head: 0.04,
    lUpperArm: 0.21, lForearm: 0.165, rUpperArm: 0.21, rForearm: 0.165,
    lThigh: 0.045, lShin: 0.03, rThigh: 0.045, rShin: 0.03,
  }),
  // Angular tolerance curve: full credit up to fullCreditDeg, smooth falloff to zero at
  // zeroCreditDeg. (v1 was 15 / 64; the real player's forearms were typically 42–60° off, and
  // routines that keep the upper arms low are told apart by the forearms alone — a 50° forearm
  // error still earns three quarters of its credit, a 60° one half.)
  fullCreditDeg: 25,
  zeroCreditDeg: 100,
  // The upper arms get a curve of their own: just as forgiving near the target, but it ends
  // sooner. People place their elbows well (in the recorded session 80 % of upper arms were
  // within 40° of the target), while two DIFFERENT moves typically differ by 40–60° in the
  // upper arm — this is where poses are told apart, and what keeps a player who does the right
  // moves in the wrong order under 30 % GOOD.
  upperFullDeg: 28,
  upperZeroDeg: 54,
  // "Ask": how much a move takes a segment away from the neutral standing pose, 0 below
  // askFromDeg, 1 from askFullDeg (the choreography guarantees at least 35° in some arm segment
  // of every scored pose). It drives two things:
  //   salience  — an asked segment weighs salienceFloor + salienceGain times its base weight,
  //               a resting one only salienceFloor: the move is about the limbs it moves;
  //   rest gate — an asked segment only earns its credit once the player's own segment has left
  //               rest: nothing while it has travelled less than restGateLow of the target's
  //               distance from rest, everything from restGateHigh. This is what makes standing
  //               still worthless on a generous tolerance curve (35° away from the pose is
  //               "close", unless you are simply still standing there).
  askFromDeg: 12,
  askFullDeg: 35,
  salienceFloor: 0.3,
  salienceGain: 1.7,
  restGateLow: 0.25,
  restGateHigh: 0.6,
  // Arm balance: a move is done with both arms (an arm the move leaves at rest has to stay
  // roughly there). The salience-weighted credit is taken per arm and the WORSE arm decides:
  // at or below armGateLow the score is capped at armGateCap (below GOOD); the cap is
  // lifted smoothly up to armGateHigh. Far looser than v1 (0.55 / 0.75): "both elbows right,
  // both hands wrong" passes untouched, only an arm that is simply somewhere else is held back
  // (for instance both arms thrown up on a move that raises one).
  armGateLow: 0.12,
  armGateHigh: 0.4,
  armGateCap: 0.58,
  // A target segment pointing mostly at the camera has no trustworthy 2D direction.
  // Its weight fades out as its x/y length drops from foreshortenFull to foreshortenZero.
  foreshortenZero: 0.2,
  foreshortenFull: 0.55,
  // Landmark confidence -> trust (0 below confLow, 1 above confHigh).
  confLow: 0.2,
  confHigh: 0.6,
  // An unseen ARM segment still counts as this fraction of its weight with zero credit, so
  // hiding an arm is never better than attempting the move. Unseen legs, spine and head are
  // simply dropped and the remaining weights renormalised: upper-body play is first-class.
  unseenPenalty: 0.5,
  // Minimum share of the (salience-weighted) ARMS that must be seen for a sample to count.
  minCoverage: 0.5,
  // Minimum tracker upperVisible (shoulders + elbows + wrists) for a sample to count. Results
  // without that field fall back to bodyVisible / upperShareOfBody (a fully visible upper body
  // with nothing else in frame has bodyVisible = 10 / 17).
  minUpperVisible: 0.5,
  upperShareOfBody: 10 / 17,
  // Follow window around the beat, in seconds: people watch the move land, then copy it.
  windowBefore: 0.10,
  windowAfter: 0.95,
  // When the next scored move is close, the window ends no later than windowAfterGapShare of
  // the gap plus windowNextSlack past this move's beat (neighbouring windows overlap a little
  // and the same sample may count for both).
  windowAfterGapShare: 0.95,
  windowNextSlack: 0.35,
  // A move is judged this long after its window closes.
  judgeDelay: 0.01,
  // Time constant of the short smoothing applied to the per-frame match before taking the best
  // value in the window. The filter starts from zero when the window opens, so the pose has to
  // be there inside the window for a few frames: a limb sweeping through, a single glitched
  // frame or a pose dropped before the beat does not score.
  holdTau: 0.08,
  // A move that has already been matched at PERFECT level cannot improve, so it is judged this
  // long after the beat instead of waiting for the window: the feedback lands on the hit.
  earlyPerfectAfter: 0.09,
  // Any other verdict lands early only when it is GOOD or better AND the player has clearly
  // settled into their answer to THIS move: from settleAfter s past the beat, once their arms
  // moved no earlier than settleZone s before the beat and have then been still for settleFor s,
  // with the best match belonging to that final position (reached no more than settleLead s
  // before the last movement, and still within settleDrop of it). A pose that has simply been
  // standing there since before the beat — a slow reactor still in the previous move — never
  // counts as settled, and everything below GOOD waits for the window to close: they may still
  // get there. Where the previous move is less than settleMinGap s away, a late arrival at THAT
  // move cannot be told from an on-time arrival at this one, so nothing is settled early there.
  settleAfter: 0.25,
  settleZone: 0.2,
  settleMinGap: 0.75,
  settleFor: 0.22,
  settleLead: 0.12,
  settleDrop: 0.06,
  // Follow assist: an OK-level verdict becomes GOOD when the player visibly reacted to the move:
  //   * their arms really moved (a seen arm segment turned followMoveDeg or more) between
  //     followLookback s before the beat and the end of the window,
  //   * the best match in the window is at least followRise above the baseline — the lowest
  //     (lightly smoothed, followBaseTau) match of the last followLookback s before the beat,
  //   * and they stayed in it: for followHold s in total the per-frame match was at OK level
  //     with the worse arm earning at least followMinArm (both arms are in the move, not one
  //     arm right and the other somewhere else; a pose flashed for a frame is no reaction).
  // Standing still can never trigger it: no movement, no rise.
  followLookback: 0.4,
  followRise: 0.2,
  followMoveDeg: 15,
  followMinArm: 0.35,
  followBaseTau: 0.1,
  followHold: 0.15,
  // Ratings. GOOD on the match alone is deliberately demanding (two different moves of a
  // routine are often 0.5–0.65 alike), barely below SUPER; the usual way to a GOOD is the
  // follow assist above: an OK-level match that the player visibly moved into and held with
  // both arms.
  thresholds: Object.freeze({ perfect: 0.86, super: 0.70, good: 0.68, ok: 0.32 }),
  points: Object.freeze({ perfect: 1000, super: 700, good: 400, ok: 150, miss: 0 }),
  goldMultiplier: 2,
  // Combo multiplier: +comboStepBonus every comboStep consecutive hits, capped at comboMaxMultiplier.
  comboStep: 4,
  comboStepBonus: 0.1,
  comboMaxMultiplier: 1.5,
  // Stars from accuracy (mean of points/1000 over judged moves). The recorded session (an
  // honest first attempt with two breaks) has an accuracy of 0.50–0.52 depending on the frame
  // rate it is replayed at: three stars, and not on a knife edge.
  starThresholds: Object.freeze([0.15, 0.34, 0.48, 0.70, 0.88]),
  // Live matcher (createLiveMatcher): how far back the player's current pose is compared
  // against the dancer, the spacing of the remembered target poses and the output smoothing.
  liveLagSec: 0.9,
  liveStepSec: 0.05,
  liveSmoothSec: 0.14,
});

export const RATINGS = Object.freeze(['perfect', 'super', 'good', 'ok', 'miss']);

// Neutral standing pose (2D directions, unit length) — the reference for "ask" and the rest gate.
const REST = (() => {
  const raw = {
    spine: [0, 1], head: [0, 1],
    lUpperArm: [-0.2, -1], lForearm: [-0.1, -1],
    rUpperArm: [0.2, -1], rForearm: [0.1, -1],
    lThigh: [-0.08, -1], lShin: [0, -1],
    rThigh: [0.08, -1], rShin: [0, -1],
  };
  const out = new Float64Array(NSEG * 2);
  SEGMENTS.forEach((seg, i) => {
    const l = Math.hypot(raw[seg][0], raw[seg][1]);
    out[i * 2] = raw[seg][0] / l;
    out[i * 2 + 1] = raw[seg][1] / l;
  });
  return out;
})();
const BASE_WEIGHT = Float64Array.from(SEGMENTS, (seg) => TUNING.weights[seg]);

const DEG = 180 / Math.PI;
// Not Math.hypot: V8 allocates an array on every call of it, and these run for every segment
// of every comparison of every frame.
const len2of = (x, y) => Math.sqrt(x * x + y * y);
const len3of = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const isVec = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length >= 2
  && Number.isFinite(v[0]) && Number.isFinite(v[1]);

/** Angle in degrees between two UNIT 2D vectors. */
function unitAngle(ax, ay, bx, by) {
  const c = ax * bx + ay * by;
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c) * DEG;
}

/**
 * Credit 0..1 for an angular error in degrees: 1 up to fullDeg, smooth falloff to 0 at zeroDeg.
 * Defaults to the general curve (TUNING.fullCreditDeg / zeroCreditDeg).
 */
export function angleCredit(errDeg, fullDeg = TUNING.fullCreditDeg, zeroDeg = TUNING.zeroCreditDeg) {
  if (!(errDeg > fullDeg)) return errDeg === errDeg ? 1 : 0; // NaN -> 0
  if (errDeg >= zeroDeg) return 0;
  return smooth01((zeroDeg - errDeg) / (zeroDeg - fullDeg));
}

// ---------------------------------------------------------------------------
// Prepared comparison. Targets and player poses are flattened once into typed arrays so the
// judge and the live matcher can compare many target/player pairs per frame without allocating.
//   target block, per segment: [tx, ty, weight, restAngleDeg, ask]   (weight 0 = not judged)
//   player block, per segment: [px, py, trust, restAngleDeg]         (trust < 0 = no direction)
// ---------------------------------------------------------------------------
const T_STRIDE = 5;
const P_STRIDE = 4;

function prepTarget(target, T) {
  for (let i = 0; i < NSEG; i++) {
    const o = i * T_STRIDE;
    T[o] = 0; T[o + 1] = 0; T[o + 2] = 0; T[o + 3] = 0; T[o + 4] = 0;
    const tv = target ? target[SEGMENTS[i]] : null;
    if (!isVec(tv)) continue;
    const tx = tv[0];
    const ty = tv[1];
    const tz = Number.isFinite(tv[2]) ? tv[2] : 0;
    const len3 = len3of(tx, ty, tz);
    const len2 = len2of(tx, ty);
    if (len3 < 1e-9 || len2 < 1e-9) continue;
    // How readable is this target segment from the front?
    const readable = smooth01(
      (len2 / len3 - TUNING.foreshortenZero) / (TUNING.foreshortenFull - TUNING.foreshortenZero));
    if (readable <= 0) continue;
    const ux = tx / len2;
    const uy = ty / len2;
    const rest = unitAngle(ux, uy, REST[i * 2], REST[i * 2 + 1]);
    const ask = smooth01((rest - TUNING.askFromDeg) / (TUNING.askFullDeg - TUNING.askFromDeg));
    T[o] = ux;
    T[o + 1] = uy;
    T[o + 2] = BASE_WEIGHT[i] * (TUNING.salienceFloor + TUNING.salienceGain * ask) * readable;
    T[o + 3] = rest;
    T[o + 4] = ask;
  }
}

function prepPlayer(pose, confidence, P) {
  const conf = confidence && typeof confidence === 'object' ? confidence : null;
  for (let i = 0; i < NSEG; i++) {
    const o = i * P_STRIDE;
    const pv = pose ? pose[SEGMENTS[i]] : null;
    let len = 0;
    if (isVec(pv)) len = len2of(pv[0], pv[1]);
    if (!(len > 1e-6)) {
      P[o] = 0; P[o + 1] = 0; P[o + 2] = -1; P[o + 3] = 0;
      continue;
    }
    let c = 1;
    if (conf) {
      const raw = conf[SEGMENTS[i]];
      c = Number.isFinite(raw) ? raw : 1;
    }
    const ux = pv[0] / len;
    const uy = pv[1] / len;
    P[o] = ux;
    P[o + 1] = uy;
    P[o + 2] = smooth01((c - TUNING.confLow) / (TUNING.confHigh - TUNING.confLow));
    P[o + 3] = unitAngle(ux, uy, REST[i * 2], REST[i * 2 + 1]);
  }
}

function makeResult() {
  const perSegment = {};
  for (let i = 0; i < NSEG; i++) perSegment[SEGMENTS[i]] = 0;
  return { score: 0, perSegment, coverage: 0, visible: false, armCredit: 0, seen: 0 };
}

/** Compare a prepared player against a prepared target; fills and returns `out`. */
function scorePrepared(T, P, out) {
  const per = out.perSegment;
  let num = 0;
  let den = 0;
  let armSeen = 0;
  let armTotal = 0;
  let armTrust = 0;
  let armNumL = 0; let armDenL = 0; let armNumR = 0; let armDenR = 0;

  for (let i = 0; i < NSEG; i++) {
    const seg = SEGMENTS[i];
    const isArm = i >= ARM_FROM && i <= ARM_TO;
    const to = i * T_STRIDE;
    const po = i * P_STRIDE;
    const trustRaw = P[po + 2];
    const trust = trustRaw > 0 ? trustRaw : 0;
    if (isArm) armTrust += trust;
    const w = T[to + 2];
    if (!(w > 0)) { per[seg] = 0; continue; }

    let credit = 0;
    if (trustRaw >= 0) {
      const err = unitAngle(T[to], T[to + 1], P[po], P[po + 1]);
      credit = i === 2 || i === 4
        ? angleCredit(err, TUNING.upperFullDeg, TUNING.upperZeroDeg)
        : angleCredit(err);
      const ask = T[to + 4];
      if (ask > 0 && credit > 0) {
        // Rest gate: has the player's own segment left the rest pose at all?
        const moved = smooth01(
          (P[po + 3] / T[to + 3] - TUNING.restGateLow) / (TUNING.restGateHigh - TUNING.restGateLow));
        credit *= 1 - ask + ask * moved;
      }
    }
    per[seg] = trust > 0 ? credit : 0;
    num += w * trust * credit;
    if (isArm) {
      den += w * (trust + (1 - trust) * TUNING.unseenPenalty);
      armSeen += w * trust;
      armTotal += w;
      if (i < 4) { armNumL += w * trust * credit; armDenL += w; } else { armNumR += w * trust * credit; armDenR += w; }
    } else {
      den += w * trust; // unseen legs / spine / head: dropped, the rest is renormalised
    }
  }

  const coverage = armTotal > 0 ? armSeen / armTotal : armTrust / 4;
  const visible = coverage >= TUNING.minCoverage;
  out.coverage = coverage;
  out.seen = coverage;
  out.visible = visible;
  let score = visible && den > 0 ? clamp01(num / den) : 0;
  const l = armDenL > 0 ? armNumL / armDenL : 1;
  const r = armDenR > 0 ? armNumR / armDenR : 1;
  const armCredit = l < r ? l : r;
  if (score > TUNING.armGateCap) {
    const lift = smooth01((armCredit - TUNING.armGateLow) / (TUNING.armGateHigh - TUNING.armGateLow));
    const cap = TUNING.armGateCap + (1 - TUNING.armGateCap) * lift;
    if (score > cap) score = cap;
  }
  out.score = score;
  out.armCredit = armCredit;
  return out;
}

const CMP_T = new Float64Array(NSEG * T_STRIDE);
const CMP_P = new Float64Array(NSEG * P_STRIDE);

/**
 * Compare a player's pose to a target pose.
 * @param {object} target  pose in contract format (vectors need not be normalised)
 * @param {object} player  pose in contract format (from the tracker; z is ignored)
 * @param {object} [confidence] per-segment 0..1 trust in the player's segment (default 1)
 * @returns {{score:number, perSegment:Object<string,number>, coverage:number, visible:boolean,
 *            armCredit:number, seen:number}}
 *   score 0..1; perSegment = credit 0..1 per segment; coverage (= seen) = share of the arms that
 *   was seen; visible = enough of the arms was seen to judge; armCredit = credit of the worse arm.
 *   A fresh object is returned on every call.
 */
export function comparePoses(target, player, confidence) {
  prepTarget(target, CMP_T);
  prepPlayer(player, confidence, CMP_P);
  return scorePrepared(CMP_T, CMP_P, makeResult());
}

/** Rating name for a 0..1 match score. */
export function rateScore(score) {
  const t = TUNING.thresholds;
  if (score >= t.perfect) return 'perfect';
  if (score >= t.super) return 'super';
  if (score >= t.good) return 'good';
  if (score >= t.ok) return 'ok';
  return 'miss';
}

/** Score multiplier for a combo count (the count including the current hit). */
export function comboMultiplier(combo) {
  const steps = Math.floor(Math.max(0, combo) / TUNING.comboStep);
  const m = 1 + steps * TUNING.comboStepBonus;
  return Math.round(Math.min(TUNING.comboMaxMultiplier, m) * 100) / 100;
}

/** Stars 0..5 for an accuracy 0..1. */
export function starsForAccuracy(accuracy) {
  let stars = 0;
  for (const th of TUNING.starThresholds) if (accuracy >= th) stars++;
  return stars;
}

function pointsFor(rating, gold, combo) {
  return Math.round(TUNING.points[rating] * (gold ? TUNING.goldMultiplier : 1) * comboMultiplier(combo));
}

/**
 * Unpack what the game hands over each frame: a tracker result ({ pose, confidence,
 * upperVisible, bodyVisible }) or a bare pose. Returns the pose (or null) and writes the
 * confidence object and the upper-body visibility into `into`.
 */
function unpackResult(r, into) {
  into.confidence = undefined;
  into.upper = 1;
  if (!r || typeof r !== 'object') return null;
  if (r.pose && typeof r.pose === 'object') {
    into.confidence = r.confidence;
    if (Number.isFinite(r.upperVisible)) into.upper = r.upperVisible;
    else if (Number.isFinite(r.bodyVisible)) into.upper = Math.min(1, r.bodyVisible / TUNING.upperShareOfBody);
    return r.pose;
  }
  if (isVec(r.spine) || isVec(r.lUpperArm) || isVec(r.rUpperArm)) return r;
  return null;
}

/**
 * Create the judge for a list of scored moves.
 * @param {Array<{id?:any, beat:number, pose:string|object, gold?:boolean}>} moves
 * @param {{getPoseByName:(name:string)=>object, beatToSec?:(beat:number)=>number}} deps
 * @returns {{pushSample:Function, update:Function, stats:Function, reset:Function, debug:Function}}
 *   pushSample(songTimeSec, playerPoseResult)  call every frame during play
 *   update(songTimeSec) -> newly judged [{ move, rating, score, points, combo, multiplier, gold,
 *                          perSegment, samples, assisted }]
 */
export function createJudge(moves, { getPoseByName, beatToSec: toSec = beatToSec } = {}) {
  if (!Array.isArray(moves)) throw new TypeError('createJudge: moves must be an array');

  const entries = moves.map((move, index) => {
    let target = null;
    if (move && typeof move.pose === 'string') {
      if (typeof getPoseByName !== 'function') {
        throw new TypeError('createJudge: getPoseByName is required for named poses');
      }
      target = getPoseByName(move.pose);
    } else if (move && move.pose && typeof move.pose === 'object') {
      target = move.pose;
    }
    if (!target) throw new Error(`createJudge: move #${index} has no resolvable pose (${move && move.pose})`);
    const time = Number.isFinite(move.time) ? move.time : toSec(move.beat);
    if (!Number.isFinite(time)) throw new Error(`createJudge: move #${index} has no valid beat`);
    const T = new Float64Array(NSEG * T_STRIDE);
    prepTarget(target, T);
    const bestPerSegment = {};
    for (let i = 0; i < NSEG; i++) bestPerSegment[SEGMENTS[i]] = 0;
    return {
      move, target, T, time, index, after: TUNING.windowAfter, canSettle: true,
      judged: false, best: 0, bestT: NaN, bestArm: 0, bestPerSegment, hasBest: false,
      held: 0, lastT: NaN, samples: 0, validSamples: 0,
      base: NaN, pre: NaN, preT: NaN, moved: false, moveT: NaN, okFor: 0, wasOk: false,
    };
  }).sort((a, b) => a.time - b.time || a.index - b.index);
  // Late side of each window, capped by the gap to the next move.
  entries.forEach((e, i) => {
    const nx = entries[i + 1];
    if (nx && nx.time > e.time) {
      e.after = Math.min(TUNING.windowAfter,
        TUNING.windowAfterGapShare * (nx.time - e.time) + TUNING.windowNextSlack);
    }
    const pv = entries[i - 1];
    e.canSettle = !pv || e.time - pv.time >= TUNING.settleMinGap;
  });

  // Highest achievable total: every move PERFECT in one unbroken combo.
  let maxScore = 0;
  entries.forEach((e, i) => { maxScore += pointsFor('perfect', !!e.move.gold, i + 1); });

  let next = 0; // index of the first unjudged entry
  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let creditSum = 0;
  let judgedCount = 0;
  let counts = { perfect: 0, super: 0, good: 0, ok: 0, miss: 0 };

  // Scratch shared by every comparison of one frame (no per-frame allocation).
  const P = new Float64Array(NSEG * P_STRIDE);
  const R = makeResult();
  const unpacked = { confidence: undefined, upper: 1 };

  // Arm motion tracker: the arms "moved" whenever a seen arm segment has turned followMoveDeg
  // away from where it was at the previous movement. Drives the follow assist ("the player
  // visibly reacted") and the early verdicts ("the player has settled").
  const anchor = new Float64Array(8);
  const anchorSet = [false, false, false, false];
  let lastUsableT = NaN;

  function trackMotion(t) {
    const fresh = !(t - lastUsableT <= 0.5); // first sample, or back after a tracking gap
    lastUsableT = t;
    let movedNow = false;
    for (let k = 0; k < 4; k++) {
      const po = (ARM_FROM + k) * P_STRIDE;
      if (!(P[po + 2] >= 0.5)) continue;
      if (fresh || !anchorSet[k]) {
        anchor[k * 2] = P[po]; anchor[k * 2 + 1] = P[po + 1]; anchorSet[k] = true;
        continue;
      }
      if (unitAngle(anchor[k * 2], anchor[k * 2 + 1], P[po], P[po + 1]) >= TUNING.followMoveDeg) movedNow = true;
    }
    if (movedNow) {
      for (let k = 0; k < 4; k++) {
        const po = (ARM_FROM + k) * P_STRIDE;
        if (P[po + 2] >= 0.5) { anchor[k * 2] = P[po]; anchor[k * 2 + 1] = P[po + 1]; anchorSet[k] = true; }
      }
    }
    return movedNow;
  }

  function reset() {
    next = 0; score = 0; combo = 0; maxCombo = 0; creditSum = 0; judgedCount = 0;
    counts = { perfect: 0, super: 0, good: 0, ok: 0, miss: 0 };
    lastUsableT = NaN;
    anchorSet[0] = anchorSet[1] = anchorSet[2] = anchorSet[3] = false;
    for (const e of entries) {
      e.judged = false; e.best = 0; e.bestT = NaN; e.bestArm = 0; e.hasBest = false;
      e.held = 0; e.lastT = NaN; e.samples = 0; e.validSamples = 0;
      e.base = NaN; e.pre = NaN; e.preT = NaN; e.moved = false; e.moveT = NaN;
      e.okFor = 0; e.wasOk = false;
      for (let i = 0; i < NSEG; i++) e.bestPerSegment[SEGMENTS[i]] = 0;
    }
  }

  function pushSample(songTimeSec, playerPoseResult) {
    if (!Number.isFinite(songTimeSec)) return;
    const t = songTimeSec;

    const pose = unpackResult(playerPoseResult, unpacked);
    const usable = !!pose && unpacked.upper >= TUNING.minUpperVisible;
    let movedNow = false;
    if (usable) {
      prepPlayer(pose, unpacked.confidence, P);
      movedNow = trackMotion(t);
    }

    for (let i = next; i < entries.length; i++) {
      const e = entries[i];
      if (e.time - TUNING.followLookback > t) break; // later moves are not being watched yet
      if (e.judged || t > e.time + e.after) continue;
      const inWindow = t >= e.time - TUNING.windowBefore;

      if (inWindow) e.samples++;
      if (!usable) continue;
      if (movedNow) {
        e.moved = true;
        if (t >= e.time - TUNING.settleZone) e.moveT = t;
      }
      scorePrepared(e.T, P, R);
      if (!R.visible) continue;

      // Run-up to the beat: remember the lowest (lightly smoothed) match — the level the
      // player has to rise from for the follow assist.
      if (t <= e.time) {
        const pdt = t - e.preT;
        if (!(pdt > 0) || pdt > 0.25) e.pre = R.score;
        else e.pre += (R.score - e.pre) * (1 - Math.exp(-pdt / TUNING.followBaseTau));
        e.preT = t;
        if (!(e.pre >= e.base)) e.base = e.pre;
      }
      if (!inWindow) continue;
      // Nothing usable in the run-up (tracking dropped out, or the player has only just come
      // into view): the baseline is the match they are first seen with.
      if (!(e.base >= 0)) e.base = R.score;

      // The hold filter always starts from zero (first sample of the window, or after a gap in
      // tracking): a pose only counts once it has been held inside the window.
      const dt = t - e.lastT;
      const contiguous = e.validSamples > 0 && dt > 0 && dt <= 0.25;
      if (!contiguous) {
        e.held = 0;
      } else {
        e.held += (R.score - e.held) * (1 - Math.exp(-dt / TUNING.holdTau));
      }
      // Follow assist: time spent at OK level with both arms in the move (only the stretch
      // between two consecutive such samples counts, so one flashed frame adds nothing).
      const okNow = R.score >= TUNING.thresholds.ok && R.armCredit >= TUNING.followMinArm;
      if (okNow && e.wasOk && contiguous) e.okFor += dt;
      e.wasOk = okNow;
      e.lastT = t;
      e.validSamples++;
      if (e.held > e.best || !e.hasBest) {
        e.best = e.held;
        e.bestT = t;
        e.bestArm = R.armCredit;
        e.hasBest = true;
        const src = R.perSegment;
        const dst = e.bestPerSegment;
        for (let k = 0; k < NSEG; k++) dst[SEGMENTS[k]] = src[SEGMENTS[k]];
      }
    }
  }

  /** Did the player visibly react to this move (the condition of the follow assist)? */
  function reacted(e) {
    return e.moved && e.best - e.base >= TUNING.followRise && e.okFor >= TUNING.followHold;
  }

  function update(songTimeSec) {
    const out = [];
    if (!Number.isFinite(songTimeSec)) return out;
    const th = TUNING.thresholds;
    while (next < entries.length) {
      const e = entries[next];
      let early = false;
      if (e.validSamples > 0) {
        const since = songTimeSec - e.time;
        if (e.best >= th.perfect) {
          early = since >= TUNING.earlyPerfectAfter;
        } else if (e.canSettle && since >= TUNING.settleAfter
          && (e.best >= th.good || (e.best >= th.ok && reacted(e)))) {
          early = e.lastT - e.moveT >= TUNING.settleFor
            && e.bestT >= e.moveT - TUNING.settleLead
            && e.held >= e.best - TUNING.settleDrop;
        }
      }
      if (!early && songTimeSec < e.time + e.after + TUNING.judgeDelay) break;
      next++;
      if (e.judged) continue;
      e.judged = true;

      const matched = e.validSamples > 0 ? e.best : 0;
      let rating = e.validSamples > 0 ? rateScore(matched) : 'miss';
      let assisted = false;
      if (rating === 'ok' && reacted(e)) { rating = 'good'; assisted = true; }
      const gold = !!e.move.gold;
      if (rating === 'miss') combo = 0; else combo++;
      if (combo > maxCombo) maxCombo = combo;
      const multiplier = comboMultiplier(combo);
      const points = pointsFor(rating, gold, combo);
      score += points;
      counts[rating]++;
      creditSum += TUNING.points[rating] / TUNING.points.perfect;
      judgedCount++;

      out.push({
        move: e.move, rating, score: matched, points, combo, multiplier, gold,
        perSegment: e.bestPerSegment, samples: e.validSamples, assisted,
      });
    }
    return out;
  }

  function stats() {
    const accuracy = judgedCount > 0 ? creditSum / judgedCount : 0;
    return {
      score, maxScore, combo, maxCombo,
      counts: { ...counts },
      stars: starsForAccuracy(accuracy),
      accuracy,
      multiplier: comboMultiplier(combo),
      judged: judgedCount,
      total: entries.length,
    };
  }

  /** Live view of the open windows, for the ?debug=1 overlay. */
  function debug(songTimeSec) {
    const open = [];
    for (let i = next; i < entries.length; i++) {
      const e = entries[i];
      if (Number.isFinite(songTimeSec) && e.time - TUNING.windowBefore > songTimeSec) break;
      open.push({
        id: e.move.id, pose: e.move.pose, time: e.time,
        best: e.best, held: e.held, base: e.base, arm: e.bestArm, okFor: e.okFor,
        moved: e.moved, reacted: reacted(e),
        samples: e.samples, validSamples: e.validSamples,
      });
      if (!Number.isFinite(songTimeSec)) break;
    }
    return { next, total: entries.length, open };
  }

  return { pushSample, update, stats, reset, debug };
}

/**
 * Live "how close am I right now" meter for the HUD and the player avatars.
 *
 * People copy the dancer with a delay, so the player's CURRENT pose is compared against every
 * target pose of the last ~0.9 s and the best one counts. Nothing is allocated per frame.
 *
 * @param {{lagSec?:number, stepSec?:number, smoothSec?:number}} [opts]
 * @returns {{push:(songTimeSec:number, targetPose:object)=>void,
 *            match:(playerResult:object|null)=>{score:number, perSegment:Object<string,number>, seen:number},
 *            reset:()=>void}}
 *   push   call every frame with the dancer's pose (choreo.samplePose(beat));
 *   match  -> { score 0..1, perSegment {segment: 0..1}, seen 0..1 } — the SAME object on every
 *             call; smoothed over time (time advances with push); null / unseen player -> fades to 0;
 *   reset  forget everything (new run, seek).
 */
export function createLiveMatcher(opts = {}) {
  const lagSec = Number.isFinite(opts.lagSec) && opts.lagSec >= 0 ? opts.lagSec : TUNING.liveLagSec;
  const stepSec = Number.isFinite(opts.stepSec) && opts.stepSec > 0 ? opts.stepSec : TUNING.liveStepSec;
  const smoothSec = Number.isFinite(opts.smoothSec) && opts.smoothSec >= 0 ? opts.smoothSec : TUNING.liveSmoothSec;

  const slots = Math.max(2, Math.min(240, Math.ceil(lagSec / stepSec) + 2));
  const targets = [];
  for (let i = 0; i < slots; i++) targets.push(new Float64Array(NSEG * T_STRIDE));
  const times = new Float64Array(slots).fill(NaN);
  let head = -1;        // slot holding the newest target
  let slotStart = NaN;  // song time at which the head slot was opened
  let now = NaN;        // song time of the latest push
  let matchedAt = NaN;  // song time of the latest match() that advanced the smoothing

  const P = new Float64Array(NSEG * P_STRIDE);
  const R = makeResult();
  const bestSeg = new Float64Array(NSEG);
  const unpacked = { confidence: undefined, upper: 1 };
  const out = makeLiveResult();

  function makeLiveResult() {
    const perSegment = {};
    for (let i = 0; i < NSEG; i++) perSegment[SEGMENTS[i]] = 0;
    return { score: 0, perSegment, seen: 0 };
  }

  function reset() {
    times.fill(NaN);
    head = -1; slotStart = NaN; now = NaN; matchedAt = NaN;
    out.score = 0; out.seen = 0;
    for (let i = 0; i < NSEG; i++) out.perSegment[SEGMENTS[i]] = 0;
  }

  function push(songTimeSec, targetPose) {
    if (!Number.isFinite(songTimeSec) || !targetPose) return;
    if (songTimeSec < now - 1e-6) reset(); // time went backwards: retry or seek
    if (head < 0 || songTimeSec - slotStart >= stepSec) {
      head = (head + 1) % slots;
      slotStart = songTimeSec;
    }
    prepTarget(targetPose, targets[head]); // the head slot always holds the freshest pose
    times[head] = songTimeSec;
    now = songTimeSec;
  }

  function match(playerResult) {
    if (head < 0) return out;
    const dt = now - matchedAt;
    if (dt === 0) return out; // same frame (or paused): nothing new to blend in

    let score = 0;
    let seen = 0;
    bestSeg.fill(0);
    const pose = unpackResult(playerResult, unpacked);
    if (pose && unpacked.upper >= TUNING.minUpperVisible) {
      prepPlayer(pose, unpacked.confidence, P);
      let found = false;
      for (let s = 0; s < slots; s++) {
        const age = now - times[s];
        if (!(age >= 0 && age <= lagSec + 1e-9)) continue; // empty or too old
        scorePrepared(targets[s], P, R);
        if (!found || R.score > score) {
          found = true;
          score = R.score;
          seen = R.seen;
          for (let i = 0; i < NSEG; i++) bestSeg[i] = R.perSegment[SEGMENTS[i]];
        }
      }
    }

    const a = !(dt > 0) || dt > 0.5 || !(smoothSec > 0) ? 1 : 1 - Math.exp(-dt / smoothSec);
    matchedAt = now;
    out.score += (score - out.score) * a;
    out.seen += (seen - out.seen) * a;
    const per = out.perSegment;
    for (let i = 0; i < NSEG; i++) per[SEGMENTS[i]] += (bestSeg[i] - per[SEGMENTS[i]]) * a;
    return out;
  }

  return { push, match, reset };
}
