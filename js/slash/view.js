// STARFALL — slash/view.js
// The 3D presentation of STAR SLASH: a glass runway that leaves the dance stage and runs out
// toward the star, star shards (faceted crystals carrying a luminous cut line) that fall out of
// the star and ride the runway to the hit plane, the player's hands as comets, and every cut
// effect. Everything is procedural, pooled and instanced; update() allocates nothing.
//
// World layout (stage space, metres: +x screen right, +y up, +z toward the viewer):
//   - the runway lies on the stage floor (y = 0) at the player's end and runs along -z toward
//     the star; a few metres past the hit plane it starts to climb (rampHeight()): the shards
//     come DOWN a slide of glass out of the star, so the far ones sit high in the frame, well
//     clear of the cells where the cuts happen;
//   - the HIT PLANE is the vertical plane z = 0. A play-plane ("pp") position (x, y) sits at
//     world (x * pp, originY + y * pp, 0); see ppToWorld() / project();
//   - a shard's position is a pure function of (note.time - songTime): it cruises at a constant
//     speed, reaches the hit plane exactly at note.time and then "docks" a hand's width in front
//     of it for the length of the late window (a webcam player's hand is seen ~0.1 s late, so
//     the comet reaches the shard after the beat: the shard waits there instead of flying past).
//
// Draw calls: at most 7 in the main pass (runway, shards, halves, floor pools, fx quads, sparks,
// comets; the guide marks and gold halos share the fx quads) + 2 in the stage's floor-reflection
// pass (shards and halves only; everything else lives on layer 1, which the mirror camera skips).
// About 2.4 k triangles with a dozen shards on the lane.
//
// Look: our own. Shield-cut crystals with a bold arrow for the cut direction, hands as comets, a
// runway of edge-lit glass with beat rungs that travel WITH the shards. No cubes, no sabers.

import * as THREE from 'three';
import { SEC_PER_BEAT } from '../song.js';

// ---------------------------------------------------------------------------------------
// Tuning (exposed as view.tuning; safe to tweak at runtime unless marked "build-time")
// ---------------------------------------------------------------------------------------
export const SLASH_VIEW_TUNING = {
  // --- layout (build-time) ---
  pp: 0.7, // metres per play-plane unit (one shoulder width)
  rowBase: 0.42, // height of row 0 above the runway (m)
  laneHalf: 1.42, // half-width of the runway (m)
  // --- approach ---
  speed: 12.5, // cruise speed (m/s); beat rungs on the runway are speed * SEC_PER_BEAT apart
  fallIn: 0.5, // s at the start of the approach spent falling out of the star onto the lane
  fallBoost: 56, // extra distance of the fall-in (m/s^2, quadratic)
  fallLift: 5, // extra height of the fall-in (m/s^2, quadratic)
  dock: 0.3, // how far past the hit plane (toward the camera) a shard settles while it can still be cut (m)
  // --- the ramp (build-time): flat to rampStart metres past the hit plane, then easing over rampEase metres into a constant slope
  rampStart: 2.5,
  rampEase: 16,
  rampSlope: 0.19, // rise per metre (0.19 = 10.8 deg): the far end of the runway reaches the heart of the star
  missAfter: 0.75, // s after note.time at which an unjudged shard gives up by itself (the judge's MISS normally comes first)
  // --- shards ---
  shardSize: 0.5, // world size of one local unit (a shield is 0.92 units wide, 1.16 long: 0.46 x 0.58 m in a 0.63 x 0.56 m cell)
  goldScale: 1.2,
  farScale: 0.9, // extra size at the far end (readability), eases to 0 at the hit plane
  markGain: 1.0, // brightness of the arrow / ring
  // --- camera (first person, fixed; fitted to the aspect ratio) ---
  camFov: 46, // vertical fov (deg)
  camHeight: 1.84, // eye height above the runway (a little above the top row: every shard is seen against the glass)
  camAimY: 1.12, // the point (0, camAimY, 0) sits on the optical axis
  camMinDist: 2.6,
  frameTop: 0.5, // the 4 x 3 grid (shards included) stays inside these NDC limits
  frameBottom: 0.7,
  frameSide: 0.84,
  nod: 0.012, // metres of camera dip on the kick (0 = perfectly still)
  // --- effects ---
  fxPower: 1.0, // master brightness of cut effects
  sparks: 1.0, // spark-count multiplier
  runwayGlow: 1.0, // rails, rungs, hit line
  speedLines: 1.0,
  guide: 1.0, // the 4 x 3 arrival guide
  cometPower: 1.0,
  poolPower: 1.0, // light the shards throw on the glass
};

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------
const GRID_X = [-1.35, -0.45, 0.45, 1.35];
const GRID_Y = [-0.55, 0.25, 1.05];
const Z_HIT = 0;
const RUNWAY_Y = 0.02;
const RUNWAY_NEAR = 8; // the runway starts this far behind the hit plane (under and behind the camera)
const RUNWAY_FAR = 84; // and ends this far down the lane
const SQ = Math.SQRT1_2;
const DIR_VEC = {
  u: [0, 1], d: [0, -1], l: [-1, 0], r: [1, 0],
  ul: [-SQ, SQ], ur: [SQ, SQ], dl: [-SQ, -SQ], dr: [SQ, -SQ],
};

const MAX_SHARDS = 48;
const MAX_HALVES = 44;
const FX_GUIDE = 0; // 12 guide marks
const FX_HALO = 12; // 4 gold halos
const FX_POOL = 16; // transient effects from here
const FX_MAX = 60;
const SPARK_MAX = 720;
const RIP_MAX = 6;
const TRAIL_PTS = 22;
const TRAIL_HIST = 72;

const FX_ARC = 0;
const FX_RING = 1;
const FX_GLINT = 2;
const FX_CRACK = 3;
const FX_HALO_T = 4;
const FX_GUIDE_T = 5;

const LIVE = 0;
const GONE = 1;
const MISSED = 2;

const HEX = { teal: 0x19e3d2, amber: 0xffc24a, either: 0xd6c8ff, violet: 0x6a3df0, gold: 0xffe2a0 };

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const smooth01 = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const frac = (v) => v - Math.floor(v);

/** Guarded uniform write (missing tables / entries are ignored; vectors and colours are copied). */
function setU(uniforms, name, value) {
  if (!uniforms) return;
  const u = uniforms[name];
  if (!u) return;
  const cur = u.value;
  if (cur !== null && typeof cur === 'object' && typeof cur.copy === 'function' && value !== null && typeof value === 'object') {
    cur.copy(value);
  } else {
    u.value = value;
  }
}

// ---------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------
// Every pow() goes through pw(): a negative base is NaN, and bloom turns one NaN pixel into a
// black disc. Lengths are guarded before every divide / normalize. Interpolated coordinates are
// clamped before use and every additive output is capped: on a multisampled target a varying
// is EXTRAPOLATED at the silhouette of a thin, edge-on triangle, and anything that grows with
// it (a width profile, a power) turns one pixel into a huge value and bloom into a white blob.
const GLSL_COMMON = /* glsl */ `
float sat(float x) { return clamp(x, 0.0, 1.0); }
float pw(float b, float e) { return pow(max(b, 0.0), e); }
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float easeOut(float t) { float u = 1.0 - sat(t); return 1.0 - u * u * u; }
`;

// --- Runway: edge-lit glass over the stage floor (premultiplied alpha, so the floor's own
//     mirror image of the shards shows through the tint) ---
const RUNWAY_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const RUNWAY_FRAG = /* glsl */ `
#define RIP_N ${RIP_MAX}
uniform float uHalf;      // lane half-width (m)
uniform float uTravel;    // metres the lane has scrolled (speed x song time)
uniform float uBeat;      // current beat, wrapped to 0..16
uniform float uRung;      // metres between beat rungs
uniform float uKick;
uniform float uEnergy;
uniform float uHeat;      // 0..1 with the score multiplier
uniform float uFx;        // effect clock (s)
uniform float uAlive;     // fade of the whole mode
uniform float uGlow;
uniform float uStreaks;
uniform float uNear;      // z at which the runway ends behind the camera
uniform float uLen;       // length down the lane
uniform vec2 uCols;       // |x| of the inner and outer columns
uniform vec3 uRamp;       // start (m past the hit line), ease length (m), slope
uniform vec4 uRip[RIP_N];     // x, z, birth, strength
uniform vec4 uRipCol[RIP_N];  // rgb, reach (m)
uniform vec3 uColL;
uniform vec3 uColR;
uniform vec3 uColN;
uniform vec3 uColWarm;
varying vec3 vW;
${GLSL_COMMON}
// Anti-aliased line of half-width w around d = 0. Thinner than a pixel, it fades instead of shimmering.
float aaLine(float d, float w, float fw) {
  float a = 1.0 - smoothstep(w, w + fw, abs(d));
  return a * clamp(w * 2.0 / max(fw, 1e-5) + 0.3, 0.0, 1.0);
}
void main() {
  float x = vW.x;
  float z = vW.z;
  float ax = abs(x);
  float fx = fwidth(x) + 1e-5;
  float fz = fwidth(z) + 1e-5;
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  float depth = max(-z, 0.0);
  float rise = uRamp.z * sat((depth - uRamp.x) / max(uRamp.y, 1e-3));   // slope of the glass here
  vec3 nrm = normalize(vec3(0.0, 1.0, rise));
  float ndv = sat(abs(dot(nrm, toCam)) / max(dist, 1e-4));
  float sheen = pw(1.0 - ndv, 3.0);
  float far = exp(-depth / 26.0);
  float farCut = 1.0 - smoothstep(uLen * 0.55, uLen, depth);
  float nearFade = 1.0 - smoothstep(uNear - 3.0, uNear, z);
  float inside = 1.0 - smoothstep(uHalf - fx, uHalf + fx, ax);
  float side = step(0.0, x);
  vec3 railCol = mix(uColL, uColR, side);
  float glowK = uGlow * (0.85 + 0.35 * uEnergy + 0.5 * uHeat);

  vec3 em = vec3(0.0);

  // --- beat rungs: a line across the glass for every beat, travelling at the approach speed,
  //     so the rung of beat b crosses the hit line exactly on beat b (shards ride their rung)
  float u = -z / uRung + uBeat;
  float ui = floor(u + 0.5);
  float dr = (u - ui) * uRung;
  float bar = step(mod(ui, 4.0), 0.5);
  float passed = smoothstep(-0.2, 0.4, z);                  // dimmer once past the hit line
  float rung = aaLine(dr, mix(0.010, 0.020, bar), fz) * inside;
  float rungGlow = exp(-abs(dr) / 0.16) * inside;
  em += mix(uColN, vec3(1.0), 0.35) * (rung * (0.22 + 0.38 * bar) + rungGlow * (0.016 + 0.03 * bar)) * far * (1.0 - 0.7 * passed) * glowK;

  // --- speed lines: thin streaks in the glass, scrolling toward the player
  float tracks = 20.0;
  float tx = (x / uHalf * 0.5 + 0.5) * tracks;
  float ti = floor(tx);
  float tf = (fract(tx) - 0.5) * (2.0 * uHalf / tracks);
  float trk = hash21(vec2(ti, 3.7));
  float sp = (-z + uTravel) / mix(3.2, 6.4, trk) + trk * 17.0;
  float si = floor(sp);
  float sf = fract(sp);
  float on = step(0.66 - 0.3 * uEnergy - 0.12 * uHeat, hash21(vec2(ti * 1.37 + 0.5, si)));
  float dashLen = mix(0.14, 0.42, hash21(vec2(si, ti + 9.1)));
  float along = smoothstep(0.0, 0.025, sf) * pw(sat(1.0 - sf / dashLen), 1.6);
  float streak = aaLine(tf, 0.007, fx) * along * on * inside;
  em += mix(uColN, vec3(1.0), 0.55) * streak * (0.16 + 0.34 * uEnergy + 0.2 * uHeat) * far * uStreaks;

  // --- column seams (very faint): the four lanes the shards ride
  float seam = min(ax, abs(ax - 0.5 * (uCols.x + uCols.y)));
  em += uColN * aaLine(seam, 0.006, fx) * inside * far * 0.045 * uGlow;

  // --- rails: light guides along both edges, teal on the left hand's side, amber on the right
  float dRail = ax - uHalf;
  float railCore = aaLine(dRail, 0.020, fx);
  float railIn = exp(-max(-dRail, 0.0) / 0.20) * step(dRail, 0.0);
  float railOut = exp(-max(dRail, 0.0) / 0.07) * step(0.0, dRail);
  float bead = exp(-dr * dr / 0.07);                         // beads of light riding the rails with each rung
  float railLvl = (0.55 + 0.7 * bead * (0.6 + 0.4 * bar) + 0.3 * uKick * sat(1.0 - abs(z) / 4.0)) * (0.35 + 0.65 * far);
  em += (mix(railCol, vec3(1.0), 0.45) * railCore * 1.5 + railCol * (railIn * 0.16 + railOut * 0.30)) * railLvl * glowK;

  // --- the hit line: where the plane meets the glass
  float hit = aaLine(z, 0.011, fz) * inside;
  float hitGlow = exp(-abs(z) / 0.22) * inside;
  float cx = min(abs(ax - uCols.x), abs(ax - uCols.y));
  float node = exp(-(cx * cx + z * z) / 0.0016);
  vec3 hitCol = mix(uColN, vec3(1.0), 0.6);
  em += (hitCol * (hit * 1.1 + node * 1.0) + uColN * hitGlow * 0.12) * (0.8 + 0.5 * uKick) * uGlow;

  // --- ripples: every cut rings on the glass under it
  for (int i = 0; i < RIP_N; i++) {
    float age = uFx - uRip[i].z;
    float dur = 0.34 + 0.16 * uRipCol[i].a;
    if (age > 0.0 && age < dur) {
      float t = age / dur;
      float rad = mix(0.12, uRipCol[i].a, easeOut(t));
      float d = length(vec2(x - uRip[i].x, z - uRip[i].y));
      float wdt = 0.02 + 0.045 * t;
      float q = (d - rad) / wdt;
      float fade = (1.0 - t) * (1.0 - t);
      float wake = (1.0 - smoothstep(rad - 0.04, rad + 0.04, d)) * exp(-max(rad - d, 0.0) * 3.2) * 0.09;
      em += uRipCol[i].rgb * ((exp(-q * q) + wake) * uRip[i].w * fade) * inside;
    }
  }

  // --- the glass itself: an indigo tint that thickens at grazing angles, edge-lit by the rails,
  //     dissolving into warm haze toward the star
  float alpha = inside * (0.74 + 0.2 * sheen) * mix(0.5, 1.0, far);
  vec3 glass = vec3(0.007, 0.006, 0.022) + uColN * (0.012 + 0.05 * sheen) + uColWarm * (0.06 * (1.0 - far));
  vec3 col = glass * alpha + em;

  float vis = uAlive * nearFade * farCut;
  gl_FragColor = vec4(min(col, vec3(6.0)) * vis, sat(alpha) * vis);
}
`;

// --- Crystals (shards and their two halves): faceted glass with an inner light ---
const CRYSTAL_VERT = /* glsl */ `
attribute vec3 aAlt;       // the same vertex on the round ("any direction") cut
attribute vec3 aBary;
attribute vec3 aFace;      // facet id, 1 on the cut face of a half, 1 on the girdle (the silhouette)
attribute vec4 aTint;      // rgb = hand colour, a = opacity
attribute vec4 aState;     // x = round cut 0/1, y = gold 0/1, z = ripeness 0..1, w = dull 0..1 (1..2 = cracked red)
attribute vec4 aExtra;     // x = seed, y = side (+1, or -1 = mirrored half), z = heat of the cut face, w = mark gain
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vViewL;
varying vec3 vBary;
varying vec3 vFace;
varying vec4 vTint;
varying vec4 vState;
varying vec4 vExtra;
void main() {
  vec3 p = mix(position, aAlt, aState.x);
  p.x *= aExtra.y;
  mat4 im = modelMatrix * instanceMatrix;
  vec4 wp = im * vec4(p, 1.0);
  vec3 toCam = cameraPosition - wp.xyz;
  mat3 m = mat3(im);
  vViewL = vec3(dot(toCam, m[0]), dot(toCam, m[1]), dot(toCam, m[2]));
  vLocal = p;
  vWorld = wp.xyz;
  vBary = aBary;
  vFace = aFace;
  vTint = aTint;
  vState = aState;
  vExtra = aExtra;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const CRYSTAL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlive;
uniform vec3 uStarDir;
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vViewL;
varying vec3 vBary;
varying vec3 vFace;
varying vec4 vTint;
varying vec4 vState;
varying vec4 vExtra;
${GLSL_COMMON}
vec3 spectrum(float t) { return 0.55 + 0.45 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67))); }
void main() {
  vec3 V = cameraPosition - vWorld;
  V /= max(length(V), 1e-4);
  // true facet normal from screen-space derivatives (flat shading without normal attributes)
  vec3 n = cross(dFdx(vWorld), dFdy(vWorld));
  float nl = length(n);
  vec3 N = nl > 1e-12 ? n / nl : V;
  if (dot(N, V) < 0.0) N = -N;
  float ndv = sat(dot(N, V));
  vec3 R = reflect(-V, N);

  float any = vState.x;
  float gold = vState.y;
  float ripe = vState.z;
  float dull = sat(vState.w);
  float bad = sat(vState.w - 1.0);
  float seed = vExtra.x;
  float cap = vFace.y;
  vec3 hue = vTint.rgb;
  vec3 body = mix(hue, vec3(1.0, 0.74, 0.30), gold * 0.94);   // a gold stone is gold whoever it is for; its mark carries the hand colour

  float fid = vFace.x + seed * 57.0;
  float fr = hash21(vec2(fid, 1.7));

  vec3 L1 = normalize(vec3(-0.50, 0.75, 0.45));
  vec3 L2 = normalize(vec3(0.60, 0.30, 0.74));
  float d1 = sat(dot(N, L1));
  float d2 = sat(dot(N, L2));
  float s1 = pw(sat(dot(R, L1)), 26.0);
  float s2 = pw(sat(dot(R, L2)), 44.0);
  float sStar = pw(sat(dot(R, uStarDir)), 10.0);
  float fres = pw(1.0 - ndv, 2.6);

  // inner light: a core seen through the facets, shifted by parallax so it sits inside the stone
  vec2 par = clamp(vViewL.xy / max(abs(vViewL.z), 1e-4), vec2(-1.5), vec2(1.5));
  vec2 q = vLocal.xy - par * clamp(vLocal.z + 0.12, 0.0, 0.4) * 0.6;
  vec2 cq = q - vec2(0.0, mix(0.02, 0.0, any));
  float core = exp(-(cq.x * cq.x / 0.010 + cq.y * cq.y / mix(0.050, 0.012, any)));

  // A dark jewel that returns light in a few places: a deep body, facets that flip between
  // dark and lit as the stone tilts (scintillation), a luminous core, a bright girdle outline.
  float rim = smoothstep(0.78, 0.98, vFace.z);
  float crown = 1.0 - smoothstep(0.70, 0.97, ndv);
  float sc = fract(fr * 5.3 + par.x * 1.9 + par.y * 1.5 + seed * 3.1);
  float lit = smoothstep(0.50, 0.62, sc) * (1.0 - smoothstep(0.86, 0.98, sc));
  vec3 deep = mix(vec3(0.012, 0.010, 0.040), body, 0.10);
  vec3 col = deep * (0.5 + 0.9 * d1 + 0.4 * d2);
  col += body * lit * (0.22 + 0.26 * crown);
  col += body * core * (0.5 + 0.5 * ripe + 0.3 * gold);
  col += mix(body, vec3(1.0), 0.25) * crown * 0.09;
  col += mix(body, vec3(1.0), 0.4) * fres * 0.9;
  col += mix(body, vec3(1.0), 0.7) * (s1 * 1.1 + s2 * 0.8);
  col += vec3(1.0, 0.68, 0.36) * sStar * 0.7;
  // chromatic sparkle: every facet owns a glint direction and fires in spectral colours as the stone tilts
  vec3 gdir = normalize(L1 + vec3(hash21(vec2(fid, 4.1)) - 0.5, hash21(vec2(fid, 9.3)) - 0.5, 0.0) * 1.1);
  float glint = pw(sat(dot(R, gdir)), 70.0);
  col += spectrum(fr + ndv * 1.3 + uTime * 0.07) * glint * (1.4 + 1.6 * gold);
  // the girdle draws the silhouette in light; the inner facet edges are only a whisper
  col += mix(body, vec3(1.0), 0.22) * rim * (0.8 + 0.45 * ripe);   // in the hand colour: identity matters most at the plane
  float e = min(min(vBary.x, vBary.y), vBary.z);
  float edge = 1.0 - smoothstep(0.0, fwidth(e) * 1.4 + 0.004, e);
  col += mix(body, vec3(1.0), 0.4) * edge * (0.07 + 0.3 * lit);

  // --- the mark: a bold arrow over the whole front of the stone, on a dark plate so that it
  //     reads against the lit facets from the far end of the runway ---
  float front = smoothstep(-0.015, 0.02, vLocal.z) * (1.0 - cap);
  vec2 p = vLocal.xy;
  float px = 0.5 * (length(dFdx(p)) + length(dFdy(p))) + 1e-5;   // local units per pixel
  // signed distance to the arrow (+y is the cut direction): a shaft and a solid head
  vec2 qs = abs(p - vec2(0.0, -0.17)) - vec2(0.064, 0.21);
  float dShaft = length(max(qs, 0.0)) + min(max(qs.x, qs.y), 0.0);
  float dHead = max(0.02 - p.y, dot(vec2(abs(p.x), p.y - 0.44), vec2(0.8137, 0.5812)));
  float dArrow = min(dShaft, dHead);
  // "any direction": a ring and a dot instead
  float rr = length(p);
  float dAny = min(abs(rr - 0.25) - 0.045, rr - 0.08);
  float dMark = mix(dArrow, dAny, any);
  float mark = (1.0 - smoothstep(-px, px, dMark)) * front;
  float plate = (1.0 - smoothstep(0.04, 0.085 + px, dMark)) * front;
  float markHalo = exp(-max(dMark, 0.0) / 0.05) * (1.0 - mark) * front;
  float gain = vExtra.w * (1.0 + 0.35 * ripe) * (1.0 - 0.5 * dull);   // an expiring stone lets go of its arrow
  col = mix(col, hue * 0.10, 0.88 * plate * sat(vExtra.w));   // the plate keeps a breath of the hand colour
  col += mix(vec3(0.92) + hue * 0.62, hue * 1.9 + vec3(0.38), gold) * mark * gain;
  col += hue * markHalo * gain * 0.3;

  // the cut face of a half: white-hot at the moment of the cut, cooling to the hand colour
  float heat = sat(vExtra.z);
  vec3 capCol = mix(body * 1.5, mix(body, vec3(1.0), 0.6) * 2.2, heat) * (0.3 + 0.7 * heat) + body * 0.35;
  col = mix(col, capCol, cap);

  // expiring (late) shards lose their colour; a BAD cut leaves a dull red stone
  float lum = dot(col, vec3(0.30, 0.55, 0.15));
  col = mix(col, vec3(0.55, 0.50, 0.66) * lum * 0.55, dull);
  col = mix(col, vec3(0.85, 0.16, 0.20) * lum * 0.7 + vec3(0.03, 0.0, 0.005), bad);

  col = min(max(col, vec3(0.0)), vec3(8.0));
  float a = sat(vTint.a) * uAlive;
  gl_FragColor = vec4(col * a, a);
}
`;

// --- Pools: the light a shard throws on the glass under it (additive discs on the runway) ---
const POOL_VERT = /* glsl */ `
attribute vec4 aPool;   // rgb, intensity
varying vec2 vP;
varying vec4 vPool;
void main() {
  vP = position.xy;
  vPool = aPool;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const POOL_FRAG = /* glsl */ `
uniform float uAlive;
varying vec2 vP;
varying vec4 vPool;
void main() {
  float r2 = dot(vP, vP);
  float g = max(exp(-r2 * 3.4) - 0.0334, 0.0);
  gl_FragColor = vec4(min(vPool.rgb * (g * vPool.a * uAlive), vec3(4.0)), 1.0);
}
`;

// --- FX quads: slash arcs, rings, glints, cracks, gold halos and the arrival guide ---
const FX_VERT = /* glsl */ `
attribute vec4 aFx;      // type, birth, duration (<= 0: persistent), seed (guide: highlight)
attribute vec4 aFxCol;   // rgb, intensity
uniform float uFx;
varying vec2 vP;
varying vec4 vFx;        // type, life 0..1, seed, age
varying vec4 vCol;
void main() {
  float age = uFx - aFx.y;
  float dur = aFx.z;
  float t = dur > 0.0 ? age / dur : 0.0;
  vP = position.xy;
  vFx = vec4(aFx.x, t, aFx.w, age);
  vCol = aFxCol;
  if ((dur > 0.0 && (t < 0.0 || t >= 1.0)) || aFxCol.a <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const FX_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlive;
varying vec2 vP;
varying vec4 vFx;
varying vec4 vCol;
${GLSL_COMMON}
void main() {
  vec2 p = clamp(vP, vec2(-1.0), vec2(1.0));
  float type = vFx.x;
  float t = sat(vFx.y);
  float seed = vFx.z;
  vec3 c = vCol.rgb;
  vec3 col = vec3(0.0);
  if (type < 0.5) {
    // slash arc: a thin bowed stroke that draws itself along the swing, then erodes from the tail
    float k = 1.0 - p.x * p.x;
    float yc = (seed - 0.5) * 0.36 * k;
    float prof = pw(sat(k), 0.7);
    float head = -1.0 + 2.1 * easeOut(t / 0.2);
    float tail = -1.0 + 2.1 * smoothstep(0.12, 1.0, t);
    float seg = smoothstep(tail - 0.25, tail + 0.05, p.x) * (1.0 - smoothstep(head - 0.03, head + 0.03, p.x));
    float d = abs(p.y - yc);
    float w = 0.06 * prof * (1.0 - 0.6 * t) + 1e-4;
    float core = 1.0 - smoothstep(w * 0.35, w, d);
    float glow = exp(-d / (0.22 * prof + 0.02)) * prof;
    float hot = sat((vCol.a - 0.55) / 0.45);
    col = (vec3(1.5) * core * hot + c * (glow * 0.55 + core * 1.3)) * seg * (1.0 - t * t);
  } else if (type < 1.5) {
    // ring opening on the hit plane
    float r = length(p);
    float rad = mix(0.10, 0.86, easeOut(t));
    float w = mix(0.035, 0.012, t);
    float q = (r - rad) / w;
    col = c * exp(-q * q) * pw(1.0 - t, 1.6) * 1.2;
  } else if (type < 2.5) {
    // glint: a four-point sparkle, quick in and slow out
    vec2 a = abs(p);
    float s = sin(3.14159 * pw(t, 0.5));
    float len = 0.25 + 0.75 * s;
    float rayH = exp(-a.y * 34.0) * pw(sat(1.0 - a.x / len), 2.0);
    float rayV = exp(-a.x * 34.0) * pw(sat(1.0 - a.y / (len * 0.7)), 2.0);
    float cz = exp(-dot(p, p) * 55.0);
    col = (mix(c, vec3(1.0), 0.7) * (rayH + rayV) * 1.2 + vec3(1.0) * cz * 0.9) * s;
  } else if (type < 3.5) {
    // crack: three dull jagged fractures
    float acc = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float ang = seed * 6.2831 + fi * 2.2 + 0.4;
      vec2 dir = vec2(cos(ang), sin(ang));
      float al = dot(p, dir);
      float ac = dot(p, vec2(-dir.y, dir.x));
      float zig = (abs(fract(al * 4.5 + fi * 0.37) - 0.5) - 0.25) * 0.16;
      float reach = (0.45 + 0.25 * hash21(vec2(seed * 31.0, fi))) * easeOut(t * 5.0);
      float ln = (1.0 - smoothstep(0.012, 0.035, abs(ac - zig))) * step(0.02, al) * (1.0 - smoothstep(reach * 0.8, reach + 1e-3, al));
      acc += ln * (1.0 - 0.6 * al / max(reach, 1e-3));
    }
    col = c * acc * pw(1.0 - t, 1.3) * 1.4;
  } else if (type < 4.5) {
    // gold halo behind a gold shard: soft glow, slow rays, a fine ring
    float r = length(p);
    float ang = atan(p.y, p.x + 1e-5) + uTime * 0.5 + seed * 6.2831;
    float rays = pw(abs(cos(ang * 2.0)), 30.0) * exp(-r * 3.2);
    float soft = exp(-r * r * 6.0) * 0.35;
    float q = (r - 0.52) / 0.02;
    col = c * (soft + rays * 0.9 + exp(-q * q) * 0.25);
  } else {
    // arrival guide: a faint four-point star; corner ticks frame it while a shard is on its way (seed = highlight 0..1)
    vec2 a = abs(p);
    float star = exp(-a.y * 46.0) * pw(sat(1.0 - a.x * 2.6), 2.0) + exp(-a.x * 46.0) * pw(sat(1.0 - a.y * 2.6), 2.0);
    float core = exp(-dot(p, p) * 160.0);
    vec2 cc = a - vec2(0.78);
    float tickA = (1.0 - smoothstep(0.006, 0.02, abs(cc.y))) * step(-0.2, cc.x) * step(cc.x, 0.012);
    float tickB = (1.0 - smoothstep(0.006, 0.02, abs(cc.x))) * step(-0.2, cc.y) * step(cc.y, 0.012);
    col = c * ((star + core) * (0.5 + 1.2 * seed) + (tickA + tickB) * (0.9 * seed));
  }
  // soft quad border: nothing ever shows a hard edge
  float edge = (1.0 - smoothstep(0.86, 1.0, abs(p.x))) * (1.0 - smoothstep(0.86, 1.0, abs(p.y)));
  gl_FragColor = vec4(min(col * (vCol.a * edge * uAlive), vec3(6.0)), 1.0);
}
`;

// --- Sparks: instanced quads stretched along their own screen-space motion ---
const SPARK_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aMeta;   // birth, life, size (m), seed
attribute vec3 aCol;
uniform float uFx;
uniform float uAspect;
uniform float uFloor;
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
varying float vLen;
${GLSL_COMMON}
vec3 flight(float age) {
  vec3 p = aPos + aVel * ((1.0 - exp(-age * 3.0)) / 3.0);
  p.y -= 2.6 * age * age;
  p.y = abs(p.y - uFloor) + uFloor;   // skips off the glass
  return p;
}
void main() {
  float age = uFx - aMeta.x;
  float t = age / max(aMeta.y, 1e-3);
  vQ = position.xy;
  vCol = aCol;
  vA = 0.0;
  vLen = 0.0;
  if (t < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 c1 = projectionMatrix * viewMatrix * vec4(flight(age), 1.0);
  vec4 c0 = projectionMatrix * viewMatrix * vec4(flight(max(age - 0.045, 0.0)), 1.0);
  if (c1.w < 0.08 || c0.w < 0.08) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 asp = vec2(uAspect, 1.0);
  vec2 n1 = c1.xy / c1.w * asp;
  vec2 n0 = c0.xy / c0.w * asp;
  vec2 d = n1 - n0;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = max(aMeta.z * (1.0 - 0.55 * t) * projectionMatrix[1][1] / c1.w, 0.0013);
  vec2 centre = (n0 + n1) * 0.5;
  vec2 off = dir * (position.y * (len * 0.5 + r)) + nrm * (position.x * r);
  vLen = len * 0.5 / r;
  vA = pw(1.0 - t, 1.4) * smoothstep(0.0, 0.1, t) * (0.75 + 0.25 * sin(age * 38.0 + aMeta.w * 40.0));
  gl_Position = vec4((centre + off) / asp * c1.w, c1.z, c1.w);
}
`;
const SPARK_FRAG = /* glsl */ `
uniform float uAlive;
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
varying float vLen;
${GLSL_COMMON}
void main() {
  float y = vQ.y * (vLen + 1.0);
  float d = length(vec2(vQ.x, max(abs(y) - vLen, 0.0)));
  float a = 1.0 - smoothstep(0.0, 1.0, d);
  float head = 0.4 + 0.6 * smoothstep(-vLen - 1.0, vLen + 1.0, y);
  float g = (a * a + pw(a, 6.0) * 1.2) * head;
  gl_FragColor = vec4(min(vCol * (g * vA * uAlive), vec3(6.0)), 1.0);
}
`;

// --- Comets: the hands. A ribbon trail and a head per hand, always drawn on top ---
const COMET_VERT = /* glsl */ `
attribute vec2 aUv;     // ribbon: (0 head .. 1 tail, -1..1 across); head: -1..1 square
attribute vec4 aCol;    // rgb, intensity
attribute float aKind;  // 0 ribbon, 1 head
varying vec2 vUv;
varying vec4 vCol;
varying float vKind;
void main() {
  vUv = aUv;
  vCol = aCol;
  vKind = aKind;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;
const COMET_FRAG = /* glsl */ `
uniform float uAlive;
varying vec2 vUv;
varying vec4 vCol;
varying float vKind;
${GLSL_COMMON}
void main() {
  vec3 col;
  if (vKind < 0.5) {
    float a = 1.0 - min(abs(vUv.y), 1.0);
    float along = pw(1.0 - clamp(vUv.x, 0.0, 1.0), 1.5);
    float core = smoothstep(0.55, 0.95, a);
    col = (vCol.rgb * (a * a * 1.1) + mix(vCol.rgb, vec3(1.0), 0.75) * (core * 1.6 * along)) * along;
  } else {
    float r2 = dot(vUv, vUv);
    float r = sqrt(r2);
    float glow = exp(-r2 * 6.0) * 0.55 + exp(-r2 * 38.0) * 1.6;
    float q = (r - 0.42) / 0.03;
    float ring = exp(-q * q) * 0.22;
    col = (vCol.rgb * (glow + ring) + vec3(1.0) * (exp(-r2 * 90.0) * 1.4)) * (1.0 - smoothstep(0.8, 1.0, r));
  }
  gl_FragColor = vec4(min(col * (vCol.a * uAlive), vec3(6.0)), 1.0);
}
`;

// ---------------------------------------------------------------------------------------
// Crystal geometry: a shield-cut gem (table, 8 crown facets, 8 pavilion facets: broad shoulders,
// a point at the end it is cut towards — big enough to carry a bold arrow) that morphs to a
// round cut for "any direction" shards. Local frame: +y = the cut direction, +z = the face.
// Both cuts are symmetric about x = 0 and have vertices ON that plane, so a half is simply the
// faces on one side plus a cap; the other half is the same geometry mirrored per instance.
// ---------------------------------------------------------------------------------------
const KITE = [[0, 0.62], [-0.33, 0.3], [-0.46, -0.06], [-0.31, -0.4], [0, -0.54], [0.31, -0.4], [0.46, -0.06], [0.33, 0.3]];
const ROUND = [];
for (let i = 0; i < 8; i++) {
  const a = Math.PI / 2 + (i * Math.PI) / 4;
  ROUND.push([Math.cos(a) * 0.46, Math.sin(a) * 0.46]);
}
ROUND[0][0] = 0;
ROUND[4][0] = 0;

function cutPoints(outline, centreY) {
  const girdle = [];
  const table = [];
  for (let i = 0; i < 8; i++) {
    const gx = outline[i][0];
    const gy = outline[i][1];
    girdle.push([gx, gy, 0]);
    table.push([gx * 0.58, centreY + (gy - centreY) * 0.58, 0.14]);
  }
  return { girdle, table, apex: [0, centreY, 0.18], culet: [0, centreY * 0.5, -0.32], mid: [0, centreY, -0.03] };
}

function buildCrystalGeometry(half) {
  const A = cutPoints(KITE, 0.03);
  const B = cutPoints(ROUND, 0);
  const pos = [];
  const alt = [];
  const bary = [];
  const face = [];
  let facet = 0;
  const tri = (a, b, c, ba, bb, bc, cap) => {
    for (const [v, w] of [[a, ba], [b, bb], [c, bc]]) {
      pos.push(v[0][0], v[0][1], v[0][2]);
      alt.push(v[1][0], v[1][1], v[1][2]);
      bary.push(w[0], w[1], w[2]);
      face.push(facet, cap, v[2]);
    }
  };
  const P = (key, i) => (i === undefined ? [A[key], B[key], 0] : [A[key][i], B[key][i], key === 'girdle' ? 1 : 0]);
  const sides = half ? 4 : 8; // i = 0..3 are the faces with x <= 0
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % 8;
    // crown: one planar trapezoid = two triangles sharing a hidden diagonal
    tri(P('girdle', i), P('girdle', j), P('table', j), [1, 1, 0], [0, 1, 0], [0, 1, 1], 0);
    tri(P('girdle', i), P('table', j), P('table', i), [1, 1, 0], [0, 1, 1], [0, 1, 0], 0);
    facet++;
    // table: a shallow eight-sided pyramid
    tri(P('table', i), P('table', j), P('apex'), [1, 0, 0], [0, 1, 0], [0, 0, 1], 0);
    facet++;
    // pavilion
    tri(P('girdle', j), P('girdle', i), P('culet'), [1, 0, 0], [0, 1, 0], [0, 0, 1], 0);
    facet++;
  }
  if (half) {
    // the cut face: the cross-section in the plane x = 0
    const ring = [P('girdle', 0), P('table', 0), P('apex'), P('table', 4), P('girdle', 4), P('culet')];
    for (let k = 0; k < ring.length; k++) {
      tri(P('mid'), ring[k], ring[(k + 1) % ring.length], [0, 1, 1], [1, 0, 1], [1, 1, 0], 1);
    }
    facet++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aAlt', new THREE.BufferAttribute(new Float32Array(alt), 3));
  geo.setAttribute('aBary', new THREE.BufferAttribute(new Float32Array(bary), 3));
  geo.setAttribute('aFace', new THREE.BufferAttribute(new Float32Array(face), 3));
  return geo;
}

// ---------------------------------------------------------------------------------------
// createSlashView
// ---------------------------------------------------------------------------------------
/**
 * createSlashView(stage) ->
 *   { group,                      // everything the mode draws (already added to stage.scene)
 *     setActive(on),              // show / hide; when shown the lane fades in over ~0.7 s
 *     start(chart),               // new run: { notes: Note[], approachSec }
 *     update(time, dt, { songTime, beat, hands, levels, energy }),   // every frame while active, BEFORE stage.update()
 *     onEvent(ev),                // judge event { note, rating, hand, x, y, multiplier, ... }
 *     project(x, y) -> { x, y },  // pp position on the hit plane -> CSS px (same object each call)
 *     dispose(),
 *     tuning, layout, ppToWorld(x, y, out), camera: { position, target, fov } }
 *
 * The camera: the view computes a fixed first-person pose for the current aspect ratio and
 * hands it to the stage with stage.setSlashCamera(position, target, fov) on every update();
 * the stage (in 'slash' mode) eases into it. main.js only calls stage.setMode('slash').
 */
export function createSlashView(stage) {
  const tuning = { ...SLASH_VIEW_TUNING };
  const scene = stage && stage.scene;
  const camera = stage && stage.camera;
  const renderer = stage && stage.renderer;

  const PP = tuning.pp;
  const ORIGIN_Y = tuning.rowBase - GRID_Y[0] * PP; // world height of pp y = 0
  const LANE_HALF = tuning.laneHalf;
  const COL_INNER = Math.abs(GRID_X[1]) * PP;
  const COL_OUTER = Math.abs(GRID_X[0]) * PP;

  /** Height of the runway `d` metres past the hit plane (0 on the flat part and behind the plane). */
  function rampHeight(d) {
    const u = d - tuning.rampStart;
    if (!(u > 0)) return 0;
    const L = Math.max(tuning.rampEase, 0.01);
    return u < L ? (tuning.rampSlope * u * u) / (2 * L) : tuning.rampSlope * (u - L / 2);
  }
  /** Slope of the runway there (rise per metre away from the player). */
  function rampSlopeAt(d) {
    return tuning.rampSlope * clamp01((d - tuning.rampStart) / Math.max(tuning.rampEase, 0.01));
  }

  const group = new THREE.Group();
  group.name = 'slash-view';
  group.visible = false;
  if (scene) scene.add(group);
  // Layer 1 = "not in the floor mirror". The stage's reflection camera only sees layer 0.
  if (camera) camera.layers.enable(1);

  const COL = {
    l: new THREE.Color(HEX.teal),
    r: new THREE.Color(HEX.amber),
    either: new THREE.Color(HEX.either),
    gold: new THREE.Color(HEX.gold),
    white: new THREE.Color(1, 1, 1),
    crack: new THREE.Color(0.8, 0.11, 0.15),
  };
  const HAND_COL = [COL.l, COL.r, COL.either];
  const lanePale = new THREE.Color(HEX.violet).lerp(COL.either, 0.55); // neutral lane colour

  // scratch (never allocate in update / onEvent)
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();
  const _axis = new THREE.Vector3();
  const _projected = { x: 0, y: 0 };
  const _shard = { x: 0, y: 0, z: 0, alpha: 0, scale: 1, dull: 0, tiltX: 0, tiltY: 0 };

  // ---------- run state ----------
  let active = false;
  let alive = 0; // fade of the whole mode
  let fx = 0; // effect clock (s), advances with dt
  let songNow = -1e9;
  let lastSong = -1e9;
  let approach = 1.7;
  let kickSm = 0;
  let energySm = 0.4;
  let heat = 0;
  let heatTarget = 0;
  let lastHands = null;
  let visibleCount = 0;

  // notes, flattened at start()
  let count = 0;
  let nTime = new Float32Array(0);
  let nX = new Float32Array(0); // world x
  let nY = new Float32Array(0); // world y
  let nAng = new Float32Array(0); // roll of the cut direction (rad)
  let nDx = new Float32Array(0);
  let nDy = new Float32Array(0);
  let nSeed = new Float32Array(0);
  let nEvAt = new Float32Array(0); // effect-clock time of the MISS
  let nHand = new Uint8Array(0); // 0 l, 1 r, 2 either
  let nAny = new Uint8Array(0);
  let nGold = new Uint8Array(0);
  let nCell = new Uint8Array(0);
  let nState = new Uint8Array(0);
  let order = new Uint32Array(0); // note indices sorted by time
  let sTime = new Float32Array(0); // times in sorted order
  let lo = 0;
  let hi = -1;
  const idIndex = new Map();

  // ---------- runway ----------
  const ripU = [];
  const ripColU = [];
  for (let i = 0; i < RIP_MAX; i++) {
    ripU.push(new THREE.Vector4(0, 0, -1000, 0));
    ripColU.push(new THREE.Vector4(0, 0, 0, 1));
  }
  let ripCursor = 0;
  const runwayMat = new THREE.ShaderMaterial({
    uniforms: {
      uHalf: { value: LANE_HALF },
      uTravel: { value: 0 },
      uBeat: { value: 0 },
      uRung: { value: tuning.speed * SEC_PER_BEAT },
      uKick: { value: 0 },
      uEnergy: { value: 0.4 },
      uHeat: { value: 0 },
      uFx: { value: 0 },
      uAlive: { value: 0 },
      uGlow: { value: 1 },
      uStreaks: { value: 1 },
      uNear: { value: RUNWAY_NEAR },
      uLen: { value: RUNWAY_FAR },
      uCols: { value: new THREE.Vector2(COL_INNER, COL_OUTER) },
      uRamp: { value: new THREE.Vector3(tuning.rampStart, tuning.rampEase, tuning.rampSlope) },
      uRip: { value: ripU },
      uRipCol: { value: ripColU },
      uColL: { value: COL.l.clone() },
      uColR: { value: COL.r.clone() },
      uColN: { value: lanePale.clone() },
      uColWarm: { value: new THREE.Color().setRGB(1.0, 0.55, 0.22) },
    },
    vertexShader: RUNWAY_VERT,
    fragmentShader: RUNWAY_FRAG,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
  });
  const runwayGeo = new THREE.PlaneGeometry(2 * (LANE_HALF + 0.9), RUNWAY_NEAR + RUNWAY_FAR, 1, 92);
  runwayGeo.rotateX(-Math.PI / 2);
  runwayGeo.translate(0, RUNWAY_Y, (RUNWAY_NEAR - RUNWAY_FAR) / 2);
  {
    const rp = runwayGeo.getAttribute('position');
    for (let i = 0; i < rp.count; i++) rp.setY(i, RUNWAY_Y + rampHeight(-rp.getZ(i)));
  }
  const runway = new THREE.Mesh(runwayGeo, runwayMat);
  runway.frustumCulled = false;
  runway.renderOrder = 1;
  runway.layers.set(1);
  runway.name = 'slash-runway';
  group.add(runway);

  // ---------- crystals ----------
  const starDir = new THREE.Vector3(0, Math.sin(THREE.MathUtils.degToRad(9)), -Math.cos(THREE.MathUtils.degToRad(9)));
  function crystalMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uAlive: { value: 0 }, uStarDir: { value: starDir.clone() } },
      vertexShader: CRYSTAL_VERT,
      fragmentShader: CRYSTAL_FRAG,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });
  }
  function crystalMesh(geo, max, name, renderOrder) {
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    const state = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    const extra = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    tint.setUsage(THREE.DynamicDrawUsage);
    state.setUsage(THREE.DynamicDrawUsage);
    extra.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTint', tint);
    geo.setAttribute('aState', state);
    geo.setAttribute('aExtra', extra);
    const mat = crystalMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.count = 0;
    mesh.name = name;
    group.add(mesh); // layer 0: the floor mirrors the crystals
    return { mesh, mat, tint, state, extra };
  }
  const shardGeo = buildCrystalGeometry(false);
  const halfGeo = buildCrystalGeometry(true);
  const shards = crystalMesh(shardGeo, MAX_SHARDS, 'slash-shards', 2);
  const halves = crystalMesh(halfGeo, MAX_HALVES, 'slash-halves', 3);

  // halves pool (simulated on the CPU: at most MAX_HALVES tiny bodies)
  const hAlive = new Uint8Array(MAX_HALVES);
  const hF = new Float32Array(MAX_HALVES * 26);
  // layout per half: 0 age, 1 life, 2-4 pos, 5-7 vel, 8-11 base quat, 12-14 spin axis (local), 15 spin rate,
  //                  16 scale, 17 side, 18-20 rgb, 21 flags (1 any, 2 gold, 4 bad), 22 seed, 23 heat time constant,
  //                  24 heat of the cut face at birth, 25 glow of the stone at birth
  let hCursor = 0;

  // ---------- pools ----------
  const poolGeo = new THREE.PlaneGeometry(2, 2);
  const poolAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHARDS * 4), 4);
  poolAttr.setUsage(THREE.DynamicDrawUsage);
  poolGeo.setAttribute('aPool', poolAttr);
  const additive = (vertexShader, fragmentShader, uniforms, extra) =>
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      ...extra,
    });
  const poolMat = additive(POOL_VERT, POOL_FRAG, { uAlive: { value: 0 } });
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, MAX_SHARDS);
  pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pools.frustumCulled = false;
  pools.renderOrder = 41;
  pools.count = 0;
  pools.layers.set(1);
  pools.name = 'slash-pools';
  group.add(pools);
  const X_AXIS = new THREE.Vector3(1, 0, 0);

  // ---------- fx quads (guide marks, gold halos, transient effects) ----------
  const fxGeo = new THREE.PlaneGeometry(2, 2);
  const fxData = new Float32Array(FX_MAX * 4);
  const fxCol = new Float32Array(FX_MAX * 4);
  for (let i = 0; i < FX_MAX; i++) {
    fxData[i * 4 + 1] = -1000;
    fxData[i * 4 + 2] = 1;
  }
  const fxAttr = new THREE.InstancedBufferAttribute(fxData, 4);
  const fxColAttr = new THREE.InstancedBufferAttribute(fxCol, 4);
  fxAttr.setUsage(THREE.DynamicDrawUsage);
  fxColAttr.setUsage(THREE.DynamicDrawUsage);
  fxGeo.setAttribute('aFx', fxAttr);
  fxGeo.setAttribute('aFxCol', fxColAttr);
  const fxMat = additive(FX_VERT, FX_FRAG, { uFx: { value: 0 }, uTime: { value: 0 }, uAlive: { value: 0 } });
  const fxMesh = new THREE.InstancedMesh(fxGeo, fxMat, FX_MAX);
  fxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  fxMesh.frustumCulled = false;
  fxMesh.renderOrder = 42;
  fxMesh.layers.set(1);
  fxMesh.name = 'slash-fx';
  group.add(fxMesh);
  let fxCursor = FX_POOL;
  _m.makeScale(0, 0, 0);
  for (let i = 0; i < FX_MAX; i++) fxMesh.setMatrixAt(i, _m);
  // the 4 x 3 arrival guide: twelve persistent marks on the hit plane
  const cellGlow = new Float32Array(12);
  const cellRGB = new Float32Array(36);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const i = FX_GUIDE + row * 4 + col;
      _p.set(GRID_X[col] * PP, ORIGIN_Y + GRID_Y[row] * PP, Z_HIT);
      _q.identity();
      _s.set(0.3, 0.3, 1);
      _m.compose(_p, _q, _s);
      fxMesh.setMatrixAt(i, _m);
      fxData[i * 4] = FX_GUIDE_T;
      fxData[i * 4 + 1] = 0;
      fxData[i * 4 + 2] = -1;
      fxData[i * 4 + 3] = 0;
    }
  }
  for (let k = 0; k < 4; k++) {
    const i = FX_HALO + k;
    fxData[i * 4] = FX_HALO_T;
    fxData[i * 4 + 2] = -1;
    fxData[i * 4 + 3] = k * 0.27;
  }

  /** One transient effect quad. `roll` turns it in the hit plane; birth may lie in the future (delay). */
  function spawnFx(type, x, y, z, roll, sx, sy, color, intensity, duration, delay) {
    const i = fxCursor;
    fxCursor = fxCursor + 1 >= FX_MAX ? FX_POOL : fxCursor + 1;
    _p.set(x, y, z);
    _e.set(-0.12, 0, roll, 'XYZ');
    _q.setFromEuler(_e);
    _s.set(sx, sy, 1);
    _m.compose(_p, _q, _s);
    fxMesh.setMatrixAt(i, _m);
    const k = i * 4;
    fxData[k] = type;
    fxData[k + 1] = fx + delay;
    fxData[k + 2] = Math.max(duration, 0.02);
    fxData[k + 3] = Math.random();
    fxCol[k] = color.r;
    fxCol[k + 1] = color.g;
    fxCol[k + 2] = color.b;
    fxCol[k + 3] = intensity * tuning.fxPower;
  }

  // ---------- sparks ----------
  const sparkGeo = new THREE.InstancedBufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
  sparkGeo.setIndex([0, 1, 2, 2, 1, 3]);
  const sparkPos = new Float32Array(SPARK_MAX * 3);
  const sparkVel = new Float32Array(SPARK_MAX * 3);
  const sparkMeta = new Float32Array(SPARK_MAX * 4);
  const sparkCol = new Float32Array(SPARK_MAX * 3);
  for (let i = 0; i < SPARK_MAX; i++) {
    sparkMeta[i * 4] = -1000;
    sparkMeta[i * 4 + 1] = 1;
  }
  const sparkPosAttr = new THREE.InstancedBufferAttribute(sparkPos, 3);
  const sparkVelAttr = new THREE.InstancedBufferAttribute(sparkVel, 3);
  const sparkMetaAttr = new THREE.InstancedBufferAttribute(sparkMeta, 4);
  const sparkColAttr = new THREE.InstancedBufferAttribute(sparkCol, 3);
  sparkPosAttr.setUsage(THREE.DynamicDrawUsage);
  sparkVelAttr.setUsage(THREE.DynamicDrawUsage);
  sparkMetaAttr.setUsage(THREE.DynamicDrawUsage);
  sparkColAttr.setUsage(THREE.DynamicDrawUsage);
  sparkGeo.setAttribute('aPos', sparkPosAttr);
  sparkGeo.setAttribute('aVel', sparkVelAttr);
  sparkGeo.setAttribute('aMeta', sparkMetaAttr);
  sparkGeo.setAttribute('aCol', sparkColAttr);
  sparkGeo.instanceCount = SPARK_MAX;
  const sparkMat = additive(SPARK_VERT, SPARK_FRAG, {
    uFx: { value: 0 },
    uAspect: { value: 16 / 9 },
    uFloor: { value: RUNWAY_Y + 0.02 },
    uAlive: { value: 0 },
  });
  const sparks = new THREE.Mesh(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  sparks.renderOrder = 43;
  sparks.layers.set(1);
  sparks.name = 'slash-sparks';
  group.add(sparks);
  let sparkCursor = 0;
  let sparkDirty = false;
  let sparkAliveUntil = -1;

  function spawnSpark(x, y, z, vx, vy, vz, life, size, color, whiten, hot) {
    const i = sparkCursor;
    sparkCursor = (sparkCursor + 1) % SPARK_MAX;
    const a = i * 3;
    sparkPos[a] = x;
    sparkPos[a + 1] = y;
    sparkPos[a + 2] = z;
    sparkVel[a] = vx;
    sparkVel[a + 1] = vy;
    sparkVel[a + 2] = vz;
    const m = i * 4;
    sparkMeta[m] = fx;
    sparkMeta[m + 1] = life;
    sparkMeta[m + 2] = size;
    sparkMeta[m + 3] = Math.random();
    const k = hot * tuning.fxPower;
    sparkCol[a] = lerp(color.r, 1, whiten) * k;
    sparkCol[a + 1] = lerp(color.g, 1, whiten) * k;
    sparkCol[a + 2] = lerp(color.b, 1, whiten) * k;
    sparkDirty = true;
    if (fx + life > sparkAliveUntil) sparkAliveUntil = fx + life;
  }

  /** A fan of sparks thrown along (dx, dy) in the hit plane from (x, y, z). */
  function sparkFan(n, x, y, z, dx, dy, spread, speed, color, life, size) {
    const base = Math.atan2(dy, dx);
    for (let k = 0; k < n; k++) {
      const a = base + (Math.random() - 0.5) * 2 * spread * (0.35 + 0.65 * Math.random());
      const v = speed * (0.35 + 0.85 * Math.random());
      const hero = Math.random() < 0.16;
      spawnSpark(
        x + (Math.random() - 0.5) * 0.2,
        y + (Math.random() - 0.5) * 0.2,
        z + (Math.random() - 0.5) * 0.1,
        Math.cos(a) * v,
        Math.sin(a) * v + 0.6,
        (Math.random() - 0.62) * 2.2,
        life * (0.55 + 0.6 * Math.random()),
        size * (hero ? 1.7 : 0.6 + 0.7 * Math.random()),
        color,
        Math.random() < 0.2 ? 0.7 : 0.05,
        hero ? 2.0 : 0.9 + 0.8 * Math.random()
      );
    }
  }

  /** Sparks in every direction of the hit plane (gold). */
  function sparkRing(n, x, y, z, speed, color, life, size) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU;
      const v = speed * (0.55 + 0.6 * Math.random());
      spawnSpark(
        x + Math.cos(a) * 0.1,
        y + Math.sin(a) * 0.1,
        z,
        Math.cos(a) * v,
        Math.sin(a) * v + 0.5,
        (Math.random() - 0.6) * 1.6,
        life * (0.6 + 0.5 * Math.random()),
        size * (0.6 + 0.8 * Math.random()),
        color,
        Math.random() < 0.3 ? 0.7 : 0.1,
        1.0 + 0.8 * Math.random()
      );
    }
  }

  function ripple(x, z, color, strength, reach, delay) {
    ripU[ripCursor].set(x, z, fx + delay, strength * tuning.fxPower);
    ripColU[ripCursor].set(color.r, color.g, color.b, reach);
    ripCursor = (ripCursor + 1) % RIP_MAX;
  }

  // ---------- comets (hands) ----------
  const RIB_VERTS = TRAIL_PTS * 2;
  const HAND_VERTS = RIB_VERTS + 4;
  const cometPos = new Float32Array(HAND_VERTS * 2 * 3);
  const cometUv = new Float32Array(HAND_VERTS * 2 * 2);
  const cometCol = new Float32Array(HAND_VERTS * 2 * 4);
  const cometKind = new Float32Array(HAND_VERTS * 2);
  const cometIdx = [];
  for (let h = 0; h < 2; h++) {
    const base = h * HAND_VERTS;
    for (let j = 0; j < TRAIL_PTS; j++) {
      const u = j / (TRAIL_PTS - 1);
      cometUv[(base + j * 2) * 2] = u;
      cometUv[(base + j * 2) * 2 + 1] = -1;
      cometUv[(base + j * 2 + 1) * 2] = u;
      cometUv[(base + j * 2 + 1) * 2 + 1] = 1;
      if (j < TRAIL_PTS - 1) {
        const a = base + j * 2;
        cometIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const hv = base + RIB_VERTS;
    const corners = [-1, -1, 1, -1, -1, 1, 1, 1];
    for (let k = 0; k < 4; k++) {
      cometUv[(hv + k) * 2] = corners[k * 2];
      cometUv[(hv + k) * 2 + 1] = corners[k * 2 + 1];
      cometKind[hv + k] = 1;
    }
    cometIdx.push(hv, hv + 1, hv + 2, hv + 2, hv + 1, hv + 3);
  }
  const cometGeo = new THREE.BufferGeometry();
  const cometPosAttr = new THREE.BufferAttribute(cometPos, 3);
  const cometColAttr = new THREE.BufferAttribute(cometCol, 4);
  cometPosAttr.setUsage(THREE.DynamicDrawUsage);
  cometColAttr.setUsage(THREE.DynamicDrawUsage);
  cometGeo.setAttribute('position', cometPosAttr);
  cometGeo.setAttribute('aUv', new THREE.BufferAttribute(cometUv, 2));
  cometGeo.setAttribute('aCol', cometColAttr);
  cometGeo.setAttribute('aKind', new THREE.BufferAttribute(cometKind, 1));
  cometGeo.setIndex(cometIdx);
  const cometMat = additive(COMET_VERT, COMET_FRAG, { uAlive: { value: 0 } }, { depthTest: false });
  const comets = new THREE.Mesh(cometGeo, cometMat);
  comets.frustumCulled = false;
  comets.renderOrder = 46;
  comets.layers.set(1);
  comets.name = 'slash-comets';
  group.add(comets);

  function makeHand() {
    return {
      x: 0, y: 0, seen: 0, speed: 0, fresh: true, head: 0,
      hx: new Float32Array(TRAIL_HIST), hy: new Float32Array(TRAIL_HIST), ht: new Float32Array(TRAIL_HIST),
      sx: new Float32Array(TRAIL_PTS), sy: new Float32Array(TRAIL_PTS),
    };
  }
  const handState = [makeHand(), makeHand()];

  // ---------- camera ----------
  const camPos = new THREE.Vector3(0, tuning.camHeight, 3.3);
  const camTgt = new THREE.Vector3(0, tuning.camAimY, 0);
  const camInfo = { position: camPos, target: camTgt, fov: tuning.camFov };
  let fitAspect = -1; // signature of the last fit (aspect ratio + framing knobs)
  let fitDist = 3.3;

  /** Does the 4 x 3 grid (shards included) fit the safe frame from `dist` metres behind the hit plane? */
  function gridFits(dist, aspect) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(tuning.camFov) * 0.5);
    const eye = tuning.camHeight;
    const th = Math.atan2(eye - tuning.camAimY, dist);
    const sn = Math.sin(th);
    const cs = Math.cos(th);
    const reach = 0.64 * tuning.shardSize * tuning.goldScale;
    const yTop = ORIGIN_Y + GRID_Y[2] * PP + reach - eye;
    const yBot = ORIGIN_Y + GRID_Y[0] * PP - reach - eye;
    const xMax = COL_OUTER + reach;
    const dTop = -yTop * sn + dist * cs;
    const dBot = -yBot * sn + dist * cs;
    if (!(dTop > 0.3) || !(dBot > 0.3)) return false;
    if ((yTop * cs + dist * sn) / (dTop * tanV) > tuning.frameTop) return false;
    if ((yBot * cs + dist * sn) / (dBot * tanV) < -tuning.frameBottom) return false;
    if (xMax / (Math.min(dTop, dBot) * tanV * aspect) > tuning.frameSide) return false;
    return true;
  }

  function fitCamera(aspect) {
    const a = finite(aspect, 16 / 9) > 0.2 ? aspect : 16 / 9;
    // refit when the aspect ratio or any framing knob changes
    const key = a * 1000 + tuning.camFov + tuning.camHeight * 3.1 + tuning.camAimY * 7.3 + tuning.camMinDist * 11.7
      + tuning.frameTop * 13.3 + tuning.frameBottom * 17.9 + tuning.frameSide * 19.1 + tuning.shardSize * 23.3 + tuning.goldScale * 29.9;
    if (Math.abs(key - fitAspect) < 1e-6) return;
    fitAspect = key;
    let near = tuning.camMinDist;
    let farD = 30;
    if (gridFits(near, a)) {
      fitDist = near;
      return;
    }
    for (let i = 0; i < 22; i++) {
      const mid = (near + farD) * 0.5;
      if (gridFits(mid, a)) farD = mid;
      else near = mid;
    }
    fitDist = farD;
  }

  // ---------- public: pp -> world, project ----------
  function ppToWorld(x, y, out) {
    const o = out || _v;
    o.set(finite(x, 0) * PP, ORIGIN_Y + finite(y, 0) * PP, Z_HIT);
    return o;
  }

  function project(x, y) {
    if (!camera) return _projected;
    _v.set(finite(x, 0) * PP, ORIGIN_Y + finite(y, 0) * PP, Z_HIT).project(camera);
    const el = renderer && renderer.domElement;
    const w = (el && el.clientWidth) || (typeof window !== 'undefined' ? window.innerWidth : 0) || 1;
    const h = (el && el.clientHeight) || (typeof window !== 'undefined' ? window.innerHeight : 0) || 1;
    _projected.x = (_v.x * 0.5 + 0.5) * w + ((el && el.offsetLeft) || 0);
    _projected.y = (0.5 - _v.y * 0.5) * h + ((el && el.offsetTop) || 0);
    return _projected;
  }

  // ---------- shard kinematics: a pure function of (note, song time) ----------
  /** Fills _shard with where note i is at song time t (missed shards also use the effect clock). */
  function placeShard(i, t) {
    const tau = nTime[i] - t;
    const speed = tuning.speed;
    let z;
    let lift = 0;
    let alpha = 1;
    let dull = 0;
    let pop = 0;
    if (tau >= 0) {
      z = -speed * tau;
      const f = tau - (approach - tuning.fallIn);
      if (f > 0) {
        z -= tuning.fallBoost * f * f;
        lift = tuning.fallLift * f * f;
      }
      alpha = smooth01(0, 0.3, approach - tau);
    } else {
      const a = -tau;
      z = (speed * a) / (1 + (speed / Math.max(tuning.dock, 0.01)) * a);
      dull = 0.55 * smooth01(0.22, 0.5, a);
      pop = 0.1 * Math.exp(-a / 0.05);
    }
    let y = nY[i] + lift + rampHeight(-z);
    let x = nX[i];
    if (nState[i] === MISSED) {
      const m = Math.max(fx - nEvAt[i], 0);
      z += 7 * m + 34 * m * m;
      y -= 1.6 * m * m + 0.25 * m;
      x += (nX[i] >= 0 ? 1 : -1) * 0.5 * m;
      alpha *= 1 - smooth01(0.02, 0.34, m);
      dull = Math.max(dull, 0.9);
    }
    const s = _shard;
    s.x = x;
    s.y = y;
    s.z = z;
    s.alpha = alpha;
    s.dull = dull;
    s.scale = tuning.shardSize * (nGold[i] ? tuning.goldScale : 1) * (1 + tuning.farScale * smooth01(5, 26, -z)) * (0.55 + 0.45 * alpha) * (1 + pop);
    const sd = nSeed[i];
    s.tiltX = -0.17 + 0.13 * Math.sin(t * 2.3 + sd * 6.283);
    s.tiltY = 0.17 * Math.sin(t * 1.7 + sd * 11.0);
    return s;
  }

  // ---------- cut / bad effects ----------
  function spawnHalf(side, x, y, z, vx, vy, vz, roll, tiltX, tiltY, scale, color, flags, life, spin, heatTau, seed, heatAmp, glowAmp) {
    const h = hCursor;
    hCursor = (hCursor + 1) % MAX_HALVES;
    hAlive[h] = 1;
    const o = h * 26;
    hF[o] = 0;
    hF[o + 1] = life;
    hF[o + 2] = x;
    hF[o + 3] = y;
    hF[o + 4] = z;
    hF[o + 5] = vx;
    hF[o + 6] = vy;
    hF[o + 7] = vz;
    _e.set(tiltX, tiltY, roll, 'XYZ');
    _q.setFromEuler(_e);
    hF[o + 8] = _q.x;
    hF[o + 9] = _q.y;
    hF[o + 10] = _q.z;
    hF[o + 11] = _q.w;
    // spin mostly about the cut line (the halves open like a book), with a little tumble
    _axis.set((Math.random() - 0.5) * 0.5, 1, (Math.random() - 0.5) * 0.7).normalize();
    hF[o + 12] = _axis.x;
    hF[o + 13] = _axis.y;
    hF[o + 14] = _axis.z;
    hF[o + 15] = spin;
    hF[o + 16] = scale;
    hF[o + 17] = side;
    hF[o + 18] = color.r;
    hF[o + 19] = color.g;
    hF[o + 20] = color.b;
    hF[o + 21] = flags;
    hF[o + 22] = seed;
    hF[o + 23] = heatTau;
    hF[o + 24] = heatAmp;
    hF[o + 25] = glowAmp;
  }

  /**
   * A clean cut at world (x, y, z): two halves fly apart across the swing (sx, sy), a spark fan
   * along it, a slash arc, a ripple under it. PERFECT adds a glint, a ring, hotter halves and a
   * second ripple; gold adds a wide ring, a burst in every direction and an amber ripple.
   */
  function fireCut(x, y, z, roll, tiltX, tiltY, scale, hand, any, gold, perfect, sx, sy, seed) {
    const color = HAND_COL[hand];
    const flags = (any ? 1 : 0) | (gold ? 2 : 0);
    // the split line is the stone's own +y axis
    const ax = -Math.sin(roll);
    const ay = Math.cos(roll);
    const px = ay; // local +x in the hit plane
    const py = -ax;
    const sep = (perfect ? 2.5 : 1.8) + Math.random() * 0.5;
    const carry = perfect ? 2.3 : 1.5;
    const life = perfect ? 0.62 : 0.5;
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1; // +1 = the x <= 0 half, which leaves toward -x
      const out = -side * sep * (0.9 + 0.2 * Math.random());
      spawnHalf(
        side, x, y, z,
        px * out + sx * carry,
        py * out + sy * carry + 0.7,
        -0.5 - Math.random() * 0.8,
        roll, tiltX, tiltY, scale, color, flags, life,
        side * (7 + Math.random() * 5),
        perfect ? 0.2 : 0.12,
        seed,
        perfect ? 1 : 0.5,
        perfect ? 0.8 : 0.4
      );
    }
    const swing = Math.atan2(sy, sx);
    const n = Math.round((perfect ? 26 : 11) * tuning.sparks);
    sparkFan(n, x, y, z + 0.05, sx, sy, perfect ? 0.75 : 0.55, perfect ? 9.5 : 6.5, color, perfect ? 0.5 : 0.36, perfect ? 0.024 : 0.02);
    spawnFx(FX_ARC, x, y, z + 0.06, swing, perfect ? 0.5 : 0.4, 0.2, color, perfect ? 1.0 : 0.7, perfect ? 0.32 : 0.24, 0);
    ripple(x, z, color, perfect ? 0.45 : 0.28, perfect ? 1.25 : 0.85, 0);
    if (perfect) {
      spawnFx(FX_GLINT, x, y, z + 0.08, 0.2, 0.5, 0.5, color, 0.7, 0.28, 0);
      spawnFx(FX_RING, x, y, z + 0.04, 0, 0.36, 0.36, color, 0.5, 0.3, 0.02);
    }
    if (gold) {
      // the big moment stays compact: one gold ring, a short burst all round, a second ripple
      sparkRing(Math.round(24 * tuning.sparks), x, y, z + 0.05, 4.6, COL.gold, 0.5, 0.02);
      spawnFx(FX_RING, x, y, z + 0.03, 0, 0.56, 0.56, COL.gold, perfect ? 0.8 : 0.6, 0.42, 0.04);
      spawnFx(FX_GLINT, x, y, z + 0.09, 0.78, 0.66, 0.66, COL.gold, 0.8, 0.36, 0);
      ripple(x, z, COL.gold, 0.55, 1.7, 0.06);
    }
  }

  /** BAD: no split. A dull crack, a few falling embers, and the whole stone tumbles away. */
  function fireBad(x, y, z, roll, tiltX, tiltY, scale, any, gold, sx, sy, seed) {
    const flags = (any ? 1 : 0) | (gold ? 2 : 0) | 4;
    const vx = sx * 1.1 + (Math.random() - 0.5) * 0.8;
    const vy = sy * 0.6 - 0.4;
    const vz = -2.2 - Math.random() * 0.8;
    const spin = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3);
    const slot = hCursor;
    spawnHalf(1, x, y, z, vx, vy, vz, roll, tiltX, tiltY, scale, COL.crack, flags, 0.62, spin, 0.01, seed, 0, 0);
    spawnHalf(-1, x, y, z, vx, vy, vz, roll, tiltX, tiltY, scale, COL.crack, flags, 0.62, spin, 0.01, seed, 0, 0);
    // both halves share one tumble axis so the stone stays whole
    const a = slot * 26;
    const b = ((slot + 1) % MAX_HALVES) * 26;
    _axis.set(0.8, 0.3 + Math.random() * 0.4, 0.5).normalize();
    hF[a + 12] = hF[b + 12] = _axis.x;
    hF[a + 13] = hF[b + 13] = _axis.y;
    hF[a + 14] = hF[b + 14] = _axis.z;
    spawnFx(FX_CRACK, x, y, z + 0.07, Math.random() * TAU, 0.5, 0.5, COL.crack, 1.0, 0.36, 0);
    for (let k = 0; k < Math.round(7 * tuning.sparks); k++) {
      spawnSpark(
        x + (Math.random() - 0.5) * 0.25, y + (Math.random() - 0.5) * 0.25, z + 0.05,
        (Math.random() - 0.5) * 2.4, -0.5 - Math.random() * 1.6, (Math.random() - 0.6) * 1.2,
        0.3 + Math.random() * 0.25, 0.02, COL.crack, 0.1, 0.9
      );
    }
    ripple(x, z, COL.crack, 0.3, 1.0, 0);
  }

  // ---------- API: start ----------
  function start(chart) {
    const notes = chart && Array.isArray(chart.notes) ? chart.notes : [];
    approach = clamp(finite(chart && chart.approachSec, 1.7), 0.8, 4);
    count = notes.length;
    nTime = new Float32Array(count);
    nX = new Float32Array(count);
    nY = new Float32Array(count);
    nAng = new Float32Array(count);
    nDx = new Float32Array(count);
    nDy = new Float32Array(count);
    nSeed = new Float32Array(count);
    nEvAt = new Float32Array(count);
    nHand = new Uint8Array(count);
    nAny = new Uint8Array(count);
    nGold = new Uint8Array(count);
    nCell = new Uint8Array(count);
    nState = new Uint8Array(count);
    idIndex.clear();
    const idx = [];
    for (let i = 0; i < count; i++) {
      const n = notes[i] || {};
      const col = clamp(Math.round(finite(n.col, 0)), 0, 3);
      const row = clamp(Math.round(finite(n.row, 0)), 0, 2);
      const x = finite(n.x, GRID_X[col]);
      const y = finite(n.y, GRID_Y[row]);
      nTime[i] = finite(n.time, 0);
      nX[i] = x * PP;
      nY[i] = ORIGIN_Y + y * PP;
      const d = typeof n.dir === 'string' ? DIR_VEC[n.dir] : null;
      nAny[i] = d ? 0 : 1;
      nDx[i] = d ? d[0] : 0;
      nDy[i] = d ? d[1] : 1;
      nAng[i] = d ? Math.atan2(-d[0], d[1]) : 0;
      nHand[i] = n.hand === 'l' ? 0 : n.hand === 'r' ? 1 : 2;
      nGold[i] = n.gold ? 1 : 0;
      nSeed[i] = frac(Math.sin((i + 1) * 12.9898) * 43758.5453);
      // nearest guide cell (charts may nudge x / y off the grid)
      let bc = 0;
      let br = 0;
      for (let c = 1; c < 4; c++) if (Math.abs(GRID_X[c] - x) < Math.abs(GRID_X[bc] - x)) bc = c;
      for (let r = 1; r < 3; r++) if (Math.abs(GRID_Y[r] - y) < Math.abs(GRID_Y[br] - y)) br = r;
      nCell[i] = br * 4 + bc;
      if (n.id !== undefined && n.id !== null) idIndex.set(n.id, i);
      idx.push(i);
    }
    idx.sort((a, b) => nTime[a] - nTime[b] || a - b);
    order = Uint32Array.from(idx);
    sTime = new Float32Array(count);
    for (let k = 0; k < count; k++) sTime[k] = nTime[order[k]];
    lo = 0;
    hi = -1;
    lastSong = -1e9;
    songNow = -1e9;
    heat = 0;
    heatTarget = 0;
    // clear every pool
    hAlive.fill(0);
    halves.mesh.count = 0;
    shards.mesh.count = 0;
    pools.count = 0;
    for (let i = FX_POOL; i < FX_MAX; i++) fxData[i * 4 + 1] = -1000;
    for (let i = 0; i < SPARK_MAX; i++) sparkMeta[i * 4] = -1000;
    for (let i = 0; i < RIP_MAX; i++) ripU[i].z = -1000;
    fxAttr.needsUpdate = true;
    sparkMetaAttr.needsUpdate = true;
    sparkAliveUntil = -1;
    handState[0].fresh = true;
    handState[1].fresh = true;
  }

  // ---------- API: setActive ----------
  function setActive(on) {
    const next = !!on;
    if (next === active) return;
    active = next;
    group.visible = next;
    if (next) alive = 0; // the lane fades in
  }

  // ---------- API: onEvent ----------
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    const note = ev.note;
    const rating = ev.rating;
    let i = -1;
    if (note && note.id !== undefined && note.id !== null) {
      const k = idIndex.get(note.id);
      if (k !== undefined) i = k;
    }
    // the lane heats up with the multiplier and cools the moment the combo breaks
    const mult = finite(ev.multiplier, NaN);
    if (rating === 'miss' || rating === 'bad') heatTarget = 0;
    else if (Number.isFinite(mult)) heatTarget = clamp01((mult - 1) / 3);

    if (rating === 'miss') {
      if (i >= 0 && nState[i] === LIVE) {
        nState[i] = MISSED;
        nEvAt[i] = fx;
      }
      return;
    }
    if (rating !== 'perfect' && rating !== 'good' && rating !== 'bad') return;
    if (i >= 0 && nState[i] === GONE) return; // already cut

    // where the stone is right now, how it is turned, how big it is
    let x;
    let y;
    let z = 0.2;
    let roll = 0;
    let tiltX = -0.17;
    let tiltY = 0;
    let scale = tuning.shardSize;
    let any = 1;
    let gold = 0;
    let seed = Math.random();
    let ndx = 0;
    let ndy = 0;
    if (i >= 0) {
      const s = placeShard(i, songNow > -1e8 ? songNow : nTime[i]);
      x = s.x;
      y = s.y;
      z = s.z;
      tiltX = s.tiltX;
      tiltY = s.tiltY;
      scale = s.scale;
      roll = nAng[i];
      any = nAny[i];
      gold = nGold[i];
      seed = nSeed[i];
      ndx = any ? 0 : nDx[i];
      ndy = any ? 0 : nDy[i];
      nState[i] = GONE;
    } else {
      x = finite(ev.x, 0) * PP;
      y = ORIGIN_Y + finite(ev.y, 0) * PP;
      gold = note && note.gold ? 1 : 0;
    }
    // which hand: the one that cut (an either-hand shard takes the cutting hand's colour)
    const hk = ev.hand === 'l' || ev.hand === 'r' ? ev.hand : note && (note.hand === 'l' || note.hand === 'r') ? note.hand : null;
    const hand = hk === 'l' ? 0 : hk === 'r' ? 1 : i >= 0 ? nHand[i] : 2;
    // swing direction: the hand's velocity when it is trustworthy, else the marked direction
    let sx = 0;
    let sy = 0;
    const hf = lastHands && hk ? lastHands[hk] : null;
    if (hf && finite(hf.seen, 0) > 0.3) {
      const vx = finite(hf.vx, 0);
      const vy = finite(hf.vy, 0);
      const sp = Math.hypot(vx, vy);
      if (sp > 0.8) {
        sx = vx / sp;
        sy = vy / sp;
      }
    }
    const marked = ndx !== 0 || ndy !== 0;
    if (rating !== 'bad' && marked && sx * ndx + sy * ndy < 0.25) {
      // a clean cut follows the mark; a stale velocity sample must not contradict the judge
      sx = ndx;
      sy = ndy;
    }
    if (sx === 0 && sy === 0) {
      if (marked) {
        sx = rating === 'bad' ? -ndx : ndx;
        sy = rating === 'bad' ? -ndy : ndy;
      } else {
        const a = seed * TAU;
        sx = Math.cos(a);
        sy = Math.sin(a);
      }
    }
    if (any) roll = Math.atan2(-sx, sy); // an unmarked stone splits along the swing itself
    if (rating === 'bad') fireBad(x, y, z, roll, tiltX, tiltY, scale, any, gold, sx, sy, seed);
    else fireCut(x, y, z, roll, tiltX, tiltY, scale, hand, any, gold, rating === 'perfect', sx, sy, seed);
  }

  // ---------- update: hands ----------
  function updateHand(h, hand, dt) {
    const H = handState[h];
    const color = HAND_COL[h];
    const seenIn = hand ? clamp01(finite(hand.seen, 0)) : 0;
    H.seen += (seenIn - H.seen) * damp(seenIn > H.seen ? 16 : 5, dt);
    let speedIn = 0;
    if (hand && seenIn > 0.02) {
      const tx = finite(hand.x, H.x);
      const ty = finite(hand.y, H.y);
      if (H.fresh) {
        // (re)appearing: start where the hand is, never streak in from a stale position
        H.x = tx;
        H.y = ty;
        H.hx.fill(tx);
        H.hy.fill(ty);
        H.ht.fill(fx);
        H.fresh = false;
      } else {
        const k = damp(34, dt);
        H.x += (tx - H.x) * k;
        H.y += (ty - H.y) * k;
      }
      speedIn = finite(hand.speed, Math.hypot(finite(hand.vx, 0), finite(hand.vy, 0)));
    } else if (H.seen < 0.02) {
      H.fresh = true;
    }
    H.speed += (speedIn - H.speed) * damp(speedIn > H.speed ? 26 : 7, dt);
    if (dt > 0) {
      H.head = (H.head + 1) % TRAIL_HIST;
      H.hx[H.head] = H.x;
      H.hy[H.head] = H.y;
      H.ht[H.head] = fx;
    }

    const fast = clamp01(H.speed / 6.5);
    const life = 0.09 + 0.24 * fast;
    const power = tuning.cometPower * H.seen;
    // resample the history at TRAIL_PTS evenly spaced ages
    let k = 0; // steps back from the head
    for (let j = 0; j < TRAIL_PTS; j++) {
      const want = fx - (j / (TRAIL_PTS - 1)) * life;
      while (k < TRAIL_HIST - 2 && H.ht[(H.head - k - 1 + TRAIL_HIST) % TRAIL_HIST] > want) k++;
      const a = (H.head - k + TRAIL_HIST) % TRAIL_HIST;
      const b = (H.head - k - 1 + TRAIL_HIST) % TRAIL_HIST;
      const span = H.ht[a] - H.ht[b];
      const f = span > 1e-5 ? clamp01((H.ht[a] - want) / span) : 0;
      H.sx[j] = lerp(H.hx[a], H.hx[b], f);
      H.sy[j] = lerp(H.hy[a], H.hy[b], f);
    }
    const base = h * HAND_VERTS;
    const widthHead = 0.035 + 0.075 * fast;
    const glow = power * (0.3 + 0.95 * fast);
    let nx = 0;
    let ny = 1;
    for (let j = 0; j < TRAIL_PTS; j++) {
      const j0 = j > 0 ? j - 1 : 0;
      const j1 = j < TRAIL_PTS - 1 ? j + 1 : j;
      const tx = H.sx[j0] - H.sx[j1];
      const ty = H.sy[j0] - H.sy[j1];
      const tl = Math.hypot(tx, ty);
      if (tl > 1e-5) {
        nx = -ty / tl;
        ny = tx / tl;
      }
      const u = j / (TRAIL_PTS - 1);
      const w = widthHead * Math.pow(1 - u, 0.6);
      const wx = H.sx[j] * PP;
      const wy = ORIGIN_Y + H.sy[j] * PP;
      const o = (base + j * 2) * 3;
      cometPos[o] = wx - nx * w;
      cometPos[o + 1] = wy - ny * w;
      cometPos[o + 2] = Z_HIT + 0.02;
      cometPos[o + 3] = wx + nx * w;
      cometPos[o + 4] = wy + ny * w;
      cometPos[o + 5] = Z_HIT + 0.02;
      const c = (base + j * 2) * 4;
      for (let e = 0; e < 2; e++) {
        cometCol[c + e * 4] = color.r;
        cometCol[c + e * 4 + 1] = color.g;
        cometCol[c + e * 4 + 2] = color.b;
        cometCol[c + e * 4 + 3] = glow;
      }
    }
    // the head
    const hv = base + RIB_VERTS;
    const hs = 0.17 + 0.07 * fast;
    const hx = H.x * PP;
    const hy = ORIGIN_Y + H.y * PP;
    const headGlow = power * (0.75 + 0.6 * fast);
    for (let e = 0; e < 4; e++) {
      const o = (hv + e) * 3;
      cometPos[o] = hx + (e % 2 ? hs : -hs);
      cometPos[o + 1] = hy + (e > 1 ? hs : -hs);
      cometPos[o + 2] = Z_HIT + 0.03;
      const c = (hv + e) * 4;
      cometCol[c] = color.r;
      cometCol[c + 1] = color.g;
      cometCol[c + 2] = color.b;
      cometCol[c + 3] = headGlow;
    }
  }

  // ---------- update ----------
  function update(time, dt, state) {
    if (!active) return;
    const delta = clamp(finite(dt, 1 / 60), 0, 0.1);
    fx += delta;
    alive = Math.min(1, alive + delta / 0.7);
    const st = state || null;
    const songTime = finite(st && st.songTime, songNow > -1e8 ? songNow : 0);
    const beat = finite(st && st.beat, (songTime - 1) / SEC_PER_BEAT);
    const levels = st && st.levels ? st.levels : null;
    const hands = st && st.hands ? st.hands : null;
    lastHands = hands;
    const energyIn = clamp01(finite(st && st.energy, 0.5));
    energySm += (energyIn - energySm) * damp(3, delta);
    let kickIn = finite(levels && levels.kick, NaN);
    if (!Number.isFinite(kickIn)) kickIn = Math.exp(-frac(beat) * 5) * energySm;
    kickIn = clamp01(kickIn);
    kickSm += (kickIn - kickSm) * damp(kickIn > kickSm ? 40 : 10, delta);
    heat += (heatTarget - heat) * damp(heatTarget > heat ? 2.5 : 5, delta);

    // seeking backwards revives the shards ahead of the new time
    if (songTime < lastSong - 0.05) {
      for (let i = 0; i < count; i++) if (nTime[i] > songTime - 0.3) nState[i] = LIVE;
    }
    const advanced = songTime - lastSong;
    lastSong = songTime;
    songNow = songTime;

    // ---- camera (the stage eases into this pose) ----
    if (camera) {
      fitCamera(camera.aspect);
      const nod = tuning.nod * kickSm * energySm;
      camPos.set(0, tuning.camHeight - nod, fitDist - nod * 1.5);
      camTgt.set(0, tuning.camAimY, 0);
      camInfo.fov = tuning.camFov;
      if (stage && typeof stage.setSlashCamera === 'function') stage.setSlashCamera(camPos, camTgt, tuning.camFov);
    }

    // ---- shards ----
    const past = tuning.missAfter + 0.5;
    while (lo < count && sTime[lo] < songTime - past) lo++;
    while (lo > 0 && sTime[lo - 1] >= songTime - past) lo--;
    while (hi < count - 1 && sTime[hi + 1] <= songTime + approach) hi++;
    while (hi >= 0 && sTime[hi] > songTime + approach) hi--;

    cellGlow.fill(0);
    let n = 0;
    let halos = 0;
    const sT = shards.tint.array;
    const sS = shards.state.array;
    const sE = shards.extra.array;
    const pA = poolAttr.array;
    const emitGold = advanced > 0 && advanced < 0.12;
    // far to near, so the blended fade-in of distant shards composes correctly
    for (let k = hi; k >= lo && n < MAX_SHARDS; k--) {
      const i = order[k];
      if (nState[i] === GONE) continue;
      const tau = nTime[i] - songTime;
      if (nState[i] === LIVE && tau < -tuning.missAfter) {
        // nobody judged it: let it go quietly
        nState[i] = MISSED;
        nEvAt[i] = fx;
      }
      if (nState[i] === MISSED && fx - nEvAt[i] > 0.4) {
        nState[i] = GONE;
        continue;
      }
      const s = placeShard(i, songTime);
      if (s.alpha <= 0.002) continue;
      const hand = nHand[i];
      const color = HAND_COL[hand];
      const ripe = nState[i] === LIVE ? 1 - smooth01(0, 0.45, tau) : 0;
      _p.set(s.x, s.y, s.z);
      _e.set(s.tiltX, s.tiltY, nAng[i], 'XYZ');
      _q.setFromEuler(_e);
      _s.set(s.scale, s.scale, s.scale);
      _m.compose(_p, _q, _s);
      shards.mesh.setMatrixAt(n, _m);
      const o = n * 4;
      sT[o] = color.r;
      sT[o + 1] = color.g;
      sT[o + 2] = color.b;
      sT[o + 3] = s.alpha;
      sS[o] = nAny[i];
      sS[o + 1] = nGold[i];
      sS[o + 2] = ripe;
      sS[o + 3] = s.dull;
      sE[o] = nSeed[i];
      sE[o + 1] = 1;
      sE[o + 2] = 0;
      sE[o + 3] = tuning.markGain;

      // the light it throws on the glass (wider and fainter the higher it flies)
      const ground = RUNWAY_Y + rampHeight(-s.z);
      const height = Math.max(s.y - ground, 0.05);
      const pr = 0.31 + 0.28 * height;
      _p.set(s.x, ground + 0.012, s.z);
      _s.set(pr, pr * 1.25, 1);
      _q.setFromAxisAngle(X_AXIS, Math.atan(rampSlopeAt(-s.z)) - Math.PI / 2);
      _m.compose(_p, _q, _s);
      pools.setMatrixAt(n, _m);
      const pl = (tuning.poolPower * s.alpha * (1 - s.dull) * (0.19 + 0.16 * ripe + 0.14 * nGold[i])) / (0.55 + height);
      _c.copy(color);
      if (nGold[i]) _c.lerp(COL.gold, 0.6);
      pA[o] = _c.r;
      pA[o + 1] = _c.g;
      pA[o + 2] = _c.b;
      pA[o + 3] = pl;

      // the guide mark of its cell wakes up as it comes in, and answers the arrival on the beat
      if (nState[i] === LIVE && tau < 0.7) {
        const g = tau >= 0 ? (1 - tau / 0.7) * (1 - tau / 0.7) : Math.max(0.55, 1 - smooth01(0.1, 0.3, -tau) * 0.6);
        const cell = nCell[i];
        if (g > cellGlow[cell]) {
          cellGlow[cell] = g;
          cellRGB[cell * 3] = _c.r;
          cellRGB[cell * 3 + 1] = _c.g;
          cellRGB[cell * 3 + 2] = _c.b;
        }
      }

      if (nGold[i]) {
        // halo behind the stone, and a trail of sparks while the song is moving
        if (halos < 4 && nState[i] === LIVE) {
          const f = FX_HALO + halos;
          _p.set(s.x, s.y, s.z - 0.06);
          _q.identity();
          const hs = s.scale * 2.5;
          _s.set(hs, hs, 1);
          _m.compose(_p, _q, _s);
          fxMesh.setMatrixAt(f, _m);
          fxCol[f * 4] = COL.gold.r;
          fxCol[f * 4 + 1] = COL.gold.g;
          fxCol[f * 4 + 2] = COL.gold.b;
          fxCol[f * 4 + 3] = s.alpha * (0.55 + 0.35 * ripe);
          halos++;
        }
        if (emitGold && nState[i] === LIVE && s.alpha > 0.3) {
          const want = advanced * 46 * tuning.sparks;
          let emit = Math.floor(want);
          if (Math.random() < want - emit) emit++;
          for (let e = 0; e < emit; e++) {
            const a = Math.random() * TAU;
            const rr = s.scale * (0.25 + 0.3 * Math.random());
            spawnSpark(
              s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr, s.z - 0.1,
              Math.cos(a) * 0.5, Math.sin(a) * 0.5 + 0.3, -tuning.speed * (0.25 + 0.3 * Math.random()),
              0.32 + 0.3 * Math.random(), 0.016 + 0.012 * Math.random(), COL.gold, Math.random() < 0.35 ? 0.8 : 0.2, 1.3 + Math.random()
            );
          }
        }
      }
      n++;
    }
    visibleCount = n;
    shards.mesh.count = n;
    pools.count = n;
    if (n > 0) {
      shards.mesh.instanceMatrix.needsUpdate = true;
      shards.tint.needsUpdate = true;
      shards.state.needsUpdate = true;
      shards.extra.needsUpdate = true;
      pools.instanceMatrix.needsUpdate = true;
      poolAttr.needsUpdate = true;
    }
    for (let k = halos; k < 4; k++) fxCol[(FX_HALO + k) * 4 + 3] = 0;

    // ---- guide marks ----
    const gBase = 0.24 * tuning.guide;
    for (let cell = 0; cell < 12; cell++) {
      const g = cellGlow[cell];
      const o = (FX_GUIDE + cell) * 4;
      fxCol[o] = lerp(lanePale.r, cellRGB[cell * 3], g);
      fxCol[o + 1] = lerp(lanePale.g, cellRGB[cell * 3 + 1], g);
      fxCol[o + 2] = lerp(lanePale.b, cellRGB[cell * 3 + 2], g);
      fxCol[o + 3] = gBase * (1 + 1.6 * g) * (0.9 + 0.1 * kickSm);
      fxData[o + 3] = g;
    }

    // ---- halves ----
    let hn = 0;
    const hT = halves.tint.array;
    const hS = halves.state.array;
    const hE = halves.extra.array;
    for (let h = 0; h < MAX_HALVES; h++) {
      if (!hAlive[h]) continue;
      const o = h * 26;
      const age = hF[o] + delta;
      const life = hF[o + 1];
      if (age >= life) {
        hAlive[h] = 0;
        continue;
      }
      hF[o] = age;
      const dragK = Math.exp(-delta * 1.6);
      hF[o + 5] *= dragK;
      hF[o + 6] = hF[o + 6] * dragK - 3.2 * delta;
      hF[o + 7] *= dragK;
      hF[o + 2] += hF[o + 5] * delta;
      hF[o + 3] += hF[o + 6] * delta;
      hF[o + 4] += hF[o + 7] * delta;
      const t = age / life;
      const flags = hF[o + 21];
      const bad = flags >= 4;
      _q.set(hF[o + 8], hF[o + 9], hF[o + 10], hF[o + 11]);
      _axis.set(hF[o + 12], hF[o + 13], hF[o + 14]);
      _q2.setFromAxisAngle(_axis, hF[o + 15] * age * (1 - 0.35 * t));
      _q.multiply(_q2);
      const sc = hF[o + 16] * (1 - 0.3 * t * t);
      _p.set(hF[o + 2], Math.max(hF[o + 3], RUNWAY_Y + 0.05), hF[o + 4]);
      _s.set(sc, sc, sc);
      _m.compose(_p, _q, _s);
      halves.mesh.setMatrixAt(hn, _m);
      const w = hn * 4;
      hT[w] = hF[o + 18];
      hT[w + 1] = hF[o + 19];
      hT[w + 2] = hF[o + 20];
      hT[w + 3] = 1 - smooth01(0.35, 1, t);
      hS[w] = flags % 2 >= 1 ? 1 : 0;
      hS[w + 1] = flags % 4 >= 2 ? 1 : 0;
      hS[w + 2] = hF[o + 25] * (1 - t);
      hS[w + 3] = bad ? 2 : 0;
      hE[w] = hF[o + 22];
      hE[w + 1] = hF[o + 17];
      hE[w + 2] = hF[o + 24] * Math.exp(-age / Math.max(hF[o + 23], 1e-3));
      hE[w + 3] = tuning.markGain * (bad ? 0.25 : 1 - 0.6 * t);
      hn++;
    }
    halves.mesh.count = hn;
    if (hn > 0) {
      halves.mesh.instanceMatrix.needsUpdate = true;
      halves.tint.needsUpdate = true;
      halves.state.needsUpdate = true;
      halves.extra.needsUpdate = true;
    }

    // ---- hands ----
    updateHand(0, hands ? hands.l : null, delta);
    updateHand(1, hands ? hands.r : null, delta);
    comets.visible = handState[0].seen > 0.004 || handState[1].seen > 0.004;
    if (comets.visible) {
      cometPosAttr.needsUpdate = true;
      cometColAttr.needsUpdate = true;
    }

    // ---- uploads for pooled effects ----
    fxMesh.instanceMatrix.needsUpdate = true;
    fxAttr.needsUpdate = true;
    fxColAttr.needsUpdate = true;
    if (sparkDirty) {
      sparkDirty = false;
      sparkPosAttr.needsUpdate = true;
      sparkVelAttr.needsUpdate = true;
      sparkMetaAttr.needsUpdate = true;
      sparkColAttr.needsUpdate = true;
    }
    sparks.visible = fx < sparkAliveUntil;

    // ---- uniforms ----
    const ease = alive * alive * (3 - 2 * alive);
    const ru = runwayMat.uniforms;
    setU(ru, 'uTravel', tuning.speed * songTime);
    setU(ru, 'uBeat', ((beat % 16) + 16) % 16);
    setU(ru, 'uRung', tuning.speed * SEC_PER_BEAT);
    setU(ru, 'uKick', kickSm);
    setU(ru, 'uEnergy', energySm);
    setU(ru, 'uHeat', heat);
    setU(ru, 'uFx', fx);
    setU(ru, 'uAlive', ease);
    setU(ru, 'uGlow', tuning.runwayGlow);
    setU(ru, 'uStreaks', tuning.speedLines);
    setU(shards.mat.uniforms, 'uTime', fx);
    setU(shards.mat.uniforms, 'uAlive', ease);
    setU(halves.mat.uniforms, 'uTime', fx);
    setU(halves.mat.uniforms, 'uAlive', ease);
    setU(poolMat.uniforms, 'uAlive', ease);
    setU(fxMat.uniforms, 'uFx', fx);
    setU(fxMat.uniforms, 'uTime', fx);
    setU(fxMat.uniforms, 'uAlive', ease);
    setU(sparkMat.uniforms, 'uFx', fx);
    setU(sparkMat.uniforms, 'uAspect', camera ? camera.aspect : 16 / 9);
    setU(sparkMat.uniforms, 'uAlive', ease);
    setU(cometMat.uniforms, 'uAlive', ease);
  }

  // ---------- dispose ----------
  function dispose() {
    active = false;
    if (camera) camera.layers.disable(1);
    if (group.parent) group.parent.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (typeof shards.mesh.dispose === 'function') shards.mesh.dispose();
    if (typeof halves.mesh.dispose === 'function') halves.mesh.dispose();
    if (typeof pools.dispose === 'function') pools.dispose();
    if (typeof fxMesh.dispose === 'function') fxMesh.dispose();
    idIndex.clear();
    lastHands = null;
  }

  return {
    group,
    setActive,
    start,
    update,
    onEvent,
    project,
    dispose,
    // extras (not required by the contract)
    tuning,
    ppToWorld,
    camera: camInfo,
    layout: Object.freeze({ pp: PP, originY: ORIGIN_Y, hitZ: Z_HIT, laneHalf: LANE_HALF, gridX: GRID_X, gridY: GRID_Y }),
    get active() {
      return active;
    },
    get visibleShards() {
      return visibleCount;
    },
  };
}
