// STARFALL — STAR SLASH: where the hands are (CONTRACT-slash.md). Pure math, no DOM.
//
//   createHandReader()  tracker result (33 mirrored image landmarks) -> HandsFrame, every frame
//   createDemoHands()   a simulated player -> HandsFrame, for the demo and for the tests
//
// A HandsFrame is { t, l: { x, y, vx, vy, speed, seen }, r: { … } } in PLAY-PLANE coordinates:
// origin = the player's shoulder midpoint, unit = one shoulder width, +x = screen right, +y = up.
// `l` is the hand on the screen-left — the player's own left hand, MediaPipe landmark 15 (the
// tracker has already mirrored x, so nothing is flipped here). Both factories hand back the SAME
// frame object on every call and allocate nothing per frame.

import { DIRS, handOf } from './chart.js';

// MediaPipe pose landmark indices (11/13/15 = the player's left side = screen-left).
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_ELBOW = 13;
const R_ELBOW = 14;
const L_WRIST = 15;
const R_WRIST = 16;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isNum = (v) => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;

function makeHand(x, y) {
  return { x, y, vx: 0, vy: 0, speed: 0, seen: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Hand reader
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Tuning of createHandReader; override any of them through its options. */
export const HAND_READER_DEFAULTS = Object.freeze({
  // The hand point: wrist + palmExtend x (wrist - elbow), roughly the palm.
  palmExtend: 0.35,
  // One-Euro filter on the pp position (units and seconds). The tracker has already smoothed
  // the landmarks, so this one is light: it calms a resting hand and gets out of the way of a
  // swing (cutoff = minCutoff + beta x speed).
  minCutoff: 3.5,
  beta: 0.9,
  dCutoff: 2.5,
  // Velocity = least-squares slope of the unsmoothed positions over this much history. With
  // 22-30 tracker results a second that is 3-4 samples: one noisy sample cannot fake a swing.
  velWindowSec: 0.11,
  // Shoulders: both must be at least this visible and this far apart (fraction of the image
  // height) to give the origin and the scale.
  minShoulderVis: 0.3,
  minShoulderWidth: 0.04,
  // The scale follows a wider reading quickly and a narrower one slowly: turning the body in a
  // swing foreshortens the shoulders, it does not shrink the player. A reading below
  // collapseRatio x the known width (sideways to the camera) is not followed at all — unless
  // it stays that way for collapseHoldSec, in which case the old width was the wrong one.
  scaleUpTau: 0.12,
  scaleDownTau: 1.5,
  collapseRatio: 0.45,
  collapseHoldSec: 1.0,
  originTau: 0.05,
  // Shoulders unusable: keep the last origin and scale for this long, fading `seen` to 0.
  holdSec: 0.5,
  // A wrist this far outside the picture (fraction of the frame) still counts fully, then fades.
  offFrameFree: 0.08,
  offFrameFade: 0.3,
  // Below this a hand is not followed (position held, velocity 0, seen 0).
  minSeen: 0.1,
  // The same tracker result read this many times in a row (it normally changes every 2-3
  // frames) means tracking has stalled: the velocity then fades out instead of sticking.
  staleReads: 15,
  // Where the hands are reported before anything has been seen.
  restX: 0.7,
  restY: -0.35,
});

const VEL_SAMPLES = 8;

function makeTrack() {
  return {
    live: false,          // being followed (filters primed)
    fx: 0, fy: 0,         // filtered position
    dfx: 0, dfy: 0,       // One-Euro derivative estimates
    n: 0, head: 0,        // ring buffer of raw samples
    bt: new Float64Array(VEL_SAMPLES),
    bx: new Float64Array(VEL_SAMPLES),
    by: new Float64Array(VEL_SAMPLES),
  };
}

/**
 * Tracker results -> hands in play-plane coordinates.
 * @param {Partial<typeof HAND_READER_DEFAULTS>} [opts]
 * @returns {{ read(trackerResult: object|null, songTime: number): object, reset(): void }}
 *   read() is meant to be called every animation frame with the tracker's current result (or
 *   null when nobody is tracked). The tracker result is updated in place 22-30 times a second;
 *   a new sample is recognised by `result.t` (ms), repeated reads change nothing but frame.t.
 *   Beyond the contract's fields the frame carries `fresh` (this call consumed a new tracker
 *   sample) and `body` (0..1: shoulders usable — 0 means "step back into the picture").
 */
export function createHandReader(opts = {}) {
  const cfg = { ...HAND_READER_DEFAULTS, ...opts };
  const frame = {
    t: 0,
    l: makeHand(-cfg.restX, cfg.restY),
    r: makeHand(cfg.restX, cfg.restY),
    fresh: false,
    body: 0,
  };
  const tracks = [makeTrack(), makeTrack()];
  let lastStamp = NaN;   // seconds, of the sample last consumed
  let lastId;            // result.id of that sample (the tracker changes it with the person)
  let hasScale = false;
  let scale = 1;         // shoulder width in image heights
  let ox = 0;            // shoulder midpoint, x in image heights (aspect-corrected), y image-down
  let oy = 0;
  let holdT = Infinity;  // seconds since the shoulders were last usable
  let narrowT = 0;       // seconds the shoulders have read far narrower than the scale
  let repeats = 0;

  function lose(track, hand) {
    track.live = false;
    track.n = 0;
    hand.vx = 0; hand.vy = 0; hand.speed = 0; hand.seen = 0;
  }

  function reset() {
    lastStamp = NaN;
    lastId = undefined;
    hasScale = false;
    holdT = Infinity;
    narrowT = 0;
    repeats = 0;
    lose(tracks[0], frame.l);
    lose(tracks[1], frame.r);
    frame.l.x = -cfg.restX; frame.l.y = cfg.restY;
    frame.r.x = cfg.restX; frame.r.y = cfg.restY;
    frame.fresh = false;
    frame.body = 0;
  }

  // Visibility of a landmark that may sit outside the picture.
  function offFrame(p) {
    const ex = p.x < 0 ? -p.x : p.x > 1 ? p.x - 1 : 0;
    const ey = p.y < 0 ? -p.y : p.y > 1 ? p.y - 1 : 0;
    let u = ((ex > ey ? ex : ey) - cfg.offFrameFree) / cfg.offFrameFade;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    return 1 - u * u * (3 - 2 * u);
  }

  function follow(track, hand, wrist, elbow, aspect, stamp, dt, bodyFactor) {
    if (!wrist || !isNum(wrist.x) || !isNum(wrist.y)) { lose(track, hand); return; }
    const wv = clamp01(isNum(wrist.v) ? wrist.v : 0) * offFrame(wrist);
    const elbowOk = !!elbow && isNum(elbow.x) && isNum(elbow.y);
    const ev = elbowOk ? clamp01(isNum(elbow.v) ? elbow.v : 0) : 0;
    const seen = wv * (0.6 + 0.4 * ev) * bodyFactor;
    if (!(seen >= cfg.minSeen)) { lose(track, hand); return; }

    // palm = wrist + k (wrist - elbow); an elbow that is not really seen is not trusted
    let k = clamp01((ev - 0.2) / 0.3);
    k = cfg.palmExtend * k * k * (3 - 2 * k);
    const px = wrist.x + (elbowOk ? k * (wrist.x - elbow.x) : 0);
    const py = wrist.y + (elbowOk ? k * (wrist.y - elbow.y) : 0);
    const X = (px * aspect - ox) / scale;
    const Y = -(py - oy) / scale;
    if (!isNum(X) || !isNum(Y)) { lose(track, hand); return; }

    if (!track.live || !(dt > 0)) {
      // first sample of this hand (or after a gap): nothing to smooth or differentiate yet
      track.live = true;
      track.fx = X; track.fy = Y;
      track.dfx = 0; track.dfy = 0;
      track.n = 0; track.head = 0;
      hand.vx = 0; hand.vy = 0; hand.speed = 0;
    } else {
      // One-Euro, both axes sharing one cutoff (from the speed of the point, not per axis, so
      // a diagonal swing is not smoothed more along one axis than the other)
      const w2 = 2 * Math.PI * dt;
      const ad = (w2 * cfg.dCutoff) / (1 + w2 * cfg.dCutoff);
      track.dfx += ((X - track.fx) / dt - track.dfx) * ad;
      track.dfy += ((Y - track.fy) / dt - track.dfy) * ad;
      const sp = Math.sqrt(track.dfx * track.dfx + track.dfy * track.dfy);
      const w = w2 * (cfg.minCutoff + cfg.beta * sp);
      const a = w / (1 + w);
      track.fx += (X - track.fx) * a;
      track.fy += (Y - track.fy) * a;
    }

    // raw sample into the ring, then the slope over the last velWindowSec
    const h = track.head;
    track.bt[h] = stamp; track.bx[h] = X; track.by[h] = Y;
    track.head = (h + 1) % VEL_SAMPLES;
    if (track.n < VEL_SAMPLES) track.n++;
    if (track.n >= 2) {
      let n = 0;
      let st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
      for (let j = 0; j < track.n; j++) {
        const idx = (h - j + VEL_SAMPLES) % VEL_SAMPLES;
        const tau = track.bt[idx] - stamp; // <= 0
        // the window, or at least the previous sample when the tracker runs slowly
        if (tau < -cfg.velWindowSec - 1e-6 && (n >= 2 || tau < -2.5 * cfg.velWindowSec)) break;
        n++;
        st += tau; sx += track.bx[idx]; sy += track.by[idx];
        stt += tau * tau; stx += tau * track.bx[idx]; sty += tau * track.by[idx];
      }
      const den = n * stt - st * st;
      if (n >= 2 && den > 1e-12) {
        hand.vx = (n * stx - st * sx) / den;
        hand.vy = (n * sty - st * sy) / den;
      } else {
        hand.vx = 0; hand.vy = 0;
      }
      if (!isNum(hand.vx) || !isNum(hand.vy)) { hand.vx = 0; hand.vy = 0; }
      hand.speed = Math.sqrt(hand.vx * hand.vx + hand.vy * hand.vy);
    }
    hand.x = track.fx;
    hand.y = track.fy;
    hand.seen = clamp01(seen);
  }

  function read(result, songTime) {
    frame.t = isNum(songTime) ? songTime : 0;
    frame.fresh = false;
    const lm = result && result.landmarks;
    if (!lm || !(lm.length > R_WRIST)) {
      // nobody there
      lose(tracks[0], frame.l);
      lose(tracks[1], frame.r);
      frame.body = 0;
      lastStamp = NaN;
      holdT = Infinity;
      return frame;
    }

    // A new sample? The tracker stamps each detection with `t` (ms); a result without a usable
    // stamp (hand-made input) counts as new whenever the song time has moved.
    const stamp = isNum(result.t) ? result.t / 1000 : frame.t;
    if (stamp === lastStamp) {
      if (++repeats > cfg.staleReads) {
        for (let i = 0; i < 2; i++) {
          const hand = i === 0 ? frame.l : frame.r;
          hand.vx *= 0.85; hand.vy *= 0.85;
          hand.speed = Math.sqrt(hand.vx * hand.vx + hand.vy * hand.vy);
        }
      }
      return frame;
    }
    let dt = stamp - lastStamp;
    const who = result.id;
    // first sample, a long gap, a clock jump or another person in the slot: start afresh
    if (!(dt > 0) || dt > 0.5 || who !== lastId) dt = 0;
    lastStamp = stamp;
    lastId = who;
    repeats = 0;
    frame.fresh = true;

    const aspect = isNum(result.aspect) && result.aspect > 0 ? result.aspect : 4 / 3;
    const ls = lm[L_SHOULDER];
    const rs = lm[R_SHOULDER];
    let bodyOk = false;
    if (ls && rs && isNum(ls.x) && isNum(ls.y) && isNum(rs.x) && isNum(rs.y)) {
      const sx = (ls.x - rs.x) * aspect;
      const sy = ls.y - rs.y;
      const width = Math.sqrt(sx * sx + sy * sy);
      const vis = Math.min(isNum(ls.v) ? ls.v : 0, isNum(rs.v) ? rs.v : 0);
      if (vis >= cfg.minShoulderVis && width >= cfg.minShoulderWidth) {
        bodyOk = true;
        const mx = (ls.x + rs.x) * 0.5 * aspect;
        const my = (ls.y + rs.y) * 0.5;
        if (!hasScale || dt === 0) {
          // first sight (or back after a gap, or somebody else): take the reading as it is
          scale = width;
          hasScale = true;
          narrowT = 0;
          ox = mx; oy = my;
        } else {
          narrowT = width < scale * cfg.collapseRatio ? narrowT + dt : 0;
          if (narrowT === 0 || narrowT > cfg.collapseHoldSec) {
            const tau = width > scale ? cfg.scaleUpTau : cfg.scaleDownTau;
            scale += (width - scale) * (1 - Math.exp(-dt / tau));
          }
          const ko = 1 - Math.exp(-dt / cfg.originTau);
          ox += (mx - ox) * ko;
          oy += (my - oy) * ko;
        }
        holdT = 0;
      }
    }
    if (!bodyOk) holdT = dt > 0 ? holdT + dt : Infinity;
    const usable = hasScale && scale > 1e-6 && holdT <= cfg.holdSec;
    const bodyFactor = !usable ? 0 : bodyOk ? 1 : 1 - holdT / cfg.holdSec;
    frame.body = bodyFactor;
    if (!usable) {
      lose(tracks[0], frame.l);
      lose(tracks[1], frame.r);
      return frame;
    }
    follow(tracks[0], frame.l, lm[L_WRIST], lm[L_ELBOW], aspect, stamp, dt, bodyFactor);
    follow(tracks[1], frame.r, lm[R_WRIST], lm[R_ELBOW], aspect, stamp, dt, bodyFactor);
    return frame;
  }

  return { read, reset };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Demo hands: a simulated player
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Tuning of createDemoHands; override any of them through its options. */
export const DEMO_HANDS_DEFAULTS = Object.freeze({
  skill: 0.9,          // 1 = clean and on the beat, 0.5 = sloppy (late, crooked, some blunders)
  seed: 1,
  // Guard: where a hand waits between cuts (mirrored for the left hand).
  guardX: 0.7,
  guardY: -0.35,
  // The swing: constant acceleration up to swingSpeed at the shard, then the same braking.
  swingSpeed: 7.5,     // units/s at the cut for a skill-1 player (about 3 m/s)
  swingPre: 0.7,       // units travelled before the shard (it starts outside the hit radius) …
  swingPost: 0.58,     // … and after it
  // Between cuts: back to the guard when the next shard for this hand is at least restGapSec
  // away, otherwise straight on to where the next swing starts.
  restGapSec: 0.9,
  returnMinSec: 0.3,   // going back to the guard takes distance / windSpeed, within these
  returnMaxSec: 0.45,
  windSpeed: 4.5,      // units/s, average speed of a wind-up out of the guard
  windMinSec: 0.2,
  windMaxSec: 0.38,
  minTransitSec: 0.06, // least time between the end of one swing and the start of the next
  transitPeak: 9,      // units/s and
  transitAccel: 140,   // units/s²: a hand does not move between two swings harder than this …
  rushSpeed: 10,       // units/s: … nor reach a shard that would take a faster average than this
  minStrokeGapSec: 0.26, // … and cannot swing twice within this: the second shard is let go
  // How far a palm gets from its shoulder (shoulders sit at x = -0.5 / +0.5, y = 0).
  reach: 1.75,
  sway: 0.02,          // idle sway amplitude, units
  // Error model, all scaled by e = 1 - skill. Every shard also gets a "form" factor between
  // formMin and formMax (mostly near the low end, now and then a careless one) that multiplies
  // its timing and direction error: a good player is not uniformly good.
  formMin: 0.6,
  formMax: 3.0,
  timingBase: 0.03,    // s, half-range of the timing error at skill 1
  timingSloppy: 0.26,  // s, added half-range per unit of e
  timingLate: 0.04,    // s, mean lateness per unit of e
  angleBase: 6,        // degrees, half-range of the direction error at skill 1
  angleSloppy: 75,     // degrees, added half-range per unit of e
  aimBase: 0.04,       // units, radius of the aiming error at skill 1
  aimSloppy: 0.5,      // units, added radius per unit of e
  // Blunders, probability = value x e^2: not swinging at all, swinging the wrong way, using
  // the other hand, swinging past the shard.
  skipRate: 0.28,
  wrongDirRate: 0.24,
  wrongHandRate: 0.08,
  whiffRate: 0.12,
});

// Small deterministic hash -> 0..1 (same construction as js/demo-player.js).
function hash01(n, seed) {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const DEG = Math.PI / 180;

/**
 * A simulated player for a chart.
 * @param {object[]} notes  chart notes ({ id, beat, time, col, x, y, hand, dir, … })
 * @param {Partial<typeof DEMO_HANDS_DEFAULTS>} [opts]
 * @returns {{ sample(songTime: number): object, reset(seed?: number): void, plan(): object[] }}
 *   sample() is a pure function of the song time (any rate, any order): each hand follows a
 *   C1-continuous path through keyframes — guard, wind-up, through the shard, follow-through.
 *   plan() lists what the player set out to do with every shard:
 *   { id, hand, kind: 'cut'|'skip'|'wrongDir'|'wrongHand'|'whiff'|'crowded', timeErr, angleErr }.
 */
export function createDemoHands(notes, opts = {}) {
  const cfg = { ...DEMO_HANDS_DEFAULTS, ...opts };
  const skill = clamp01(isNum(cfg.skill) ? cfg.skill : DEMO_HANDS_DEFAULTS.skill);
  const e = 1 - skill;
  const list = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && isNum(n.time) && isNum(n.x) && isNum(n.y))
    .slice()
    .sort((a, b) => a.time - b.time);
  let seed = (cfg.seed | 0) || 1;

  const frame = { t: 0, l: makeHand(-cfg.guardX, cfg.guardY), r: makeHand(cfg.guardX, cfg.guardY) };
  frame.l.seen = 1;
  frame.r.seen = 1;

  // Keyframes per hand: time, position, velocity (cubic Hermite in between).
  const keys = [null, null];
  const cursor = [0, 0];
  let planned = [];

  const guardOf = (h) => [h === 0 ? -cfg.guardX : cfg.guardX, cfg.guardY];

  // Keep a point within arm's reach of the hand's shoulder (and not below the knees).
  function reachable(h, p) {
    const sx = h === 0 ? -0.5 : 0.5;
    const dx = p[0] - sx;
    const dy = p[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > cfg.reach) { p[0] = sx + (dx / d) * cfg.reach; p[1] = (dy / d) * cfg.reach; }
    if (p[1] < -1.5) p[1] = -1.5;
    return p;
  }

  function build() {
    const strokes = [[], []];
    planned = [];
    const lastEnd = [guardOf(0), guardOf(1)];
    const lastT = [-Infinity, -Infinity];

    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const id = n.id !== undefined ? n.id : i;
      const key = (id | 0) + 1;
      const beatKey = Math.round((isNum(n.beat) ? n.beat : n.time) * 8) + 7;
      let h = handOf(n) === 'l' ? 0 : 1;

      // what this player does with the shard
      const roll = hash01(key, seed + 17);
      const e2 = e * e;
      let kind = 'cut';
      let acc = cfg.skipRate * e2;
      if (roll < acc) kind = 'skip';
      else if (roll < (acc += cfg.wrongDirRate * e2)) kind = 'wrongDir';
      else if (roll < (acc += cfg.wrongHandRate * e2)) kind = 'wrongHand';
      else if (roll < (acc += cfg.whiffRate * e2)) kind = 'whiff';
      // the wrong hand only when it has nothing to do just then; a shard for either hand has no wrong hand
      if (kind === 'wrongHand') {
        if (n.hand !== 'l' && n.hand !== 'r') kind = 'cut';
        else if (n.time - lastT[1 - h] < 0.45) kind = 'skip';
        else h = 1 - h;
      }

      // both hands of a double share their form and most of their timing error: people move
      // them together
      const f3 = hash01(beatKey, seed + 59);
      const form = cfg.formMin + (cfg.formMax - cfg.formMin) * f3 * f3 * f3;
      const timeErr = (cfg.timingBase + cfg.timingSloppy * e) * form * (2 * hash01(beatKey, seed + 11) - 1)
        + cfg.timingLate * e
        + 0.012 * (1 + 2 * e) * (2 * hash01(key, seed + 12) - 1);
      let angleErr = (cfg.angleBase + cfg.angleSloppy * e) * form * (2 * hash01(key, seed + 13) - 1);
      if (kind === 'wrongDir') angleErr += hash01(key, seed + 19) < 0.6 ? 180 : (hash01(key, seed + 23) < 0.5 ? 90 : -90);
      planned.push({ id, hand: h === 0 ? 'l' : 'r', kind, timeErr, angleErr });
      if (kind === 'skip') continue;

      const tc = n.time + timeErr;
      const aimR = (cfg.aimBase + cfg.aimSloppy * e) * Math.sqrt(hash01(key, seed + 29));
      const aimA = 2 * Math.PI * hash01(key, seed + 31);
      let px = n.x + aimR * Math.cos(aimA);
      let py = n.y + aimR * Math.sin(aimA);

      // direction of the swing: the shard's, or for a free shard straight through from where
      // the hand is (downwards when it is already on top of it)
      let dx;
      let dy;
      const dir = DIRS[n.dir];
      if (dir) { dx = dir[0]; dy = dir[1]; } else {
        const from = n.time - lastT[h] < cfg.restGapSec ? lastEnd[h] : guardOf(h);
        dx = px - from[0]; dy = py - from[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0.3) { dx /= len; dy /= len; } else { dx = 0; dy = from[1] >= py ? -1 : 1; }
      }
      const a = angleErr * DEG;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rx = dx * ca - dy * sa;
      const ry = dx * sa + dy * ca;
      dx = rx; dy = ry;
      if (kind === 'whiff') {
        // past the shard on one side — the other side when that one is out of reach
        let off = (0.95 + 0.3 * hash01(key, seed + 37)) * (hash01(key, seed + 41) < 0.5 ? -1 : 1);
        const sx = h === 0 ? -0.5 : 0.5;
        if (Math.hypot(px - dy * off - sx, py + dx * off) > cfg.reach - 0.3) off = -off;
        px += -dy * off; py += dx * off;
      }
      const cutAt = reachable(h, [px, py]);
      px = cutAt[0]; py = cutAt[1];

      const speed = cfg.swingSpeed * (1 - 0.3 * e) * (0.85 + 0.3 * hash01(key, seed + 43));
      const pre = cfg.swingPre * (0.9 + 0.2 * hash01(key, seed + 47));
      const post = cfg.swingPost * (0.9 + 0.2 * hash01(key, seed + 53));
      const s = { tc, px, py, dx, dy, speed, pre, post, planned: planned[planned.length - 1] };

      // no time after the previous swing of this hand: nobody swings twice that fast
      const prev = strokes[h][strokes[h].length - 1];
      if (prev && s.tc - prev.tc < cfg.minStrokeGapSec) { s.planned.kind = 'crowded'; continue; }
      strokes[h].push(s);
      lastT[h] = tc;
      lastEnd[h] = [px + dx * post, py + dy * post];
    }

    for (let h = 0; h < 2; h++) {
      const g = guardOf(h);
      const kt = [];
      const kx = [];
      const ky = [];
      const kvx = [];
      const kvy = [];
      const add = (t, x, y, vx, vy) => {
        // keyframe times must increase; a clash (only possible with extreme options) nudges
        const last = kt.length ? kt[kt.length - 1] : -Infinity;
        kt.push(t > last + 1e-4 ? t : last + 1e-4); kx.push(x); ky.push(y); kvx.push(vx); kvy.push(vy);
      };
      add(-1e6, g[0], g[1], 0, 0);
      let at = g;           // where the hand is after the last keyframe
      let atT = -1e6;
      let resting = true;   // at the guard
      let merged = false;   // the previous swing ran straight into this one (shared turning point)
      const list2 = strokes[h];
      const backToGuard = () => {
        const dist = Math.hypot(at[0] - g[0], at[1] - g[1]);
        add(atT + Math.min(cfg.returnMaxSec, Math.max(cfg.returnMinSec, dist / cfg.windSpeed)), g[0], g[1], 0, 0);
      };
      for (let k = 0; k < list2.length; k++) {
        const s = list2[k];
        const tPre = (2 * s.pre) / s.speed;
        const tPost = (2 * s.post) / s.speed;
        const start = reachable(h, [s.px - s.dx * s.pre, s.py - s.dy * s.pre]);
        const end = reachable(h, [s.px + s.dx * s.post, s.py + s.dy * s.post]);
        if (!merged) {
          const t0 = s.tc - tPre;
          const gap = t0 - atT;
          if (resting || gap >= cfg.restGapSec) {
            if (!resting) backToGuard();
            const dist = Math.hypot(start[0] - g[0], start[1] - g[1]);
            let wind = Math.min(cfg.windMaxSec, Math.max(cfg.windMinSec, dist / cfg.windSpeed));
            const earliest = kt[kt.length - 1] + 0.02;
            if (t0 - wind < earliest) wind = Math.max(0.02, t0 - earliest);
            add(t0 - wind, g[0], g[1], 0, 0);
          } else if (gap > 0.42) {
            // a moment to spare: let the arm relax towards the guard on the way
            const mx = (at[0] + start[0]) * 0.5;
            const my = (at[1] + start[1]) * 0.5;
            add(atT + gap * 0.5, mx + (g[0] - mx) * 0.35, my + (g[1] - my) * 0.35,
              ((start[0] - at[0]) / gap) * 0.9, ((start[1] - at[1]) / gap) * 0.9);
          }
          add(t0, start[0], start[1], 0, 0);
        }
        add(s.tc, s.px, s.py, s.dx * s.speed, s.dy * s.speed);
        // Straight into the next swing? When there is no time to finish this one, travel and
        // wind up for the next, the hand turns at the end of a (shortened) follow-through and
        // goes for the next shard from there in one accelerating move.
        merged = false;
        for (let next = list2[k + 1]; next; next = list2[k + 1]) {
          const nStart = reachable(h, [next.px - next.dx * next.pre, next.py - next.dy * next.pre]);
          const travel = Math.hypot(nStart[0] - end[0], nStart[1] - end[1]);
          const transit = Math.max(cfg.minTransitSec, (1.5 * travel) / cfg.transitPeak, Math.sqrt((6 * travel) / cfg.transitAccel));
          const need = tPost + (2 * next.pre) / next.speed + transit;
          const gap = next.tc - s.tc;
          if (gap >= need) break;
          // the less time there is, the shorter the follow-through
          const kk = Math.max(0.3, gap / need);
          const m = reachable(h, [s.px + s.dx * s.post * kk, s.py + s.dy * s.post * kk]);
          let tau = tPost * kk;
          tau = tau < 0.2 * gap ? 0.2 * gap : tau > 0.6 * gap ? 0.6 * gap : tau;
          // too far to get to in the time left: this player lets the next shard go
          if (Math.hypot(next.px - m[0], next.py - m[1]) > cfg.rushSpeed * (gap - tau)) {
            next.planned.kind = 'crowded';
            list2.splice(k + 1, 1);
            continue;
          }
          add(s.tc + tau, m[0], m[1], 0, 0);
          // More time than a straight swing from there takes: wait at the turning point first.
          // Only when the next shard lies ahead in its cut direction and a swing's length away;
          // otherwise the curve itself scoops round (or backs off) into the cut.
          const ax = next.px - m[0];
          const ay = next.py - m[1];
          const reachD = Math.hypot(ax, ay);
          const swing = (2 * reachD) / next.speed;
          if (reachD >= 0.45 && ax * next.dx + ay * next.dy >= 0.85 * reachD && gap - tau > swing * 1.15 + 0.02) {
            add(next.tc - swing, m[0], m[1], 0, 0);
          }
          merged = true;
          break;
        }
        if (!merged) {
          add(s.tc + tPost, end[0], end[1], 0, 0);
          at = end;
          atT = s.tc + tPost;
        }
        resting = false;
      }
      if (!resting) backToGuard();
      add(1e6, g[0], g[1], 0, 0);
      keys[h] = {
        n: kt.length,
        t: Float64Array.from(kt), x: Float64Array.from(kx), y: Float64Array.from(ky),
        vx: Float64Array.from(kvx), vy: Float64Array.from(kvy),
      };
      cursor[h] = 0;
    }
  }

  function evalHand(h, t, out) {
    const K = keys[h];
    let c = cursor[h];
    if (c > K.n - 2) c = K.n - 2;
    while (c < K.n - 2 && t >= K.t[c + 1]) c++;
    while (c > 0 && t < K.t[c]) c--;
    cursor[h] = c;
    const t0 = K.t[c];
    const span = K.t[c + 1] - t0;
    let s = (t - t0) / span;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const s2 = s * s;
    const s3 = s2 * s;
    // cubic Hermite and its derivative
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    const d00 = 6 * s2 - 6 * s;
    const d10 = 3 * s2 - 4 * s + 1;
    const d01 = -d00;
    const d11 = 3 * s2 - 2 * s;
    const x0 = K.x[c], x1 = K.x[c + 1], y0 = K.y[c], y1 = K.y[c + 1];
    const m0x = K.vx[c] * span, m1x = K.vx[c + 1] * span;
    const m0y = K.vy[c] * span, m1y = K.vy[c + 1] * span;
    // a little life while waiting: slow sway, a different phase per hand
    const p = h * 1.9 + (seed % 7) * 0.6;
    const swx = cfg.sway * Math.sin(t * 1.7 + p);
    const swy = cfg.sway * 0.8 * Math.sin(t * 2.3 + p * 1.3);
    out.x = h00 * x0 + h10 * m0x + h01 * x1 + h11 * m1x + swx;
    out.y = h00 * y0 + h10 * m0y + h01 * y1 + h11 * m1y + swy;
    out.vx = (d00 * x0 + d10 * m0x + d01 * x1 + d11 * m1x) / span + cfg.sway * 1.7 * Math.cos(t * 1.7 + p);
    out.vy = (d00 * y0 + d10 * m0y + d01 * y1 + d11 * m1y) / span + cfg.sway * 0.8 * 2.3 * Math.cos(t * 2.3 + p * 1.3);
    out.speed = Math.sqrt(out.vx * out.vx + out.vy * out.vy);
    out.seen = 1;
  }

  /** The hands at song time `t` (seconds). Same frame object every call. */
  function sample(t) {
    const time = isNum(t) ? t : 0;
    frame.t = time;
    evalHand(0, time, frame.l);
    evalHand(1, time, frame.r);
    return frame;
  }

  /** New run; another seed gives another (repeatable) performance. */
  function reset(newSeed) {
    if (isNum(newSeed)) seed = (newSeed | 0) || 1;
    build();
  }

  build();
  return { sample, reset, plan: () => planned };
}
