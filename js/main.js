// STARFALL — game loop and state machine.
// loading -> title -> camera -> countdown -> play (<-> pause) -> results
//
//   ?demo=1   never touch the camera: a simulated player (js/demo-player.js) feeds the judge
//   ?debug=1  fps + judge overlay, and window.__game.seek(beat)

import { createStage } from './stage.js';
import { createDancer } from './dancer.js';
import { createMusic } from './audio.js';
import { createHud } from './hud.js';
import { createJudge } from './scoring.js';
import { createPoseTracker } from './pose-tracker.js';
import { createDemoPlayer } from './demo-player.js';
import { MOVES, samplePose, getPose, lerpPose } from './choreo.js';
import {
  SONG, TOTAL_BEATS, SEC_PER_BEAT, SONG_DURATION, beatToSec, secToBeat, sectionAtBeat,
} from './song.js';

const params = new URLSearchParams(location.search);
const DEMO_ONLY = window.STARFALL_DEMO_ONLY === true;
const FORCE_DEMO = DEMO_ONLY || params.get('demo') === '1';
const DEBUG = params.get('debug') === '1';

const canvas = document.getElementById('stage');
const hudRoot = document.getElementById('hud');
const video = document.getElementById('cam');

// ---------------------------------------------------------------------------
// modules
// ---------------------------------------------------------------------------
const hud = createHud(hudRoot);
hud.showScreen('loading');
hud.setLoading(0, '무대를 세우는 중');

const stage = createStage(canvas);
const dancer = createDancer();
stage.add(dancer.group);
stage.setMode('menu');
stage.renderer.info.autoReset = false; // count draw calls across all passes of a frame

const music = createMusic();
const tracker = createPoseTracker(video);
const demoPlayer = createDemoPlayer();

// Scored moves with their pose resolved once, so the HUD never has to look poses up.
const moves = MOVES.map((m) => ({ ...m, poseData: getPose(m.pose) }));
let judge = createJudge(moves, { getPoseByName: getPose });

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let state = 'loading';
let demo = FORCE_DEMO;
let runId = 0;             // bumps whenever a run starts or is abandoned (cancels stale callbacks)
let cameraWanted = false;  // the player passed the camera check but the model is still loading
let energy = 0.3;
let lastRating = null;
let resultStats = null;
let resultsAt = 0;
let handoffTimer = 0;
let demoSeed = 1;
let lastSongT = 0;        // song time of the last rendered play frame
let rewindTo = null;      // set when frames stalled while the music kept running
let countdownStalled = false; // the tab was hidden while the countdown was running

// A wall-clock stand-in for the song clock, used only if the audio engine failed to start.
const fallbackClock = { running: false, base: 0, at: 0 };
function songTime() {
  if (music.isReady) return music.getTime();
  if (!fallbackClock.running) return fallbackClock.base;
  return Math.min(SONG_DURATION, fallbackClock.base + (performance.now() - fallbackClock.at) / 1000);
}
function clockStart(fromSec = 0) {
  if (music.isReady) { music.start(fromSec); return; }
  fallbackClock.base = fromSec; fallbackClock.at = performance.now(); fallbackClock.running = true;
}
function clockPause() {
  if (music.isReady) { music.pause(); return; }
  fallbackClock.base = songTime(); fallbackClock.running = false;
}
function clockResume() {
  if (music.isReady) { music.resume(); return; }
  fallbackClock.at = performance.now(); fallbackClock.running = true;
}
function clockStop() {
  if (music.isReady) music.stop();
  fallbackClock.base = 0; fallbackClock.running = false;
}

const RATING_FLASH = {
  perfect: 0x19e3d2, super: 0x8a5cff, good: 0x2bb8c9, miss: 0xff5a6e, gold: 0xffc24a,
};

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------
function setState(next) {
  state = next;
  if (DEBUG) console.info('[game] state ->', next);
}

function goTitle() {
  runId++;
  clearTimeout(handoffTimer);
  cameraWanted = false;
  clockStop();
  tracker.stop();
  stage.setMode('menu');
  dancer.setExpression('smile');
  hud.showScreen('title');
  setState('title');
}

function startCountdown() {
  runId++;
  clearTimeout(handoffTimer);
  cameraWanted = false;
  countdownStalled = false;
  clockStop();
  judge = createJudge(moves, { getPoseByName: getPose });
  rewindTo = null;
  lastSongT = 0;
  demoPlayer.reset(demoSeed++);
  lastRating = null;
  resultStats = null;
  stage.setMode('play');
  dancer.setExpression('smile');
  // State first: showScreen('countdown') emits the first countdownTick synchronously.
  setState('countdown');
  // The HUD only resets its own run state when entering from outside a run (pause -> retry
  // stays "inside"), so do it explicitly as well.
  hud.showScreen('countdown');
  hud.setScore(0, 0, 1);
  hud.setProgress(0);
  hud.setSection(sectionAtBeat(0).name);
}

function startPlay() {
  if (state !== 'countdown') return;
  // Tab hidden during the countdown: do not start the song behind the player's back.
  // The countdown is run again when the page becomes visible (see visibilitychange).
  if (document.hidden) { countdownStalled = true; return; }
  const id = ++runId;
  lastSongT = 0;
  clockStart(0);
  setState('play');
  // let "시작!" breathe for a moment (the song has its own 1 s lead-in), then swap the screen
  handoffTimer = setTimeout(() => {
    if (id === runId && state === 'play' && hud.screen === 'countdown') hud.showScreen('play');
  }, 650);
}

function pauseGame() {
  if (state !== 'play') return;
  clockPause();
  clearTimeout(handoffTimer);
  if (hud.screen !== 'pause') hud.showScreen('pause');
  setState('pause');
}

function resumeGame() {
  if (state !== 'pause') return;
  if (rewindTo != null) clockStart(rewindTo); else clockResume();
  rewindTo = null;
  if (!demo) tracker.resumeVideo();
  if (hud.screen !== 'play') hud.showScreen('play');
  setState('play');
}

function finishRun() {
  if (state !== 'play' && state !== 'pause') return;
  runId++;
  clearTimeout(handoffTimer);
  fallbackClock.running = false;
  judge.update(SONG_DURATION + 10); // flush anything still pending (update ignores non-finite times)
  resultStats = judge.stats();
  resultsAt = performance.now();
  tracker.stop();
  stage.setMode('results');
  dancer.setExpression(resultStats.stars >= 2 ? 'smile' : 'neutral');
  hud.showResults(resultStats);
  setState('results');
}

async function startCameraPath() {
  if (FORCE_DEMO) { demo = true; startCountdown(); return; }
  demo = false;
  const id = ++runId;
  cameraWanted = false;
  clockStop();
  stage.setMode('menu');
  hud.showScreen('camera');
  setState('camera');

  // model and camera in parallel; either failing lands on the HUD's error panel (demo still works)
  const model = tracker.init((p, text) => hud.setLoading(p, text)).catch((e) => {
    console.warn('[game] pose model failed to load', e);
    const err = new Error('pose model load failed');
    err.kind = 'model';
    throw err;
  });
  const cam = tracker.startCamera();
  let failed = false;
  // Whenever the camera finally opens (the permission prompt can sit there for a long time),
  // release it again unless this very attempt is still waiting for it: the player may have
  // started the demo, gone back to the title, or the model may have failed in the meantime.
  cam.then(() => {
    const mine = id === runId && state === 'camera' && !failed;
    const inCameraRun = !demo && (state === 'countdown' || state === 'play' || state === 'pause' || state === 'camera');
    if (!mine && (id !== runId ? !inCameraRun : true)) tracker.stop();
  }, () => {});
  try {
    await Promise.all([model, cam]);
  } catch (e) {
    model.catch(() => {});
    if (id !== runId || state !== 'camera') return;
    failed = true;
    tracker.stop();
    hud.setCameraError(e && e.kind ? e : 'unknown');
    return;
  }
  if (id !== runId || state !== 'camera') return; // the cam.then() above already released it if needed
  if (cameraWanted) startCountdown();
}

/** The camera went away in the middle of a camera run: stop the run and say why. */
function cameraLost() {
  runId++;
  clearTimeout(handoffTimer);
  cameraWanted = false;
  clockStop();
  tracker.stop();
  stage.setMode('menu');
  setState('camera');
  hud.setCameraError('nodevice');
}

// ---------------------------------------------------------------------------
// HUD events
// ---------------------------------------------------------------------------
hud.on('start', () => {
  if (state !== 'title' && state !== 'camera') return;
  music.playSfx('ui');
  if (DEMO_ONLY) { runId++; demo = true; startCountdown(); return; }
  startCameraPath();
});
hud.on('startDemo', () => {
  if (state !== 'title' && state !== 'camera') return;
  music.playSfx('ui');
  runId++;
  tracker.stop();
  demo = true;
  startCountdown();
});
hud.on('cameraReady', () => {
  if (state !== 'camera') return;
  if (tracker.isReady && tracker.cameraActive) startCountdown();
  else cameraWanted = true; // startCameraPath() finishes the hand-off (or shows the error panel)
});
hud.on('countdownTick', (n) => {
  if (state === 'countdown') music.playSfx(n > 0 ? 'countdown' : 'go');
});
hud.on('countdownDone', startPlay);
hud.on('pause', pauseGame);     // the HUD already switched its own screen
hud.on('resume', resumeGame);
hud.on('retry', () => {
  if (state !== 'results' && state !== 'pause') return;
  music.playSfx('ui');
  if (!demo && !FORCE_DEMO) {
    if (tracker.isReady && tracker.cameraActive) startCountdown();
    else startCameraPath(); // the camera is released on the results screen: check framing again
  } else {
    startCountdown();
  }
});
hud.on('menu', () => {
  music.playSfx('ui');
  goTitle();
});

music.onEnded(() => finishRun());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state === 'countdown') countdownStalled = true;
    pauseGame();
    return;
  }
  if (!demo) tracker.resumeVideo();
  if (state === 'countdown' && countdownStalled) startCountdown(); // count in again from 3
});
window.addEventListener('blur', () => { /* keep playing: only a hidden tab pauses */ });

function onResize() {
  stage.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
onResize();

// ---------------------------------------------------------------------------
// debug overlay
// ---------------------------------------------------------------------------
let debugEl = null;
let fps = 60;
let debugAt = 0;
if (DEBUG) {
  debugEl = document.createElement('pre');
  debugEl.id = 'debug';
  debugEl.style.cssText = 'position:fixed;left:8px;top:22%;z-index:50;margin:0;padding:8px 10px;'
    + 'font:11px/1.35 ui-monospace,Menlo,monospace;color:#c8fff8;background:rgba(6,3,20,.72);'
    + 'border:1px solid rgba(25,227,210,.35);border-radius:6px;pointer-events:none;white-space:pre;max-width:46vw';
  document.body.appendChild(debugEl);
}

function drawDebug(now, t, beat, section) {
  if (!debugEl || now - debugAt < 120) return;
  debugAt = now;
  const s = judge.stats();
  const d = judge.debug(t);
  const info = stage.renderer.info;
  const lines = [
    `fps ${fps.toFixed(0)}  calls ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k  pr ${stage.renderer.getPixelRatio().toFixed(2)}`,
    `state ${state}${demo ? ' (demo)' : ''}  hud ${hud.screen}  stage ${stage.mode}`,
    `t ${t.toFixed(2)}s  beat ${beat.toFixed(2)}  ${section.name}  energy ${energy.toFixed(2)}`,
    `score ${s.score}/${s.maxScore}  combo ${s.combo} x${s.multiplier}  judged ${s.judged}/${s.total}`,
    `P ${s.counts.perfect} S ${s.counts.super} G ${s.counts.good} O ${s.counts.ok} M ${s.counts.miss}  acc ${(s.accuracy * 100).toFixed(0)}%`,
  ];
  if (lastRating) {
    lines.push(`last ${lastRating.move.id} ${lastRating.move.pose} @${lastRating.move.beat} -> ${lastRating.rating} ${lastRating.score.toFixed(2)} (+${lastRating.points})`);
  }
  for (const o of d.open) {
    lines.push(`open ${o.id} ${o.pose} dt ${(t - o.time).toFixed(2)} held ${o.held.toFixed(2)} best ${o.best.toFixed(2)} n ${o.validSamples}/${o.samples}`);
  }
  if (!demo) {
    const td = tracker.debug;
    const pp = tracker.getPlayerPose();
    lines.push(`tracker ${td.delegate} ${td.fps.toFixed(0)}fps ${td.inferMs.toFixed(1)}ms body ${pp ? pp.bodyVisible.toFixed(2) : '-'}`);
  }
  const md = music.isReady ? music.debug : null;
  if (md) lines.push(`audio ${md.state} latency ${(md.latency * 1000).toFixed(0)}ms ctx ${md.context.state}`);
  debugEl.textContent = lines.join('\n');
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------
let lastNow = performance.now();
let wall = 0;
let frameErrors = 0;
const resultPoseCache = {};

function menuPose(wallSec) {
  // a seamless 4-beat groove taken from the intro (grooveR -> grooveL -> grooveR)
  const b = (wallSec / SEC_PER_BEAT) * 0.5;
  return samplePose(4 + (b % 4));
}

function resultPose(now) {
  const stars = resultStats ? resultStats.stars : 0;
  const name = stars >= 4 ? 'starburst' : stars >= 2 ? 'vHigh' : 'hipsBoth';
  const hero = resultPoseCache[name] || (resultPoseCache[name] = getPose(name));
  // strike the pose, hold it, then settle into the groove
  const since = (now - resultsAt) / 1000;
  const k = since < 3.2 ? 1 : Math.max(0, 1 - (since - 3.2) / 1.2);
  if (k >= 1) return hero;
  const groove = menuPose(wall);
  return k <= 0 ? groove : lerpPose(groove, hero, k * k * (3 - 2 * k));
}

function frame(now) {
  requestAnimationFrame(frame);
  const gap = (now - lastNow) / 1000;
  const dt = Math.min(0.1, Math.max(0, gap));
  lastNow = now;
  // Frames stopped (occluded window, debugger, long GC) while the audio clock kept running:
  // nothing was sampled or judged in between, so pause and pick the song up where we last drew.
  if (state === 'play' && gap > 0.6) {
    pauseGame();
    rewindTo = lastSongT;
  }
  wall += dt;
  if (dt > 0) fps += (1 / dt - fps) * 0.08;

  try {
    const inRun = state === 'play' || state === 'pause';
    const t = !inRun ? 0 : (state === 'pause' && rewindTo != null ? rewindTo : songTime());
    const beat = inRun ? secToBeat(t) : secToBeat(0);
    const section = sectionAtBeat(Math.max(0, beat));
    const levels = music.isReady ? music.getLevels() : { bass: 0, mid: 0, high: 0, kick: 0 };

    // ---- player input ----
    let player = null;
    if (state === 'camera' || ((state === 'countdown' || inRun) && !demo)) {
      tracker.update(now);
      player = tracker.getPlayerPose();
    } else if (demo && (state === 'countdown' || inRun)) {
      player = demoPlayer.sample(t);
    }

    // ---- judging ----
    if (!demo && (state === 'play' || state === 'countdown') && !tracker.cameraActive) {
      cameraLost(); // unplugged / permission revoked: do not keep scoring MISS in silence
    }
    if (state === 'play') {
      lastSongT = t;
      judge.pushSample(t, player);
      const events = judge.update(t);
      for (const ev of events) {
        lastRating = ev;
        const big = ev.gold && (ev.rating === 'perfect' || ev.rating === 'super');
        hud.showRating(ev.rating, { gold: ev.gold, points: ev.points });
        stage.pulse(big ? 'gold' : ev.rating);
        const flash = big ? RATING_FLASH.gold : RATING_FLASH[ev.rating];
        if (flash !== undefined) dancer.flash(flash);
        music.playSfx(big ? 'gold' : ev.rating);
      }
      if (events.length) {
        const s = judge.stats();
        hud.setScore(s.score, s.combo, s.multiplier);
      }
      hud.setProgress(Math.min(1, Math.max(0, beat / TOTAL_BEATS)));
      hud.setSection(section.name);
      const chorus = section.name === 'chorus1' || section.name === 'chorus2';
      dancer.setExpression(chorus ? 'fierce' : 'smile');
      if (!music.isReady && t >= SONG_DURATION) finishRun();
    }

    // ---- dancer ----
    let target = 0.3;
    if (state === 'play' || state === 'pause') {
      dancer.setPose(samplePose(beat));
      target = section.intensity;
    } else if (state === 'countdown') {
      dancer.setPose(samplePose(secToBeat(0)));
      target = 0.3;
    } else if (state === 'results') {
      dancer.setPose(resultPose(now));
      target = 0.45;
    } else {
      dancer.setPose(menuPose(wall));
      target = 0.35;
    }
    energy += (target - energy) * (1 - Math.exp(-dt * 2.5));

    dancer.update(wall, dt, { levels, energy });
    stage.update(wall, dt, { beat, levels, energy, section });
    stage.renderer.info.reset();
    stage.render();

    // ---- HUD ----
    if (state === 'play' || state === 'pause' || state === 'countdown') {
      hud.updateTimeline(beat, moves);
      hud.drawPlayer(demo ? null : video, player);
    } else if (state === 'camera') {
      hud.drawPlayer(video, player);
    }
    if (DEBUG) drawDebug(now, t, beat, section);
    frameErrors = 0;
  } catch (e) {
    // keep the loop alive, but do not flood the console
    if (frameErrors++ < 3) console.error('[game] frame failed', e);
  }
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// test / debug handle
// ---------------------------------------------------------------------------
window.__game = {
  get state() { return state; },
  get judge() { return judge; },
  get demo() { return demo; },
  get beat() { return secToBeat(songTime()); },
  hud, stage, dancer, music, tracker, moves,
  /** Debug: jump to a beat while playing. Moves before it are dropped from the judge. */
  seek(beat) {
    if (state !== 'play' && state !== 'pause') return false;
    const b = Math.max(-2, Math.min(TOTAL_BEATS + 3.5, +beat || 0));
    judge = createJudge(moves.filter((m) => m.beat >= b + 0.5), { getPoseByName: getPose });
    hud.setScore(0, 0, 1);
    rewindTo = null;
    if (state === 'pause') { hud.showScreen('play'); setState('play'); }
    clockStart(beatToSec(b));
    return true;
  },
};

// ---------------------------------------------------------------------------
// boot: render the track, then show the title
// ---------------------------------------------------------------------------
(async () => {
  try {
    await music.init((p, label) => hud.setLoading(0.04 + 0.96 * p, label || '음악을 만드는 중'));
  } catch (e) {
    console.warn('[game] audio engine unavailable, running silent', e);
  }
  hud.setLoading(1, '준비 완료');
  goTitle();
})();
