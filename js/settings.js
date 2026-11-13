// STARFALL — the player's settings: what they are, how they are kept, and what each one means
// for the game. Pure (no DOM): the settings window is drawn by js/hud.js, js/main.js applies them.
//
//   music, sfx    0..1   volume of the song / of the effect sounds
//   offsetMs      -200..200  judge the player this much later (+) or earlier (-): for headphones
//                 that play late (Bluetooth), or for somebody who is always a touch behind
//   judge         'easy' | 'normal' | 'strict'   STAR SLASH with the camera: how forgiving a cut is
//   fx            'normal' | 'low'               flashes, glow and sparks
//   quality       'auto' | 'low' | 'high'        rendering resolution
//   pad           's' | 'm' | 'l'                size of the touch pads

export const SETTINGS_KEY = 'starfall.settings';

export const SETTINGS_DEFAULTS = Object.freeze({
  music: 1,
  sfx: 1,
  offsetMs: 0,
  judge: 'normal',
  fx: 'normal',
  quality: 'auto',
  pad: 'm',
});

export const OFFSET_LIMIT_MS = 200;
export const OFFSET_STEP_MS = 10;

const CHOICES = Object.freeze({
  judge: Object.freeze(['easy', 'normal', 'strict']),
  fx: Object.freeze(['normal', 'low']),
  quality: Object.freeze(['auto', 'low', 'high']),
  pad: Object.freeze(['s', 'm', 'l']),
});

const isNum = (v) => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Any value -> a complete, valid settings object (unknown or broken fields fall back to the defaults). */
export function sanitizeSettings(raw) {
  const s = { ...SETTINGS_DEFAULTS };
  if (!raw || typeof raw !== 'object') return s;
  for (const k of ['music', 'sfx']) {
    const v = typeof raw[k] === 'string' && raw[k].trim() !== '' ? Number(raw[k]) : raw[k];
    if (isNum(v)) s[k] = Math.round(clamp(v, 0, 1) * 100) / 100;
  }
  const off = typeof raw.offsetMs === 'string' && raw.offsetMs.trim() !== '' ? Number(raw.offsetMs) : raw.offsetMs;
  if (isNum(off)) s.offsetMs = Math.round(clamp(off, -OFFSET_LIMIT_MS, OFFSET_LIMIT_MS) / OFFSET_STEP_MS) * OFFSET_STEP_MS || 0;
  for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(raw[k])) s[k] = raw[k];
  return s;
}

/** The stored settings (the defaults when there are none, or storage is not available). */
export function loadSettings(storage) {
  try {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const text = st ? st.getItem(SETTINGS_KEY) : null;
    return sanitizeSettings(text ? JSON.parse(text) : null);
  } catch (e) {
    return sanitizeSettings(null);
  }
}

/** Keep them. Returns what was stored (sanitized); never throws (private windows have no storage). */
export function saveSettings(settings, storage) {
  const s = sanitizeSettings(settings);
  try {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (st) st.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (e) {
    /* nowhere to keep them: they last for this visit */
  }
  return s;
}

/**
 * STAR SLASH with the camera: createSlashJudge options for a `judge` setting, on top of
 * SLASH_TUNING ('normal' = the tuning as it is).
 *   easy    a cut reaches almost a whole cell, comes a good half second late if it must, and
 *           only a swing straight against the arrow through the middle of the shard is a BAD
 *   strict  the first, arcade tuning: tight windows, a real direction, no pass for the rim
 */
export function slashJudgeOptions(level) {
  if (level === 'easy') {
    return {
      windowBefore: 0.28, windowAfter: 0.6,
      hitRadius: 0.95, stopRadius: 0.7,
      wrongDirRadius: 0.35, wrongHandRadius: 0.25,
      minSpeed: 0.9, badMinSpeed: 3.6,
      perfectAngle: 60, goodAngle: 100, earlyAngle: 70,
      perfectSec: 0.26, badGraceSec: 0.5, wrongHandGuardSec: 0.5,
    };
  }
  if (level === 'strict') {
    return {
      windowBefore: 0.2, windowAfter: 0.28,
      hitRadius: 0.6, stopRadius: 0.4,
      wrongDirRadius: 0.6, wrongHandRadius: 0.45,
      minSpeed: 1.5, badMinSpeed: 2.5,
      perfectAngle: 40, goodAngle: 75, earlyAngle: 75,
      perfectSec: 0.14, badGraceSec: 0.32, wrongHandGuardSec: 0.3,
      rankS: 0.92, rankA: 0.8, rankB: 0.65, rankC: 0.45,
      starThresholds: [0.2, 0.45, 0.65, 0.8, 0.92],
    };
  }
  return {};
}

/** Brightness of the hit effects for an `fx` setting: multipliers for the stage and the lane. */
export function fxScale(fx) {
  return fx === 'low'
    ? { bloom: 0.55, stage: 0.5, lane: 0.55, sparks: 0.5, hud: 0.45 }
    : { bloom: 1, stage: 1, lane: 1, sparks: 1, hud: 1 };
}

/** Rendering resolution for a `quality` setting: a fixed share of the pixel budget, or null = adapt. */
export function qualityScale(quality) {
  return quality === 'low' ? 0.5 : quality === 'high' ? 1 : null;
}

/** Size of the touch pads for a `pad` setting (1 = as designed). */
export function padScale(pad) {
  return pad === 's' ? 0.82 : pad === 'l' ? 1.2 : 1;
}
