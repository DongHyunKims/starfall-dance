// STARFALL — STAR SLASH: cut detection and scoring (CONTRACT-slash.md). Pure; imports the
// chart module only for the direction vectors.
//
// How a cut is found
// ------------------
// push() receives the hands every frame. The tracker delivers a new hand position only every
// 2-3 frames, so a frame whose hand has not moved AT ALL is a repeat and is skipped: the judge
// works on the path through the distinct samples. A sample pushed at song time t describes the
// hand at t - latencySec ("hand time"; everything below is in hand time).
//
// For every new piece of path (previous sample -> this sample) and every shard whose window is
// open, the point of the piece closest to the shard is found. If it lies within the radius and
// the hand is moving fast enough, that is a TOUCH, timed at the closest point (not at the edge
// of the circle: a slow swing would otherwise always read early). While the closest point is
// still the END of the piece the hand is closing in and the next sample decides; if the hand
// then stops, or no sample follows, the touch is taken where the hand ended up — provided it
// got into the core of the shard (stopRadius). A hand that comes to rest at the rim has not cut
// anything: that is what arriving at the start of a swing looks like.
//
// What a touch does
// -----------------
//   right hand (or an either-hand shard), direction within goodAngle  -> the shard is CUT:
//       PERFECT within perfectAngle and perfectSec of the beat, otherwise GOOD.
//       (ahead of the beat only a swing along the arrow, within earlyAngle, cuts: a hand that
//       crosses the shard sideways that early is passing by, and nothing happens)
//   right hand, wrong direction (through its core: wrongDirRadius)    -> the shard is MARKED.
//   wrong hand (through the core of the shard: wrongHandRadius)       -> the shard is MARKED.
//   A marked shard becomes BAD badGraceSec later (or when its window closes) unless it is cut
//   properly first. The grace is what keeps a wind-up from being punished: raising the hand
//   through a shard in order to cut it downwards is a "wrong direction" touch followed, a
//   moment later, by the real one. Marks need a real swing (badMinSpeed), not a drift.
//   Nothing by the time the window closes                             -> MISS.
// Every shard is judged exactly once. BAD and MISS are only called once the hand samples
// covering the deadline have arrived (they come late and in steps), or settleSec after it.
//
// Who gets a swing
// ----------------
// When one piece of path touches several shards the hand may cut, the one nearest in time to
// the touch wins (then the nearest in space), together with any others ON THE SAME BEAT — a
// double may be taken by one sweep. After a cut the hand cannot cut a shard of another beat
// for swingLockSec, nor mark one. A hand is never blamed for brushing the other hand's shard
// while it has a shard of its own within wrongHandGuardSec (doubles, runs): it is busy.

import { DIRS } from './chart.js';

/** Every knob. Override per judge through createSlashJudge(notes, opts). */
export const SLASH_TUNING = Object.freeze({
  // A hand sample pushed at song time t shows the hand at t - latencySec (camera + tracker).
  // Use 0 for the demo hands, which are exact.
  latencySec: 0.10,
  // A shard can be cut from time - windowBefore to time + windowAfter. The late side is the
  // generous one: a webcam shows the hand late and a player reacting to the shard is late too,
  // while an early touch is mostly the follow-through of the swing before.
  windowBefore: 0.24,
  windowAfter: 0.45,
  // Reach of a cut: the hand's path must come this close to the shard's centre (pp units).
  // The cells are 0.9 x 0.8 apart, so a cut reaches most of the way into the neighbouring
  // cells: a hand followed by a webcam is not a precise thing, and a swing in the right place,
  // more or less, has to count. The chart keeps one hand's shards a beat apart and the
  // attribution rules above settle the rest.
  hitRadius: 0.8,
  // A hand that STOPS near a shard (instead of passing it) only touches it within this.
  stopRadius: 0.55,
  // Only a swing through the core of a shard can count AGAINST the player: the wrong way …
  wrongDirRadius: 0.5,
  // … or with the wrong hand.
  wrongHandRadius: 0.35,
  // Speed gate (units/s). The path piece itself must be this fast …
  minSpeed: 1.1,
  // … and the hand's own speed estimate (HandsFrame.speed, averaged over ~0.1 s by the hand
  // reader) at least this fraction of it at either end of the piece: tracker jitter on a
  // resting hand can fake one fast piece but not a fast average.
  frameSpeedRatio: 0.6,
  // A wrong-direction or wrong-hand touch only counts as a swing above this speed.
  badMinSpeed: 3.0,
  // Direction (degrees between the hand's movement and the shard's cut line). Anything that is
  // not against the arrow cuts; within perfectAngle it can be a PERFECT.
  perfectAngle: 50,
  goodAngle: 90,
  // Ahead of the beat (more than earlySec) only a swing within earlyAngle of the arrow cuts: a
  // hand crossing the shard sideways that early is on its way to where the swing starts. It is
  // not held against the player either.
  earlySec: 0.08,
  earlyAngle: 65,
  // PERFECT needs the touch within this of the beat (seconds).
  perfectSec: 0.20,
  // A marked shard waits this long for the real cut before it is called BAD (a wind-up through
  // the shard and the swing back take a person 0.2-0.3 s).
  badGraceSec: 0.40,
  // One swing, one shard (per hand), unless they share a beat.
  swingLockSec: 0.08,
  // A hand with a shard of its own this close in time is not blamed for the other hand's.
  wrongHandGuardSec: 0.40,
  // How long the judge waits for a hand's next sample: before taking a touch where the hand
  // was last seen closing in, and before calling BAD / MISS on what it has not seen yet.
  settleSec: 0.09,
  // No path is drawn across a gap in the samples longer than this, or through an unseen hand.
  maxGapSec: 0.20,
  minSeen: 0.3,
  // Scoring.
  points: Object.freeze({ perfect: 1000, good: 600, bad: 150, miss: 0 }),
  goldMultiplier: 2,
  comboStep: 8,          // the multiplier goes up by one every comboStep hits in a row …
  comboMaxMultiplier: 4, // … up to this (x1 -> x4)
  // Rank and stars from accuracy (mean of points / 1000 over the judged shards, gold and
  // combo left out).
  rankS: 0.9,
  rankA: 0.75,
  rankB: 0.6,
  rankC: 0.4,
  starThresholds: Object.freeze([0.2, 0.4, 0.6, 0.75, 0.9]),
});

const EMPTY = Object.freeze([]);
const RAD = 180 / Math.PI;
const isNum = (v) => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;

/** Combo multiplier for a combo count (x1, then +1 every comboStep hits up to the cap). */
export function slashMultiplier(combo, tuning = SLASH_TUNING) {
  const m = 1 + Math.floor(Math.max(0, combo) / tuning.comboStep);
  return m > tuning.comboMaxMultiplier ? tuning.comboMaxMultiplier : m;
}

/** Rank letter for an accuracy 0..1. */
export function slashRank(accuracy, tuning = SLASH_TUNING) {
  if (accuracy >= tuning.rankS) return 'S';
  if (accuracy >= tuning.rankA) return 'A';
  if (accuracy >= tuning.rankB) return 'B';
  if (accuracy >= tuning.rankC) return 'C';
  return 'D';
}

/** Stars 0..5 for an accuracy 0..1. */
export function slashStars(accuracy, tuning = SLASH_TUNING) {
  let stars = 0;
  for (const th of tuning.starThresholds) if (accuracy >= th) stars++;
  return stars;
}

const MAX_CANDIDATES = 24;

/**
 * @param {object[]} notes  chart notes: { id, beat, time, x, y, hand: 'l'|'r'|'any', dir, gold }
 * @param {Partial<typeof SLASH_TUNING>} [opts]  tuning overrides (e.g. { latencySec: 0 } for the demo)
 * @returns judge:
 *   push(handsFrame)        every frame during play; reads frame.t and frame.l / frame.r
 *   update(songTime)        -> events judged since the last call, in the order they were judged
 *                              (an empty frozen array when there are none; a non-empty array is
 *                              yours to keep). Call it right after push(), with the same time.
 *     event: { note, rating: 'perfect'|'good'|'bad'|'miss', hand, points, combo, multiplier,
 *              angleErr, offsetSec, x, y, gold, reason, hitX, hitY, dirX, dirY, speed }
 *       hand       the hand that touched it ('l' | 'r'); for a miss, the note's own `hand`
 *       combo, multiplier   after this event
 *       angleErr   degrees between the swing and the cut line (0 for an `any` shard; NaN for a miss)
 *       offsetSec  touch time minus note time, latency taken out (negative = early; NaN for a miss)
 *       x, y       the shard's pp position (where the cut FX belongs)
 *       reason     'cut' | 'direction' | 'hand' | 'miss'
 *       hitX, hitY where the hand's path came closest; dirX, dirY its unit direction there;
 *       speed      units/s of that piece of path (all 0 / the note position for a miss)
 *   stats(out?)             -> { score, maxScore, combo, maxCombo, multiplier,
 *                               counts: { perfect, good, bad, miss }, accuracy, judged, total,
 *                               rank, stars }  (a new object, or `out` filled in place)
 *   reset()                 back to the start of the chart
 *   debug(songTime)         -> { next, total, open: [{ id, time, marked }] } for a debug overlay
 */
export function createSlashJudge(notes, opts = {}) {
  const cfg = { ...SLASH_TUNING, ...opts };
  cfg.points = { ...SLASH_TUNING.points, ...(opts && opts.points ? opts.points : null) };

  const list = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && isNum(n.time) && isNum(n.x) && isNum(n.y))
    .slice()
    .sort((a, b) => a.time - b.time);
  const N = list.length;

  // Notes, unpacked.
  const nt = new Float64Array(N);
  const nx = new Float64Array(N);
  const ny = new Float64Array(N);
  const ndx = new Float64Array(N);
  const ndy = new Float64Array(N);
  const nFree = new Uint8Array(N);   // 1 = any direction
  const nHand = new Int8Array(N);    // 0 = l, 1 = r, 2 = either
  let maxScore = 0;
  for (let i = 0; i < N; i++) {
    const n = list[i];
    nt[i] = n.time; nx[i] = n.x; ny[i] = n.y;
    const d = DIRS[n.dir];
    if (d) { ndx[i] = d[0]; ndy[i] = d[1]; } else nFree[i] = 1;
    nHand[i] = n.hand === 'l' ? 0 : n.hand === 'r' ? 1 : 2;
    maxScore += Math.round(cfg.points.perfect * (n.gold ? cfg.goldMultiplier : 1) * slashMultiplier(i + 1, cfg));
  }
  // "Share a beat": same beat number when the chart gives one, else the same time.
  const sameBeat = (i, j) => (isNum(list[i].beat) && isNum(list[j].beat)
    ? Math.abs(list[i].beat - list[j].beat) < 1e-6
    : Math.abs(nt[i] - nt[j]) < 1e-6);

  // Per-note state.
  const done = new Uint8Array(N);
  const markT = new Float64Array(N);  // hand time of the wrong touch that marked it (NaN = unmarked)
  const markHand = new Int8Array(N);
  const markWhy = new Uint8Array(N);  // 1 = direction, 2 = hand
  const markAngle = new Float64Array(N);
  const markDX = new Float64Array(N);
  const markDY = new Float64Array(N);
  const markHX = new Float64Array(N);
  const markHY = new Float64Array(N);
  const markSpeed = new Float64Array(N);

  // Per-hand path state.
  const makeHandState = () => ({
    has: false, x: 0, y: 0, t: 0,   // last distinct sample (hand time)
    fs: 0,                          // the frame's speed estimate at that sample
    moving: false,                  // the last piece of path was a fast one …
    dx: 0, dy: 0, sp: 0, len: 0,    // … with this unit direction, speed and length
    open: false,                    // closing in on a shard: the next sample decides
    cutT: -Infinity, cutNote: -1,   // last cut by this hand
  });
  const hands = [makeHandState(), makeHandState()];

  // Scratch for the touches of one piece of path.
  const cI = new Int32Array(MAX_CANDIDATES);
  const cT = new Float64Array(MAX_CANDIDATES);
  const cD = new Float64Array(MAX_CANDIDATES);
  const cDX = new Float64Array(MAX_CANDIDATES);
  const cDY = new Float64Array(MAX_CANDIDATES);
  const cHX = new Float64Array(MAX_CANDIDATES);
  const cHY = new Float64Array(MAX_CANDIDATES);
  const cAngle = new Float64Array(MAX_CANDIDATES);
  const cKind = new Uint8Array(MAX_CANDIDATES); // 1 = may cut, 2 = wrong direction, 3 = wrong hand
  let nc = 0;

  let lo = 0;          // first note not yet judged
  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let creditSum = 0;
  let judged = 0;
  const counts = { perfect: 0, good: 0, bad: 0, miss: 0 };
  let queue = [];

  function reset() {
    done.fill(0);
    markT.fill(NaN);
    for (const H of hands) {
      H.has = false; H.moving = false; H.open = false; H.cutT = -Infinity; H.cutNote = -1; H.fs = 0;
    }
    lo = 0; score = 0; combo = 0; maxCombo = 0; creditSum = 0; judged = 0;
    counts.perfect = 0; counts.good = 0; counts.bad = 0; counts.miss = 0;
    queue = [];
  }
  reset();

  function settle(i, rating, hand, reason, offsetSec, angleErr, hitX, hitY, dirX, dirY, speed) {
    done[i] = 1;
    const note = list[i];
    if (rating === 'perfect' || rating === 'good') combo++; else combo = 0;
    if (combo > maxCombo) maxCombo = combo;
    const multiplier = slashMultiplier(combo, cfg);
    const points = Math.round(cfg.points[rating] * (note.gold ? cfg.goldMultiplier : 1) * multiplier);
    score += points;
    counts[rating]++;
    creditSum += cfg.points[rating] / cfg.points.perfect;
    judged++;
    queue.push({
      note, rating, hand, points, combo, multiplier, angleErr, offsetSec,
      x: note.x, y: note.y, gold: !!note.gold, reason, hitX, hitY, dirX, dirY, speed,
    });
  }

  const handName = (h) => (h === 0 ? 'l' : 'r');

  function settleMarked(i) {
    settle(i, 'bad', handName(markHand[i]), markWhy[i] === 2 ? 'hand' : 'direction',
      markT[i] - nt[i], markAngle[i], markHX[i], markHY[i], markDX[i], markDY[i], markSpeed[i]);
  }

  /** Does hand h have a shard of its own close enough in time to note i to be busy with it? */
  function busy(h, i) {
    const g = cfg.wrongHandGuardSec;
    for (let j = i - 1; j >= 0 && nt[i] - nt[j] <= g; j--) if (nHand[j] === h) return true;
    for (let j = i + 1; j < N && nt[j] - nt[i] <= g; j++) if (nHand[j] === h) return true;
    return false;
  }

  function addCandidate(h, i, tt, dist, dx, dy, hx, hy) {
    if (nc >= MAX_CANDIDATES) return;
    const own = nHand[i] === 2 || nHand[i] === h;
    let angle = 0;
    if (!nFree[i]) {
      let dot = dx * ndx[i] + dy * ndy[i];
      dot = dot > 1 ? 1 : dot < -1 ? -1 : dot;
      angle = Math.acos(dot) * RAD;
    }
    const kind = !own ? 3 : angle <= cfg.goodAngle ? 1 : 2;
    if (kind === 1 && angle > cfg.earlyAngle && tt < nt[i] - cfg.earlySec) return; // sideways, ahead of the beat: passing by
    cI[nc] = i; cT[nc] = tt; cD[nc] = dist; cDX[nc] = dx; cDY[nc] = dy; cHX[nc] = hx; cHY[nc] = hy;
    cAngle[nc] = angle;
    cKind[nc] = kind;
    nc++;
  }

  function cut(h, H, c, speed) {
    const i = cI[c];
    const offset = cT[c] - nt[i];
    const perfect = cAngle[c] <= cfg.perfectAngle && Math.abs(offset) <= cfg.perfectSec;
    H.cutT = cT[c];
    H.cutNote = i;
    settle(i, perfect ? 'perfect' : 'good', handName(h), 'cut', offset, cAngle[c],
      cHX[c], cHY[c], cDX[c], cDY[c], speed);
  }

  /** Decide what the touches gathered in the scratch arrays do. */
  function resolve(h, H, speed) {
    if (nc === 0) return;
    // 1. the shard this swing cuts: nearest in time to the touch, then nearest in space
    let best = -1;
    for (let c = 0; c < nc; c++) {
      if (cKind[c] !== 1) continue;
      const i = cI[c];
      if (cT[c] - H.cutT < cfg.swingLockSec && H.cutNote >= 0 && !sameBeat(i, H.cutNote)) continue;
      if (best < 0) { best = c; continue; }
      const a = Math.abs(cT[c] - nt[i]);
      const b = Math.abs(cT[best] - nt[cI[best]]);
      if (a < b - 1e-9 || (Math.abs(a - b) <= 1e-9 && cD[c] < cD[best])) best = c;
    }
    if (best >= 0) {
      const first = cI[best];
      cut(h, H, best, speed);
      // … and whatever else of the same beat it went through
      for (let c = 0; c < nc; c++) {
        if (c === best || cKind[c] !== 1 || done[cI[c]]) continue;
        if (sameBeat(cI[c], first)) cut(h, H, c, speed);
      }
      return; // the swing is spoken for: it marks nothing
    }
    // 2. no cut: a real swing the wrong way, or with the wrong hand, marks the shard
    if (speed < cfg.badMinSpeed) return;
    for (let c = 0; c < nc; c++) {
      const i = cI[c];
      if (cKind[c] === 1 || done[i] || markT[i] === markT[i]) continue;
      if (cKind[c] === 2 && cD[c] > cfg.wrongDirRadius) continue; // the wrong way, but only past its rim
      if (cT[c] - H.cutT < cfg.swingLockSec) continue; // the follow-through of a cut
      if (cKind[c] === 3 && busy(h, i)) continue;
      markT[i] = cT[c];
      markHand[i] = h;
      markWhy[i] = cKind[c] === 3 ? 2 : 1;
      markAngle[i] = cAngle[c];
      markDX[i] = cDX[c]; markDY[i] = cDY[c];
      markHX[i] = cHX[c]; markHY[i] = cHY[c];
      markSpeed[i] = speed;
    }
  }

  /**
   * The path of hand h has come to an end at its last sample (it stopped, went unseen, or no
   * sample followed): shards it was closing in on are touched there, in the direction it came.
   */
  function closeApproach(h, H) {
    H.open = false;
    if (!H.has || !H.moving) return;
    nc = 0;
    for (let i = lo; i < N; i++) {
      if (nt[i] - cfg.windowBefore > H.t) break;
      if (done[i] || H.t > nt[i] + cfg.windowAfter) continue;
      const ex = nx[i] - H.x;
      const ey = ny[i] - H.y;
      const dist = Math.sqrt(ex * ex + ey * ey);
      const own = nHand[i] === 2 || nHand[i] === h;
      if (dist > Math.min(cfg.stopRadius, own ? cfg.hitRadius : cfg.wrongHandRadius)) continue;
      addCandidate(h, i, H.t, dist, H.dx, H.dy, H.x, H.y);
    }
    resolve(h, H, H.sp);
  }

  function pushHand(h, f, th) {
    const H = hands[h];
    if (!f || !(f.seen >= cfg.minSeen) || !isNum(f.x) || !isNum(f.y)) {
      if (H.open) closeApproach(h, H);
      H.has = false; H.moving = false;
      return;
    }
    const x1 = f.x;
    const y1 = f.y;
    const fs1 = isNum(f.speed) ? f.speed : NaN;
    if (!H.has || th < H.t) {
      // first sight of the hand, or the clock went back (a seek): a new path starts here
      H.has = true; H.x = x1; H.y = y1; H.t = th; H.fs = fs1; H.moving = false; H.open = false;
      return;
    }
    if (x1 === H.x && y1 === H.y) return; // the tracker has nothing new: same sample as before
    const dt = th - H.t;
    if (!(dt > 0) || dt > cfg.maxGapSec) {
      if (H.open) closeApproach(h, H);
      H.x = x1; H.y = y1; H.t = th; H.fs = fs1; H.moving = false;
      return;
    }
    const x0 = H.x;
    const y0 = H.y;
    const t0 = H.t;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const speed = len / dt;
    // fast enough? the piece itself, and the hand's own (averaged) speed at either end
    const fsMin = cfg.minSpeed * cfg.frameSpeedRatio;
    const fast = speed >= cfg.minSpeed && !(H.fs < fsMin && fs1 < fsMin);
    if (!fast) {
      if (H.open) closeApproach(h, H); // it arrived and stopped
      H.x = x1; H.y = y1; H.t = th; H.fs = fs1; H.moving = false;
      return;
    }
    const ux = dx / len;
    const uy = dy / len;
    let open = false;
    nc = 0;
    for (let i = lo; i < N; i++) {
      if (nt[i] - cfg.windowBefore > th) break;
      if (done[i]) continue;
      // closest point of the piece to the shard
      let u = ((nx[i] - x0) * dx + (ny[i] - y0) * dy) / (len * len);
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = x0 + u * dx;
      const qy = y0 + u * dy;
      const ex = nx[i] - qx;
      const ey = ny[i] - qy;
      const dist = Math.sqrt(ex * ex + ey * ey);
      const own = nHand[i] === 2 || nHand[i] === h;
      if (dist > (own ? cfg.hitRadius : cfg.wrongHandRadius)) continue;
      if (u >= 1 - 1e-9) { open = true; continue; } // still closing in
      const tt = t0 + u * dt;
      if (tt < nt[i] - cfg.windowBefore || tt > nt[i] + cfg.windowAfter) continue;
      if (u <= 1e-9 && H.moving) {
        // Closest at the very start of the piece. If the previous piece was still closing in
        // when it ended, the hand turned right there: a touch, in the direction it came. If
        // not, the hand is on its way out of a pass that the previous piece has already
        // accounted for (cut, or refused: too early, or locked) — not a second touch.
        // (same test, same tolerance, as "u >= 1" on the previous piece)
        if ((nx[i] - x0) * H.dx + (ny[i] - y0) * H.dy < -1e-9 * H.len) continue;
        addCandidate(h, i, tt, dist, H.dx, H.dy, qx, qy);
      } else {
        addCandidate(h, i, tt, dist, ux, uy, qx, qy);
      }
    }
    resolve(h, H, speed);
    H.open = open;
    H.x = x1; H.y = y1; H.t = th; H.fs = fs1;
    H.moving = true; H.dx = ux; H.dy = uy; H.sp = speed; H.len = len;
  }

  /** The hands of this frame. Uses frame.t (song seconds) and frame.l / frame.r. */
  function push(frame) {
    if (!frame || !isNum(frame.t)) return;
    const th = frame.t - cfg.latencySec;
    pushHand(0, frame.l, th);
    pushHand(1, frame.r, th);
  }

  /**
   * Is everything the hands that may cut note i did up to hand time `when` on the table? Yes
   * once each of them has delivered a sample at or after `when` (or is not being followed),
   * and in any case settleSec later.
   */
  function seenUntil(i, when, th) {
    if (th - when > cfg.settleSec) return true;
    for (let h = 0; h < 2; h++) {
      if (nHand[i] !== 2 && nHand[i] !== h) continue;
      if (hands[h].has && hands[h].t < when) return false;
    }
    return true;
  }

  /** Judge what can be judged by `songTime`; returns the new events (cuts found by push() included). */
  function update(songTime) {
    if (isNum(songTime)) {
      const th = songTime - cfg.latencySec;
      for (let h = 0; h < 2; h++) {
        const H = hands[h];
        if (H.open && th - H.t > cfg.settleSec) closeApproach(h, H);
      }
      for (let i = lo; i < N; i++) {
        if (nt[i] - cfg.windowBefore > th) break;
        if (done[i]) continue;
        const closes = nt[i] + cfg.windowAfter;
        const marked = markT[i] === markT[i];
        const deadline = marked ? Math.min(markT[i] + cfg.badGraceSec, closes) : closes;
        if (!(th > deadline) || !seenUntil(i, deadline, th)) continue;
        if (deadline === closes) {
          // last call for a hand that came to rest on it just before the window closed
          for (let h = 0; h < 2; h++) if (hands[h].open) closeApproach(h, hands[h]);
          if (done[i]) continue;
        }
        if (marked) settleMarked(i);
        else settle(i, 'miss', list[i].hand, 'miss', NaN, NaN, nx[i], ny[i], 0, 0, 0);
      }
      while (lo < N && done[lo]) lo++;
    }
    if (queue.length === 0) return EMPTY;
    const out = queue;
    queue = [];
    return out;
  }

  function stats(out) {
    const s = out && typeof out === 'object' ? out : {};
    const accuracy = judged > 0 ? creditSum / judged : 0;
    s.score = score;
    s.maxScore = maxScore;
    s.combo = combo;
    s.maxCombo = maxCombo;
    s.multiplier = slashMultiplier(combo, cfg);
    if (!s.counts || typeof s.counts !== 'object') s.counts = {};
    s.counts.perfect = counts.perfect;
    s.counts.good = counts.good;
    s.counts.bad = counts.bad;
    s.counts.miss = counts.miss;
    s.accuracy = accuracy;
    s.judged = judged;
    s.total = N;
    s.rank = slashRank(accuracy, cfg);
    s.stars = slashStars(accuracy, cfg);
    return s;
  }

  /** For a debug overlay: where the judge stands and which shards are open (allocates). */
  function debug(songTime) {
    const th = isNum(songTime) ? songTime - cfg.latencySec : NaN;
    const open = [];
    for (let i = lo; i < N; i++) {
      if (th === th && nt[i] - cfg.windowBefore > th) break;
      if (done[i]) continue;
      open.push({ id: list[i].id, time: nt[i], marked: markT[i] === markT[i] });
      if (th !== th) break;
    }
    return { next: lo, total: N, open };
  }

  return { push, update, stats, reset, debug };
}
