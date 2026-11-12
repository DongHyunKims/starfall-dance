// STARFALL — STAR SLASH: the note chart (CONTRACT-slash.md). Pure: imports only ../song.js.
//
// The chart is AUTHORED, not generated: every section of the song is a sequence of named
// patterns (one or two bars each) written out in a tiny timeline notation, and a pattern can be
// played mirrored (`name~`: hands, columns and left/right directions swapped). Three charts —
// easy / normal / hard — share the song's shape: a calm verse, a build that climbs, a chorus that
// opens with two gold shards on the downbeat, a second verse with sideways cuts, a half-time
// bridge of big slow cuts, and a second chorus that answers the first one mirrored and ends on
// the last gold shard.
//
// Pattern notation: bars are separated by `|`, a bar has 4 slots (beats) or 8 slots (half
// beats), `.` is a rest, `+` joins the two shards of a double. A shard is
//   <hand><col><row><dir>[*]     hand  l | r | a (either hand)
//                                col   0..3 (screen-left .. screen-right), row 0..2 (waist .. head)
//                                dir   u d l r ul ur dl dr, or o (any direction)
//                                *     gold
// e.g. `l11d` = left hand, column 1, chest height, cut downwards.
//
// What the authoring keeps to (checked for all three charts in test/slash.test.mjs):
//   - a hand never has two shards closer than 1 beat (easy: 2 beats);
//   - two cuts of one hand a beat apart always reverse or turn (down then up, out then in):
//     the return of one swing is the next cut;
//   - easy / normal: the left hand stays on columns 0-1, the right hand on 2-3; hard crosses the
//     body a handful of times, and only one column over;
//   - doubles sit on accents, the last beat of every four-bar phrase is a rest (the finale
//     excepted: the last gold shard lands on the last beat of the last scored bar);
//   - everything lies inside the scored sections of js/song.js.

import { SONG, SEC_PER_BEAT, beatToSec } from '../song.js';

/** Pp positions of the 4 x 3 target grid (col 0..3, row 0..2). */
export const GRID = Object.freeze({
  X: Object.freeze([-1.35, -0.45, 0.45, 1.35]),
  Y: Object.freeze([-0.55, 0.25, 1.05]),
});

const D = Math.SQRT1_2;
/** Unit vectors of the eight cut directions (pp: +x = screen right, +y = up). `any` has none. */
export const DIRS = Object.freeze({
  u: Object.freeze([0, 1]),
  d: Object.freeze([0, -1]),
  l: Object.freeze([-1, 0]),
  r: Object.freeze([1, 0]),
  ul: Object.freeze([-D, D]),
  ur: Object.freeze([D, D]),
  dl: Object.freeze([-D, -D]),
  dr: Object.freeze([D, -D]),
});

export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);

/** The limits each chart is written to (the tests check the charts against these). */
export const CHART_RULES = Object.freeze({
  easy: Object.freeze({
    approachSec: 2.0, minSameHandGap: 2, dirs: Object.freeze(['d', 'u', 'any']), crossBody: false,
  }),
  normal: Object.freeze({
    approachSec: 1.7, minSameHandGap: 0.9, dirs: Object.freeze(['d', 'u', 'l', 'r', 'any']), crossBody: false,
  }),
  hard: Object.freeze({
    approachSec: 1.5, minSameHandGap: 0.9,
    dirs: Object.freeze(['d', 'u', 'l', 'r', 'ul', 'ur', 'dl', 'dr', 'any']), crossBody: true,
  }),
});

/** The hand a shard belongs to; an either-hand shard goes to the hand on its side of the grid. */
export function handOf(note) {
  return note.hand === 'l' || note.hand === 'r' ? note.hand : (note.col <= 1 ? 'l' : 'r');
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Pattern library
// ─────────────────────────────────────────────────────────────────────────────────────────

const PATTERNS = {
  // Easy: half notes, hands take turns, straight down / up only; a hand rests 2 beats or more.
  easy: {
    // verse
    wake: 'l11d . r21d . | l11u . r21u .',
    wakeEnd: 'l11d . r21d . | l11u+r21u . . .',
    wide: 'l01d . r31d . | l01u . r31u .',
    lowHigh: 'l10d . r20d . | l12o+r22o . . .',
    sway: 'l11d . r21d . | l12u . r22u .',
    pairs: 'l01d r31d . . | l01u r31u . .',
    calm: 'l11d . r21d . | l12o+r22o . . .',
    // build
    climb: 'l10d . r20d . | l11u . r21u .',
    surge: 'l10d+r20d . l11u+r21u . | l10d+r20d . l12u+r22u .',
    // chorus
    drop: 'a11d*+a21d* . l01u r31u | l01d . r31d .',
    lift: 'l11u+r21u . l10d r20d | l11u . r21u .',
    crash: 'l10d+r20d . l01u r31u | l01d . r31d .',
    finish: 'l11u+r21u . l11d+r21d . | l12u+r22u . . .',
    finale: 'l11u+r21u . l11d+r21d . | l12u+r22u . . a22o*',
    // bridge
    wings: 'l00d+r30d . . . | l02u+r32u . . .',
    gather: 'l11d . r21d . | . . l12u+r22u .',
  },

  // Normal: a shard a beat, hands alternate (each swings every other beat), sideways cuts,
  // doubles on the accents.
  normal: {
    // verse A
    pulse: 'l11d r21d l11u . | r21d l11d r21u .',
    pulseEnd: 'l10d r20d l11u . | l11d r21d l12u+r22u .',
    wideDrum: 'l01d r31d l01u r31u | l01l r31r l11r r21l',
    settle: 'l10d r20d l11u r21u | l11d r21d l12u+r22u .',
    // build
    tense: 'l10d r20d l11u . | l10d r20d l11u r21u',
    scissorUp: 'l01l r31r l11r r21l | l11u+r21u l11d+r21d l12u+r22u .',
    // chorus
    dropRun: 'a11d*+a21d* l01u r31u l01d | r31d l01u r31u l11d+r21d',
    scissors: 'l01l+r31r . l11r+r21l . | l11d r21d l11u+r21u .',
    scissorsHi: 'l02l+r32r . l11r+r21l . | l11d r21d l11u+r21u .',
    crashRun: 'l10d+r20d l11u r21u l12d | r22d l11u r21u l01d+r31d',
    peak: 'l01u+r31u l11d r21d l11u+r21u | l11d+r21d l01u r31u .',
    finalPeak: 'l01u+r31u l11d r21d l11u+r21u | l11d+r21d l01u r31u a12o*',
    // verse B
    wipers: 'l11l r21r l11r r21l | l10d r20d l12u r22u',
    highWipe: 'l02l r32r l01r r31l | l11d r21d l11u+r21u .',
    stairs: 'l00d r30d l01u r31u | l02d r32d l11l r21r',
    fold: 'l11r r21l l10d+r20d . | l11u r21u . .',
    // bridge
    bigWings: 'l00d+r30d . l02u+r32u . | l01l . r31r .',
    gatherIn: 'l11r . r21l . | l10d r20d l12u+r22u .',
  },

  // Hard: half-beat runs (hands alternate, so each still swings once a beat), diagonals,
  // the chorus stabs, and a few cuts across the body.
  hard: {
    // verse A
    hDrum: 'l11d . r21d . l11u . r21u . | l10d . r20d . l11u r21u . .',
    hDiag: 'l01dl . r31dr . l01ur . r31ul . | l11d+r21d . l11u r21u l10d r20d . .',
    hWide: 'l01u . r31u . l01d r31d . . | l11u r21u . . l01l . r31r .',
    hFold: 'l11r . r21l . l10dl r20dr . . | l11ur r21ul . . l12d+r22d . . .',
    // build
    hTense: 'l11u . r21u . l10d . r20d . | l11u r21u l10d r20d l11u . r21u .',
    hRoll: 'l11d r21d l11u r21u l11d r21d . . | l12u+r22u . l11d r21d l12u r22u . .',
    // chorus
    hDrop: 'a11d*+a21d* . l01u r31u . l01d r31d . | l01u r31u l11d r21d l11u r21u . .',
    hScissor: 'l01l+r31r . l11r+r21l . l10dl r20dr l11ur r21ul | l10d . r20d . l12u+r22u . . .',
    hCrash: 'l10d+r20d . l11u r21u . l12d r22d . | l11u r21u l01d r31d l01u r31u . .',
    hPeak: 'l11d+r21d . l01u+r31u . l11d r21d . . | l12u+r22u . l11d+r21d . l01u+r31u . . .',
    hFinale: 'l11d+r21d . l01u+r31u . l21dr . r11dl . | l11ul+r21ur . l11d+r21d . . . a22o* .',
    // verse B
    hWipers: 'l11l . r21r . l11r r21l l10d r20d | l12u r22u . . l01d . r31d .',
    hCross: 'l01u . r31u . l21dr . l11ul . | r11dl . r21ur . l11d+r21d . . .',
    hStairs: 'l01u . r31u . l10d r20d l11u r21u | l12d r22d . . l02l . r32r .',
    hFoldB: 'l01r . r31l . l10dl r20dr l11ur r21ul | l11d . r21d . . . . .',
    // bridge
    hWings: 'l00d+r30d . . . l02u+r32u . . . | l21dr . . . r11dl . . .',
    hGather: 'l11ul . . . r21ur . . . | l10d . r20d . l12u+r22u . . .',
  },
};

/** Which patterns each section plays, in order (`~` = mirrored). Two bars per pattern. */
const PLAN = {
  easy: {
    verseA: ['wake', 'wakeEnd', 'wide', 'lowHigh'],
    build: ['climb', 'surge'],
    chorus1: ['drop', 'lift', 'crash', 'finish'],
    verseB: ['sway', 'pairs', 'wide~', 'calm'],
    bridge: ['wings', 'gather'],
    chorus2: ['drop~', 'lift~', 'crash~', 'finale'],
  },
  normal: {
    verseA: ['pulse', 'pulseEnd', 'wideDrum', 'settle'],
    build: ['tense', 'scissorUp'],
    chorus1: ['dropRun', 'scissors', 'crashRun', 'peak'],
    verseB: ['wipers', 'highWipe', 'stairs', 'fold'],
    bridge: ['bigWings', 'gatherIn'],
    chorus2: ['dropRun~', 'scissorsHi~', 'crashRun~', 'finalPeak~'],
  },
  hard: {
    verseA: ['hDrum', 'hDiag', 'hWide', 'hFold'],
    build: ['hTense', 'hRoll'],
    chorus1: ['hDrop', 'hScissor', 'hCrash', 'hPeak'],
    verseB: ['hWipers', 'hCross', 'hStairs', 'hFoldB'],
    bridge: ['hWings', 'hGather'],
    chorus2: ['hDrop~', 'hScissor~', 'hCrash~', 'hFinale'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Notation -> notes
// ─────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = /^([lra])([0-3])([0-2])(ul|ur|dl|dr|u|d|l|r|o)(\*?)$/;
const MIRROR_DIR = { u: 'u', d: 'd', l: 'r', r: 'l', ul: 'ur', ur: 'ul', dl: 'dr', dr: 'dl', any: 'any' };
const MIRROR_HAND = { l: 'r', r: 'l', any: 'any' };
const BEATS_PER_BAR = SONG.beatsPerBar;

/** One pattern string -> { bars, steps: [{ offset (beats), hand, col, row, dir, gold }] }. */
function parsePattern(name, text) {
  const bars = text.split('|').map((b) => b.trim().split(/\s+/));
  const steps = [];
  bars.forEach((slots, bar) => {
    if (slots.length !== 4 && slots.length !== 8) {
      throw new Error(`chart: pattern "${name}" bar ${bar + 1} has ${slots.length} slots (4 or 8 expected)`);
    }
    const step = BEATS_PER_BAR / slots.length;
    slots.forEach((slot, k) => {
      if (slot === '.') return;
      const parts = slot.split('+');
      if (parts.length > 2) throw new Error(`chart: pattern "${name}" puts ${parts.length} shards on one beat`);
      for (const part of parts) {
        const m = TOKEN.exec(part);
        if (!m) throw new Error(`chart: pattern "${name}" has a bad shard "${part}"`);
        steps.push({
          offset: bar * BEATS_PER_BAR + k * step,
          hand: m[1] === 'a' ? 'any' : m[1],
          col: +m[2],
          row: +m[3],
          dir: m[4] === 'o' ? 'any' : m[4],
          gold: m[5] === '*',
        });
      }
    });
  });
  return { bars: bars.length, steps };
}

function mirrorStep(s) {
  return {
    offset: s.offset, hand: MIRROR_HAND[s.hand], col: 3 - s.col, row: s.row, dir: MIRROR_DIR[s.dir], gold: s.gold,
  };
}

const parsed = {};
function patternOf(difficulty, ref) {
  const mirrored = ref.endsWith('~');
  const name = mirrored ? ref.slice(0, -1) : ref;
  const key = `${difficulty}/${ref}`;
  if (!parsed[key]) {
    const text = PATTERNS[difficulty][name];
    if (typeof text !== 'string') throw new Error(`chart: unknown pattern "${name}" (${difficulty})`);
    const p = parsePattern(name, text);
    parsed[key] = mirrored ? { bars: p.bars, steps: p.steps.map(mirrorStep) } : p;
  }
  return parsed[key];
}

const round3 = (v) => Math.round(v * 1000) / 1000;

function chartStats(notes) {
  const perHand = { l: 0, r: 0, any: 0 };
  const perDir = { u: 0, d: 0, l: 0, r: 0, ul: 0, ur: 0, dl: 0, dr: 0, any: 0 };
  const perSection = {};
  let gold = 0;
  let doubles = 0;
  let crossBody = 0;
  let maxInWindow = 0;
  let lo = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    perHand[n.hand]++;
    perDir[n.dir]++;
    perSection[n.section] = (perSection[n.section] || 0) + 1;
    if (n.gold) gold++;
    if (i > 0 && notes[i - 1].beat === n.beat) doubles++;
    if ((n.hand === 'l' && n.col >= 2) || (n.hand === 'r' && n.col <= 1)) crossBody++;
    // densest four beats: shards with beat in (n.beat - 4, n.beat]
    while (notes[lo].beat <= n.beat - BEATS_PER_BAR) lo++;
    if (i - lo + 1 > maxInWindow) maxInWindow = i - lo + 1;
  }
  const first = notes.length ? notes[0].beat : 0;
  const last = notes.length ? notes[notes.length - 1].beat : 0;
  let scoredBeats = 0;
  for (const s of SONG.sections) if (s.scored) scoredBeats += s.bars * BEATS_PER_BAR;
  return {
    notes: notes.length,
    perHand,
    perDir,
    perSection,
    doubles,
    gold,
    crossBody,
    firstBeat: first,
    lastBeat: last,
    notesPerBeat: round3(notes.length / Math.max(1, scoredBeats)),
    maxPerFourBeats: maxInWindow,
    maxNps: round3(maxInWindow / (BEATS_PER_BAR * SEC_PER_BEAT)),
  };
}

/**
 * The chart of one difficulty. Deterministic; every call returns fresh objects.
 * @param {'easy'|'normal'|'hard'} [difficulty]  anything else means 'normal'
 * @returns {{ difficulty: string, notes: object[], approachSec: number, stats: object,
 *             patterns: {section: string, bar: number, name: string}[] }}
 *   notes: sorted by time, `id` = index. Beyond the contract's fields a note also carries
 *   `section` (song section name) and `pair` (id of the other shard of a double, or -1).
 */
export function buildChart(difficulty = 'normal') {
  const diff = DIFFICULTIES.includes(difficulty) ? difficulty : 'normal';
  const plan = PLAN[diff];
  const notes = [];
  const patterns = [];
  for (const section of SONG.sections) {
    const refs = plan[section.name];
    if (!refs) continue;
    if (!section.scored) throw new Error(`chart: section "${section.name}" is not scored`);
    let bar = section.startBar;
    for (const ref of refs) {
      const p = patternOf(diff, ref);
      patterns.push({ section: section.name, bar, name: ref });
      for (const s of p.steps) {
        const beat = bar * BEATS_PER_BAR + s.offset;
        notes.push({
          id: 0,
          beat,
          time: beatToSec(beat),
          col: s.col,
          row: s.row,
          x: GRID.X[s.col],
          y: GRID.Y[s.row],
          hand: s.hand,
          dir: s.dir,
          gold: s.gold,
          section: section.name,
          pair: -1,
        });
      }
      bar += p.bars;
    }
    if (bar !== section.startBar + section.bars) {
      throw new Error(`chart: "${section.name}" (${diff}) fills ${bar - section.startBar} of ${section.bars} bars`);
    }
  }
  notes.sort((a, b) => a.beat - b.beat || a.col - b.col || a.row - b.row);
  for (let i = 0; i < notes.length; i++) {
    notes[i].id = i;
    if (i > 0 && notes[i - 1].beat === notes[i].beat) {
      notes[i].pair = i - 1;
      notes[i - 1].pair = i;
    }
  }
  return {
    difficulty: diff,
    notes,
    approachSec: CHART_RULES[diff].approachSec,
    stats: chartStats(notes),
    patterns,
  };
}
