// STARFALL — STAR SLASH on the keyboard (no camera). Pure: no DOM, imports the chart only.
//
//   left hand  (teal shards)   W A S D
//   right hand (amber shards)  the arrow keys
//
// A key is a cut in its direction; two keys of one hand together are a diagonal. WHERE a shard
// sits does not matter on the keyboard: a key goes to the shard of its hand that is due, and
// NOVA reaches for that cell. Keys are read by their physical position (KeyboardEvent.code), so
// the layout and the input language (한/영) make no difference.
//
// How a key press is judged
// -------------------------
// The judge (judge.js) knows nothing about keys: it reads hand paths. So a key press is handed
// to it as the shortest possible swing — two hand samples, one either side of the shard, in the
// direction of the key, timed so that the path crosses the shard at the moment the key went
// down — and the hand is taken out of sight again. Everything the judge does for a real hand
// then holds for a key: PERFECT / GOOD by timing and angle, a cut against the arrow marks the
// shard BAD unless the right key follows in time, an untouched shard is a MISS. The timing does
// not depend on the frame rate: the samples carry their own times.
//
// What the player SEES is a separate thing: sample() gives the view and NOVA a pair of hands
// that wait in the guard and swing through the cell when a key is pressed. Those hands are
// never shown to the judge.

import { DIRS } from './chart.js';

/** KeyboardEvent.code -> [hand, direction]. */
export const KEY_BINDINGS = Object.freeze({
  KeyW: Object.freeze(['l', 'u']),
  KeyA: Object.freeze(['l', 'l']),
  KeyS: Object.freeze(['l', 'd']),
  KeyD: Object.freeze(['l', 'r']),
  ArrowUp: Object.freeze(['r', 'u']),
  ArrowLeft: Object.freeze(['r', 'l']),
  ArrowDown: Object.freeze(['r', 'd']),
  ArrowRight: Object.freeze(['r', 'r']),
});

/**
 * Judge tuning for a keyboard run (createSlashJudge(notes, KEY_JUDGE_TUNING)). A key is exact
 * where a webcam is not, so there is no latency to take out and no reach to speak of; what is
 * left is timing and the right key.
 *   - the direction: the key of the arrow is a PERFECT; half of a diagonal (one of its two
 *     keys), or a diagonal on a straight arrow, is 45 degrees off and a GOOD; anything else is
 *     against the arrow;
 *   - a wrong key marks the shard BAD, and the right key within badGraceSec still cuts it.
 */
export const KEY_JUDGE_TUNING = Object.freeze({
  latencySec: 0,
  windowBefore: 0.18,
  windowAfter: 0.25,
  perfectSec: 0.09,
  perfectAngle: 30,
  goodAngle: 60,
  earlyAngle: 60,
  badGraceSec: 0.2,
  // the stroke goes through the centre of its shard and is short: it touches nothing else
  hitRadius: 0.3,
  stopRadius: 0.3,
  wrongDirRadius: 0.3,
  wrongHandRadius: 0.3,
  swingLockSec: 0, // every stroke is aimed at one shard: nothing to lock out
});

/** Tuning of createKeyHands; override any of them through its options. */
export const KEY_HANDS_DEFAULTS = Object.freeze({
  // The second key of a diagonal may follow the first by this much (seconds). Only a press that
  // is aimed at a diagonal shard waits for it; every other press is judged at once.
  chordSec: 0.045,
  // The stroke handed to the judge: strokeHalf either side of the shard at strokeSpeed.
  strokeHalf: 0.25,
  strokeSpeed: 9,
  // The hands the player sees. Guard: where a hand waits (mirrored for the left hand); home:
  // the cell a key swings through when no shard is due.
  guardX: 0.7,
  guardY: -0.35,
  homeX: 0.45,
  homeY: 0.25,
  swingPre: 0.6,      // units before the cell at the start of the visible swing …
  swingPost: 0.65,    // … and after it
  // A hand does not wait for the key in the guard: readySec before a shard of its own is due it
  // rises to where the cut starts (the blade is up when the key comes, and the cut is on the
  // screen at once), following at readyRate (1/s).
  readySec: 0.42,
  readyRate: 13,
  windSpeed: 24,      // units/s (average) to the start of a swing the hand was not ready for …
  windMaxSec: 0.09,   // … but never longer than this
  cutSec: 0.085,      // through the cell
  holdSec: 0.1,       // the follow-through hangs for a moment
  sway: 0.02,         // idle sway of a waiting hand, units
});

const isNum = (v) => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const easeOut = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 1 - (1 - u) * (1 - u));
const RAD = 180 / Math.PI;

function makeHand(x, y) {
  return { x, y, vx: 0, vy: 0, speed: 0, seen: 1 };
}

/**
 * The player's hands on the keyboard, for one run.
 * @param {object[]} notes  chart notes ({ id, time, x, y, hand: 'l'|'r'|'any', dir, … })
 * @param {{ push(frame: object): void }} judge  the run's judge, created with KEY_JUDGE_TUNING
 * @param {Partial<typeof KEY_HANDS_DEFAULTS> & { windowBefore?: number, windowAfter?: number, goodAngle?: number, latencySec?: number }} [opts]
 *        latencySec: the judge's own latencySec when it is not 0 (the player's timing offset):
 *        a key at song time t then counts as a cut at t - latencySec, for the judge and here alike.
 * @returns
 *   keyDown(code, songTime, live = true) -> boolean   a key went down (ignore auto-repeat before
 *       calling). true when the key is one of ours. `live: false` (the countdown, a practice
 *       swing) only moves the visible hand.
 *   strike(hand, dir, songTime, live = true) -> boolean   a press that knows its direction
 *       already ('l' | 'r', 'u' … 'dr': a touch pad). Judged at once, diagonals included.
 *   diagonals            true when the chart has diagonal shards (a touch pad then needs 8 ways)
 *   update(songTime)     every frame while the song runs, BEFORE judge.update(): lets go of a
 *                        half-pressed diagonal whose second key never came
 *   onEvents(events)     what judge.update() returned (the shards that are settled)
 *   sample(songTime, dt, hold?) -> HandsFrame  the hands to draw (the same object every call);
 *                        `hold` freezes them (pause)
 *   reset()
 *   stats                { presses, strikes, empty }  (strikes found a shard, empty did not)
 */
export function createKeyHands(notes, judge, opts = {}) {
  const cfg = { ...KEY_HANDS_DEFAULTS, ...opts };
  const before = isNum(opts.windowBefore) ? opts.windowBefore : KEY_JUDGE_TUNING.windowBefore;
  const after = isNum(opts.windowAfter) ? opts.windowAfter : KEY_JUDGE_TUNING.windowAfter;
  const goodAngle = isNum(opts.goodAngle) ? opts.goodAngle : KEY_JUDGE_TUNING.goodAngle;
  const lat = isNum(opts.latencySec) ? opts.latencySec : 0;

  const list = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && isNum(n.time) && isNum(n.x) && isNum(n.y))
    .slice()
    .sort((a, b) => a.time - b.time);
  const N = list.length;
  const index = new Map();
  list.forEach((n, i) => index.set(n, i));
  const done = new Uint8Array(N);
  let lo = 0;

  const stats = { presses: 0, strikes: 0, empty: 0 };

  // ---- the judge's side -------------------------------------------------------------------
  const shot = { t: 0, l: makeHand(0, 0), r: makeHand(0, 0) };
  const pend = [null, null];                 // per hand: a diagonal waiting for its second key
  const pendSlot = [{ ts: 0, dir: '', until: 0 }, { ts: 0, dir: '', until: 0 }];

  const angleTo = (i, dx, dy) => {
    const d = DIRS[list[i].dir];
    if (!d) return 0; // any direction
    const dot = dx * d[0] + dy * d[1];
    return Math.acos(dot > 1 ? 1 : dot < -1 ? -1 : dot) * RAD;
  };

  /** The shard a press of hand h at song time ts goes to (-1: none is due). */
  function pickTarget(h, ts, dx, dy) {
    while (lo < N && done[lo]) lo++;
    let best = -1;
    let bestFits = false;
    let bestGap = Infinity;
    for (let i = lo; i < N; i++) {
      const n = list[i];
      if (n.time - before > ts) break;
      if (done[i] || ts > n.time + after) continue;
      if (n.hand === (h === 0 ? 'r' : 'l')) continue; // the other hand's (an either-hand shard is anyone's)
      const fits = angleTo(i, dx, dy) <= goodAngle + 1e-6;
      const gap = Math.abs(ts - n.time);
      // a shard this key can cut before one it cannot, then the one nearest in time
      if (best < 0 || (fits && !bestFits) || (fits === bestFits && gap < bestGap)) {
        best = i; bestFits = fits; bestGap = gap;
      }
    }
    return best;
  }

  /** Hand h crosses (x, y) in the direction (dx, dy) at song time ts: tell the judge. */
  function stroke(h, ts, x, y, dx, dy) {
    const mine = h === 0 ? shot.l : shot.r;
    const other = h === 0 ? shot.r : shot.l;
    const half = cfg.strokeHalf;
    const dt = half / cfg.strokeSpeed;
    other.seen = 0;
    mine.seen = 1;
    mine.vx = dx * cfg.strokeSpeed; mine.vy = dy * cfg.strokeSpeed; mine.speed = cfg.strokeSpeed;
    mine.x = x - dx * half; mine.y = y - dy * half;
    shot.t = ts - dt + lat; // (the judge takes its latency off again)
    judge.push(shot);
    mine.x = x + dx * half; mine.y = y + dy * half;
    shot.t = ts + dt + lat;
    judge.push(shot);
    mine.seen = 0; // out of sight again: the judge never sees the hand between two keys
    judge.push(shot);
  }

  /** A press of hand h at song time ts in the direction (dx, dy). `quiet`: the visible hand is already swinging. */
  function commit(h, ts, dx, dy, quiet) {
    const i = pickTarget(h, ts, dx, dy);
    if (i < 0) {
      stats.empty++;
      if (!quiet) swing(h, dx, dy, (h === 0 ? -1 : 1) * cfg.homeX, cfg.homeY);
      return;
    }
    stats.strikes++;
    const n = list[i];
    stroke(h, ts, n.x, n.y, dx, dy);
    // a key that fits the arrow has cut it (the judge will say so on its next update): the
    // next press must not be aimed at it again. A wrong key leaves it for the right one.
    if (angleTo(i, dx, dy) <= goodAngle + 1e-6) done[i] = 1;
    if (!quiet) swing(h, dx, dy, n.x, n.y);
  }

  const isDiagonal = (i) => {
    const d = list[i].dir;
    return d === 'ul' || d === 'ur' || d === 'dl' || d === 'dr';
  };
  // two keys make a diagonal when one is vertical and the other horizontal
  const vertical = (d) => d === 'u' || d === 'd';

  function keyDown(code, songTime, live = true) {
    const b = KEY_BINDINGS[code];
    if (!b) return false;
    const h = b[0] === 'l' ? 0 : 1;
    const dir = b[1];
    const v = DIRS[dir];
    stats.presses++;
    if (!live || !isNum(songTime)) {
      swing(h, v[0], v[1], (h === 0 ? -1 : 1) * cfg.homeX, cfg.homeY);
      return true;
    }
    const ts = songTime - lat;
    const p = pend[h];
    if (p) {
      pend[h] = null;
      if (vertical(p.dir) !== vertical(dir)) {
        // the second key of the diagonal: judged at the time of the first
        const a = DIRS[p.dir];
        commit(h, p.ts, (a[0] + v[0]) * Math.SQRT1_2, (a[1] + v[1]) * Math.SQRT1_2, true);
        return true;
      }
      // the same axis again: the first key stands as it is, this one is a press of its own
      const a = DIRS[p.dir];
      commit(h, p.ts, a[0], a[1], true);
    }
    const i = pickTarget(h, ts, v[0], v[1]);
    if (i >= 0 && isDiagonal(i)) {
      const slot = pendSlot[h];
      slot.ts = ts; slot.dir = dir; slot.until = songTime + cfg.chordSec;
      pend[h] = slot;
      // the blade is already on its way — along the arrow when this key is half of it
      const nd = DIRS[list[i].dir];
      const half = nd[0] * v[0] + nd[1] * v[1] > 0.5;
      swing(h, half ? nd[0] : v[0], half ? nd[1] : v[1], list[i].x, list[i].y);
      return true;
    }
    commit(h, ts, v[0], v[1]);
    return true;
  }

  /** A touch pad: the direction is known at once (one of the eight), nothing to wait for. */
  function strike(hand, dir, songTime, live = true) {
    const v = DIRS[dir];
    if (!v || (hand !== 'l' && hand !== 'r')) return false;
    const h = hand === 'l' ? 0 : 1;
    stats.presses++;
    if (!live || !isNum(songTime)) {
      swing(h, v[0], v[1], (h === 0 ? -1 : 1) * cfg.homeX, cfg.homeY);
      return true;
    }
    const p = pend[h];
    if (p) { // a key of this hand was still waiting for its partner: it stands as it is
      pend[h] = null;
      const a = DIRS[p.dir];
      commit(h, p.ts, a[0], a[1], true);
    }
    commit(h, songTime - lat, v[0], v[1]);
    return true;
  }

  function update(songTime) {
    if (!isNum(songTime)) return;
    for (let h = 0; h < 2; h++) {
      const p = pend[h];
      if (p && songTime >= p.until) {
        pend[h] = null;
        const a = DIRS[p.dir];
        commit(h, p.ts, a[0], a[1], true);
      }
    }
  }

  function onEvents(events) {
    if (!events) return;
    for (let k = 0; k < events.length; k++) {
      const i = index.get(events[k] && events[k].note);
      if (i !== undefined) done[i] = 1;
    }
  }

  // ---- the hands the player sees ----------------------------------------------------------
  const frame = { t: 0, l: makeHand(-cfg.guardX, cfg.guardY), r: makeHand(cfg.guardX, cfg.guardY), fresh: true, body: 1 };
  let clock = 0;
  const anim = [
    { on: false, t0: 0, wind: 0, sx: 0, sy: 0, ax: 0, ay: 0, bx: 0, by: 0, dx: 0, dy: 0 },
    { on: false, t0: 0, wind: 0, sx: 0, sy: 0, ax: 0, ay: 0, bx: 0, by: 0, dx: 0, dy: 0 },
  ];

  /** Hand h swings through (x, y) in the direction (dx, dy), from wherever it is now. */
  function swing(h, dx, dy, x, y) {
    const a = anim[h];
    const hand = h === 0 ? frame.l : frame.r;
    a.on = true;
    a.t0 = clock;
    a.sx = hand.x; a.sy = hand.y;
    a.ax = x - dx * cfg.swingPre; a.ay = y - dy * cfg.swingPre;
    a.bx = x + dx * cfg.swingPost; a.by = y + dy * cfg.swingPost;
    a.dx = dx; a.dy = dy;
    // a hand that is already where the cut starts goes straight into it
    const far = Math.hypot(a.ax - a.sx, a.ay - a.sy);
    a.wind = far < 0.08 ? 0 : Math.min(cfg.windMaxSec, far / cfg.windSpeed);
  }

  /** The shard hand h should be getting ready for at song time t (-1: none yet). */
  function nextDue(h, t) {
    for (let i = lo; i < N; i++) {
      const n = list[i];
      if (n.time - cfg.readySec > t) break;
      if (done[i] || t > n.time + after) continue;
      const mine = n.hand === 'l' ? h === 0 : n.hand === 'r' ? h === 1 : (n.x < 0) === (h === 0);
      if (mine) return i;
    }
    return -1;
  }

  function place(h, hand, t, dt) {
    const a = anim[h];
    const side = h === 0 ? -1 : 1;
    let x = hand.x;
    let y = hand.y;
    if (a.on) {
      const u = clock - a.t0;
      const t1 = a.wind;
      const t2 = t1 + cfg.cutSec;
      const t3 = t2 + cfg.holdSec;
      if (u < t1) {
        const k = smooth(u / t1);
        x = a.sx + (a.ax - a.sx) * k; y = a.sy + (a.ay - a.sy) * k;
      } else if (u < t2) {
        const k = (u - t1) / cfg.cutSec;
        x = a.ax + (a.bx - a.ax) * k; y = a.ay + (a.by - a.ay) * k;
      } else if (u < t3) {
        const k = easeOut((u - t2) / cfg.holdSec) * 0.06;
        x = a.bx + a.dx * k; y = a.by + a.dy * k;
      } else {
        a.on = false;
      }
    }
    if (!a.on) {
      // between keys: in the guard, or up where the cut of the next shard starts
      let rx = side * cfg.guardX + cfg.sway * Math.sin(clock * 1.7 + h * 2.1);
      let ry = cfg.guardY + cfg.sway * Math.sin(clock * 2.3 + h * 1.3);
      const i = isNum(t) ? nextDue(h, t - lat) : -1;
      if (i >= 0) {
        const d = DIRS[list[i].dir];
        // (an any-direction shard: from the outside in)
        rx = list[i].x - (d ? d[0] : -side) * cfg.swingPre;
        ry = list[i].y - (d ? d[1] : 0) * cfg.swingPre;
      }
      const k = 1 - Math.exp(-cfg.readyRate * dt);
      x = hand.x + (rx - hand.x) * k;
      y = hand.y + (ry - hand.y) * k;
    }
    if (dt > 1e-4) {
      hand.vx = (x - hand.x) / dt;
      hand.vy = (y - hand.y) / dt;
      hand.speed = Math.sqrt(hand.vx * hand.vx + hand.vy * hand.vy);
    }
    hand.x = x; hand.y = y; hand.seen = 1;
  }

  function sample(songTime, dt, hold) {
    const step = hold ? 0 : (isNum(dt) && dt > 0 ? Math.min(dt, 0.1) : 0);
    clock += step;
    frame.t = isNum(songTime) ? songTime : 0;
    if (hold) {
      frame.l.vx = 0; frame.l.vy = 0; frame.l.speed = 0;
      frame.r.vx = 0; frame.r.vy = 0; frame.r.speed = 0;
      return frame;
    }
    place(0, frame.l, songTime, step);
    place(1, frame.r, songTime, step);
    return frame;
  }

  function reset() {
    done.fill(0);
    lo = 0;
    pend[0] = null; pend[1] = null;
    anim[0].on = false; anim[1].on = false;
    stats.presses = 0; stats.strikes = 0; stats.empty = 0;
    frame.l.x = -cfg.guardX; frame.l.y = cfg.guardY;
    frame.r.x = cfg.guardX; frame.r.y = cfg.guardY;
  }

  let diagonals = false;
  for (let i = 0; i < N; i++) if (isDiagonal(i)) { diagonals = true; break; }

  return { keyDown, strike, update, onEvents, sample, reset, stats, diagonals };
}

/**
 * A scripted keyboard player, for the tests and for checking the mode in a browser: the key
 * presses a clean player makes for a chart, in time order.
 * @returns {{ time: number, codes: string[] }[]}  (two codes = a diagonal; an any-direction
 *   shard gets the "up" key of its hand)
 */
export function keyScript(notes) {
  const LEFT = { u: 'KeyW', l: 'KeyA', d: 'KeyS', r: 'KeyD' };
  const RIGHT = { u: 'ArrowUp', l: 'ArrowLeft', d: 'ArrowDown', r: 'ArrowRight' };
  const out = [];
  for (const n of notes) {
    const map = n.hand === 'r' || (n.hand !== 'l' && n.x > 0) ? RIGHT : LEFT;
    const d = DIRS[n.dir] ? n.dir : 'u';
    const codes = d.length === 2 ? [map[d[0]], map[d[1]]] : [map[d]];
    out.push({ time: n.time, codes });
  }
  return out.sort((a, b) => a.time - b.time);
}
