// STARFALL — original music engine.
//
// Pure WebAudio synthesis: no samples, no external assets. The whole track ("STARFALL", an
// original composition in F minor at 124 BPM) is described as note/drum event data, rendered
// section-by-section with OfflineAudioContext (in parallel), overlap-added, mastered in JS
// (loudness normalise -> glue compressor -> look-ahead limiter) and then played back from a
// single AudioBufferSourceNode so timing is sample-accurate.
//
// Every musical event time derives from beatToSec() in song.js.

import { SONG, TOTAL_BEATS, SEC_PER_BEAT, SONG_DURATION, beatToSec, secToBeat } from './song.js';

// ───────────────────────────────────────────────────────────── constants / tuning knobs

const SR = 44100; // offline render rate (the live context resamples if it differs)
const SPB = SEC_PER_BEAT;
const BPB = SONG.beatsPerBar;
const CHUNK_PREROLL = 0.05; // s of pre-roll before each section downbeat inside its chunk
const REVERB_TAIL = 3.2; // s rendered past the last event of a chunk (reverb / delay tails)

/** Mix settings. Stem gains are *defaults*; init() calibrates them against `targets`. */
export const MIX = {
  stems: { kick: 0.8, snare: 0.28, hats: 0.5, bass: 0.28, chords: 0.85, lead: 0.5, pluck: 0.85, pad: 0.5, fx: 0.5 },
  // Calibration targets measured on a solo'd stem (pre-master). kind: 'peak' | 'rms'.
  targets: {
    kick: { kind: 'peak', value: 0.8, bars: [36, 38] },
    snare: { kind: 'peak', value: 0.5, bars: [36, 38] },
    hats: { kind: 'rms', value: 0.04, bars: [36, 38] },
    bass: { kind: 'rms', value: 0.17, bars: [36, 38] },
    chords: { kind: 'rms', value: 0.15, bars: [36, 38] },
    lead: { kind: 'rms', value: 0.115, bars: [36, 38] },
    pluck: { kind: 'rms', value: 0.06, bars: [8, 10] },
    pad: { kind: 'rms', value: 0.045, bars: [8, 10] },
  },
  calibrationClamp: [0.2, 5], // allowed correction factor relative to the default stem gain
  reverbSend: { kick: 0, snare: 0.16, hats: 0.05, bass: 0, chords: 0.2, lead: 0.24, pluck: 0.28, pad: 0.38, fx: 0.32 },
  delaySend: { lead: 0.3, pluck: 0.18 },
  reverbReturn: 0.8,
  delayReturn: 0.55,
  delayFeedback: 0.42,
  duckFloor: { chords: 0.2, pad: 0.45, bass: 0.35, pluck: 0.7 }, // sidechain depth (gain at the kick)
  duckRecover: 0.34, // s
  master: {
    targetRms: 0.21, // loud-section (90th percentile, 400 ms windows) RMS after normalisation
    compThreshDb: -10, compRatio: 2, compKneeDb: 8, compAttackMs: 15, compReleaseMs: 180, compMakeupDb: 1,
    ceiling: 0.89, lookaheadMs: 5, limiterReleaseMs: 70,
  },
  musicGain: 0.9, // playback gain of the mastered buffer (peak ~0.8 -> headroom for SFX)
  sfxGain: 0.6,
};

/** getLevels() mapping knobs (analyser byte magnitudes 0..1 -> visual 0..1). */
export const LEVELS = {
  minDb: -70, maxDb: -10, fft: 2048, smoothing: 0.5,
  bass: { lo: 30, hi: 140, floor: 0.45, span: 0.5 },
  mid: { lo: 300, hi: 2500, floor: 0.3, span: 0.4 },
  high: { lo: 5000, hi: 14000, floor: 0.1, span: 0.35 },
  attack: 0.03, release: 0.14, // s
  kickDecay: 0.11, // s, exponential decay of the 'kick' envelope
};

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const T = (x) => (x < 0 ? 0 : x);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────────────────────── composition (original)
// Key: F minor. MIDI note numbers. Chord = bass root + 4-note voicing for pads / supersaws.

const CH = {
  Db: { root: 37, notes: [53, 56, 60, 63] }, // Dbmaj9 colour
  Eb: { root: 39, notes: [55, 58, 63, 65] }, // Eb add9
  Fm: { root: 41, notes: [56, 60, 63, 67] }, // Fm9
  Ab: { root: 44, notes: [56, 60, 63, 70] }, // Ab add9
  Bbm: { root: 34, notes: [56, 58, 61, 65] }, // Bbm7
  Cm: { root: 36, notes: [58, 60, 63, 67] }, // Cm7
  DbHi: { root: 37, notes: [56, 60, 65, 68] },
  EbHi: { root: 39, notes: [58, 63, 67, 70] },
  C7: { root: 36, notes: [58, 60, 64, 67] }, // dominant lift into the last chorus
  FmEnd: { root: 41, notes: [53, 56, 60, 67] },
};

const PROG = {
  intro: ['Db', 'Eb', 'Fm', 'Eb'],
  verse: ['Fm', 'Db', 'Ab', 'Eb'],
  build: ['Bbm', 'Cm', 'DbHi', 'EbHi'],
  chorus: ['Db', 'Eb', 'Fm', 'Ab'],
  bridge: ['Db', 'Eb', 'Bbm', 'C7'],
  outro: ['Db', 'Eb', 'Fm'],
};

// The chorus hook: 8 bars, each note [beatInBar, lengthBeats, midi].
const HOOK = [
  [[0, 0.75, 77], [0.75, 0.75, 75], [1.5, 0.5, 72], [2, 0.5, 68], [2.5, 0.5, 72], [3, 1, 75]],
  [[0, 0.75, 70], [0.75, 0.75, 72], [1.5, 0.5, 75], [2, 1, 79], [3, 0.5, 77], [3.5, 0.5, 75]],
  [[0, 0.75, 77], [0.75, 0.75, 75], [1.5, 0.5, 72], [2, 0.5, 68], [2.5, 0.5, 72], [3, 0.5, 77], [3.5, 1.5, 80]],
  [[1, 0.5, 79], [1.5, 1, 75], [2.5, 0.5, 72], [3, 1, 75]],
  [[0, 0.75, 77], [0.75, 0.75, 75], [1.5, 0.5, 72], [2, 0.5, 68], [2.5, 0.5, 72], [3, 1, 75]],
  [[0, 0.75, 70], [0.75, 0.75, 72], [1.5, 0.5, 75], [2, 0.5, 79], [2.5, 0.5, 80], [3, 1, 82]],
  [[0, 0.75, 84], [0.75, 0.75, 80], [1.5, 0.5, 77], [2, 0.5, 80], [2.5, 0.5, 79], [3, 0.5, 77], [3.5, 0.5, 75]],
  [[0, 0.75, 75], [0.75, 0.75, 72], [1.5, 0.5, 68], [2, 2, 72]],
];

// Second-chorus counter-melody (bell, long notes above the hook).
const COUNTER = [
  [[0, 2, 80], [2, 2, 84]],
  [[0, 2, 82], [2, 2, 79]],
  [[0, 2, 80], [2, 2, 84]],
  [[0, 2, 87], [2, 2, 84]],
  [[0, 2, 85], [2, 2, 84]],
  [[0, 2, 82], [2, 2, 87]],
  [[0, 2, 89], [2, 2, 87]],
  [[0, 4, 84]],
];

// Verse-B bell melody (answers the pluck arpeggio).
const VERSE_MEL = [
  [[0.5, 0.5, 68], [1, 0.5, 72], [1.5, 1, 77], [2.5, 0.5, 75], [3, 1, 72]],
  [[0.5, 0.5, 73], [1, 0.5, 77], [1.5, 1, 80], [2.5, 0.5, 77], [3, 1, 75]],
  [[0.5, 0.5, 72], [1, 0.5, 75], [1.5, 1, 80], [2.5, 0.5, 79], [3, 1, 75]],
  [[0.5, 0.5, 70], [1, 0.5, 75], [1.5, 1, 79], [2.5, 0.5, 77], [3, 0.5, 75], [3.5, 0.5, 72]],
  [[0.5, 0.5, 68], [1, 0.5, 72], [1.5, 1, 77], [2.5, 0.5, 75], [3, 1, 72]],
  [[0.5, 0.5, 73], [1, 0.5, 77], [1.5, 1, 80], [2.5, 0.5, 77], [3, 1, 75]],
  [[0.5, 0.5, 72], [1, 0.5, 75], [1.5, 1, 80], [2.5, 0.5, 79], [3, 1, 75]],
  [[0.5, 0.5, 70], [1, 0.5, 75], [1.5, 1, 79], [2.5, 1.5, 82]],
];

const BRIDGE_MEL = [
  HOOK[0],
  HOOK[1],
  [[0, 1.5, 77], [1.5, 0.5, 73], [2, 2, 70]],
  [[0, 1.5, 79], [1.5, 0.5, 76], [2, 0.5, 79], [2.5, 0.5, 82]],
];

const INTRO_MEL = [
  [[0, 0.75, 77], [0.75, 0.75, 75], [1.5, 0.5, 72], [2, 0.5, 68], [2.5, 0.5, 72], [3, 1, 77]],
  HOOK[1],
];

const PLUCK_STEPS = [0, 3, 6, 8, 11, 14]; // 16th steps, 3-3-2-3-3-2
const PLUCK_ORDER = [0, 2, 1, 3, 2, 1];

// Which calibrated stem each event type feeds.
const STEM_OF = {
  kick: 'kick', snare: 'snare', clap: 'snare', hat: 'hats', bass: 'bass', saw: 'chords', pad: 'pad',
  pluck: 'pluck', bell: 'lead', lead: 'lead', riser: 'fx', down: 'fx', swell: 'fx', impact: 'fx', crash: 'fx',
};
// Seconds a voice keeps sounding after its gate (used to size chunk renders).
const VOICE_TAIL = {
  kick: 0.6, snare: 0.5, clap: 0.6, hat: 0.5, bass: 0.3, saw: 0.6, pad: 2.6, pluck: 0.8, bell: 1.4, lead: 0.5,
  riser: 0.1, down: 0.1, swell: 0.1, impact: 2.6, crash: 2.7,
};

/**
 * Build the whole arrangement as plain event data (pure; runs in Node).
 * Event: { type, b (beat, may be slightly negative in the lead-in), len (beats), vel, ... }.
 */
export function buildArrangement() {
  const ev = [];
  const add = (type, b, o) => ev.push(Object.assign({ type, b, len: 0.25, vel: 1 }, o));
  const sections = {};
  for (const s of SONG.sections) sections[s.name] = s;
  const startOf = (name) => sections[name].startBar * BPB;

  const melody = (type, start, bars, vel, extra) => {
    bars.forEach((bar, i) => bar.forEach(([p, len, m]) => add(type, start + i * 4 + p, Object.assign({ len, m, vel }, extra))));
  };
  const hats8 = (b0, on, off) => {
    for (let k = 0; k < 8; k++) add('hat', b0 + k * 0.5, { vel: k % 2 ? off : on });
  };
  const verseBass = (b0, root, vel) => {
    add('bass', b0, { len: 1.0, m: root, vel });
    add('bass', b0 + 1.5, { len: 0.5, m: root, vel: vel * 0.9 });
    add('bass', b0 + 2.5, { len: 0.75, m: root, vel });
    add('bass', b0 + 3.5, { len: 0.4, m: root + 12, vel: vel * 0.85, sub: false });
  };
  const plucks = (b0, notes, vel, steps = 6, octaveLayer = false) => {
    for (let k = 0; k < steps; k++) {
      const m = notes[PLUCK_ORDER[k]] + 12;
      const b = b0 + PLUCK_STEPS[k] * 0.25;
      add('pluck', b, { m, vel: vel * (k % 2 ? 0.75 : 1), pan: k % 2 ? 0.35 : -0.35 });
      if (octaveLayer) add('pluck', b, { m: m + 12, vel: vel * 0.38, pan: k % 2 ? -0.5 : 0.5 });
    }
  };

  // ── intro (filtered pad, sparse hats, a teaser of the hook)
  {
    const S = startOf('intro');
    add('swell', S - 1.5, { len: 1.5, vel: 0.35 });
    PROG.intro.forEach((name, i) => {
      const c = CH[name];
      const b0 = S + i * 4;
      add('pad', b0, { len: 4, notes: c.notes, vel: 0.9 });
      if (i >= 2) add('bass', b0, { len: 3.5, m: c.root, vel: 0.6, mid: false });
      if (i === 1) for (let k = 0; k < 4; k++) add('hat', b0 + k + 0.5, { vel: 0.35 });
      if (i >= 2) hats8(b0, 0.25, 0.45);
    });
    melody('bell', S + 8, INTRO_MEL, 0.55);
    add('kick', S + 8, { vel: 0.6 });
    add('kick', S + 12, { vel: 0.6 });
    add('kick', S + 14, { vel: 0.6 });
    add('snare', S + 15, { vel: 0.35 });
    add('snare', S + 15.5, { vel: 0.45 });
    add('snare', S + 15.75, { vel: 0.6 });
    add('swell', S + 14, { len: 2, vel: 0.5 });
  }

  // ── verses
  const verse = (name, variantB) => {
    const S = startOf(name);
    if (variantB) {
      add('down', S, { len: 4, vel: 0.5 });
      add('crash', S, { vel: 0.5 });
    } else {
      add('impact', S, { vel: 0.45 });
      add('crash', S, { vel: 0.4 });
    }
    for (let i = 0; i < 8; i++) {
      const c = CH[PROG.verse[i % 4]];
      const b0 = S + i * 4;
      const last = i === 7;
      for (let k = 0; k < 4; k++) if (!(variantB && last && k === 3)) add('kick', b0 + k, { vel: 0.92 });
      if (variantB || i >= 4) {
        add('clap', b0 + 1, { vel: 0.8 });
        add('clap', b0 + 3, { vel: 0.8 });
      }
      if (variantB) {
        const v = [0.42, 0.16, 0.6, 0.2];
        for (let s = 0; s < 16; s++) {
          if (s === 14) add('hat', b0 + s * 0.25, { vel: 0.4, open: true });
          else add('hat', b0 + s * 0.25, { vel: v[s % 4] });
        }
      } else hats8(b0, 0.3, 0.55);
      verseBass(b0, c.root, 0.9);
      add('pad', b0, { len: 4, notes: c.notes, vel: 0.5 });
      plucks(b0, c.notes, variantB ? 0.85 : 0.8, 6, variantB);
    }
    if (variantB) {
      melody('bell', S, VERSE_MEL, 0.7);
      add('swell', S + 29, { len: 3, vel: 0.5 });
    } else {
      add('snare', S + 31.5, { vel: 0.5 });
      add('snare', S + 31.75, { vel: 0.7 });
      add('swell', S + 30, { len: 2, vel: 0.45 });
    }
  };
  verse('verseA', false);
  verse('verseB', true);

  // ── build (lifted pre-chorus: iv - v - VI - VII, snare roll, riser, filter sweep)
  {
    const S = startOf('build');
    const vAt = (b) => 0.45 + 0.55 * ((b - S) / 16);
    PROG.build.forEach((name, i) => {
      const c = CH[name];
      const b0 = S + i * 4;
      add('saw', b0, { len: i === 3 ? 3.5 : 4, notes: c.notes, vel: 0.75, sustain: true });
      if (i < 3) {
        for (let k = 0; k < 4; k++) add('kick', b0 + k, { vel: 0.95 });
        verseBass(b0, c.root, 0.9);
      }
      if (i < 2) {
        add('pad', b0, { len: 4, notes: c.notes, vel: 0.5 });
        hats8(b0, 0.3, 0.55);
      } else {
        for (let s = 0; s < (i === 3 ? 14 : 16); s++) add('hat', b0 + s * 0.25, { vel: vAt(b0) * (s % 2 ? 0.35 : 0.6) });
      }
      plucks(b0, c.notes, 0.7 + 0.08 * i, i === 3 ? 5 : 6, i >= 2);
    });
    // snare roll: 2&4 -> quarters -> 8ths -> 16ths -> 32nds, then half a beat of air
    add('clap', S + 1, { vel: 0.7 });
    add('clap', S + 3, { vel: 0.7 });
    for (let k = 0; k < 4; k++) add('snare', S + 4 + k, { vel: vAt(S + 4 + k) });
    for (let k = 0; k < 8; k++) add('snare', S + 8 + k * 0.5, { vel: vAt(S + 8 + k * 0.5) });
    for (let k = 0; k < 12; k++) add('snare', S + 12 + k * 0.25, { vel: vAt(S + 12 + k * 0.25) });
    for (let k = 0; k < 4; k++) add('snare', S + 15 + k * 0.125, { vel: 0.9 + 0.025 * k });
    add('riser', S, { len: 15.5, vel: 0.8 });
    add('riser', S + 8, { len: 7.5, vel: 0.5, tone: true });
  }

  // ── choruses (full drums, sidechained supersaws, sub + mid bass, the hook)
  const chorus = (name, second) => {
    const S = startOf(name);
    add('impact', S, { vel: 1 });
    add('crash', S, { vel: 0.9 });
    add('crash', S + 16, { vel: 0.6 });
    for (let i = 0; i < 8; i++) {
      const c = CH[PROG.chorus[i % 4]];
      const b0 = S + i * 4;
      for (let k = 0; k < 4; k++) add('kick', b0 + k, { vel: 1 });
      if (second && i % 2 === 1) add('kick', b0 + 3.75, { vel: 0.7 });
      for (const k of [1, 3]) {
        add('clap', b0 + k, { vel: 0.9 });
        add('snare', b0 + k, { vel: second ? 0.85 : 0.7 });
      }
      for (let s = 0; s < 16; s++) {
        if (s % 4 === 2) add('hat', b0 + s * 0.25, { vel: 0.5, open: true });
        else add('hat', b0 + s * 0.25, { vel: [0.55, 0.22, 0, 0.3][s % 4] });
      }
      const hits = [[0, 1.4, 1], [1.5, 0.9, 1], [2.5, 1.4, 0.95]];
      for (const [p, len, vel] of hits) {
        add('saw', b0 + p, { len, notes: c.notes, vel });
        add('bass', b0 + p, { len: len + 0.05, m: c.root, vel: 1, mid: false });
      }
      for (let k = 0; k < 8; k++) {
        add('bass', b0 + k * 0.5, { len: 0.42, m: c.root + (k === 7 ? 12 : 0), vel: k % 2 ? 1 : 0.6, sub: false });
      }
      if (i === 7) {
        add('snare', b0 + 3.25, { vel: 0.6 });
        add('snare', b0 + 3.5, { vel: 0.75 });
        add('snare', b0 + 3.75, { vel: 0.9 });
      }
    }
    melody('lead', S, HOOK, 1, { oct: second });
    if (second) {
      melody('bell', S, COUNTER, 0.5);
      add('swell', S + 30, { len: 2, vel: 0.5 });
    }
  };
  chorus('chorus1', false);
  chorus('chorus2', true);

  // ── bridge (half-time breakdown, pad swell, hook restated on bells, roll back up)
  {
    const S = startOf('bridge');
    add('down', S, { len: 4, vel: 0.5 });
    add('impact', S, { vel: 0.6 });
    PROG.bridge.forEach((name, i) => {
      const c = CH[name];
      const b0 = S + i * 4;
      if (i < 3) {
        add('kick', b0, { vel: 0.95 });
        add('kick', b0 + 2.5, { vel: 0.7 });
        add('snare', b0 + 2, { vel: 1 });
        add('clap', b0 + 2, { vel: 0.8 });
      } else {
        for (let k = 0; k < 4; k++) add('kick', b0 + k, { vel: 0.95 });
      }
      for (let k = 0; k < 8; k++) add('hat', b0 + k * 0.5, { vel: k % 2 ? 0.18 : 0.3 });
      add('pad', b0, { len: 4, notes: c.notes, vel: 1 });
      add('bass', b0, { len: 3.5, m: c.root, vel: 0.8 });
      if (i >= 2) add('saw', b0, { len: i === 3 ? 3.9 : 4, notes: c.notes, vel: 0.7, sustain: true });
    });
    melody('bell', S, BRIDGE_MEL, 0.75);
    for (let k = 0; k < 4; k++) add('snare', S + 12 + k * 0.5, { vel: 0.5 + 0.05 * k });
    for (let k = 0; k < 8; k++) add('snare', S + 14 + k * 0.25, { vel: 0.7 + 0.04 * k });
    add('riser', S + 8, { len: 8, vel: 0.7 });
    add('riser', S + 12, { len: 4, vel: 0.5, tone: true });
  }

  // ── outro (resolve: hook on bells/plucks over VI - VII - i, then the final impact)
  {
    const S = startOf('outro');
    add('impact', S, { vel: 0.9 });
    add('crash', S, { vel: 0.8 });
    PROG.outro.forEach((name, i) => {
      const c = CH[name];
      const b0 = S + i * 4;
      if (i < 2) {
        for (let k = 0; k < 4; k++) add('kick', b0 + k, { vel: 0.9 });
        add('clap', b0 + 1, { vel: 0.7 });
        add('clap', b0 + 3, { vel: 0.7 });
      } else {
        add('kick', b0, { vel: 0.85 });
        add('kick', b0 + 2, { vel: 0.85 });
      }
      hats8(b0, 0.3, 0.5);
      add('pad', b0, { len: 4, notes: c.notes, vel: 0.8 });
      add('bass', b0, { len: 3.5, m: c.root, vel: 0.8, midVel: 0.6 });
    });
    const outroMel = [HOOK[0], HOOK[1], HOOK[0]];
    melody('bell', S, outroMel, 0.65);
    melody('pluck', S, outroMel, 0.7, { pan: 0 });
    add('swell', S + 10, { len: 2, vel: 0.55 });
    const F = S + 12; // final downbeat
    add('impact', F, { vel: 1 });
    add('crash', F, { vel: 0.8 });
    add('kick', F, { vel: 1 });
    add('saw', F, { len: 3.6, notes: CH.FmEnd.notes, vel: 0.9, sustain: true });
    add('pad', F, { len: 4, notes: CH.FmEnd.notes, vel: 0.8 });
    add('bass', F, { len: 3, m: CH.FmEnd.root, vel: 1 });
    for (const [m, v] of [[77, 0.6], [84, 0.5], [89, 0.35]]) add('bell', F, { len: 3, m, vel: v });
  }

  const events = ev.filter((e) => e.vel > 0.001).sort((a, b) => a.b - b.b);
  for (const e of events) {
    e.t = beatToSec(e.b);
    e.end = e.t + e.len * SPB + VOICE_TAIL[e.type];
  }
  const kicks = events.filter((e) => e.type === 'kick').map((e) => ({ t: e.t, vel: e.vel, beat: e.b }));

  // Bus filter automation (beats -> Hz), exponential interpolation between points.
  const chordsEnd = startOf('outro') + 12;
  const bS = startOf('build');
  const brS = startOf('bridge');
  const curves = {
    chordCutoff: [
      [-8, 16000], [bS - 0.1, 16000], [bS, 320], [bS + 15.4, 9000], [bS + 15.6, 16000],
      [brS + 7.9, 16000], [brS + 8, 300], [brS + 15.7, 8000], [brS + 15.9, 16000],
      [chordsEnd - 0.1, 16000], [chordsEnd, 12000], [chordsEnd + 4, 700], [chordsEnd + 12, 500],
    ],
    padCutoff: [
      [-8, 450], [0, 450], [16, 3200], [17, 1800], [brS, 1800], [brS + 0.5, 500], [brS + 16, 7000],
      [brS + 17, 2500], [chordsEnd - 12, 3500], [chordsEnd + 4, 900], [chordsEnd + 12, 800],
    ],
  };
  for (const k of Object.keys(curves)) curves[k] = curves[k].map(([b, v]) => ({ t: beatToSec(b), v }));

  return { events, kicks, curves };
}

// ───────────────────────────────────────────────────────────── shared generated buffers

function makeNoiseData(seconds, seed) {
  const rnd = mulberry32(seed);
  const d = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
  return d;
}

/** Stereo reverb impulse response: early taps + darkening exponential noise tail, unit energy. */
function makeImpulseData(seconds = 2.6, rt60 = 2.2) {
  const n = Math.floor(seconds * SR);
  const tau = rt60 / 6.91;
  const pre = Math.floor(0.012 * SR);
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(0x51a7 + ch * 7919);
    const d = new Float32Array(n);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / SR;
      const a = 0.12 + 0.8 * Math.exp(-t / 0.5); // one-pole coefficient: bright early, dark late
      lp += a * (rnd() * 2 - 1 - lp);
      const build = Math.min(1, t / 0.008);
      d[i] = lp * Math.exp(-t / tau) * build;
    }
    for (let k = 0; k < 7; k++) {
      const i = pre + Math.floor((0.004 + rnd() * 0.07) * SR);
      d[i] += (rnd() > 0.5 ? 1 : -1) * (0.5 - k * 0.05);
    }
    const fade = Math.floor(0.2 * SR);
    for (let i = 0; i < fade; i++) d[n - 1 - i] *= i / fade;
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const s = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < n; i++) d[i] *= s;
    out.push(d);
  }
  return out;
}

function makeBuffer(ctx, channels, sampleRate = SR) {
  const b = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((d, i) => {
    if (b.copyToChannel) b.copyToChannel(d, i);
    else b.getChannelData(i).set(d);
  });
  return b;
}

function makeTanhCurve(drive, n = 1024) {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * drive) / norm;
  return c;
}

// ───────────────────────────────────────────────────────────── synthesis graph (per chunk)

/** ADSR-ish gate on a gain param that starts at 0. Release is exponential (time constant `rel`). */
function gate(p, t, dur, peak, a, rel, sus = 1, dec = 0.1) {
  const d = Math.max(dur, a + 0.005);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (sus < 1) p.setTargetAtTime(peak * sus, t + a, dec);
  p.setTargetAtTime(0, t + d, rel);
  return t + d + rel * 7; // time at which the voice may be stopped
}

function createGraph(ctx, shared, gains, seed) {
  const rnd = mulberry32(seed);
  const gain = (v) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const biquad = (type, f, q = 0.707) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };
  const panner = (p) => {
    if (!ctx.createStereoPanner) return gain(1);
    const n = ctx.createStereoPanner();
    n.pan.value = p;
    return n;
  };
  const noiseBuf = makeBuffer(ctx, [shared.noise]);
  const noiseLen = shared.noise.length / SR;
  const noise = (t, stopAt, loop = false) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = loop;
    s.start(t, rnd() * (noiseLen - 0.7));
    s.stop(stopAt);
    return s;
  };
  const osc = (type, freq, detune = 0) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    return o;
  };

  const mix = gain(1);
  mix.connect(ctx.destination);

  // reverb: generated impulse response, unit energy, not auto-normalised (deterministic level)
  const revIn = gain(1);
  const revHP = biquad('highpass', 260);
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = makeBuffer(ctx, shared.ir);
  const revOut = gain(MIX.reverbReturn);
  revIn.connect(revHP);
  revHP.connect(conv);
  conv.connect(revOut);
  revOut.connect(mix);

  // dotted-eighth ping-pong delay
  const dlyIn = gain(1);
  const dlyHP = biquad('highpass', 500);
  const dlyLP = biquad('lowpass', 4500);
  const dL = ctx.createDelay(1);
  const dR = ctx.createDelay(1);
  dL.delayTime.value = 0.75 * SPB;
  dR.delayTime.value = 0.75 * SPB;
  const fbA = gain(MIX.delayFeedback);
  const fbB = gain(MIX.delayFeedback);
  const pL = panner(-0.55);
  const pR = panner(0.55);
  const dlyOut = gain(MIX.delayReturn);
  const dlyRev = gain(0.3);
  dlyIn.connect(dlyHP);
  dlyHP.connect(dlyLP);
  dlyLP.connect(dL);
  dL.connect(pL);
  dL.connect(fbA);
  fbA.connect(dR);
  dR.connect(pR);
  dR.connect(fbB);
  fbB.connect(dL);
  pL.connect(dlyOut);
  pR.connect(dlyOut);
  dlyOut.connect(mix);
  dlyOut.connect(dlyRev);
  dlyRev.connect(revIn);

  const stem = (name) => {
    const g = gain(gains[name] || 0);
    g.connect(mix);
    if (MIX.reverbSend[name]) {
      const s = gain(MIX.reverbSend[name]);
      g.connect(s);
      s.connect(revIn);
    }
    if (MIX.delaySend[name]) {
      const s = gain(MIX.delaySend[name]);
      g.connect(s);
      s.connect(dlyIn);
    }
    return g;
  };
  const S = {};
  for (const name of Object.keys(MIX.stems)) S[name] = stem(name);

  // instrument inputs
  const kickIn = gain(1);
  const kickShaper = ctx.createWaveShaper();
  kickShaper.curve = shared.kickCurve;
  kickIn.connect(kickShaper);
  kickShaper.connect(S.kick);

  const hatsIn = panner(0.12);
  hatsIn.connect(S.hats);

  const ducks = {};
  const ducked = (name) => {
    const d = gain(1);
    d.connect(S[name]);
    ducks[name] = d;
    return d;
  };
  const bassIn = ducked('bass');
  const chordLP = biquad('lowpass', 16000, 0.8);
  chordLP.connect(ducked('chords'));
  const padLP = biquad('lowpass', 1800, 0.6);
  padLP.connect(ducked('pad'));
  const pluckIn = ducked('pluck');
  const leadIn = S.lead;
  const fxIn = S.fx;
  const snareIn = S.snare;

  // ── voices: (localTime, event)
  const V = {
    kick(t, e) {
      const v = e.vel;
      const o = osc('sine', 165);
      o.frequency.setValueAtTime(165, t);
      o.frequency.exponentialRampToValueAtTime(58, t + 0.06);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.26);
      const g = gain(0);
      g.gain.setValueAtTime(v, t);
      g.gain.setTargetAtTime(0, t + 0.07, 0.085);
      o.connect(g);
      g.connect(kickIn);
      o.start(t);
      o.stop(t + 0.6);
      const n = noise(t, t + 0.04);
      const hp = biquad('highpass', 2500);
      const ng = gain(0);
      ng.gain.setValueAtTime(v * 0.35, t);
      ng.gain.setTargetAtTime(0, t, 0.004);
      n.connect(hp);
      hp.connect(ng);
      ng.connect(kickIn);
    },
    snare(t, e) {
      const v = e.vel;
      const n = noise(t, t + 0.45);
      const hp = biquad('highpass', 1200);
      const g = gain(0);
      g.gain.setValueAtTime(v * 0.9, t);
      g.gain.setTargetAtTime(0, t + 0.012, 0.06);
      n.connect(hp);
      hp.connect(g);
      g.connect(snareIn);
      const o = osc('triangle', 230);
      o.frequency.setValueAtTime(230, t);
      o.frequency.exponentialRampToValueAtTime(175, t + 0.05);
      const og = gain(0);
      og.gain.setValueAtTime(v * 0.55, t);
      og.gain.setTargetAtTime(0, t, 0.035);
      o.connect(og);
      og.connect(snareIn);
      o.start(t);
      o.stop(t + 0.25);
    },
    clap(t, e) {
      const v = e.vel;
      const n = noise(t, t + 0.6);
      const bp = biquad('bandpass', 1400, 1.1);
      const g = gain(0);
      const p = g.gain;
      for (let k = 0; k < 3; k++) {
        p.setValueAtTime(v, t + k * 0.011);
        p.exponentialRampToValueAtTime(v * 0.15, t + k * 0.011 + 0.01);
      }
      p.setValueAtTime(v * 0.9, t + 0.033);
      p.setTargetAtTime(0, t + 0.035, 0.075);
      n.connect(bp);
      bp.connect(g);
      g.connect(snareIn);
    },
    hat(t, e) {
      const n = noise(t, t + (e.open ? 0.5 : 0.12));
      const hp = biquad('highpass', e.open ? 6500 : 7200);
      const g = gain(0);
      g.gain.setValueAtTime(e.vel, t);
      g.gain.setTargetAtTime(0, t + 0.002, e.open ? 0.085 : 0.016);
      n.connect(hp);
      hp.connect(g);
      g.connect(hatsIn);
    },
    bass(t, e) {
      const dur = e.len * SPB;
      if (e.sub !== false) {
        const o = osc('sine', mtof(e.m));
        const g = gain(0);
        const end = gate(g.gain, t, dur, e.vel, 0.012, 0.03);
        o.connect(g);
        g.connect(bassIn);
        o.start(t);
        o.stop(end);
      }
      if (e.mid !== false) {
        const v = e.midVel !== undefined ? e.midVel : e.vel;
        const f = mtof(e.m + 12);
        const o1 = osc('sawtooth', f);
        const o2 = osc('square', f, 6);
        const o2g = gain(0.4);
        const lp = biquad('lowpass', 1500, 1.5);
        lp.frequency.setValueAtTime(1500, t);
        lp.frequency.setTargetAtTime(420, t, 0.09);
        const g = gain(0);
        const end = gate(g.gain, t, dur, v * 0.6, 0.006, 0.025);
        o1.connect(lp);
        o2.connect(o2g);
        o2g.connect(lp);
        lp.connect(g);
        g.connect(bassIn);
        o1.start(t);
        o2.start(t);
        o1.stop(end);
        o2.stop(end);
      }
    },
    saw(t, e) {
      // supersaw: 5 detuned saws per note spread over three pan positions
      const dur = e.len * SPB;
      const lp = biquad('lowpass', 14000, 0.6);
      if (!e.sustain) {
        lp.frequency.setValueAtTime(9000, t);
        lp.frequency.setTargetAtTime(3200, t + 0.01, 0.18);
      }
      const g = gain(0);
      const end = e.sustain
        ? gate(g.gain, t, dur, e.vel * 0.1, 0.04, 0.09)
        : gate(g.gain, t, dur, e.vel * 0.1, 0.012, 0.06, 0.8, 0.15);
      lp.connect(g);
      g.connect(chordLP);
      const pans = [panner(-0.7), panner(0), panner(0.7)];
      for (const p of pans) p.connect(lp);
      const det = [-14, -7, 0, 7, 14];
      const slot = [0, 2, 1, 0, 2];
      for (const m of e.notes) {
        for (let k = 0; k < 5; k++) {
          const o = osc('sawtooth', mtof(m), det[k] + (rnd() - 0.5) * 4);
          o.connect(pans[slot[k]]);
          o.start(T(t - 0.004 - rnd() * 0.03)); // staggered starts -> decorrelated phases at the gate
          o.stop(end);
        }
      }
    },
    pad(t, e) {
      const dur = e.len * SPB;
      const g = gain(0);
      const end = gate(g.gain, t, dur, e.vel * 0.12, 0.35, 0.35);
      g.connect(padLP);
      const pl = panner(-0.5);
      const pr = panner(0.5);
      pl.connect(g);
      pr.connect(g);
      for (const m of e.notes) {
        const a = osc('sawtooth', mtof(m), -7 + (rnd() - 0.5) * 3);
        const b = osc('sawtooth', mtof(m), 7 + (rnd() - 0.5) * 3);
        a.connect(pl);
        b.connect(pr);
        a.start(T(t - rnd() * 0.03));
        b.start(T(t - rnd() * 0.03));
        a.stop(end);
        b.stop(end);
      }
    },
    pluck(t, e) {
      const f = mtof(e.m);
      const o1 = osc('sawtooth', f);
      const o2 = osc('square', f, 7);
      const o2g = gain(0.5);
      const lp = biquad('lowpass', 5200, 4);
      lp.frequency.setValueAtTime(5200, t);
      lp.frequency.setTargetAtTime(700, t, 0.045);
      const g = gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(e.vel * 0.5, t + 0.003);
      g.gain.setTargetAtTime(0, t + 0.003, 0.1);
      const p = panner(e.pan || 0);
      o1.connect(lp);
      o2.connect(o2g);
      o2g.connect(lp);
      lp.connect(g);
      g.connect(p);
      p.connect(pluckIn);
      o1.start(t);
      o2.start(t);
      o1.stop(t + 0.75);
      o2.stop(t + 0.75);
    },
    bell(t, e) {
      const dur = e.len * SPB;
      const f = mtof(e.m);
      const g = gain(0);
      const pk = e.vel * 0.5;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(pk, t + 0.004);
      g.gain.setTargetAtTime(pk * 0.35, t + 0.004, 0.12);
      g.gain.setTargetAtTime(0, t + Math.max(dur, 0.02), 0.18);
      const end = t + dur + 1.3;
      g.connect(leadIn);
      const parts = [[1, 1], [2, 0.35], [3.01, 0.15]];
      for (const [mul, amp] of parts) {
        const o = osc('sine', f * mul);
        if (amp === 1) o.connect(g);
        else {
          const og = gain(amp);
          o.connect(og);
          og.connect(g);
        }
        o.start(t);
        o.stop(end);
      }
    },
    lead(t, e) {
      const dur = e.len * SPB * 0.93;
      const f = mtof(e.m);
      const lp = biquad('lowpass', 5500, 1.2);
      lp.frequency.setValueAtTime(5500, t);
      lp.frequency.setTargetAtTime(3200, t, 0.1);
      const g = gain(0);
      const end = gate(g.gain, t, dur, e.vel * 0.25, 0.01, 0.05, 0.75, 0.12);
      lp.connect(g);
      g.connect(leadIn);
      const voices = [osc('sawtooth', f, -8), osc('sawtooth', f, 8)];
      for (const o of voices) o.connect(lp);
      const sq = osc('square', f / 2);
      const sqg = gain(0.35);
      sq.connect(sqg);
      sqg.connect(lp);
      voices.push(sq);
      if (e.oct) {
        const og = gain(0.42);
        og.connect(lp);
        for (const d of [-6, 6]) {
          const o = osc('sawtooth', f * 2, d);
          o.connect(og);
          voices.push(o);
        }
      }
      for (const o of voices) {
        o.start(T(t - rnd() * 0.004));
        o.stop(end);
      }
    },
    riser(t, e) {
      const dur = e.len * SPB;
      const g = gain(0);
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(e.tone ? e.vel * 0.25 : e.vel, t + dur);
      g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
      g.connect(fxIn);
      if (e.tone) {
        const o = osc('sawtooth', mtof(53));
        o.frequency.setValueAtTime(mtof(53), t);
        o.frequency.exponentialRampToValueAtTime(mtof(77), t + dur);
        const lp = biquad('lowpass', 2500);
        o.connect(lp);
        lp.connect(g);
        o.start(t);
        o.stop(t + dur + 0.03);
      } else {
        const n = noise(t, t + dur + 0.03, true);
        const bp = biquad('bandpass', 400, 1.2);
        bp.frequency.setValueAtTime(400, t);
        bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
        n.connect(bp);
        bp.connect(g);
      }
    },
    down(t, e) {
      const dur = e.len * SPB;
      const n = noise(t, t + dur + 0.03, true);
      const lp = biquad('lowpass', 10000);
      lp.frequency.setValueAtTime(10000, t);
      lp.frequency.exponentialRampToValueAtTime(250, t + dur);
      const g = gain(0);
      g.gain.setValueAtTime(e.vel * 0.6, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
      n.connect(lp);
      lp.connect(g);
      g.connect(fxIn);
    },
    swell(t, e) {
      // reverse-style swell that cuts exactly at the following downbeat
      const dur = e.len * SPB;
      const n = noise(t, t + dur + 0.03, true);
      const hp = biquad('highpass', 2500);
      const g = gain(0);
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(e.vel, t + dur);
      g.gain.linearRampToValueAtTime(0, t + dur + 0.015);
      n.connect(hp);
      hp.connect(g);
      g.connect(fxIn);
    },
    impact(t, e) {
      const v = e.vel;
      const o = osc('sine', 110);
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(36, t + 0.6);
      const g = gain(0);
      g.gain.setValueAtTime(v * 0.9, t);
      g.gain.setTargetAtTime(0, t + 0.05, 0.32);
      o.connect(g);
      g.connect(fxIn);
      o.start(t);
      o.stop(t + 2.4);
      const n = noise(t, t + 2.5, true);
      const lp = biquad('lowpass', 7000);
      lp.frequency.setValueAtTime(7000, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + 1.4);
      const ng = gain(0);
      ng.gain.setValueAtTime(v * 0.6, t);
      ng.gain.setTargetAtTime(0, t + 0.02, 0.38);
      n.connect(lp);
      lp.connect(ng);
      ng.connect(fxIn);
    },
    crash(t, e) {
      const n = noise(t, t + 2.6, true);
      const hp = biquad('highpass', 5000);
      const g = gain(0);
      g.gain.setValueAtTime(e.vel * 0.5, t);
      g.gain.setTargetAtTime(0, t + 0.01, 0.42);
      n.connect(hp);
      hp.connect(g);
      g.connect(fxIn);
    },
  };

  return { V, ducks, chordCutoff: chordLP.frequency, padCutoff: padLP.frequency };
}

/** Value of an exponential breakpoint curve at time t (points sorted by t). */
function curveAt(pts, t) {
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      const k = (t - a.t) / (b.t - a.t);
      return a.v * Math.pow(b.v / a.v, k);
    }
  }
  return pts[pts.length - 1].v;
}

function scheduleCurve(param, pts, t0, len) {
  param.setValueAtTime(curveAt(pts, t0), 0);
  for (const p of pts) {
    if (p.t <= t0 + 1e-4) continue;
    param.exponentialRampToValueAtTime(p.v, p.t - t0);
    if (p.t - t0 > len) break; // one point past the end is enough to define the last ramp
  }
}

/** Sidechain: gain automation derived from the kick list (global seconds). */
function scheduleDuck(param, floor, kicks, t0, len) {
  param.setValueAtTime(1, 0);
  for (let i = 0; i < kicks.length; i++) {
    const tk = kicks[i].t - t0;
    if (tk < -0.0005) continue;
    if (tk > len) break;
    const gap = i + 1 < kicks.length ? kicks[i + 1].t - kicks[i].t : 10;
    const rec = clamp(Math.min(MIX.duckRecover, gap - 0.02), 0.05, 1);
    const f = 1 - (1 - floor) * Math.min(1, kicks[i].vel);
    const t = T(tk);
    param.setValueAtTime(1, t);
    param.linearRampToValueAtTime(f, t + 0.012);
    param.linearRampToValueAtTime(f + (1 - f) * 0.7, t + 0.012 + rec * 0.45);
    param.linearRampToValueAtTime(1, t + 0.012 + rec);
  }
}

function getOfflineCtor() {
  return globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
}

function startRendering(ctx) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (b) => {
      if (!done && b) {
        done = true;
        resolve(b);
      }
    };
    ctx.oncomplete = (e) => finish(e.renderedBuffer);
    try {
      const p = ctx.startRendering();
      if (p && typeof p.then === 'function') p.then(finish, reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Render the events whose start lies in [t0, t1) into a stereo buffer starting at global time t0.
 * `only` restricts scheduling to one stem (calibration); kicks always drive the sidechain.
 */
function renderRange(arr, shared, { t0, t1, len, gains, seed, only }) {
  const Ctor = getOfflineCtor();
  const frames = Math.max(1, Math.ceil(len * SR));
  const ctx = new Ctor(2, frames, SR);
  const G = createGraph(ctx, shared, gains, seed);
  scheduleCurve(G.chordCutoff, arr.curves.chordCutoff, t0, len);
  scheduleCurve(G.padCutoff, arr.curves.padCutoff, t0, len);
  for (const name of Object.keys(G.ducks)) scheduleDuck(G.ducks[name].gain, MIX.duckFloor[name], arr.kicks, t0, len);
  let count = 0;
  for (const e of arr.events) {
    if (e.t < t0) continue;
    if (e.t >= t1) break;
    if (only && STEM_OF[e.type] !== only) continue;
    G.V[e.type](T(e.t - t0), e);
    count++;
  }
  return startRendering(ctx).then((buffer) => ({ buffer, count }));
}

/** Section-aligned render chunks (global seconds, sample-quantised). */
export function planChunks(arr) {
  const q = (t) => Math.round(t * SR) / SR;
  const starts = SONG.sections.map((s, i) => (i === 0 ? 0 : q(beatToSec(s.startBar * BPB) - CHUNK_PREROLL)));
  return starts.map((t0, i) => {
    const t1 = i + 1 < starts.length ? starts[i + 1] : SONG_DURATION;
    let maxEnd = t1;
    for (const e of arr.events) if (e.t >= t0 && e.t < t1 && e.end > maxEnd) maxEnd = e.end;
    const len = Math.min(SONG_DURATION - t0, maxEnd - t0 + REVERB_TAIL);
    return { name: SONG.sections[i].name, t0, t1, len, seed: 1000 + i * 77 };
  });
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function measure(buffer) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    n += d.length;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)) };
}

/** Solo-render short excerpts of each stem and derive stem gains that hit MIX.targets. */
async function calibrate(arr, shared, limit, onStep) {
  const names = Object.keys(MIX.targets);
  const gains = Object.assign({}, MIX.stems);
  const report = {};
  const tasks = names.map((name) => async () => {
    const tg = MIX.targets[name];
    const t0 = Math.round((beatToSec(tg.bars[0] * BPB) - CHUNK_PREROLL) * SR) / SR;
    const t1 = beatToSec(tg.bars[1] * BPB);
    const solo = {};
    for (const k of Object.keys(MIX.stems)) solo[k] = k === name ? 1 : 0;
    try {
      const { buffer } = await renderRange(arr, shared, { t0, t1, len: t1 - t0, gains: solo, seed: 500, only: name });
      const m = measure(buffer);
      const got = tg.kind === 'peak' ? m.peak : m.rms;
      if (got > 1e-5 && Number.isFinite(got)) {
        const [lo, hi] = MIX.calibrationClamp;
        gains[name] = clamp(tg.value / got, MIX.stems[name] * lo, MIX.stems[name] * hi);
      }
      report[name] = { measured: got, gain: gains[name] };
    } catch (err) {
      report[name] = { error: String(err), gain: gains[name] };
    }
    if (onStep) onStep();
  });
  await runPool(tasks, limit);
  return { gains, report };
}

// ───────────────────────────────────────────────────────────── mastering (pure JS, testable)

/** Scale so the loud sections (90th percentile of 400 ms windows) sit at targetRms. */
export function normaliseInPlace(L, R, sr, targetRms) {
  const win = Math.floor(sr * 0.4);
  const ms = [];
  for (let i = 0; i + win <= L.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += L[j] * L[j] + R[j] * R[j];
    const v = s / (2 * win);
    if (v > 1e-7) ms.push(v);
  }
  if (!ms.length) return 1;
  ms.sort((a, b) => a - b);
  const loud = Math.sqrt(ms[Math.floor(0.9 * (ms.length - 1))]);
  const g = clamp(targetRms / loud, 0.05, 12);
  for (let i = 0; i < L.length; i++) {
    L[i] *= g;
    R[i] *= g;
  }
  return g;
}

/** Stereo-linked feed-forward soft-knee compressor (glue). Returns max gain reduction in dB. */
export function compressInPlace(L, R, sr, cfg) {
  const aA = 1 - Math.exp(-1 / (sr * cfg.compAttackMs * 0.001));
  const aR = 1 - Math.exp(-1 / (sr * cfg.compReleaseMs * 0.001));
  const thr = cfg.compThreshDb;
  const knee = cfg.compKneeDb;
  const slope = 1 - 1 / cfg.compRatio;
  const makeup = Math.pow(10, cfg.compMakeupDb / 20);
  const kneeLo = Math.pow(10, (thr - knee / 2) / 20);
  let env = 0;
  let maxGr = 0;
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const r = R[i];
    const x = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
    env += (x - env) * (x > env ? aA : aR);
    let g = makeup;
    if (env > kneeLo) {
      const over = 20 * Math.log10(env) - thr;
      let gr;
      if (over >= knee / 2) gr = over * slope;
      else {
        const k = over + knee / 2;
        gr = (slope * k * k) / (2 * knee);
      }
      if (gr > maxGr) maxGr = gr;
      g = makeup * Math.pow(10, -gr / 20);
    }
    L[i] = l * g;
    R[i] = r * g;
  }
  return maxGr;
}

/** Look-ahead brick-wall limiter: output never exceeds `ceiling`. Returns max reduction in dB. */
export function limitInPlace(L, R, sr, ceiling, lookaheadMs, releaseMs) {
  const n = L.length;
  const look = Math.max(1, Math.round((sr * lookaheadMs) / 1000));
  const rel = 1 - Math.exp(-1 / ((sr * releaseMs) / 1000));
  const g = new Float32Array(n);
  let cur = 1;
  let minG = 1;
  for (let i = 0; i < n; i++) {
    const l = L[i];
    const r = R[i];
    const pk = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
    cur += (1 - cur) * rel;
    if (pk > ceiling) {
      const need = ceiling / pk;
      if (need < cur) cur = need;
    }
    g[i] = cur;
    if (cur < minG) minG = cur;
  }
  if (minG >= 1) return 0;
  // m[i] = min(g[i .. i+look]) via a monotonic deque, scanning backwards
  const m = new Float32Array(n);
  const cap = look + 2;
  const dq = new Int32Array(cap);
  let head = 0;
  let size = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (size > 0 && g[dq[(head + size - 1) % cap]] >= g[i]) size--;
    dq[(head + size) % cap] = i;
    size++;
    while (dq[head] > i + look) {
      head = (head + 1) % cap;
      size--;
    }
    m[i] = g[dq[head]];
  }
  // smooth the attack with a trailing box of `look` samples (each term already <= g[i])
  let sum = look; // virtual history of 1s
  for (let i = 0; i < n; i++) {
    sum += m[i] - (i - look >= 0 ? m[i - look] : 1);
    const gg = sum / look;
    let l = L[i] * gg;
    let r = R[i] * gg;
    if (l > ceiling) l = ceiling;
    else if (l < -ceiling) l = -ceiling;
    if (r > ceiling) r = ceiling;
    else if (r < -ceiling) r = -ceiling;
    L[i] = l;
    R[i] = r;
  }
  return -20 * Math.log10(minG);
}

function fadeEdges(L, R, sr, inSec, outSec) {
  const n = L.length;
  const a = Math.min(n, Math.floor(inSec * sr));
  for (let i = 0; i < a; i++) {
    const k = i / a;
    L[i] *= k;
    R[i] *= k;
  }
  const b = Math.min(n, Math.floor(outSec * sr));
  for (let i = 0; i < b; i++) {
    const k = i / b;
    const s = k * k * (3 - 2 * k);
    L[n - 1 - i] *= s;
    R[n - 1 - i] *= s;
  }
}

function peakOf(L, R) {
  let p = 0;
  for (let i = 0; i < L.length; i++) {
    const a = L[i] < 0 ? -L[i] : L[i];
    const b = R[i] < 0 ? -R[i] : R[i];
    if (a > p) p = a;
    if (b > p) p = b;
  }
  return p;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Full offline production: calibrate -> render chunks -> overlap-add -> master. */
async function produceTrack(onProgress) {
  if (!getOfflineCtor()) throw new Error('OfflineAudioContext is not supported in this browser');
  const report = (p, label) => {
    if (onProgress) {
      try {
        onProgress(clamp(p, 0, 1), label);
      } catch (_) {
        /* progress callbacks must never break the render */
      }
    }
  };
  const t00 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  report(0, '음악 합성 준비 중');
  const arr = buildArrangement();
  const shared = { noise: makeNoiseData(2.0, 0xc0ffee), ir: makeImpulseData(), kickCurve: makeTanhCurve(1.6) };
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const limit = clamp(cores - 1, 2, 4);
  await tick();

  // 1) calibration (cheap solo renders)
  const nCal = Object.keys(MIX.targets).length;
  let calDone = 0;
  let cal;
  try {
    cal = await calibrate(arr, shared, limit, () => report(0.02 + 0.13 * (++calDone / nCal), '사운드 밸런스 조정 중'));
  } catch (err) {
    cal = { gains: Object.assign({}, MIX.stems), report: { error: String(err) } };
  }

  // 2) chunk renders, overlap-added into the full-length mix
  const N = Math.ceil(SONG_DURATION * SR);
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const chunks = planChunks(arr);
  const totalLen = chunks.reduce((s, c) => s + c.len, 0);
  let doneLen = 0;
  let eventCount = 0;
  const tasks = chunks.map((c) => async () => {
    const { buffer, count } = await renderRange(arr, shared, Object.assign({ gains: cal.gains }, c));
    const off = Math.round(c.t0 * SR);
    const l = buffer.getChannelData(0);
    const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
    const m = Math.min(l.length, N - off);
    for (let i = 0; i < m; i++) {
      L[off + i] += l[i];
      R[off + i] += r[i];
    }
    eventCount += count;
    doneLen += c.len;
    report(0.15 + 0.7 * (doneLen / totalLen), '트랙 렌더링 중');
  });
  await runPool(tasks, limit);

  // 3) master
  report(0.87, '마스터링 중');
  await tick();
  const M = MIX.master;
  const prePeak = peakOf(L, R);
  const normGain = normaliseInPlace(L, R, SR, M.targetRms);
  await tick();
  const compGr = compressInPlace(L, R, SR, M);
  report(0.94, '마스터링 중');
  await tick();
  const limGr = limitInPlace(L, R, SR, M.ceiling, M.lookaheadMs, M.limiterReleaseMs);
  fadeEdges(L, R, SR, 0.005, 0.3);
  const t11 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const stats = {
    renderMs: Math.round(t11 - t00), events: eventCount, stemGains: cal.gains, calibration: cal.report,
    preMasterPeak: prePeak, normaliseGain: normGain, compMaxReductionDb: compGr, limiterMaxReductionDb: limGr,
    peak: peakOf(L, R), sampleRate: SR,
  };
  report(1, '준비 완료');
  return { L, R, kicks: arr.kicks, stats };
}

// ───────────────────────────────────────────────────────────── SFX (live, short one-shots)

function sfxTone(c, out, t, { f, f2, type = 'sine', vel = 0.2, a = 0.004, tc = 0.08, glide = 0.1, lp }) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + glide);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + a);
  g.gain.setTargetAtTime(0, t + a, tc);
  let node = o;
  if (lp) {
    const fl = c.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.value = lp;
    o.connect(fl);
    node = fl;
  }
  node.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + a + tc * 7);
}

function sfxNoise(c, out, buf, t, { vel = 0.08, hp = 6000, tc = 0.2 }) {
  const s = c.createBufferSource();
  s.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = c.createGain();
  g.gain.setValueAtTime(vel, t);
  g.gain.setTargetAtTime(0, t + 0.005, tc);
  s.connect(f);
  f.connect(g);
  g.connect(out);
  s.start(t, Math.random() * 0.5);
  s.stop(t + tc * 7 + 0.01);
}

// All SFX are pitched in F minor so they sit inside the track.
const SFX = {
  perfect(c, out, t, nb) {
    sfxTone(c, out, t, { f: 1396.9, vel: 0.2, tc: 0.09 });
    sfxTone(c, out, t + 0.055, { f: 2093.0, vel: 0.18, tc: 0.12 });
    sfxTone(c, out, t + 0.11, { f: 2793.8, type: 'triangle', vel: 0.07, tc: 0.15 });
    sfxNoise(c, out, nb, t, { vel: 0.03, hp: 8000, tc: 0.06 });
  },
  super(c, out, t) {
    sfxTone(c, out, t, { f: 1046.5, vel: 0.19, tc: 0.08 });
    sfxTone(c, out, t + 0.05, { f: 1396.9, vel: 0.16, tc: 0.1 });
  },
  good(c, out, t) {
    sfxTone(c, out, t, { f: 830.6, type: 'triangle', vel: 0.17, tc: 0.07 });
  },
  ok(c, out, t) {
    sfxTone(c, out, t, { f: 698.5, vel: 0.13, tc: 0.05 });
  },
  miss(c, out, t) {
    sfxTone(c, out, t, { f: 165, f2: 70, glide: 0.18, type: 'sawtooth', vel: 0.24, tc: 0.07, a: 0.006, lp: 700 });
  },
  gold(c, out, t, nb) {
    const notes = [698.5, 830.6, 1046.5, 1396.9, 1661.2, 2093.0];
    notes.forEach((f, i) => {
      sfxTone(c, out, t + i * 0.045, { f, vel: 0.14, tc: 0.16 });
      sfxTone(c, out, t + i * 0.045, { f: f * 2, type: 'triangle', vel: 0.04, tc: 0.12 });
    });
    sfxNoise(c, out, nb, t, { vel: 0.05, hp: 7000, tc: 0.22 });
  },
  ui(c, out, t) {
    sfxTone(c, out, t, { f: 1568, f2: 2093, glide: 0.03, type: 'triangle', vel: 0.11, tc: 0.022, a: 0.002 });
  },
  countdown(c, out, t) {
    sfxTone(c, out, t, { f: 698.5, type: 'triangle', vel: 0.2, tc: 0.05, a: 0.003 });
    sfxTone(c, out, t, { f: 1396.9, vel: 0.07, tc: 0.04, a: 0.003 });
  },
  go(c, out, t) {
    sfxTone(c, out, t, { f: 1396.9, type: 'triangle', vel: 0.2, tc: 0.14, a: 0.003 });
    sfxTone(c, out, t, { f: 2093.0, vel: 0.1, tc: 0.14, a: 0.003 });
  },
};

// ───────────────────────────────────────────────────────────── public API

export function createMusic() {
  let ctx = null;
  let initPromise = null;
  let buffer = null;
  let kicks = [];
  let stats = null;
  let ready = false;

  let masterGain = null;
  let musicGain = null;
  let sfxGain = null;
  let analyser = null;
  let freq = null;
  let bands = null;
  let sfxNoiseBuf = null;

  let volume = 1;
  let state = 'idle'; // 'idle' | 'playing' | 'paused' | 'ended'
  let source = null; // { node, fade }
  let startAt = 0; // ctx time at which `offset` seconds of the song are (were) rendered
  let offset = 0;
  let pausedPos = 0;
  let posFloor = -Infinity; // keeps getTime() monotonic across the short re-schedule on resume()
  const endedCbs = [];

  // audio-clock reader, interpolated between currentTime updates so it advances smoothly
  let lastCt = -1;
  let lastPn = 0;
  let lastEst = 0;
  const pnow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function ctxNow() {
    const ct = ctx.currentTime;
    if (ctx.state !== 'running') return ct > lastEst ? (lastEst = ct) : lastEst;
    const pn = pnow();
    if (ct !== lastCt) {
      lastCt = ct;
      lastPn = pn;
    }
    const est = ct + Math.min(0.03, Math.max(0, (pn - lastPn) / 1000));
    if (est > lastEst) lastEst = est;
    return lastEst;
  }
  function latency() {
    if (!ctx) return 0;
    const o = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    const b = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    return clamp(o + b, 0, 0.35);
  }
  function rawPos() {
    if (state === 'playing') return Math.max(posFloor, offset + (ctxNow() - startAt));
    if (state === 'paused') return pausedPos;
    if (state === 'ended') return SONG_DURATION + latency();
    return 0;
  }

  function unlock() {
    if (ctx && ctx.state === 'suspended') {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }

  function buildLiveGraph() {
    masterGain = ctx.createGain();
    masterGain.gain.value = volume;
    // zero-latency soft clipper: linear below 0.8, saturates smoothly to 1.0 (input range ±2)
    const pre = ctx.createGain();
    pre.gain.value = 0.5;
    const shaper = ctx.createWaveShaper();
    const n = 2049;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * 2;
      const a = Math.abs(x);
      const y = a <= 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
      curve[i] = x < 0 ? -y : y;
    }
    shaper.curve = curve;
    masterGain.connect(pre);
    pre.connect(shaper);
    shaper.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = MIX.musicGain;
    musicGain.connect(masterGain);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = MIX.sfxGain;
    sfxGain.connect(masterGain);

    analyser = ctx.createAnalyser();
    analyser.fftSize = LEVELS.fft;
    analyser.smoothingTimeConstant = LEVELS.smoothing;
    analyser.minDecibels = LEVELS.minDb;
    analyser.maxDecibels = LEVELS.maxDb;
    musicGain.connect(analyser); // tapped before the master volume: visuals ignore setVolume()
    freq = new Uint8Array(analyser.frequencyBinCount);
    const hz = ctx.sampleRate / analyser.fftSize;
    const range = (b) => {
      const lo = clamp(Math.round(b.lo / hz), 1, freq.length - 1);
      const hi = clamp(Math.round(b.hi / hz), lo, freq.length - 1);
      return [lo, hi];
    };
    bands = { bass: range(LEVELS.bass), mid: range(LEVELS.mid), high: range(LEVELS.high) };

    const nd = new Float32Array(Math.floor(ctx.sampleRate * 1.0));
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    sfxNoiseBuf = makeBuffer(ctx, [nd], ctx.sampleRate);
  }

  function killSource(fadeOut) {
    if (!source) return;
    const s = source;
    source = null;
    s.node.onended = null;
    const now = ctx.currentTime;
    try {
      if (fadeOut) {
        s.fade.gain.setTargetAtTime(0, now, 0.008);
        s.node.stop(now + 0.045);
      } else s.node.stop();
    } catch (_) {
      /* already stopped */
    }
    setTimeout(() => {
      try {
        s.node.disconnect();
        s.fade.disconnect();
      } catch (_) {
        /* ignore */
      }
    }, 200);
  }

  function launch(pos) {
    // pos: song position (s) that should be rendered at `when`; negative = extra delay
    const when = ctx.currentTime + 0.04;
    const off = clamp(pos, 0, Math.max(0, buffer.duration - 0.01));
    const delay = pos < 0 ? -pos : 0;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const fade = ctx.createGain();
    if (off > 0) {
      fade.gain.setValueAtTime(0, when);
      fade.gain.linearRampToValueAtTime(1, when + 0.02);
    }
    node.connect(fade);
    fade.connect(musicGain);
    const me = { node, fade };
    node.onended = () => {
      if (source !== me) return;
      source = null;
      state = 'ended';
      for (const cb of endedCbs.slice()) {
        try {
          cb();
        } catch (err) {
          console.error('[audio] onEnded callback failed', err);
        }
      }
    };
    node.start(when + delay, off);
    source = me;
    startAt = when + delay;
    offset = off;
    lastEst = Math.min(lastEst, ctx.currentTime); // allow the estimate to restart from "now"
    state = 'playing';
  }

  const levels = { bass: 0, mid: 0, high: 0, kick: 0 };
  let levelsAt = 0;
  function bandAvg([lo, hi]) {
    let s = 0;
    for (let i = lo; i <= hi; i++) s += freq[i];
    return s / ((hi - lo + 1) * 255);
  }
  function kickEnv(t) {
    let lo = 0;
    let hi = kicks.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kicks[mid].t <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx < 0) return 0;
    const dt = t - kicks[idx].t;
    return dt > 1.2 ? 0 : kicks[idx].vel * Math.exp(-dt / LEVELS.kickDecay);
  }

  const api = {
    /**
     * Create the AudioContext (call from a user gesture when possible) and render the track.
     * onProgress(fraction 0..1, koreanLabel) is optional. Safe to call more than once.
     */
    init(onProgress) {
      if (initPromise) return initPromise;
      initPromise = (async () => {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) throw new Error('Web Audio API is not supported in this browser');
        try {
          ctx = new AC({ latencyHint: 'interactive' });
        } catch (_) {
          ctx = new AC();
        }
        unlock();
        if (typeof window !== 'undefined' && window.addEventListener) {
          for (const type of ['pointerdown', 'keydown', 'touchend']) {
            window.addEventListener(type, unlock, { capture: true, passive: true });
          }
        }
        buildLiveGraph();
        const track = await produceTrack(onProgress);
        buffer = makeBuffer(ctx, [track.L, track.R]);
        kicks = track.kicks;
        stats = track.stats;
        ready = true;
      })();
      initPromise.catch(() => {
        initPromise = null; // allow a retry after a failure
      });
      return initPromise;
    },

    /** Begin playback from the top (optionally from `fromSec` for auditioning). */
    start(fromSec = 0) {
      if (!ready) return;
      unlock();
      killSource(true);
      posFloor = -Infinity;
      launch(Number.isFinite(fromSec) ? fromSec : 0);
    },
    stop() {
      if (!ready) return;
      killSource(true);
      state = 'idle';
    },
    pause() {
      if (!ready || state !== 'playing') return;
      pausedPos = rawPos();
      killSource(true);
      state = 'paused';
    },
    resume() {
      if (!ready || state !== 'paused') return;
      unlock();
      posFloor = pausedPos;
      launch(pausedPos);
    },

    /** Song seconds (0 = start of the lead-in, beat 0 at SONG.leadInSec), latency compensated. */
    getTime() {
      if (!ready || state === 'idle') return 0;
      return Math.min(SONG_DURATION, rawPos() - latency());
    },
    getBeat() {
      return secToBeat(api.getTime());
    },

    getLevels() {
      if (!ready) return { bass: 0, mid: 0, high: 0, kick: 0 };
      const now = pnow();
      const dt = clamp((now - levelsAt) / 1000, 0, 0.1);
      if (dt >= 0.004 || levelsAt === 0) {
        levelsAt = now;
        analyser.getByteFrequencyData(freq);
        for (const name of ['bass', 'mid', 'high']) {
          const cfg = LEVELS[name];
          const target = clamp((bandAvg(bands[name]) - cfg.floor) / cfg.span, 0, 1);
          const k = 1 - Math.exp(-dt / (target > levels[name] ? LEVELS.attack : LEVELS.release));
          levels[name] += (target - levels[name]) * (dt > 0 ? k : 1);
        }
        levels.kick = state === 'playing' ? clamp(kickEnv(api.getTime()), 0, 1) : levels.kick * Math.exp(-dt / LEVELS.kickDecay);
      }
      return { bass: levels.bass, mid: levels.mid, high: levels.high, kick: levels.kick };
    },

    /** 'perfect' | 'super' | 'good' | 'ok' | 'miss' | 'gold' | 'ui' | 'countdown' (+ 'go'). */
    playSfx(name) {
      if (!ctx || !sfxGain) return;
      const fn = SFX[name];
      if (!fn) return;
      unlock();
      try {
        fn(ctx, sfxGain, ctx.currentTime + 0.005, sfxNoiseBuf);
      } catch (err) {
        console.warn('[audio] sfx failed', name, err);
      }
    },

    setVolume(v) {
      volume = clamp(Number(v) || 0, 0, 1);
      if (masterGain) masterGain.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
    },

    /** Register a callback fired once each time the track reaches its natural end. Returns an unsubscribe fn. */
    onEnded(cb) {
      if (typeof cb !== 'function') return () => {};
      endedCbs.push(cb);
      return () => {
        const i = endedCbs.indexOf(cb);
        if (i >= 0) endedCbs.splice(i, 1);
      };
    },

    get duration() {
      return SONG_DURATION;
    },
    get isPlaying() {
      return state === 'playing';
    },
    get isReady() {
      return ready;
    },
    /** Diagnostics for the integrator: render stats, calibrated gains, the mastered buffer. */
    get debug() {
      return { state, stats, buffer, context: ctx, latency: latency(), kicks, totalBeats: TOTAL_BEATS };
    },
  };
  return api;
}
