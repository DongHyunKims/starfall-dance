// STARFALL — slash/hero.js
// NOVA in STAR SLASH: she stands on the runway just in front of the hit plane with her back to
// the camera, facing the incoming star shards, a blade of red light in each hand. She is the
// player's stand-in: her arms follow the player's hands (the same hands frame the judge reads),
// so a swing in front of the webcam is her swing on stage.
//
// How it works
//   - the dancer rig is posed from direction vectors (see CONTRACT.md), so every frame this
//     module solves a small two-bone IK per arm: the hand goes out toward the player's hand
//     point on the hit plane as far as the arm comfortably reaches, the blade does the rest;
//   - a blade is a small group (beam, glow, grip, star guard) placed on NOVA's wrist after the
//     rig has been solved. It points through the hand point, its tip trails the swing (a blade
//     has weight), and between cuts it comes up into a ready guard instead of hanging;
//   - the body is not a statue: her feet keep time (see "footwork" below: a planted sway in the
//     quiet parts, a step-touch in the verses, out-out-in-in in the chorus), the knees give on
//     every beat, and the torso twists and leans into whichever arm is cutting.
//
// Sides. NOVA is turned around (rotation.y = PI), so the rig's `l` arm (local -x) is on the
// SCREEN-RIGHT: the player's screen-left hand drives the rig's `r` arm, and the other way round.

import * as THREE from 'three';

export const SLASH_HERO_TUNING = {
  z: 0.5, // where she stands: metres in front of the hit plane (toward the camera)
  scale: 0.74, // a little smaller than on the dance stage so the lane stays readable around her
  bladeLength: 0.86, // metres, guard to tip
  bladeRadius: 0.021, // metres, the white-hot core
  bladePower: 1.0,
  reachShare: 0.44, // how much of the way to the hand point the hand itself goes (the blade covers the rest)
  minReach: 0.2, // the hand never comes closer to the shoulder than this (rig units)
  tipLag: 0.42, // how far the tip trails the swing at full speed (1 = 45 degrees)
  restSpeed: 1.1, // play-plane units/s under which a hand counts as resting
  guard: [0.2, 1.08, 0.34], // rig-space grip position of the ready guard (x per side)
  guardDir: [0.34, 0.82, 0.46], // rig-space blade direction of the ready guard (x per side): up, forward, slightly out
  lean: 0.2, // sideways lean toward the hands
  twist: 0.42, // torso twist (rad) into the cutting arm
  footwork: 1.0, // 0 = planted feet, 1 = the full step patterns (scales sway, bounce and step height)
  crouch: 0.05, // how far the hips sit below straight legs (soft knees), rig metres
  cutSink: 0.035, // extra sink into a cut
  beatLead: 0.1, // beats: the feet aim a hair ahead (the rig eases every pose) so the landing reads on the beat
  backLight: 1.9, // she is seen from behind, in her own shadow: ambient light is raised by this factor
};

const BLADE_HEX = 0xff2a3c; // the red of the light blades
const HAND_HEX = { l: 0x19e3d2, r: 0xffc24a }; // the guards keep the hand colours of the shards

const BEAM_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying float vAlong;
void main() {
  vAlong = position.y;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;
// The core: white-hot where it faces the eye, the blade colour toward its silhouette.
const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uPower;
uniform float uTime;
varying vec3 vN;
varying vec3 vView;
varying float vAlong;
void main() {
  float ndv = clamp(abs(dot(normalize(vN + vec3(0.0, 0.0, 1e-6)), normalize(-vView))), 0.0, 1.0);
  float core = pow(ndv, 2.4);
  float hum = 0.94 + 0.06 * sin(uTime * 37.0 + vAlong * 9.0);
  vec3 col = mix(uColor * 1.5, vec3(1.0, 0.9, 0.88) * 2.1, core);
  gl_FragColor = vec4(col * (uPower * hum), 1.0);
}
`;
// The glow around it: additive, strongest along the axis, gone at the silhouette.
const HALO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uPower;
varying vec3 vN;
varying vec3 vView;
varying float vAlong;
void main() {
  float ndv = clamp(abs(dot(normalize(vN + vec3(0.0, 0.0, 1e-6)), normalize(-vView))), 0.0, 1.0);
  float a = pow(ndv, 2.2) * 0.5;
  float ends = smoothstep(0.0, 0.05, vAlong) * (1.0 - smoothstep(0.92, 1.0, vAlong));
  gl_FragColor = vec4(uColor * (a * ends * uPower), 1.0);
}
`;

/** A beam along +y from 0 to 1 with a rounded tip: radius 1 at the base (scaled per mesh). */
function buildBeamGeometry() {
  const pts = [
    new THREE.Vector2(0.0001, 0), new THREE.Vector2(1, 0.012), new THREE.Vector2(0.92, 0.6),
    new THREE.Vector2(0.78, 0.9), new THREE.Vector2(0.5, 0.97), new THREE.Vector2(0.0001, 1),
  ];
  return new THREE.LatheGeometry(pts, 14);
}

/** NOVA's own guard: a small four-point star in the plane across the blade. */
function buildGuardGeometry() {
  const s = new THREE.Shape();
  const R = 0.068, r = 0.024;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 4;
    const rad = i % 2 === 0 ? R : r;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: false });
  g.translate(0, 0, -0.006);
  g.rotateX(Math.PI / 2); // into the x/z plane: across the blade
  return g;
}

/**
 * @param {{ dancer: object, view: object, scene: THREE.Scene }} deps  NOVA (createDancer()), the
 *        slash view (for ppToWorld) and the scene the blades are added to
 */
export function createSlashHero({ dancer, view, scene }) {
  const tuning = { ...SLASH_HERO_TUNING };
  let active = false;
  let clock = 0;

  // rig proportions (rig units; the group scale takes care of the rest)
  const UPPER = 0.265;
  const FORE = 0.235;
  const REACH = UPPER + FORE - 0.012;
  const PP = (view && view.layout && view.layout.pp) || 0.7; // metres per play-plane unit

  // ---- blades -------------------------------------------------------------------------------
  const beamGeo = buildBeamGeometry();
  const guardGeo = buildGuardGeometry();
  const gripGeo = new THREE.CylinderGeometry(0.016, 0.02, 0.17, 10);
  gripGeo.translate(0, -0.095, 0);
  const gripMat = new THREE.MeshBasicMaterial({ color: 0x1a1430 });
  const blades = {};
  for (const side of ['l', 'r']) {
    const uniforms = {
      uColor: { value: new THREE.Color(BLADE_HEX) },
      uPower: { value: tuning.bladePower },
      uTime: { value: 0 },
    };
    const core = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({ uniforms, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG }));
    const halo = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
      uniforms, vertexShader: BEAM_VERT, fragmentShader: HALO_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    halo.renderOrder = 6;
    const grip = new THREE.Mesh(gripGeo, gripMat);
    const guard = new THREE.Mesh(guardGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(HAND_HEX[side]).multiplyScalar(1.15) }));
    const group = new THREE.Group();
    group.name = 'slash-blade-' + side;
    group.add(core, halo, grip, guard);
    for (const m of [core, halo, grip, guard]) m.frustumCulled = false;
    group.visible = false;
    scene.add(group);
    blades[side] = {
      group, core, halo, uniforms,
      mesh: group, // (older name)
      dir: new THREE.Vector3(0, 1, 0), dirPrimed: false,
      swing: 0, rest: 1, tip: new THREE.Vector3(),
    };
  }

  // ---- scratch ------------------------------------------------------------------------------
  const pose = {
    spine: [0, 1, 0.14], head: [0, 1, 0.06],
    lUpperArm: [-0.2, -1, 0.2], lForearm: [0, -0.4, 1], rUpperArm: [0.2, -1, 0.2], rForearm: [0, -0.4, 1],
    lThigh: [-0.3, -1, 0.17], lShin: [0.1, -1, -0.21], rThigh: [0.3, -1, 0.17], rShin: [-0.1, -1, -0.21],
    hipX: 0, yaw: 0,
  };
  const S = new THREE.Vector3();
  const T = new THREE.Vector3();
  const U = new THREE.Vector3();
  const E = new THREE.Vector3();
  const H = new THREE.Vector3();
  const G = new THREE.Vector3();
  const POLE = new THREE.Vector3();
  const PERP = new THREE.Vector3();
  const W = new THREE.Vector3();
  const DIR = new THREE.Vector3();
  const VEL = new THREE.Vector3();
  const READY = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const Q = new THREE.Quaternion();
  const worldTarget = { l: new THREE.Vector3(), r: new THREE.Vector3() };
  const eased = { l: new THREE.Vector3(), r: new THREE.Vector3() }; // grip targets in rig space, smoothed
  const primed = { l: false, r: false };
  const act = { l: 0, r: 0 }; // how hard each screen-side hand is working right now (0..1)
  let leanX = 0;
  let twist = 0;
  let saved = null;

  // rig space <-> world, for a group at (0, 0, z) turned by PI about y and scaled uniformly
  function worldToRig(v, out) {
    const s = tuning.scale;
    return out.set(-v.x / s, v.y / s, -(v.z - tuning.z) / s);
  }
  function rigDirToWorld(v, out) { return out.set(-v.x, v.y, -v.z); }

  function setVec(a, v) { a[0] = v.x; a[1] = v.y; a[2] = v.z; }
  const seenHand = (h) => !!(h && h.seen > 0.25 && Number.isFinite(h.x) && Number.isFinite(h.y));

  /**
   * One arm. `screen` is the screen side of the hand ('l' | 'r'); it drives the rig arm on the
   * other rig side (NOVA is turned around). Writes the pose's upper arm / forearm for that arm
   * and returns the rig x of the grip (for the lean).
   */
  function solveArm(screen, hand, dt) {
    const rigSide = screen === 'l' ? 'r' : 'l';
    const sg = rigSide === 'l' ? -1 : 1; // rig x of that shoulder
    const B = blades[screen];
    const joints = dancer.joints && dancer.joints[rigSide];
    if (joints && joints.shoulder && Number.isFinite(joints.shoulder.x) && joints.shoulder.lengthSq() > 1e-6) {
      S.copy(joints.shoulder);
    } else {
      S.set(sg * 0.121, 1.36, 0);
    }

    // is this hand cutting or waiting? (smoothed: a swing switches on at once, rest comes slowly)
    const seen = seenHand(hand);
    const sp = seen && Number.isFinite(hand.speed) ? hand.speed : 0;
    const busy = Math.min(1, sp / 5);
    B.swing += (busy - B.swing) * (1 - Math.exp(-dt * (busy > B.swing ? 30 : 6)));
    const resting = !seen || sp < tuning.restSpeed ? 1 : 0;
    B.rest += (resting - B.rest) * (1 - Math.exp(-dt * (resting ? 3.2 : 22)));
    act[screen] = B.swing;

    // where the blade has to go: the player's hand point on the hit plane ...
    if (seen) {
      view.ppToWorld(hand.x, hand.y, W);
      worldTarget[screen].copy(W);
      worldToRig(W, T);
    }
    // ... and where the grip sits in the ready guard
    G.set(sg * tuning.guard[0], tuning.guard[1] + 0.015 * Math.sin(clock * 1.7 + sg), tuning.guard[2]);

    // the grip: toward the hand point as far as the arm comfortably goes, pushed out a little
    // further while the swing is fast; eased back to the guard when the hand is at rest
    if (seen) {
      U.copy(T).sub(S);
      const dist = U.length();
      if (dist > 1e-5) U.multiplyScalar(1 / dist); else U.set(0, 0, 1);
      let reach = dist * tuning.reachShare + 0.07 * B.swing;
      if (reach < tuning.minReach) reach = tuning.minReach;
      if (reach > REACH * 0.94) reach = REACH * 0.94;
      H.copy(S).addScaledVector(U, reach);
      H.lerp(G, B.rest * 0.85);
    } else {
      H.copy(G);
    }
    const e = eased[screen];
    if (!primed[screen]) { e.copy(H); primed[screen] = true; }
    else e.lerp(H, 1 - Math.exp(-dt * 26));

    // clamp the grip into the arm's reach around the (moving) shoulder
    U.copy(e).sub(S);
    let reach = U.length();
    if (reach > 1e-5) U.multiplyScalar(1 / reach); else U.set(0, 0, 1);
    if (reach < tuning.minReach) reach = tuning.minReach;
    if (reach > REACH) reach = REACH;
    H.copy(S).addScaledVector(U, reach);

    // two-bone IK: elbow on the circle around the shoulder->hand axis, pulled down, out and back
    const x = (UPPER * UPPER - FORE * FORE + reach * reach) / (2 * reach);
    const h2 = UPPER * UPPER - x * x;
    const h = h2 > 0 ? Math.sqrt(h2) : 0;
    POLE.set(sg * 0.7, -0.62, -0.35);
    PERP.copy(POLE).addScaledVector(U, -POLE.dot(U));
    if (PERP.lengthSq() < 1e-6) PERP.set(sg, 0, 0);
    PERP.normalize();
    E.copy(S).addScaledVector(U, x).addScaledVector(PERP, h);

    const upper = rigSide === 'l' ? pose.lUpperArm : pose.rUpperArm;
    const fore = rigSide === 'l' ? pose.lForearm : pose.rForearm;
    DIR.copy(E).sub(S).normalize();
    setVec(upper, DIR);
    DIR.copy(H).sub(E).normalize();
    setVec(fore, DIR);
    return H.x;
  }

  // ---- footwork -------------------------------------------------------------------------------
  // Rig space: +x is the rig's `r` side, +z is the way she faces, the floor is y = 0. Each foot
  // has a short list of landings per bar; it stays planted until half a beat before its next
  // landing, then travels there in a low arc. The hips ride between the feet, closer to the
  // one carrying the weight, and dip on every beat. The legs are then solved by two-bone IK
  // from hip socket to ankle, so a planted foot really stays where it is while the body moves.
  const LEG = { thigh: 0.44, shin: 0.43, hipHalf: 0.088, hipDrop: 0.035, ankle: 0.095 };
  const STEPS = {
    // feet planted, the weight rolls from one to the other every two beats
    sway: {
      swayBeats: 4, hip: 0.075, bounce: 0.024, arc: 0, move: 0.5,
      r: [{ t: 0, x: 0.18, z: 0.03 }],
      l: [{ t: 2, x: -0.18, z: 0.03 }],
    },
    // step-touch: step out, bring the other foot in beside it, step back the other way
    touch: {
      swayBeats: 4, hip: 0.115, bounce: 0.034, arc: 0.07, move: 0.5,
      r: [{ t: 0, x: 0.215, z: 0.045 }, { t: 3, x: -0.045, z: 0.0 }],
      l: [{ t: 1, x: 0.045, z: 0.0 }, { t: 2, x: -0.215, z: 0.045 }],
    },
    // out, out, in, in: one foot per beat
    box: {
      swayBeats: 2, hip: 0.05, bounce: 0.048, arc: 0.085, move: 0.55,
      r: [{ t: 0, x: 0.255, z: 0.05 }, { t: 2, x: 0.115, z: 0.0 }],
      l: [{ t: 1, x: -0.255, z: 0.05 }, { t: 3, x: -0.115, z: 0.0 }],
    },
  };
  const STEP_NAMES = ['sway', 'touch', 'box'];
  const stepW = { sway: 1, touch: 0, box: 0 }; // blend weights, eased
  const foot = { l: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } };
  const ft = { x: 0, y: 0, z: 0 };
  let phase = 0; // beats, follows the song's beat (free-runs at the tempo when there is none)
  let phasePrimed = false;
  const smooth01 = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

  /** Where one foot of one pattern is at bar position u (0..4): x, z and height off the floor. */
  function footAt(keys, P, u, out) {
    const n = keys.length;
    let i = 0;
    while (i < n && keys[i].t < u) i++;
    const next = keys[i % n];
    const prev = keys[(i - 1 + n) % n];
    const s = 1 - ((i < n ? next.t : next.t + 4) - u) / P.move; // 0..1 while it travels
    if (s <= 0 || P.arc <= 0) { out.x = prev.x; out.z = prev.z; out.y = 0; return; }
    const e = smooth01(s);
    out.x = prev.x + (next.x - prev.x) * e;
    out.z = prev.z + (next.z - prev.z) * e;
    out.y = P.arc * Math.sin(Math.PI * s);
  }

  /** Two-bone IK, hip socket -> ankle, knee forward and a little out. Writes unit directions. */
  function solveLeg(sg, hipX, hipY, f, thigh, shin) {
    const hx = hipX + sg * LEG.hipHalf;
    const hy = hipY - LEG.hipDrop;
    let dx = f.x - hx, dy = (LEG.ankle + f.y) - hy, dz = f.z;
    let dist = Math.hypot(dx, dy, dz) || 1e-6;
    const far = (LEG.thigh + LEG.shin) * 0.996;
    const near = 0.4;
    const k = dist > far ? far / dist : dist < near ? near / dist : 1; // out of reach: the foot gives, the knee never locks
    dx *= k; dy *= k; dz *= k; dist *= k;
    const nx = dx / dist, ny = dy / dist, nz = dz / dist;
    let px = sg * 0.2, py = 0, pz = 1;
    const d = px * nx + py * ny + pz * nz;
    px -= d * nx; py -= d * ny; pz -= d * nz;
    const pl = Math.hypot(px, py, pz) || 1;
    px /= pl; py /= pl; pz /= pl;
    let ca = (LEG.thigh * LEG.thigh + dist * dist - LEG.shin * LEG.shin) / (2 * LEG.thigh * dist);
    ca = ca > 1 ? 1 : ca < -1 ? -1 : ca;
    const sa = Math.sqrt(1 - ca * ca);
    const tx = nx * ca + px * sa, ty = ny * ca + py * sa, tz = nz * ca + pz * sa;
    thigh[0] = tx; thigh[1] = ty; thigh[2] = tz;
    const sx = dx - tx * LEG.thigh, sy = dy - ty * LEG.thigh, sz = dz - tz * LEG.thigh;
    const sl = Math.hypot(sx, sy, sz) || 1;
    shin[0] = sx / sl; shin[1] = sy / sl; shin[2] = sz / sl;
  }

  /**
   * The legs for this frame. groove = { beat, spb, intensity, hold }: beat is the song's beat
   * (null while there is no music yet: she keeps time on her own), hold freezes her (pause).
   * Returns the hips' sideways sway (rig metres) so the torso can counter it.
   */
  function stepLegs(d, groove, cutLean, drive) {
    const spb = groove && groove.spb > 0.2 && groove.spb < 1.5 ? groove.spb : 0.5;
    const hold = !!(groove && groove.hold);
    const beat = groove && Number.isFinite(groove.beat) ? groove.beat + tuning.beatLead : null;
    if (!hold) {
      if (beat !== null && !phasePrimed) { phase = beat; phasePrimed = true; }
      phase += d / spb;
      if (beat !== null) {
        // lock onto the song a bar at a time, without a jump when the music comes in
        let err = (beat - phase) % 4;
        if (err > 2) err -= 4; else if (err < -2) err += 4;
        phase += err * (1 - Math.exp(-d * 7));
      }
    }
    let u = phase % 4;
    if (u < 0) u += 4;

    // which step: quiet parts sway, verses step-touch, the chorus goes out-out-in-in
    const inten = groove && Number.isFinite(groove.intensity) ? groove.intensity : 0.25;
    const pick = beat === null ? 'sway' : inten >= 0.9 ? 'box' : inten >= 0.45 ? 'touch' : 'sway';
    const kw = 1 - Math.exp(-d * 3.2);
    let sum = 0;
    for (const n of STEP_NAMES) { stepW[n] += ((n === pick ? 1 : 0) - stepW[n]) * kw; sum += stepW[n]; }

    const amp = Math.max(0, tuning.footwork);
    const dip = Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * (u - 0.08)), 1.6); // lowest just after each beat
    let hipX = 0, bounce = 0;
    foot.l.x = foot.l.y = foot.l.z = 0; foot.r.x = foot.r.y = foot.r.z = 0;
    for (const n of STEP_NAMES) {
      const w = stepW[n] / (sum || 1);
      if (w < 1e-4) continue;
      const P = STEPS[n];
      // the weight starts across a little before the foot lands and settles after it
      const sway = Math.tanh(2.2 * Math.sin((2 * Math.PI * (u + 0.14)) / P.swayBeats)) / 0.9757;
      hipX += w * P.hip * sway;
      bounce += w * P.bounce;
      for (const side of ['l', 'r']) {
        footAt(P[side], P, u, ft);
        const F = foot[side];
        F.x += w * ft.x; F.y += w * ft.y; F.z += w * ft.z;
      }
    }
    // with footwork off she stands in the middle of her feet
    hipX = hipX * amp + 0.06 * cutLean;
    foot.l.y *= amp; foot.r.y *= amp;
    if (amp < 1) { // toward a planted stance
      foot.l.x = -0.18 + (foot.l.x + 0.18) * amp; foot.r.x = 0.18 + (foot.r.x - 0.18) * amp;
    }
    const hipY = LEG.ankle + LEG.shin + LEG.thigh + LEG.hipDrop
      - tuning.crouch - bounce * amp * dip - tuning.cutSink * drive;
    solveLeg(-1, hipX, hipY, foot.l, pose.lThigh, pose.lShin);
    solveLeg(1, hipX, hipY, foot.r, pose.rThigh, pose.rShin);
    pose.hipX = hipX;
    return { sway: hipX, dip: dip * bounce * amp };
  }
  const NO_GROOVE = { beat: null, spb: 0.5, intensity: 0.25, hold: false };

  /**
   * Call before dancer.update(): poses NOVA from the hands frame (null = guard). `groove`
   * ({ beat, spb, intensity, hold }) keeps her feet in time with the song.
   */
  function pose_(hands, dt, levels, groove) {
    if (!active) return;
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0.016;
    clock += d;
    const lx = solveArm('l', hands ? hands.l : null, d);
    const rx = solveArm('r', hands ? hands.r : null, d);

    // the body goes with the blades: lean toward where the hands are, twist into the arm that
    // is cutting (the screen-left hand is the rig's +x arm: bringing it forward is a negative yaw)
    const mid = (lx + rx) * 0.5;
    leanX += (Math.max(-1, Math.min(1, mid / 0.4)) - leanX) * (1 - Math.exp(-d * 7));
    const want = (act.r - act.l) * tuning.twist;
    twist += (want - twist) * (1 - Math.exp(-d * 10));
    const drive = Math.max(act.l, act.r);
    // the feet keep time; the hips sink a little into every cut (sets the legs and pose.hipX)
    const g = stepLegs(d, groove || NO_GROOVE, leanX, drive);
    // the shoulders stay over the middle while the hips travel, and the chest gives on the beat
    const L = tuning.lean * leanX - 0.45 * (g.sway - 0.06 * leanX);
    pose.spine[0] = L; pose.spine[1] = 1; pose.spine[2] = 0.15 + 0.1 * drive + g.dip * 1.1;
    pose.head[0] = L * 0.4 - twist * 0.25; pose.head[1] = 1; pose.head[2] = 0.08 + g.dip * 0.8;
    pose.yaw = twist;
    dancer.setPose(pose);
  }

  /** Call after dancer.update(): puts the blades into her hands. */
  function sync(dt, hands) {
    if (!active) return;
    const g = dancer.group;
    g.updateMatrixWorld();
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0.016;
    for (const screen of ['l', 'r']) {
      const rigSide = screen === 'l' ? 'r' : 'l';
      const sg = rigSide === 'l' ? -1 : 1;
      const B = blades[screen];
      const j = dancer.joints && dancer.joints[rigSide];
      if (!j || !j.wrist || !Number.isFinite(j.wrist.x)) { B.group.visible = false; continue; }
      const hand = hands ? hands[screen] : null;
      const seen = seenHand(hand);
      // wrist and elbow in world space
      W.copy(j.wrist).applyMatrix4(g.matrixWorld);
      E.copy(j.elbow).applyMatrix4(g.matrixWorld);
      // cutting: the blade runs from the grip through the player's hand point ...
      DIR.copy(worldTarget[screen]).sub(W);
      const far = DIR.length();
      if (seen && far > 0.08) DIR.multiplyScalar(1 / far); else DIR.copy(W).sub(E).normalize();
      // ... and its tip trails the swing: a blade has weight
      if (seen && Number.isFinite(hand.vx) && Number.isFinite(hand.vy)) {
        VEL.set(hand.vx * PP, hand.vy * PP, 0);
        const sp = VEL.length();
        if (sp > 0.2) DIR.addScaledVector(VEL, -tuning.tipLag * Math.min(1, sp / 4.5) / sp).normalize();
      }
      // waiting: up into the ready guard (with a slow sway so she never freezes)
      READY.set(sg * tuning.guardDir[0], tuning.guardDir[1], tuning.guardDir[2]);
      READY.x += 0.05 * Math.sin(clock * 1.3 + sg * 1.1);
      READY.z += 0.04 * Math.sin(clock * 0.9 + sg * 0.4);
      rigDirToWorld(READY, U).normalize();
      DIR.lerp(U, B.rest).normalize();
      // never fold the blade back along the forearm
      U.copy(W).sub(E).normalize();
      if (DIR.dot(U) < -0.2) DIR.lerp(U, 0.5).normalize();
      // follow smoothly (fast while cutting, softer when settling into the guard)
      if (!B.dirPrimed) { B.dir.copy(DIR); B.dirPrimed = true; }
      else B.dir.lerp(DIR, 1 - Math.exp(-d * (16 + 22 * B.swing))).normalize();

      Q.setFromUnitVectors(UP, B.dir);
      B.group.position.copy(W);
      B.group.quaternion.copy(Q);
      const R = tuning.bladeRadius;
      B.core.scale.set(R, tuning.bladeLength, R);
      B.halo.scale.set(R * 3.6, tuning.bladeLength * 1.03, R * 3.6);
      B.group.visible = true;
      B.tip.copy(W).addScaledVector(B.dir, tuning.bladeLength);
      B.uniforms.uPower.value = tuning.bladePower * (0.9 + 0.5 * B.swing);
      B.uniforms.uTime.value = clock;
    }
  }

  /** NOVA takes her place on the runway, back to the camera. */
  function enter() {
    if (active) return;
    const g = dancer.group;
    saved = { x: g.position.x, y: g.position.y, z: g.position.z, ry: g.rotation.y, s: g.scale.x };
    g.position.set(0, 0, tuning.z);
    g.rotation.y = Math.PI;
    g.scale.setScalar(tuning.scale);
    // seen from behind she would be a dark shape against the lane: lift her ambient light
    const u = dancer.uniforms;
    if (u && u.uAmbSky && u.uAmbGround && u.uAmbSky.value && u.uAmbSky.value.isColor) {
      saved.sky = u.uAmbSky.value.clone();
      saved.ground = u.uAmbGround.value.clone();
      u.uAmbSky.value.multiplyScalar(tuning.backLight);
      u.uAmbGround.value.multiplyScalar(tuning.backLight);
    }
    primed.l = false; primed.r = false;
    blades.l.dirPrimed = false; blades.r.dirPrimed = false;
    blades.l.rest = 1; blades.r.rest = 1;
    blades.l.swing = 0; blades.r.swing = 0;
    worldTarget.l.set(-0.4, 1.0, 0); worldTarget.r.set(0.4, 1.0, 0);
    leanX = 0; twist = 0;
    phasePrimed = false;
    stepW.sway = 1; stepW.touch = 0; stepW.box = 0;
    active = true;
  }

  /** Back to the dance stage: centre, facing the audience, full size; blades away. */
  function leave() {
    blades.l.group.visible = false;
    blades.r.group.visible = false;
    if (!active) return;
    active = false;
    const g = dancer.group;
    if (saved) {
      g.position.set(saved.x, saved.y, saved.z);
      g.rotation.y = saved.ry;
      g.scale.setScalar(saved.s);
      const u = dancer.uniforms;
      if (saved.sky && u && u.uAmbSky) { u.uAmbSky.value.copy(saved.sky); u.uAmbGround.value.copy(saved.ground); }
    } else {
      g.position.set(0, 0, 0);
      g.rotation.y = 0;
      g.scale.setScalar(1);
    }
    saved = null;
  }

  function dispose() {
    leave();
    for (const side of ['l', 'r']) {
      const B = blades[side];
      scene.remove(B.group);
      B.core.material.dispose();
      B.halo.material.dispose();
      B.group.children[3].material.dispose();
    }
    beamGeo.dispose(); guardGeo.dispose(); gripGeo.dispose(); gripMat.dispose();
  }

  return {
    enter, leave, pose: pose_, sync, dispose, tuning,
    get active() { return active; },
    blades,
  };
}
