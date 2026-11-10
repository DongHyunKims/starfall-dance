// STARFALL — simulated player for demo mode (?demo=1 / "데모 보기").
// Pure math, no DOM: imports in Node so the rating mix can be checked offline.
//
// The fake player copies the dancer a little late and a little wrong: the target pose is
// sampled `lagSec` behind the music and every segment is rotated in the screen plane by a
// smoothly wandering error. How sloppy the player is changes from move to move (a seeded
// "form" value per scored move), which is what produces a believable mix of ratings.

import { SEGMENTS, MOVES, samplePose, getPose } from './choreo.js';
import { secToBeat } from './song.js';

export const DEMO_TUNING = {
  lagSec: 0.12,
  // [cumulative probability, error amplitude in degrees]; the last tier freezes in idle (a MISS)
  tiers: [
    [0.46, 7],    // clean        -> PERFECT
    [0.78, 42],   // a bit loose  -> mostly SUPER
    [0.91, 54],   // sloppy       -> mostly GOOD
    [0.975, 68],  // lost         -> mostly OK
    [1.0, -1],    // blanked      -> MISS
  ],
  ampSmoothing: 9, // 1/s, how fast the sloppiness changes between moves
};

// Small deterministic hash -> 0..1
function hash01(n, seed) {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const DEG = Math.PI / 180;

export function createDemoPlayer(options = {}) {
  const cfg = { ...DEMO_TUNING, ...options };
  let seed = (options.seed | 0) || 1;
  let amp = 8;        // current error amplitude, degrees
  let freeze = 0;     // 0..1 blend toward idle (a blanked move)
  let lastT = NaN;
  let cursor = 0;
  const idle = getPose('idle');
  const confidence = {};
  for (const seg of SEGMENTS) confidence[seg] = 1;

  // per-segment phases and rates of the wandering error
  const phases = SEGMENTS.map((_, i) => [hash01(i, 11) * 6.283, hash01(i, 23) * 6.283]);
  const rates = SEGMENTS.map((_, i) => [1.3 + hash01(i, 37) * 1.4, 3.1 + hash01(i, 41) * 2.2]);
  // Sign pattern per move so a sloppy move is consistently off rather than averaging out.
  const bias = SEGMENTS.map((_, i) => (hash01(i, 53) < 0.5 ? -1 : 1));

  function tierFor(moveIndex) {
    const r = hash01(moveIndex + 1, seed);
    for (const [p, a] of cfg.tiers) if (r < p) return a;
    return cfg.tiers[cfg.tiers.length - 1][1];
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

  /** Simulated tracker result at song time `t` (seconds). Same shape as the tracker's. */
  function sample(t) {
    const tl = t - cfg.lagSec;
    const beat = secToBeat(tl);
    const pose = samplePose(beat);

    const dt = Number.isFinite(lastT) ? Math.min(0.1, Math.max(0, t - lastT)) : 0;
    lastT = t;
    const idx = nearestMove(beat);
    const tier = tierFor(idx);
    const k = dt > 0 ? 1 - Math.exp(-dt * cfg.ampSmoothing) : 1;
    amp += ((tier < 0 ? 20 : tier) - amp) * k;
    freeze += ((tier < 0 ? 1 : 0) - freeze) * k;

    for (let i = 0; i < SEGMENTS.length; i++) {
      const seg = SEGMENTS[i];
      let v = pose[seg];
      if (freeze > 0.002) {
        const b = idle[seg];
        v = [v[0] + (b[0] - v[0]) * freeze, v[1] + (b[1] - v[1]) * freeze, v[2] + (b[2] - v[2]) * freeze];
      }
      // wander in [-1, 1], biased so the mean error is not zero
      const n = 0.55 * bias[i] * (hash01(idx * 16 + i, seed + 7) < 0.5 ? -1 : 1)
        + 0.3 * Math.sin(tl * rates[i][0] + phases[i][0])
        + 0.15 * Math.sin(tl * rates[i][1] + phases[i][1]);
      // torso wobbles far less than the limbs
      const scale = i < 2 ? 0.25 : (i >= 6 ? 0.6 : 1);
      const a = amp * scale * n * DEG;
      const c = Math.cos(a), s = Math.sin(a);
      const x = v[0] * c - v[1] * s;
      const y = v[0] * s + v[1] * c;
      const len = Math.hypot(x, y, v[2]) || 1;
      pose[seg] = [x / len, y / len, v[2] / len];
    }
    return { pose, confidence, bodyVisible: 1, landmarks: null, t: t * 1000, demo: true };
  }

  return { sample, reset };
}
