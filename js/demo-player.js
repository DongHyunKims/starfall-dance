// STARFALL — simulated players for demo mode (?demo=1 / "데모 보기").
// Pure math, no DOM: imports in Node so the rating mix can be checked offline.
//
// A fake player behaves like a person who watches the coach and follows: the coach's pose is
// sampled a reaction time behind the music (about 0.3–0.6 s, different for every move) and every
// segment is rotated in the screen plane by a smoothly wandering error. How sloppy the player is
// changes from move to move (a seeded "form" value per scored move), which is what produces a
// believable mix of ratings. `skill` shifts both the reaction time and the mix.

import { SEGMENTS, MOVES, samplePose, getPose } from './choreo.js';
import { secToBeat } from './song.js';

export const DEMO_TUNING = {
  skill: 0.85,          // 0 = hopeless, 1 = tidy and quick
  lagFast: 0.28,        // s, reaction time of a skill-1 player on a good move
  lagSlow: 0.62,        // s, reaction time of a skill-0 player on a bad move
  lagSmoothing: 5,      // 1/s, how fast the reaction time drifts between moves
  // error amplitude in degrees per tier; the last tier freezes in idle (a missed move)
  tierAmp: [10, 38, 56, 74, -1],
  // cumulative tier probabilities at skill 1 and at skill 0 (interpolated in between)
  tiersBest: [0.60, 0.86, 0.96, 0.99, 1],
  tiersWorst: [0.10, 0.36, 0.66, 0.86, 1],
  ampSmoothing: 9,      // 1/s, how fast the sloppiness changes between moves
  legsUnseen: false,    // play "upper body only": leg confidence 0, like a player close to the camera
  side: 0,              // 0 = stands on the screen-left (P1), 1 = screen-right (P2)
};

// Small deterministic hash -> 0..1
function hash01(n, seed) {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const DEG = Math.PI / 180;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createDemoPlayer(options = {}) {
  const cfg = { ...DEMO_TUNING, ...options };
  const skill = clamp01(Number.isFinite(cfg.skill) ? cfg.skill : DEMO_TUNING.skill);
  const tiers = cfg.tiersBest.map((b, i) => cfg.tiersWorst[i] + (b - cfg.tiersWorst[i]) * skill);
  let seed = (options.seed | 0) || 1;
  let amp = 8;        // current error amplitude, degrees
  let freeze = 0;     // 0..1 blend toward idle (a blanked move)
  let lag = cfg.lagFast + (cfg.lagSlow - cfg.lagFast) * (1 - skill) * 0.5;
  let lastT = NaN;
  let cursor = 0;
  const idle = getPose('idle');
  const confidence = {};
  for (const seg of SEGMENTS) confidence[seg] = 1;
  if (cfg.legsUnseen) for (const seg of ['lThigh', 'lShin', 'rThigh', 'rShin']) confidence[seg] = 0;

  // per-segment phases and rates of the wandering error
  const phases = SEGMENTS.map((_, i) => [hash01(i, 11) * 6.283, hash01(i, 23) * 6.283]);
  const rates = SEGMENTS.map((_, i) => [1.3 + hash01(i, 37) * 1.4, 3.1 + hash01(i, 41) * 2.2]);
  // Sign pattern per move so a sloppy move is consistently off rather than averaging out.
  const bias = SEGMENTS.map((_, i) => (hash01(i, 53) < 0.5 ? -1 : 1));

  function tierFor(moveIndex) {
    const r = hash01(moveIndex + 1, seed);
    for (let i = 0; i < tiers.length; i++) if (r < tiers[i]) return i;
    return tiers.length - 1;
  }

  // reaction time for a move: quick players are quick, and everyone is slower on a bad move
  function lagFor(moveIndex, tier) {
    const jitter = hash01(moveIndex + 1, seed + 101);
    const slow = clamp01((1 - skill) * 0.7 + (tier / (tiers.length - 1)) * 0.35 + (jitter - 0.5) * 0.3);
    return cfg.lagFast + (cfg.lagSlow - cfg.lagFast) * slow;
  }

  function nearestMove(beat) {
    if (cursor >= MOVES.length || (cursor > 0 && MOVES[cursor - 1].beat > beat)) cursor = 0;
    while (cursor < MOVES.length - 1
      && Math.abs(MOVES[cursor + 1].beat - beat) <= Math.abs(MOVES[cursor].beat - beat)) cursor++;
    return cursor;
  }

  /** New run: a different seed gives a different (but repeatable) rating pattern. */
  function reset(newSeed) {
    if (Number.isFinite(newSeed)) seed = newSeed | 0;
    lastT = NaN;
    cursor = 0;
    freeze = 0;
    amp = 8;
  }

  const result = {
    pose: null, confidence, landmarks: null, demo: true, t: 0,
    bodyVisible: cfg.legsUnseen ? 0.8 : 1,
    upperVisible: 1,
    cx: cfg.side ? 0.72 : 0.28,
    size: 0.2,
  };

  /** Simulated tracker result at song time `t` (seconds). Same shape as the tracker's. */
  function sample(t) {
    const dt = Number.isFinite(lastT) ? Math.min(0.1, Math.max(0, t - lastT)) : 0;
    lastT = t;

    // which move is this player currently reacting to, and how well
    const idx = nearestMove(secToBeat(t - lag));
    const tier = tierFor(idx);
    const tierAmp = cfg.tierAmp[tier];
    const k = dt > 0 ? 1 - Math.exp(-dt * cfg.ampSmoothing) : 1;
    amp += ((tierAmp < 0 ? 20 : tierAmp) - amp) * k;
    freeze += ((tierAmp < 0 ? 1 : 0) - freeze) * k;
    // the reaction time drifts slowly, never faster than the clock (time never runs backwards)
    const wantLag = lagFor(idx, tier);
    const kl = dt > 0 ? 1 - Math.exp(-dt * cfg.lagSmoothing) : 1;
    const nextLag = lag + (wantLag - lag) * kl;
    lag = Math.min(nextLag, lag + dt * 0.6);

    const tl = t - lag;
    const pose = samplePose(secToBeat(tl));

    for (let i = 0; i < SEGMENTS.length; i++) {
      const seg = SEGMENTS[i];
      let v = pose[seg];
      if (freeze > 0.002) {
        const b = idle[seg];
        v = [v[0] + (b[0] - v[0]) * freeze, v[1] + (b[1] - v[1]) * freeze, v[2] + (b[2] - v[2]) * freeze];
      }
      // wander in [-1, 1], biased so the mean error is not zero
      const n = 0.74 * bias[i] * (hash01(idx * 16 + i, seed + 7) < 0.5 ? -1 : 1)
        + 0.17 * Math.sin(tl * rates[i][0] + phases[i][0])
        + 0.09 * Math.sin(tl * rates[i][1] + phases[i][1]);
      // torso wobbles far less than the limbs
      const scale = i < 2 ? 0.25 : (i >= 6 ? 0.22 : 1);
      const a = amp * scale * n * DEG;
      const c = Math.cos(a), s = Math.sin(a);
      const x = v[0] * c - v[1] * s;
      const y = v[0] * s + v[1] * c;
      const len = Math.hypot(x, y, v[2]) || 1;
      pose[seg] = [x / len, y / len, v[2] / len];
    }
    result.pose = pose;
    result.t = t * 1000;
    return result;
  }

  return { sample, reset, get lag() { return lag; } };
}
