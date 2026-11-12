// Shared song structure. Single source of truth for tempo and sections.
// Imported by audio.js (music synthesis), choreo.js (choreography), the STAR SLASH chart and main.js.
//
// There are three songs, one per difficulty. They share one 48-bar form (the choreography, the
// STAR SLASH patterns and the stage looks are all written against these sections), and differ in
// tempo, key, harmony, melody and groove (see the song materials in audio.js):
//   MOON DRIFT  100 BPM  easy     STARFALL  124 BPM  normal     COMET RUSH  140 BPM  hard
//
// `SONG`, `SEC_PER_BEAT` and `SONG_DURATION` are LIVE bindings: setSong(id) repoints them, and
// every importer that reads them when it needs them (not once at module load) follows along.
// Code that must not depend on the current song (the offline music renderer) uses timingOf().

// intensity 0..1 drives music density, stage lighting and choreography energy
const SECTIONS = [
  { name: 'intro', startBar: 0, bars: 4, intensity: 0.25, scored: false },
  { name: 'verseA', startBar: 4, bars: 8, intensity: 0.5, scored: true },
  { name: 'build', startBar: 12, bars: 4, intensity: 0.7, scored: true },
  { name: 'chorus1', startBar: 16, bars: 8, intensity: 1.0, scored: true },
  { name: 'verseB', startBar: 24, bars: 8, intensity: 0.6, scored: true },
  { name: 'bridge', startBar: 32, bars: 4, intensity: 0.35, scored: true },
  { name: 'chorus2', startBar: 36, bars: 8, intensity: 1.0, scored: true },
  { name: 'outro', startBar: 44, bars: 4, intensity: 0.4, scored: false },
];

const song = (id, title, genre, level, bpm) => ({
  id, title, artist: 'NOVA', genre, level, bpm,
  beatsPerBar: 4,
  leadInSec: 1.0, // silence before beat 0 once playback starts
  sections: SECTIONS,
});

/** level: the STAR SLASH chart ('easy' | 'normal' | 'hard') that belongs to the song. */
export const SONGS = {
  moondrift: song('moondrift', 'MOON DRIFT', '드림 팝', 'easy', 100),
  starfall: song('starfall', 'STARFALL', '일렉트로 팝', 'normal', 124),
  cometrush: song('cometrush', 'COMET RUSH', '하이퍼 댄스', 'hard', 140),
};
export const SONG_IDS = ['moondrift', 'starfall', 'cometrush']; // easiest first
export const DEFAULT_SONG = 'starfall';
export const songById = (id) => (Object.prototype.hasOwnProperty.call(SONGS, id) ? SONGS[id] : null);
export const songForLevel = (level) => SONG_IDS.map((id) => SONGS[id]).find((s) => s.level === level) || null;

export const TOTAL_BARS = 48;
export const TOTAL_BEATS = TOTAL_BARS * 4; // 192, the same for every song
const TAIL_SEC = 2.0; // rendered past the last bar

/** Everything about a song's clock, without touching the current song. */
export function timingOf(s) {
  const spb = 60 / s.bpm;
  return {
    song: s,
    spb,
    beatsPerBar: s.beatsPerBar,
    totalBeats: TOTAL_BEATS,
    duration: s.leadInSec + TOTAL_BEATS * spb + TAIL_SEC, // incl. tail
    beatToSec: (beat) => s.leadInSec + beat * spb,
    secToBeat: (sec) => (sec - s.leadInSec) / spb,
  };
}

// ---- the current song (live bindings) ----
export let SONG = SONGS[DEFAULT_SONG];
export let SEC_PER_BEAT = 60 / SONG.bpm;
export let SONG_DURATION = SONG.leadInSec + TOTAL_BEATS * SEC_PER_BEAT + TAIL_SEC; // incl. tail

/** Make `id` the current song (unknown ids fall back to the default). Returns the song. */
export function setSong(id) {
  const s = songById(id) || SONGS[DEFAULT_SONG];
  SONG = s;
  SEC_PER_BEAT = 60 / s.bpm;
  SONG_DURATION = s.leadInSec + TOTAL_BEATS * SEC_PER_BEAT + TAIL_SEC;
  return s;
}

export const beatToSec = (beat) => SONG.leadInSec + beat * SEC_PER_BEAT;
export const secToBeat = (sec) => (sec - SONG.leadInSec) / SEC_PER_BEAT;

export function sectionAtBeat(beat) {
  const bar = Math.floor(beat / SONG.beatsPerBar);
  for (const s of SONG.sections) {
    if (bar >= s.startBar && bar < s.startBar + s.bars) return s;
  }
  return beat < 0 ? SONG.sections[0] : SONG.sections[SONG.sections.length - 1];
}
