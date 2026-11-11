// STARFALL — game loop and state machine (v2: one or two players).
// loading -> title -> camera -> countdown -> play (<-> pause) -> results
//
//   ?demo=1      never touch the camera: simulated players (js/demo-player.js) feed the judges
//   ?players=2   with ?demo=1: run the demo with two players whichever button is pressed
//   ?debug=1     fps + judge overlay, and window.__game.seek(beat)
//   ?model=full  a more accurate (and slower) pose model for the camera
//   ?telemetry=1 (see js/telemetry.js) post numbers about the run to the local dev server

import { createStage, RATING_COLORS } from './stage.js';
import { createDancer } from './dancer.js';
import { createMusic } from './audio.js';
import { createHud } from './hud.js';
import { createJudge, createLiveMatcher } from './scoring.js';
import { createPoseTracker, completePose } from './pose-tracker.js';
import { createDemoPlayer } from './demo-player.js';
import { MOVES, HERO_POSES, samplePose, getPose, lerpPose } from './choreo.js';
import {
  TOTAL_BEATS, SEC_PER_BEAT, SONG_DURATION, beatToSec, secToBeat, sectionAtBeat,
} from './song.js';

const params = new URLSearchParams(location.search);
const DEMO_ONLY = window.STARFALL_DEMO_ONLY === true;
const FORCE_DEMO = DEMO_ONLY || params.get('demo') === '1';
const FORCE_PLAYERS = params.get('players') === '2' ? 2 : 0;
const DEBUG = params.get('debug') === '1';

const MAX_PLAYERS = 2;
const PLAYER_COLORS = [0x19e3d2, 0xff5a6e];

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
// ?model=full (or heavy) swaps in a more accurate, slower pose model; the default is the light one
const tracker = createPoseTracker(video, { model: params.get('model') || 'lite' });

// Scored moves with their pose resolved once, so the HUD never has to look poses up.
const moves = MOVES.map((m) => ({ ...m, poseData: getPose(m.pose) }));
const newJudge = (list = moves) => createJudge(list, { getPoseByName: getPose });

// One record per player slot. Slot 0 is P1 (screen-left in a two-player game), slot 1 is P2.
const players = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  const avatar = createDancer({
    variant: 'player', color: PLAYER_COLORS[i], label: i ? 'P2' : 'P1', presence: 0,
  });
  stage.add(avatar.group);
  players.push({
    index: i,
    judge: newJudge(),
    live: createLiveMatcher(),
    // P1 follows well with the whole body in view; P2 is a little looser and plays upper-body
    // only, so a demo exercises both the full-body and the legs-out-of-frame paths.
    demo: createDemoPlayer(i === 0 ? { skill: 0.9 } : { skill: 0.72, legsUnseen: true, side: 1 }),
    avatar,
    avatarPose: {},      // completePose() output, reused every frame
    sync: 0,
    milestone: 0,        // highest combo milestone already celebrated in the current streak
    lastRating: null,
  });
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let state = 'loading';
let demo = FORCE_DEMO;
let playerCount = 1;
let runId = 0;             // bumps whenever a run starts or is abandoned (cancels stale callbacks)
let cameraWanted = false;  // the players passed the camera check but the model is still loading
let energy = 0.3;
let resultStats = null;    // one stats object, or [stats0, stats1] in a two-player game
let resultStars = 0;
let resultsAt = 0;
let handoffTimer = 0;
let demoSeed = 1;
let lastSongT = 0;        // song time of the last rendered play frame
let rewindTo = null;      // set when frames stalled while the music kept running
let countdownStalled = false; // the tab was hidden while the countdown was running
const results = [null, null]; // this frame's tracker (or demo) result per player slot
const events = [];            // recent judged events, drained by js/telemetry.js

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

// ---------------------------------------------------------------------------
// players
// ---------------------------------------------------------------------------
/** Choose a one- or two-player game: camera framing, avatar spots, tracker and HUD follow. */
function setPlayerCount(n) {
  playerCount = n === 2 ? 2 : 1;
  stage.setPlayers(playerCount);
  const spots = stage.getPlayerSpots(playerCount);
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const P = players[i];
    const spot = spots[i];
    if (spot) {
      P.avatar.group.position.set(spot.x, 0, spot.z);
      P.avatar.group.scale.setScalar(spot.scale);
    } else {
      P.avatar.setPresence(0, true);
    }
  }
  labelAvatars();
  tracker.setMaxPlayers(playerCount);
}

/**
 * Avatar tags. Alone on stage the tag says "me"; with two players it says who is who. In a demo
 * nobody is being filmed: the tag says so, because a figure dancing next to the coach is
 * otherwise taken for one's own.
 */
function labelAvatars() {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const a = players[i].avatar;
    if (!a.setLabel) continue;
    if (demo) a.setLabel(playerCount === 2 ? (i ? 'DEMO 2' : 'DEMO 1') : 'DEMO');
    else a.setLabel(playerCount === 2 ? (i ? 'P2' : 'P1') : '나');
  }
}

function resetPlayers() {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const P = players[i];
    P.judge = newJudge();
    P.live.reset();
    P.demo.reset(demoSeed * 2 + i);
    P.sync = 0;
    P.milestone = 0;
    P.lastRating = null;
  }
  demoSeed++;
  events.length = 0;
}

function hideAvatars(immediate) {
  for (let i = 0; i < MAX_PLAYERS; i++) players[i].avatar.setPresence(0, immediate === true);
}

// 5, then every 10: the streaks worth a fanfare.
const isMilestone = (combo) => combo === 5 || (combo >= 10 && combo % 10 === 0);

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
  hideAvatars();
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
  resetPlayers();
  labelAvatars(); // `demo` is settled by now
  rewindTo = null;
  lastSongT = 0;
  resultStats = null;
  stage.setMode('play');
  dancer.setExpression('smile');
  // State first: showScreen('countdown') emits the first countdownTick synchronously.
  setState('countdown');
  // The HUD only resets its own run state when entering from outside a run (pause -> retry
  // stays "inside"), so do it explicitly as well.
  hud.showScreen('countdown', { players: playerCount });
  for (let i = 0; i < playerCount; i++) hud.setScore(0, 0, 1, i);
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
    if (id === runId && state === 'play' && hud.screen === 'countdown') {
      hud.showScreen('play', { players: playerCount });
    }
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
  if (hud.screen !== 'play') hud.showScreen('play', { players: playerCount });
  setState('play');
}

function finishRun() {
  if (state !== 'play' && state !== 'pause') return;
  runId++;
  clearTimeout(handoffTimer);
  fallbackClock.running = false;
  const all = [];
  resultStars = 0;
  for (let i = 0; i < playerCount; i++) {
    const P = players[i];
    handleEvents(i, P.judge.update(SONG_DURATION + 10), true); // flush anything still pending
    const s = P.judge.stats();
    all.push(s);
    if (s.stars > resultStars) resultStars = s.stars;
  }
  resultStats = playerCount === 2 ? all : all[0];
  resultsAt = performance.now();
  tracker.stop();
  hideAvatars();
  stage.setMode('results');
  dancer.setExpression(resultStars >= 2 ? 'smile' : 'neutral');
  hud.showResults(resultStats);
  setState('results');
}

async function startCameraPath() {
  if (FORCE_DEMO) { demo = true; startCountdown(); return; }
  demo = false;
  const id = ++runId;
  cameraWanted = false;
  clockStop();
  hideAvatars();
  stage.setMode('menu');
  hud.showScreen('camera', { players: playerCount });
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
  hideAvatars();
  stage.setMode('menu');
  setState('camera');
  hud.setCameraError('nodevice');
}

// ---------------------------------------------------------------------------
// HUD events
// ---------------------------------------------------------------------------
const wantedPlayers = (e) => (FORCE_PLAYERS || (e && e.players === 2 ? 2 : 1));

hud.on('start', (e) => {
  if (state !== 'title' && state !== 'camera') return;
  music.playSfx('ui');
  setPlayerCount(DEMO_ONLY ? 1 : wantedPlayers(e));
  if (DEMO_ONLY) { runId++; demo = true; startCountdown(); return; }
  startCameraPath();
});
hud.on('startDemo', (e) => {
  if (state !== 'title' && state !== 'camera') return;
  music.playSfx('ui');
  runId++;
  tracker.stop();
  setPlayerCount(DEMO_ONLY ? 1 : wantedPlayers(e));
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

function onResize() {
  stage.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
onResize();

// ---------------------------------------------------------------------------
// judged moves -> feedback
// ---------------------------------------------------------------------------
function handleEvents(i, list, silent) {
  if (!list || !list.length) return;
  const P = players[i];
  for (const ev of list) {
    P.lastRating = ev;
    if (events.length < 400) {
      events.push({ player: i, id: ev.move.id, pose: ev.move.pose, beat: ev.move.beat, rating: ev.rating, score: ev.score, points: ev.points });
    }
    if (silent) continue; // the run is over: count it, do not celebrate it
    const big = ev.gold && (ev.rating === 'perfect' || ev.rating === 'super');
    const kind = big ? 'gold' : ev.rating;
    hud.showRating(ev.rating, { gold: ev.gold, points: ev.points, player: i, combo: ev.combo });
    stage.pulse(kind, { player: i });
    const flash = RATING_COLORS[kind];
    if (flash !== undefined) P.avatar.flash(flash, ev.rating === 'miss' ? 0.4 : 1);
    if (playerCount === 1 && ev.rating !== 'miss' && ev.rating !== 'ok') dancer.flash(flash);
    music.playSfx(kind, { player: playerCount === 2 ? i : undefined });
  }
  const s = P.judge.stats();
  if (!silent) hud.setScore(s.score, s.combo, s.multiplier, i);
  if (s.combo < P.milestone) P.milestone = 0; // the streak broke: milestones can be earned again
  if (!silent && s.combo > P.milestone && isMilestone(s.combo)) {
    P.milestone = s.combo;
    hud.showCombo(i, s.combo);
    stage.pulse('combo', { player: i, combo: s.combo });
    music.playSfx('combo', { player: playerCount === 2 ? i : undefined });
  }
}

// ---------------------------------------------------------------------------
// debug overlay
// ---------------------------------------------------------------------------
let debugEl = null;
let fps = 60;
let debugAt = 0;
if (DEBUG) {
  debugEl = document.createElement('pre');
  debugEl.id = 'debug';
  debugEl.style.cssText = 'position:fixed;left:8px;top:34%;z-index:50;margin:0;padding:8px 10px;'
    + 'font:11px/1.35 ui-monospace,Menlo,monospace;color:#c8fff8;background:rgba(6,3,20,.72);'
    + 'border:1px solid rgba(25,227,210,.35);border-radius:6px;pointer-events:none;white-space:pre;max-width:46vw';
  document.body.appendChild(debugEl);
}

function drawDebug(now, t, beat, section) {
  if (!debugEl || now - debugAt < 120) return;
  debugAt = now;
  const info = stage.renderer.info;
  const lines = [
    `fps ${fps.toFixed(0)}  calls ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k  pr ${stage.renderer.getPixelRatio().toFixed(2)}  quality ${(quality.scale * 100).toFixed(0)}%`,
    `state ${state}${demo ? ' (demo)' : ''}  players ${playerCount}  hud ${hud.screen}  stage ${stage.mode}`,
    `t ${t.toFixed(2)}s  beat ${beat.toFixed(2)}  ${section.name}  energy ${energy.toFixed(2)}`,
  ];
  for (let i = 0; i < playerCount; i++) {
    const P = players[i];
    const s = P.judge.stats();
    const r = results[i];
    lines.push(`P${i + 1} ${s.score}/${s.maxScore}  combo ${s.combo} x${s.multiplier}  judged ${s.judged}/${s.total}  sync ${(P.sync * 100).toFixed(0)}%`
      + `  seen ${r ? (r.upperVisible !== undefined ? r.upperVisible : r.bodyVisible).toFixed(2) : '-'}`);
    lines.push(`   P ${s.counts.perfect} S ${s.counts.super} G ${s.counts.good} O ${s.counts.ok} M ${s.counts.miss}  acc ${(s.accuracy * 100).toFixed(0)}%`);
    if (P.lastRating) {
      const ev = P.lastRating;
      lines.push(`   last ${ev.move.id} ${ev.move.pose} @${ev.move.beat} -> ${ev.rating} ${ev.score.toFixed(2)} (+${ev.points})`);
    }
    const d = P.judge.debug(t);
    for (const o of d.open) {
      lines.push(`   open ${o.id} ${o.pose} dt ${(t - o.time).toFixed(2)} best ${o.best.toFixed(2)} n ${o.validSamples}/${o.samples}`);
    }
  }
  if (!demo) {
    const td = tracker.debug;
    lines.push(`tracker ${td.model} ${td.delegate} ${td.fps.toFixed(0)}fps ${td.inferMs.toFixed(1)}ms  depth ${results[0] && results[0].has3d ? 'on' : 'off'}`);
  }
  const md = music.isReady ? music.debug : null;
  if (md) lines.push(`audio ${md.state} latency ${(md.latency * 1000).toFixed(0)}ms ctx ${md.context.state}`);
  debugEl.textContent = lines.join('\n');
}

// ---------------------------------------------------------------------------
// adaptive resolution
// ---------------------------------------------------------------------------
// The stage is fill-rate bound: on a high-density display the pixel budget, not the scene, decides
// the frame rate. When frames stay slow the render resolution steps down (never the game speed);
// it only steps back up after a long comfortable stretch, and not past a level that proved slow.
const quality = {
  base: stage.tuning.maxPixels, msaa: stage.tuning.msaaBelowPixelRatio,
  scale: 1, min: 0.4, ceiling: 1,
  slowFor: 0, fastFor: 0, cooldown: 2,
  trial: null,   // { from, fps, wait }: a step down that still has to prove it helped
  locked: 0,     // seconds during which the resolution is left alone
};
function applyQuality() {
  stage.tuning.maxPixels = Math.round(quality.base * quality.scale);
  // multisampling is for full-resolution rendering only: once the budget is cut it costs more
  // than the pixels it would save
  stage.tuning.msaaBelowPixelRatio = quality.scale < 1 ? 0 : quality.msaa;
  stage.resize(window.innerWidth, window.innerHeight);
  quality.slowFor = 0; quality.fastFor = 0; quality.cooldown = 1.5;
}
function adaptQuality(dt) {
  // Only a run is representative: menus and the results screen have their own (CSS-heavy) load
  // and no need for a locked frame rate.
  if (document.hidden || state !== 'play') return;
  if (quality.cooldown > 0) { quality.cooldown -= dt; return; }
  if (quality.locked > 0) { quality.locked -= dt; return; }
  // Did the last step down buy anything? If not, the slowness is not about pixels (a busy
  // machine, a throttled window): put the resolution back and stop fiddling for a while.
  if (quality.trial) {
    quality.trial.wait -= dt;
    if (quality.trial.wait > 0) return;
    const helped = fps > quality.trial.fps * 1.08 || fps >= 50;
    if (!helped) {
      quality.scale = quality.trial.from;
      quality.trial = null;
      quality.locked = 45;
      applyQuality();
      return;
    }
    quality.trial = null;
  }
  quality.slowFor = fps < 48 ? quality.slowFor + dt : 0;
  quality.fastFor = fps > 57 ? quality.fastFor + dt : 0;
  if (quality.slowFor > 1.5 && quality.scale > quality.min) {
    quality.trial = { from: quality.scale, fps, wait: 1.5 };
    quality.ceiling = quality.scale * 0.92; // this level is too much for this machine
    quality.scale = Math.max(quality.min, quality.scale * (fps < 36 ? 0.62 : 0.8));
    applyQuality();
  } else if (quality.fastFor > 20 && quality.scale < quality.ceiling) {
    quality.scale = Math.min(quality.ceiling, quality.scale * 1.12);
    applyQuality();
  }
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------
let lastNow = performance.now();
let wall = 0;
let frameErrors = 0;
const resultPoseCache = {};

function menuPose(wallSec) {
  // a seamless 4-beat groove taken from the intro
  const b = (wallSec / SEC_PER_BEAT) * 0.5;
  return samplePose(4 + (b % 4));
}

/** The relaxed standing groove, in time with the song: what unseen limbs of an avatar fall back to. */
function idleGroove(beat) {
  return samplePose(-8 + (((beat % 4) + 4) % 4));
}

function resultPose(now) {
  const name = resultStars >= 4 ? HERO_POSES.win : resultStars >= 2 ? HERO_POSES.good : HERO_POSES.low;
  const hero = resultPoseCache[name] || (resultPoseCache[name] = getPose(name));
  // strike the pose, hold it, then settle into the groove
  const since = (now - resultsAt) / 1000;
  const k = since < 3.2 ? 1 : Math.max(0, 1 - (since - 3.2) / 1.2);
  if (k >= 1) return hero;
  const groove = menuPose(wall);
  return k <= 0 ? groove : lerpPose(groove, hero, k * k * (3 - 2 * k));
}

const seenAmount = (r) => (!r ? 0 : (r.upperVisible !== undefined ? r.upperVisible : r.bodyVisible) || 0);

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
  adaptQuality(dt);

  try {
    const inRun = state === 'play' || state === 'pause';
    const onStage = inRun || state === 'countdown';
    const t = !inRun ? 0 : (state === 'pause' && rewindTo != null ? rewindTo : songTime());
    const beat = inRun ? secToBeat(t) : secToBeat(0);
    const section = sectionAtBeat(Math.max(0, beat));
    const levels = music.isReady ? music.getLevels() : { bass: 0, mid: 0, high: 0, kick: 0 };

    // ---- player input ----
    results[0] = null; results[1] = null;
    if (state === 'camera' || (onStage && !demo)) {
      tracker.update(now);
      const tracked = tracker.getPlayers();
      results[0] = tracked[0];
      results[1] = playerCount === 2 ? tracked[1] : null;
    } else if (demo && onStage) {
      for (let i = 0; i < playerCount; i++) results[i] = players[i].demo.sample(t);
    }

    // ---- coach ----
    let target = 0.3;
    let coach;
    if (inRun) {
      coach = samplePose(beat);
      target = section.intensity;
    } else if (state === 'countdown') {
      coach = samplePose(secToBeat(0));
    } else if (state === 'results') {
      coach = resultPose(now);
      target = 0.45;
    } else {
      coach = menuPose(wall);
      target = 0.35;
    }
    dancer.setPose(coach);
    energy += (target - energy) * (1 - Math.exp(-dt * 2.5));

    // ---- judging ----
    if (!demo && (state === 'play' || state === 'countdown') && !tracker.cameraActive) {
      cameraLost(); // unplugged / permission revoked: do not keep scoring MISS in silence
    }
    if (state === 'play') {
      lastSongT = t;
      for (let i = 0; i < playerCount; i++) {
        const P = players[i];
        P.judge.pushSample(t, results[i]);
        handleEvents(i, P.judge.update(t), false);
        // live read-out: how close is this player to what the coach has been doing just now
        P.live.push(t, coach);
        const m = P.live.match(results[i]);
        P.sync = m.score;
        hud.setSync(i, m.score, m.perSegment);
      }
      hud.setProgress(Math.min(1, Math.max(0, beat / TOTAL_BEATS)));
      hud.setSection(section.name);
      const chorus = section.name === 'chorus1' || section.name === 'chorus2';
      dancer.setExpression(chorus ? 'fierce' : 'smile');
      if (!music.isReady && t >= SONG_DURATION) finishRun();
    }

    // ---- player avatars ----
    const stageNow = state === 'play' || state === 'pause' || state === 'countdown';
    const fallback = stageNow ? idleGroove(beat) : null;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const P = players[i];
      const r = results[i];
      const here = stageNow && i < playerCount && (demo || seenAmount(r) > 0.3 || state === 'pause');
      P.avatar.setPresence(here ? 1 : 0);
      if (here && r && r.pose) {
        completePose(r, fallback, P.avatarPose);
        P.avatar.setPose(P.avatarPose);
      }
      P.avatar.setSync(state === 'play' ? P.sync : 0.35);
      P.avatar.update(wall, dt, { levels });
    }

    dancer.update(wall, dt, { levels, energy });
    stage.update(wall, dt, { beat, levels, energy, section });
    stage.renderer.info.reset();
    stage.render();

    // ---- HUD ----
    if (stageNow) {
      hud.updateTimeline(beat, moves);
      hud.drawPlayer(demo ? null : video, results);
    } else if (state === 'camera') {
      hud.drawPlayer(video, results);
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
  get judge() { return players[0].judge; },
  get demo() { return demo; },
  get beat() { return secToBeat(songTime()); },
  get playerCount() { return playerCount; },
  get results() { return results; },
  get avatars() { return players.map((P) => P.avatar); },
  players, events, quality,
  hud, stage, dancer, music, tracker, moves,
  /** Debug: jump to a beat while playing. Moves before it are dropped from every judge. */
  seek(beat) {
    if (state !== 'play' && state !== 'pause') return false;
    const b = Math.max(-2, Math.min(TOTAL_BEATS + 3.5, +beat || 0));
    const rest = moves.filter((m) => m.beat >= b + 0.5);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const P = players[i];
      P.judge = newJudge(rest);
      P.live.reset();
      P.milestone = 0;
      P.lastRating = null;
      if (i < playerCount) hud.setScore(0, 0, 1, i);
    }
    rewindTo = null;
    if (state === 'pause') { hud.showScreen('play', { players: playerCount }); setState('play'); }
    clockStart(beatToSec(b));
    return true;
  },
};

// ---------------------------------------------------------------------------
// boot: render the track, then show the title
// ---------------------------------------------------------------------------
setPlayerCount(FORCE_PLAYERS || 1);
(async () => {
  try {
    await music.init((p, label) => hud.setLoading(0.04 + 0.96 * p, label || '음악을 만드는 중'));
  } catch (e) {
    console.warn('[game] audio engine unavailable, running silent', e);
  }
  hud.setLoading(1, '준비 완료');
  goTitle();
})();
