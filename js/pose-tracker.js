// STARFALL — webcam pose tracking (MediaPipe PoseLandmarker -> contract pose).
//
// Mirror convention (CONTRACT.md): limb names are SCREEN-side names and the player sees
// themself mirrored. MediaPipe landmark 11 is the person's anatomical LEFT shoulder; in the raw
// (un-mirrored) camera image a person facing the camera has their left side at large x. After
// mirroring x -> 1 - x that side sits on the screen-left, which is our `l*` side. So:
//   MediaPipe LEFT_* landmarks  -> l* segments,  MediaPipe RIGHT_* landmarks -> r* segments,
// and only the x axis is flipped. Image y grows downwards, stage y grows upwards, so y is negated
// for directions. z is ignored (0): one RGB camera cannot measure depth well enough to judge on.
//
// This module touches the DOM only inside the functions of createPoseTracker, so the pure
// helpers (poseFromLandmarks, createOneEuro) import fine in Node.

const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// MediaPipe pose landmark indices.
const LM = Object.freeze({
  NOSE: 0, L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
});
const LANDMARK_COUNT = 33;

/** Bones of the mirrored landmark set, for the HUD skeleton overlay. */
export const SKELETON_EDGES = Object.freeze([
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
]);

/** Tuning knobs; override any of them through createPoseTracker(videoEl, options). */
export const TRACKER_DEFAULTS = Object.freeze({
  // One-Euro filter on landmark positions (normalised image units, seconds).
  minCutoff: 1.7,   // Hz. Lower = steadier when still, more lag on slow moves.
  beta: 6.0,        // Speed coefficient. Higher = less lag on fast moves, more jitter.
  dCutoff: 1.0,     // Hz, derivative low-pass.
  visibilityTau: 0.08, // s, smoothing of per-landmark visibility.
  // Detector thresholds.
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  // A result older than this (ms) is treated as "no player".
  staleMs: 400,
  // Consecutive detector failures before the GPU delegate is swapped for CPU.
  maxErrors: 3,
  // Camera request.
  width: 640,
  height: 480,
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };

/** One-Euro filter bank over `n` scalar channels. */
export function createOneEuro(n, { minCutoff = 1.7, beta = 6, dCutoff = 1 } = {}) {
  const x = new Float64Array(n);
  const dx = new Float64Array(n);
  let primed = false;
  const alpha = (cutoff, dt) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  return {
    reset() { primed = false; },
    /** Filters `values` (length n) in place given the seconds since the previous call. */
    apply(values, dt) {
      if (!primed || !(dt > 0) || dt > 0.5) {
        for (let i = 0; i < n; i++) { x[i] = values[i]; dx[i] = 0; }
        primed = true;
        return values;
      }
      const ad = alpha(dCutoff, dt);
      for (let i = 0; i < n; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) { values[i] = x[i]; continue; }
        const rawD = (v - x[i]) / dt;
        dx[i] += (rawD - dx[i]) * ad;
        const a = alpha(minCutoff + beta * Math.abs(dx[i]), dt);
        x[i] += (v - x[i]) * a;
        values[i] = x[i];
      }
      return values;
    },
  };
}

// 1 inside the frame, fading to 0 a little outside it (MediaPipe extrapolates off-screen joints).
function inFrame(p) {
  const ox = p.x < 0 ? -p.x : p.x > 1 ? p.x - 1 : 0;
  const oy = p.y < 0 ? -p.y : p.y > 1 ? p.y - 1 : 0;
  const o = ox > oy ? ox : oy;
  return 1 - smooth01((o - 0.02) / 0.1);
}

/**
 * Convert MIRRORED, normalised image landmarks into the contract pose.
 * @param {Array<{x:number,y:number,v:number}>} lm  33 landmarks, x already mirrored (0 = screen
 *        left), y image-down (0 = top), v = visibility 0..1
 * @param {number} aspect  video width / height, so that directions are true on-screen angles
 * @returns {{pose:object, confidence:object, bodyVisible:number}}
 */
export function poseFromLandmarks(lm, aspect = 4 / 3) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
  const P = (i) => lm[i];
  const vis = (i) => clamp01(lm[i].v) * inFrame(lm[i]);
  const mid = (i, j) => ({ x: (lm[i].x + lm[j].x) / 2, y: (lm[i].y + lm[j].y) / 2 });

  const shoulderMid = mid(LM.L_SHOULDER, LM.R_SHOULDER);
  const hipMid = mid(LM.L_HIP, LM.R_HIP);
  const earMid = mid(LM.L_EAR, LM.R_EAR);
  const nose = P(LM.NOSE);
  const headPt = { x: (earMid.x + nose.x) / 2, y: (earMid.y + nose.y) / 2 };

  // Body scale in aspect-corrected units: torso length, or shoulder width when hips are unseen.
  const torso = Math.hypot((shoulderMid.x - hipMid.x) * a, shoulderMid.y - hipMid.y);
  const shoulderW = Math.hypot((lm[LM.L_SHOULDER].x - lm[LM.R_SHOULDER].x) * a,
    lm[LM.L_SHOULDER].y - lm[LM.R_SHOULDER].y);
  const scale = Math.max(torso, shoulderW * 1.3, 1e-4);

  const pose = { hipX: 0, yaw: 0 };
  const confidence = {};

  // from -> to in image space; conf = weakest landmark, reduced when the segment is so
  // foreshortened (pointing at the camera) that its 2D direction is mostly noise.
  const seg = (name, from, to, conf, fallback) => {
    const dx = (to.x - from.x) * a;
    const dy = -(to.y - from.y);
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) {
      pose[name] = fallback;
      confidence[name] = 0;
      return;
    }
    pose[name] = [dx / len, dy / len, 0];
    confidence[name] = clamp01(conf * smooth01((len / scale - 0.06) / 0.14));
  };

  const vLS = vis(LM.L_SHOULDER), vRS = vis(LM.R_SHOULDER);
  const vLE = vis(LM.L_ELBOW), vRE = vis(LM.R_ELBOW);
  const vLW = vis(LM.L_WRIST), vRW = vis(LM.R_WRIST);
  const vLH = vis(LM.L_HIP), vRH = vis(LM.R_HIP);
  const vLK = vis(LM.L_KNEE), vRK = vis(LM.R_KNEE);
  const vLA = vis(LM.L_ANKLE), vRA = vis(LM.R_ANKLE);
  const vHead = Math.max(vis(LM.NOSE), Math.min(vis(LM.L_EAR), vis(LM.R_EAR)));

  seg('spine', hipMid, shoulderMid, Math.min(vLS, vRS, vLH, vRH), [0, 1, 0]);
  seg('head', shoulderMid, headPt, Math.min(vLS, vRS, vHead), [0, 1, 0]);
  seg('lUpperArm', P(LM.L_SHOULDER), P(LM.L_ELBOW), Math.min(vLS, vLE), [0, -1, 0]);
  seg('lForearm', P(LM.L_ELBOW), P(LM.L_WRIST), Math.min(vLE, vLW), [0, -1, 0]);
  seg('rUpperArm', P(LM.R_SHOULDER), P(LM.R_ELBOW), Math.min(vRS, vRE), [0, -1, 0]);
  seg('rForearm', P(LM.R_ELBOW), P(LM.R_WRIST), Math.min(vRE, vRW), [0, -1, 0]);
  seg('lThigh', P(LM.L_HIP), P(LM.L_KNEE), Math.min(vLH, vLK), [0, -1, 0]);
  seg('lShin', P(LM.L_KNEE), P(LM.L_ANKLE), Math.min(vLK, vLA), [0, -1, 0]);
  seg('rThigh', P(LM.R_HIP), P(LM.R_KNEE), Math.min(vRH, vRK), [0, -1, 0]);
  seg('rShin', P(LM.R_KNEE), P(LM.R_ANKLE), Math.min(vRK, vRA), [0, -1, 0]);

  // How much of the body is usable: torso and arms matter most, feet least.
  const bodyVisible = clamp01(
    ((vLS + vRS) * 2 + (vLH + vRH) * 2 + (vLE + vRE) * 1.5 + (vLW + vRW) * 1.5
      + (vLK + vRK) * 1 + (vLA + vRA) * 0.5) / 17);

  return { pose, confidence, bodyVisible };
}

function taggedError(kind, message, cause) {
  const err = new Error(message);
  err.name = 'CameraError';
  err.kind = kind;
  if (cause) err.cause = cause;
  return err;
}

function classifyCameraError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return taggedError('denied', '카메라 권한이 거부되었습니다.', e);
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return taggedError('nodevice', '사용할 수 있는 카메라를 찾지 못했습니다.', e);
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return taggedError('busy', '다른 앱이 카메라를 사용 중입니다.', e);
  }
  return taggedError('unknown', '카메라를 시작하지 못했습니다.', e);
}

/**
 * @param {HTMLVideoElement} videoEl
 * @param {Partial<typeof TRACKER_DEFAULTS>} [options]
 */
export function createPoseTracker(videoEl, options = {}) {
  const cfg = { ...TRACKER_DEFAULTS, ...options };

  let vision = null;        // imported module
  let fileset = null;       // wasm fileset
  let modelBuffer = null;   // Uint8Array of the .task file (reused for the CPU fallback)
  let landmarker = null;
  let delegate = 'none';
  let initPromise = null;
  let rebuilding = false;
  let errorCount = 0;

  let stream = null;
  let cameraPromise = null;

  let lastVideoTime = -1;
  let lastTs = 0;           // last timestamp handed to MediaPipe (must strictly increase)
  let lastDetectMs = NaN;   // nowMs of the previous successful detection (filter dt)
  let lastNow = 0;          // most recent nowMs seen by update()
  let result = null;
  let inferMs = 0;
  let fps = 0;

  const filter = createOneEuro(LANDMARK_COUNT * 2, cfg);
  const coords = new Float64Array(LANDMARK_COUNT * 2);
  const visSmooth = new Float64Array(LANDMARK_COUNT);
  let visPrimed = false;

  const report = (cb, p, text) => {
    if (typeof cb !== 'function') return;
    try { cb(clamp01(p), text); } catch { /* a broken progress callback must not break loading */ }
  };

  async function fetchModel(onProgress) {
    const res = await fetch(MODEL_URL, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total) {
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress(1);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(Math.min(1, received / total));
    }
    const buf = new Uint8Array(received);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return buf;
  }

  async function buildLandmarker(preferred) {
    const make = (which) => vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        ...(modelBuffer ? { modelAssetBuffer: modelBuffer } : { modelAssetPath: MODEL_URL }),
        delegate: which,
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: cfg.minPoseDetectionConfidence,
      minPosePresenceConfidence: cfg.minPosePresenceConfidence,
      minTrackingConfidence: cfg.minTrackingConfidence,
      outputSegmentationMasks: false,
    });
    if (preferred === 'GPU') {
      try {
        const lmk = await make('GPU');
        delegate = 'GPU';
        return lmk;
      } catch (e) {
        console.warn('[pose-tracker] GPU delegate unavailable, falling back to CPU.', e);
      }
    }
    const lmk = await make('CPU');
    delegate = 'CPU';
    return lmk;
  }

  function init(onProgress) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      report(onProgress, 0.02, '동작 인식 엔진 불러오는 중');
      vision = await import(/* @vite-ignore */ VISION_URL);
      report(onProgress, 0.15, '동작 인식 엔진 준비 중');
      fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
      report(onProgress, 0.3, '포즈 모델 내려받는 중');
      try {
        modelBuffer = await fetchModel((p) => report(onProgress, 0.3 + 0.55 * p, '포즈 모델 내려받는 중'));
      } catch (e) {
        // Let MediaPipe fetch it by URL instead (no byte-level progress).
        console.warn('[pose-tracker] manual model download failed, delegating to MediaPipe.', e);
        modelBuffer = null;
      }
      report(onProgress, 0.88, '포즈 모델 시작하는 중');
      landmarker = await buildLandmarker('GPU');
      report(onProgress, 1, '준비 완료');
    })().catch((e) => {
      initPromise = null; // allow a retry
      landmarker = null;
      throw e;
    });
    return initPromise;
  }

  function resetTracking() {
    filter.reset();
    visPrimed = false;
    lastDetectMs = NaN;
    result = null;
  }

  function releaseStream() {
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
    }
    stream = null;
    if (videoEl) {
      try { videoEl.pause(); } catch { /* not playing */ }
      try { videoEl.srcObject = null; } catch { /* element gone */ }
    }
  }

  function startCamera() {
    if (stream && stream.active) return Promise.resolve();
    if (cameraPromise) return cameraPromise;
    cameraPromise = (async () => {
      const secure = typeof window === 'undefined' || window.isSecureContext !== false;
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
      if (!md || typeof md.getUserMedia !== 'function') {
        throw secure
          ? taggedError('nodevice', '이 브라우저에서는 카메라를 사용할 수 없습니다.')
          : taggedError('insecure', '카메라는 https 또는 localhost 에서만 사용할 수 있습니다.');
      }
      if (!secure) throw taggedError('insecure', '카메라는 https 또는 localhost 에서만 사용할 수 있습니다.');

      let s;
      try {
        s = await md.getUserMedia({
          audio: false,
          video: {
            width: { ideal: cfg.width },
            height: { ideal: cfg.height },
            facingMode: 'user',
            frameRate: { ideal: 30 },
          },
        });
      } catch (e) {
        if (e && e.name === 'OverconstrainedError') {
          try {
            s = await md.getUserMedia({ audio: false, video: true });
          } catch (e2) {
            throw classifyCameraError(e2);
          }
        } else {
          throw classifyCameraError(e);
        }
      }

      stream = s;
      for (const track of s.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (stream === s) { releaseStream(); resetTracking(); }
        });
      }

      try {
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.setAttribute('playsinline', '');
        videoEl.srcObject = s;
        if (videoEl.readyState < 1) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('camera metadata timeout')); }, 8000);
            const onMeta = () => { cleanup(); resolve(); };
            const onErr = () => { cleanup(); reject(new Error('video element error')); };
            function cleanup() {
              clearTimeout(timer);
              videoEl.removeEventListener('loadedmetadata', onMeta);
              videoEl.removeEventListener('error', onErr);
            }
            videoEl.addEventListener('loadedmetadata', onMeta);
            videoEl.addEventListener('error', onErr);
          });
        }
        await videoEl.play();
      } catch (e) {
        releaseStream();
        throw e && e.kind ? e : classifyCameraError(e);
      }
      lastVideoTime = -1;
      resetTracking();
    })().finally(() => { cameraPromise = null; });
    return cameraPromise;
  }

  /** Stops the camera. The loaded model is kept so a retry starts instantly. */
  function stop() {
    releaseStream();
    resetTracking();
    lastVideoTime = -1;
  }

  /**
   * Some browsers (Safari / iOS) pause a MediaStream <video> when the page goes to the
   * background and never resume it. Call after the page is visible again / on game resume.
   */
  function resumeVideo() {
    if (!stream || stream.active === false || !videoEl || !videoEl.paused) return;
    try {
      const p = videoEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* nothing to resume */ }
  }

  function swapToCpu() {
    if (rebuilding || delegate !== 'GPU' || !vision || !fileset) return;
    rebuilding = true;
    const old = landmarker;
    landmarker = null;
    console.warn('[pose-tracker] repeated detector errors on GPU, rebuilding on CPU.');
    buildLandmarker('CPU')
      .then((lmk) => { landmarker = lmk; errorCount = 0; })
      .catch((e) => { console.error('[pose-tracker] CPU fallback failed.', e); })
      .finally(() => {
        rebuilding = false;
        try { if (old && typeof old.close === 'function') old.close(); } catch { /* ignore */ }
      });
  }

  function ingest(raw, nowMs) {
    // Smooth in raw image space, then mirror.
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const p = raw[i];
      coords[i * 2] = p ? p.x : NaN;
      coords[i * 2 + 1] = p ? p.y : NaN;
    }
    const dt = (nowMs - lastDetectMs) / 1000;
    if (Number.isFinite(dt) && dt > 0) fps += ((1 / dt) - fps) * 0.1;
    filter.apply(coords, dt);

    const va = visPrimed && dt > 0 && dt < 0.5 ? 1 - Math.exp(-dt / cfg.visibilityTau) : 1;
    const landmarks = new Array(LANDMARK_COUNT);
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const p = raw[i];
      const v = p && Number.isFinite(p.visibility) ? p.visibility : (p ? 1 : 0);
      visSmooth[i] += (v - visSmooth[i]) * va;
      const x = coords[i * 2];
      const y = coords[i * 2 + 1];
      landmarks[i] = {
        x: Number.isFinite(x) ? 1 - x : 0.5, // mirrored: 0 = screen left
        y: Number.isFinite(y) ? y : 0.5,     // image-down: 0 = top
        v: Number.isFinite(x) && Number.isFinite(y) ? clamp01(visSmooth[i]) : 0,
      };
    }
    visPrimed = true;
    lastDetectMs = nowMs;

    const aspect = videoEl.videoWidth > 0 && videoEl.videoHeight > 0
      ? videoEl.videoWidth / videoEl.videoHeight : cfg.width / cfg.height;
    const { pose, confidence, bodyVisible } = poseFromLandmarks(landmarks, aspect);
    result = { pose, confidence, landmarks, bodyVisible, t: nowMs, aspect };
  }

  /** Call once per animation frame. Never throws. */
  function update(nowMs) {
    try {
      const now = Number.isFinite(nowMs) ? nowMs
        : (typeof performance !== 'undefined' ? performance.now() : Date.now());
      lastNow = now;
      if (!landmarker || rebuilding || !stream || !videoEl) return;
      if (videoEl.readyState < 2 || videoEl.paused || videoEl.ended) return;
      if (!(videoEl.videoWidth > 0)) return;
      const vt = videoEl.currentTime;
      if (vt === lastVideoTime) return; // same camera frame as last time
      lastVideoTime = vt;

      const ts = Math.max(lastTs + 1, Math.round(now));
      lastTs = ts;

      let out;
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      try {
        out = landmarker.detectForVideo(videoEl, ts);
        errorCount = 0;
      } catch (e) {
        errorCount++;
        if (errorCount === 1) console.warn('[pose-tracker] detection failed.', e);
        if (errorCount >= cfg.maxErrors) swapToCpu();
        return;
      }
      if (typeof performance !== 'undefined') inferMs += ((performance.now() - t0) - inferMs) * 0.1;

      const raw = out && out.landmarks && out.landmarks[0];
      if (raw && raw.length >= LANDMARK_COUNT) {
        ingest(raw, now);
      } else if (result && now - result.t > cfg.staleMs) {
        resetTracking();
      }
    } catch (e) {
      // The game loop must survive anything that goes wrong in here.
      console.warn('[pose-tracker] update error.', e);
    }
  }

  /** Latest player pose, or null when nobody has been seen recently. */
  function getPlayerPose() {
    if (!result) return null;
    if (lastNow - result.t > cfg.staleMs) return null;
    return result;
  }

  /** Stops the camera and frees the model (the tracker can be init()-ed again). */
  function dispose() {
    stop();
    try { if (landmarker && typeof landmarker.close === 'function') landmarker.close(); } catch { /* ignore */ }
    landmarker = null;
    initPromise = null;
    delegate = 'none';
  }

  return {
    init,
    startCamera,
    stop,
    resumeVideo,
    update,
    getPlayerPose,
    dispose,
    get isReady() { return !!landmarker && !rebuilding; },
    get cameraActive() { return !!stream && stream.active !== false; },
    get delegate() { return delegate; },
    get debug() { return { delegate, fps, inferMs, errorCount }; },
  };
}
