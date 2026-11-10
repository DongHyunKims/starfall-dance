// Shared song structure. Single source of truth for tempo and sections.
// Imported by audio.js (music synthesis), choreo.js (choreography) and main.js.
export const SONG = {
  title: 'STARFALL',
  artist: 'NOVA',
  bpm: 124,
  beatsPerBar: 4,
  leadInSec: 1.0, // silence before beat 0 once playback starts
  sections: [
    // intensity 0..1 drives music density, stage lighting and choreography energy
    { name: 'intro', startBar: 0, bars: 4, intensity: 0.25, scored: false },
    { name: 'verseA', startBar: 4, bars: 8, intensity: 0.5, scored: true },
    { name: 'build', startBar: 12, bars: 4, intensity: 0.7, scored: true },
    { name: 'chorus1', startBar: 16, bars: 8, intensity: 1.0, scored: true },
    { name: 'verseB', startBar: 24, bars: 8, intensity: 0.6, scored: true },
    { name: 'bridge', startBar: 32, bars: 4, intensity: 0.35, scored: true },
    { name: 'chorus2', startBar: 36, bars: 8, intensity: 1.0, scored: true },
    { name: 'outro', startBar: 44, bars: 4, intensity: 0.4, scored: false },
  ],
};

export const TOTAL_BARS = 48;
export const TOTAL_BEATS = TOTAL_BARS * SONG.beatsPerBar; // 192
export const SEC_PER_BEAT = 60 / SONG.bpm;
export const SONG_DURATION = SONG.leadInSec + TOTAL_BEATS * SEC_PER_BEAT + 2.0; // incl. tail

export const beatToSec = (beat) => SONG.leadInSec + beat * SEC_PER_BEAT;
export const secToBeat = (sec) => (sec - SONG.leadInSec) / SEC_PER_BEAT;

export function sectionAtBeat(beat) {
  const bar = Math.floor(beat / SONG.beatsPerBar);
  for (const s of SONG.sections) {
    if (bar >= s.startBar && bar < s.startBar + s.bars) return s;
  }
  return beat < 0 ? SONG.sections[0] : SONG.sections[SONG.sections.length - 1];
}
