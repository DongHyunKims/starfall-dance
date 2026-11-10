// STARFALL — pose comparison and move judging.
// Pure logic: no DOM, no three.js. Imports cleanly in Node (see test/scoring.test.mjs).
//
// Conventions (see CONTRACT.md): every pose segment is a [x, y, z] direction in stage space,
// +x = screen right, +y = up. Limb names are screen-side names. Comparison is done in the
// x/y plane only, because a single front-facing webcam cannot measure depth reliably.

import { beatToSec } from './song.js';

const SEGMENTS = [
  'spine', 'head',
  'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm',
  'lThigh', 'lShin', 'rThigh', 'rShin',
];

/** Every tuning knob of the judge lives here. The object is frozen; edit the source to retune. */
export const TUNING = Object.freeze({
  // Base importance of each segment. Arms 65 %, legs 25 %, spine + head 10 %.
  weights: Object.freeze({
    spine: 0.06, head: 0.04,
    lUpperArm: 0.17, lForearm: 0.155, rUpperArm: 0.17, rForearm: 0.155,
    lThigh: 0.075, lShin: 0.05, rThigh: 0.075, rShin: 0.05,
  }),
  // Angular tolerance curve: full credit up to fullCreditDeg, smooth falloff to zero at zeroCreditDeg.
  fullCreditDeg: 15,
  zeroCreditDeg: 64,
  // Arm gate: the arms are what a move is about. The salience-weighted credit is taken per arm
  // (upper arm + forearm) and the WORSE arm decides: at or below armGateLow the score is capped
  // at armGateCap (just under GOOD); the cap is lifted smoothly up to armGateHigh. Legs, torso
  // and one correct arm can never earn GOOD on their own.
  armGateLow: 0.55,
  armGateHigh: 0.75,
  armGateCap: 0.57,
  // Salience: segments that the move takes away from the neutral standing pose are what the
  // move is "about". A segment at rest keeps salienceFloor of its base weight, a segment moved
  // salienceFullDeg or more away from rest gets salienceFloor + salienceGain. This is what keeps
  // a player who just stands still from collecting credit for the limbs that happen to be idle.
  salienceFloor: 0.3,
  salienceGain: 1.7,
  salienceFullDeg: 45,
  // A target segment pointing mostly at the camera has no trustworthy 2D direction.
  // Its weight fades out as its x/y length drops from foreshortenFull to foreshortenZero.
  foreshortenZero: 0.2,
  foreshortenFull: 0.55,
  // Landmark confidence -> trust (0 below confLow, 1 above confHigh).
  confLow: 0.2,
  confHigh: 0.6,
  // An unseen segment still counts as this fraction of its weight with zero credit,
  // so hiding a limb is never better than attempting it.
  unseenPenalty: 0.5,
  // Minimum share of the (salience-weighted) pose that must be seen for a sample to count.
  minCoverage: 0.5,
  // Minimum tracker bodyVisible for a sample to count.
  minBodyVisible: 0.5,
  // Timing window around the beat, in seconds (humans lag behind the beat).
  // The contract's nominal window is [-0.20, +0.40] s. The early side is deliberately much
  // shorter: with 0.20 s a player still holding the PREVIOUS pose collected full credit for the
  // next move whenever the two looked alike (and a left/right swapped player scored every
  // "answer" move). A pose has to be held at, or just before, the beat to count.
  windowBefore: 0.08,
  windowAfter: 0.40,
  // In dense passages the late side is capped at this share of the gap to the next move, so a
  // verdict always lands before the next beat does.
  windowAfterGapShare: 0.7,
  // A move is judged this long after its window closes.
  judgeDelay: 0.03,
  // A move that was matched (at OK or better) and has clearly been left again is judged without
  // waiting for the window: not before settleAfter s past the beat, and only once the smoothed
  // match has stayed settleDrop below its best for settleFor s.
  settleAfter: 0.20,
  settleFor: 0.10,
  settleDrop: 0.05,
  // ...and a match of GOOD or better is final too once the raw per-frame match has stopped
  // improving (by more than plateauGain) for plateauFor s and for plateauTaus hold time
  // constants, i.e. the player has settled into their version of the pose and the hold filter
  // has caught up with it.
  plateauFor: 0.16,
  plateauGain: 0.03,
  plateauTaus: 3.5,
  // Sparse passages (a move every two beats or slower) ask for a slightly longer hold: the
  // hold time constant is scaled by up to holdTauSparse as the gap to the previous move grows
  // from one beat's worth (denseGap s) to twice that.
  holdTauSparse: 1.5,
  denseGap: 0.5,
  // A move that has already been matched at PERFECT level cannot improve, so it is judged this
  // long after the beat instead of waiting for the whole window: the feedback lands on the hit.
  earlyPerfectAfter: 0.09,
  // Time constant of the short smoothing applied to the per-frame match before taking the best
  // value in the window. Stops a limb that merely sweeps through the pose from scoring.
  holdTau: 0.06,
  // Ratings.
  thresholds: Object.freeze({ perfect: 0.86, super: 0.74, good: 0.60, ok: 0.45 }),
  points: Object.freeze({ perfect: 1000, super: 700, good: 400, ok: 150, miss: 0 }),
  goldMultiplier: 2,
  // Combo multiplier: +comboStepBonus every comboStep consecutive hits, capped at comboMaxMultiplier.
  comboStep: 4,
  comboStepBonus: 0.1,
  comboMaxMultiplier: 1.5,
  // Stars from accuracy (mean of points/1000 over judged moves).
  starThresholds: Object.freeze([0.15, 0.34, 0.52, 0.70, 0.88]),
});

export const RATINGS = Object.freeze(['perfect', 'super', 'good', 'ok', 'miss']);

// Neutral standing pose used as the salience reference (2D directions only matter).
const REST = {
  spine: [0, 1], head: [0, 1],
  lUpperArm: [-0.2, -1], lForearm: [-0.1, -1],
  rUpperArm: [0.2, -1], rForearm: [0.1, -1],
  lThigh: [-0.08, -1], lShin: [0, -1],
  rThigh: [0.08, -1], rShin: [0, -1],
};

const DEG = 180 / Math.PI;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const isVec = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length >= 2
  && Number.isFinite(v[0]) && Number.isFinite(v[1]);

/** Angle in degrees between the x/y projections of two vectors (assumes both non-degenerate). */
function angle2D(ax, ay, bx, by) {
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 180;
  let c = (ax * bx + ay * by) / (la * lb);
  c = c > 1 ? 1 : c < -1 ? -1 : c;
  return Math.acos(c) * DEG;
}

/** Credit 0..1 for an angular error in degrees. */
export function angleCredit(errDeg) {
  const { fullCreditDeg, zeroCreditDeg } = TUNING;
  if (!(errDeg > fullCreditDeg)) return errDeg === errDeg ? 1 : 0; // NaN -> 0
  if (errDeg >= zeroCreditDeg) return 0;
  return smooth01((zeroCreditDeg - errDeg) / (zeroCreditDeg - fullCreditDeg));
}

/**
 * Compare a player's pose to a target pose.
 * @param {object} target  pose in contract format (vectors need not be normalised)
 * @param {object} player  pose in contract format (from the tracker; z is ignored)
 * @param {object} [confidence] per-segment 0..1 trust in the player's segment (default 1)
 * @returns {{score:number, perSegment:Object<string,number>, coverage:number, visible:boolean}}
 *   score 0..1; perSegment = credit 0..1 per segment; coverage = share of the pose that was seen.
 */
export function comparePoses(target, player, confidence) {
  const perSegment = {};
  let num = 0;
  let den = 0;
  let seen = 0;
  let total = 0;
  const armNum = [0, 0];
  const armDen = [0, 0];

  for (let i = 0; i < SEGMENTS.length; i++) {
    const seg = SEGMENTS[i];
    perSegment[seg] = 0;
    const tv = target ? target[seg] : null;
    if (!isVec(tv)) continue;

    const tx = tv[0];
    const ty = tv[1];
    const tz = Number.isFinite(tv[2]) ? tv[2] : 0;
    const len3 = Math.hypot(tx, ty, tz);
    if (len3 < 1e-9) continue;
    const len2 = Math.hypot(tx, ty) / len3;

    // How readable is this target segment from the front?
    const readable = smooth01(
      (len2 - TUNING.foreshortenZero) / (TUNING.foreshortenFull - TUNING.foreshortenZero));
    if (readable <= 0) continue;

    // How much does the move ask of this segment?
    const rest = REST[seg];
    const salience = clamp01(angle2D(tx, ty, rest[0], rest[1]) / TUNING.salienceFullDeg);
    const w = TUNING.weights[seg] * (TUNING.salienceFloor + TUNING.salienceGain * salience) * readable;
    total += w;

    const pv = player ? player[seg] : null;
    let trust = 0;
    let credit = 0;
    if (isVec(pv) && Math.hypot(pv[0], pv[1]) > 1e-6) {
      let c = 1;
      if (confidence && typeof confidence === 'object') {
        const raw = confidence[seg];
        c = Number.isFinite(raw) ? raw : 1;
      }
      trust = smooth01((c - TUNING.confLow) / (TUNING.confHigh - TUNING.confLow));
      credit = angleCredit(angle2D(tx, ty, pv[0], pv[1]));
    }

    perSegment[seg] = credit * (trust > 0 ? 1 : 0);
    num += w * trust * credit;
    den += w * (trust + (1 - trust) * TUNING.unseenPenalty);
    seen += w * trust;
    if (i >= 2 && i <= 5) { // arm segments: 2,3 = screen-left arm, 4,5 = screen-right arm
      const side = i < 4 ? 0 : 1;
      armNum[side] += w * trust * credit;
      armDen[side] += w;
    }
  }

  const coverage = total > 0 ? seen / total : 0;
  const visible = coverage >= TUNING.minCoverage;
  let score = visible && den > 0 ? clamp01(num / den) : 0;
  const armCredit = Math.min(
    armDen[0] > 0 ? armNum[0] / armDen[0] : 1,
    armDen[1] > 0 ? armNum[1] / armDen[1] : 1);
  if (score > TUNING.armGateCap) {
    const lift = smooth01((armCredit - TUNING.armGateLow) / (TUNING.armGateHigh - TUNING.armGateLow));
    const cap = TUNING.armGateCap + (1 - TUNING.armGateCap) * lift;
    if (score > cap) score = cap;
  }
  return { score, perSegment, coverage, visible, armCredit };
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
 * Create the judge for a list of scored moves.
 * @param {Array<{id?:any, beat:number, pose:string|object, gold?:boolean}>} moves
 * @param {{getPoseByName:(name:string)=>object, beatToSec?:(beat:number)=>number}} deps
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
    return {
      move, target, time, index, after: TUNING.windowAfter, tau: TUNING.holdTau,
      judged: false, best: 0, bestT: NaN, bestPerSegment: null, platV: 0, platT: NaN,
      held: 0, lastT: NaN, samples: 0, validSamples: 0,
    };
  }).sort((a, b) => a.time - b.time || a.index - b.index);
  // Late side of each window, capped by the gap to the next move.
  entries.forEach((e, i) => {
    const nx = entries[i + 1];
    if (nx && nx.time > e.time) {
      e.after = Math.min(TUNING.windowAfter, TUNING.windowAfterGapShare * (nx.time - e.time));
    }
    const pv = entries[i - 1];
    const gap = pv ? e.time - pv.time : Infinity;
    const sparse = clamp01((gap - TUNING.denseGap) / TUNING.denseGap);
    e.tau = TUNING.holdTau * (1 + (TUNING.holdTauSparse - 1) * sparse);
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

  function reset() {
    next = 0; score = 0; combo = 0; maxCombo = 0; creditSum = 0; judgedCount = 0;
    counts = { perfect: 0, super: 0, good: 0, ok: 0, miss: 0 };
    for (const e of entries) {
      e.judged = false; e.best = 0; e.bestT = NaN; e.bestPerSegment = null; e.platV = 0; e.platT = NaN;
      e.held = 0; e.lastT = NaN; e.samples = 0; e.validSamples = 0;
    }
  }

  function pushSample(songTimeSec, playerPoseResult) {
    if (!Number.isFinite(songTimeSec)) return;
    const t = songTimeSec;

    // Unpack once: accept the tracker result or a bare pose.
    let pose = null;
    let confidence;
    let bodyVisible = 1;
    const r = playerPoseResult;
    if (r && typeof r === 'object') {
      if (r.pose && typeof r.pose === 'object') {
        pose = r.pose;
        confidence = r.confidence;
        if (Number.isFinite(r.bodyVisible)) bodyVisible = r.bodyVisible;
      } else if (isVec(r.spine) || isVec(r.lUpperArm) || isVec(r.rUpperArm)) {
        pose = r;
      }
    }
    const usable = !!pose && bodyVisible >= TUNING.minBodyVisible;

    for (let i = next; i < entries.length; i++) {
      const e = entries[i];
      if (e.time - TUNING.windowBefore > t) break; // later windows have not opened yet
      if (e.judged || t > e.time + e.after) continue;

      e.samples++;
      if (!usable) continue;
      const cmp = comparePoses(e.target, pose, confidence);
      if (!cmp.visible) continue;

      // The hold filter always starts from zero (first sample of the window, or after a gap in
      // tracking): a pose only counts once it has been held inside the window, so neither a
      // limb sweeping through nor a pose left over from the previous move scores.
      const dt = t - e.lastT;
      if (e.validSamples === 0 || !(dt > 0) || dt > 0.25) {
        e.held = 0;
      } else {
        const a = 1 - Math.exp(-dt / e.tau);
        e.held += (cmp.score - e.held) * a;
      }
      e.lastT = t;
      e.validSamples++;
      if (e.held > e.best || e.bestPerSegment === null) {
        e.best = e.held;
        e.bestT = t;
        e.bestPerSegment = cmp.perSegment;
      }
      if (!(cmp.score <= e.platV + TUNING.plateauGain) || e.platT !== e.platT) {
        e.platV = cmp.score;
        e.platT = t;
      }
    }
  }

  function update(songTimeSec) {
    const out = [];
    if (!Number.isFinite(songTimeSec)) return out;
    while (next < entries.length) {
      const e = entries[next];
      let early = false;
      if (e.validSamples > 0) {
        if (e.best >= TUNING.thresholds.perfect) {
          early = songTimeSec >= e.time + TUNING.earlyPerfectAfter;
        } else if (e.best >= TUNING.thresholds.ok && songTimeSec >= e.time + TUNING.settleAfter) {
          early = (e.lastT - e.bestT >= TUNING.settleFor && e.held <= e.best - TUNING.settleDrop)
            || (e.best >= TUNING.thresholds.good
              && e.lastT - e.platT >= Math.max(TUNING.plateauFor, TUNING.plateauTaus * e.tau));
        }
      }
      if (!early && songTimeSec < e.time + e.after + TUNING.judgeDelay) break;
      next++;
      if (e.judged) continue;
      e.judged = true;

      const matched = e.validSamples > 0 ? e.best : 0;
      const rating = e.validSamples > 0 ? rateScore(matched) : 'miss';
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
        perSegment: e.bestPerSegment, samples: e.validSamples,
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
        best: e.best, held: e.held, samples: e.samples, validSamples: e.validSamples,
      });
      if (!Number.isFinite(songTimeSec)) break;
    }
    return { next, total: entries.length, open };
  }

  return { pushSample, update, stats, reset, debug };
}
