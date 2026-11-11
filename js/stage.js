// STARFALL — stage.js
// The world NOVA dances in: shader nebula sky with a giant rising star, god rays, a glossy
// planar-reflective floor, a beat-synced light rig, GPU particles, shockwaves, the camera
// director and the post-processing chain (bloom + filmic final pass).
//
// Everything here is procedural: no textures, models or other assets are loaded.
// Conventions (see CONTRACT.md): +x screen right, +y up, +z toward the viewer, metres,
// dancer at the origin facing +z.
//
// v2 (CONTRACT-v2.md): the stage makes room for one or two player avatars beside NOVA
// (setPlayers / getPlayerSpots) and answers every rating with a layered, per-player hit
// effect (pulse(kind, { player })). The rule for all hit effects: the energy goes to the
// FLOOR, the SIDES, BEHIND the coach and the scoring avatar's own spot. Nothing is ever
// drawn as a haze across NOVA's body.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SONG, sectionAtBeat } from './song.js';

// ---------------------------------------------------------------------------------------
// Tuning knobs (exposed on the returned stage as `stage.tuning`; safe to tweak at runtime)
// ---------------------------------------------------------------------------------------
const TUNING = {
  maxPixelRatio: 2, // hard cap on devicePixelRatio
  maxPixels: 3.8e6, // drawing-buffer pixel budget (w*h*pr^2); pixel ratio is lowered to fit
  msaaBelowPixelRatio: 1.2, // 4x MSAA on the scene target when the pixel ratio is below this
  reflectionScale: 0.5, // planar reflection resolution relative to the drawing buffer
  exposure: 1.0,
  bloomStrength: 0.45,
  bloomRadius: 0.58,
  bloomThreshold: 0.86,
  vignette: 0.42,
  chromaticAberration: 0.0055,
  grain: 0.035,
  rayStrength: 0.04, // screen-space light shafts from the star (adds light over the dancer: keep low)
  rayDensity: 0.42,
  starPower: 0.12, // brightness of the star's corona / haze (this is what veils the dancer)
  discPower: 2.4, // extra gain on the disc itself, so it stays hot while the haze stays low
  floorReflectivity: 0.6, // mirror strength of the stage disc
  beamPower: 0.2, // volumetric beam brightness
  wavePower: 0.55, // rating shockwave brightness (thin rings on a billboard behind everybody)
  resultsShift: 0.22, // results: the view is shifted so NOVA stands in the left third (fraction of width)
  menuShift: -0.19, // title: NOVA stands in the right third, clear of the logo and buttons
  cameraFov: 30, // vertical fov, all modes
  // 'play' framing: the dancer's reach box must stay inside these NDC limits
  frameTop: 0.9,
  frameBottom: 0.66, // keeps her feet above the HUD pictogram lane
  frameSide: 0.66,
  frameSideAvatar: 0.94, // the player avatars' reach boxes may come this close to the left/right edge
  playDollyBeat: 0.04, // metres of dolly-in on each kick
  playSway: 0.1, // metres of lateral camera sway
  // hit feedback (v2). Everything below scales effects that live on the floor, at the sides,
  // behind NOVA or at an avatar's spot, so none of it can veil the coach.
  fxPower: 0.8, // master brightness of rings, pads, columns and flashes
  fxSparks: 0.65, // particle-count multiplier for fountains and bursts
  columnPower: 0.6, // light column at the scoring avatar's spot
  padPower: 1.0, // the avatars' floor pads
  edgeGlow: 0.6, // frame-edge colour hit on the scoring player's side (final pass)
  sideBeams: 1.5, // how hard the overhead beams on the scoring side slam onto that spot
  pylonJump: 1.7, // metres the flank pylons jump at full strength
  punch: 0.3, // metres of camera punch-in at full strength (gold; PERFECT is 0.55 of it); capped at 0.3
  missDip: 0.3, // desaturation of the missing player's side on MISS (a hint, not a blackout)
};

// ---------------------------------------------------------------------------------------
// Palette and per-section "looks"
// ---------------------------------------------------------------------------------------
const HEX = {
  indigo: 0x0b0620,
  deepViolet: 0x3b2aa8,
  violet: 0x6a3df0,
  teal: 0x19e3d2,
  amber: 0xffc24a,
  coral: 0xff5a6e,
  white: 0xfff4e2,
};

/** Player colours (index 0 = P1 on the screen-left, 1 = P2 on the screen-right). */
export const PLAYER_COLORS = Object.freeze([0x19e3d2, 0xff5a6e]);

/**
 * One colour per rating, shared by every hit effect. They follow the HUD's rating words
 * (cool and dim at the bottom of the ladder, white-hot and golden at the top) so the word,
 * the floor and the light all say the same thing. MISS is a deeper red than P2's coral.
 */
export const RATING_COLORS = Object.freeze({
  ok: 0x9aa3e0,
  good: 0x9c7dff,
  super: 0x19e3d2,
  perfect: 0xffe9a8,
  gold: 0xffc24a,
  miss: 0xff3d55,
  combo: 0xffd27a,
});

/**
 * The hit ladder: OK < GOOD < SUPER < PERFECT < gold. Every step is bigger in several ways at
 * once, so the rating can be read from the corner of the eye:
 *   rings   - how many floor shockwaves leave the avatar's pad, and how far they travel (m)
 *   wake    - how strongly the floor's LED grid lights up behind each shockwave
 *   sparks  - fountain particle count; rise = how high it shoots (m)
 *   column  - height (m) of the light column at the avatar's spot (0 = none)
 *   beam    - the overhead beams on that side slam onto the spot
 *   pylon   - the flank pylons on that side jump
 *   halo    - a ring of light opens on the back wall behind the avatar
 *   stage   - > 0: the WHOLE stage answers (flash, floor sweep, ring behind NOVA, ribbons, sky)
 *   punch   - camera punch-in
 * Exposed as `stage.ladder`; safe to tweak at runtime.
 */
const LADDER = {
  ok: {
    rings: 1, reach: 1.3, ring: 0.6, ringTime: 0.42, wake: 0.0,
    sparks: 12, rise: 0.6, spread: 0.5, size: 0.05, life: 0.5, encore: 0, tint: 0.6,
    column: 0, columnGain: 0, columnTime: 0,
    pad: 0.5, padTint: 0.3, edge: 0.14, beam: 0, pylon: 0, halo: 0, haloReach: 0, stage: 0, punch: 0, ca: 0,
  },
  good: {
    rings: 1, reach: 2.5, ring: 1.0, ringTime: 0.55, wake: 0.55,
    sparks: 30, rise: 1.5, spread: 0.7, size: 0.058, life: 0.8, encore: 0, tint: 0.5,
    column: 1.3, columnGain: 0.6, columnTime: 0.4,
    pad: 0.85, padTint: 0.4, edge: 0.3, beam: 0, pylon: 0.35, halo: 0, haloReach: 0, stage: 0, punch: 0, ca: 0,
  },
  super: {
    rings: 2, reach: 3.9, ring: 1.35, ringTime: 0.68, wake: 0.95,
    sparks: 64, rise: 2.6, spread: 0.95, size: 0.064, life: 1.05, encore: 0, tint: 0.42,
    column: 2.8, columnGain: 0.8, columnTime: 0.52,
    pad: 1.1, padTint: 0.5, edge: 0.55, beam: 0.7, pylon: 0.7, halo: 0.7, haloReach: 1.5, stage: 0, punch: 0, ca: 0.25,
  },
  perfect: {
    rings: 3, reach: 6.0, ring: 1.8, ringTime: 0.82, wake: 1.3,
    sparks: 110, rise: 3.8, spread: 1.15, size: 0.07, life: 1.3, encore: 0, tint: 0.34,
    column: 5.0, columnGain: 0.95, columnTime: 0.66,
    pad: 1.4, padTint: 0.65, edge: 0.6, beam: 0.85, pylon: 1.0, halo: 0.85, haloReach: 2.2, stage: 0.3, punch: 0.5, ca: 0.45,
  },
  gold: {
    rings: 4, reach: 7.5, ring: 2.2, ringTime: 1.0, wake: 1.6,
    sparks: 170, rise: 4.8, spread: 1.3, size: 0.078, life: 1.6, encore: 60, tint: 0.2,
    column: 7.0, columnGain: 1.7, columnTime: 1.0,
    pad: 1.8, padTint: 0.8, edge: 1.0, beam: 1.3, pylon: 1.3, halo: 1.5, haloReach: 3.0, stage: 0.8, punch: 1.0, ca: 0.9,
  },
};

function makeLook(a, b, c, star, nebula, beams, sweep, strobe, ribbons, embers) {
  return {
    a: new THREE.Color(a),
    b: new THREE.Color(b),
    c: new THREE.Color(c),
    star,
    nebula,
    beams,
    sweep,
    strobe,
    ribbons,
    embers,
  };
}

//                          primary          secondary     accent        star  neb   beams sweep strobe rib   embers
const LOOKS = {
  menu: makeLook(HEX.violet, HEX.teal, HEX.amber, 0.7, 0.7, 0.42, 0.45, 0.0, 0.8, 0.55),
  results: makeLook(HEX.amber, HEX.violet, HEX.teal, 1.1, 1.0, 0.5, 0.5, 0.0, 0.9, 0.9),
  intro: makeLook(HEX.violet, HEX.teal, HEX.deepViolet, 0.72, 0.8, 0.26, 0.5, 0.0, 0.45, 0.3),
  verseA: makeLook(HEX.teal, HEX.violet, HEX.amber, 0.88, 0.68, 0.5, 0.8, 0.05, 0.6, 0.45),
  build: makeLook(HEX.violet, HEX.amber, HEX.coral, 0.95, 0.8, 0.58, 1.0, 0.12, 0.7, 0.55),
  // choruses: violet space with amber/coral as accents (an amber-primary nebula washed the frame out)
  chorus1: makeLook(HEX.violet, HEX.amber, HEX.coral, 0.9, 0.75, 0.7, 1.2, 0.25, 0.8, 0.65),
  verseB: makeLook(HEX.teal, HEX.coral, HEX.violet, 0.9, 0.72, 0.52, 0.85, 0.06, 0.62, 0.45),
  bridge: makeLook(HEX.deepViolet, HEX.teal, HEX.violet, 0.58, 0.85, 0.24, 0.4, 0.0, 0.55, 0.3),
  chorus2: makeLook(HEX.violet, HEX.teal, HEX.amber, 1.0, 0.8, 0.7, 1.2, 0.25, 0.8, 0.65),
  outro: makeLook(HEX.violet, HEX.amber, HEX.teal, 0.8, 0.9, 0.36, 0.6, 0.0, 0.6, 0.45),
};
const LOOK_SCALARS = ['star', 'nebula', 'beams', 'sweep', 'strobe', 'ribbons', 'embers'];

const SECTION_BY_NAME = {};
for (const s of SONG.sections) SECTION_BY_NAME[s.name] = s;

// ---------------------------------------------------------------------------------------
// Small math helpers (allocation-free)
// ---------------------------------------------------------------------------------------
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

/** Guarded uniform write: silently ignores missing uniform tables / entries. */
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

// Sizes shared by the hit-effect shaders and the code that feeds them.
// Pool sizes. Worst realistic frame: both players land gold AND both reach a combo milestone
// on the same move = 14 floor rings and 8 back-wall rings (the stage-wide parts are shared);
// the rest is headroom for the tail of the previous move, which is still fading out.
const RING_MAX = 16; // floor shockwaves alive at once
const WAVE_MAX = 10; // back-wall rings alive at once
const BURST_DRAG = 1.9; // spark air drag (1/s); used by the burst shader and launchSpeed()
const BURST_GRAVITY = 0.55; // spark fall: y -= g * age^2

// ---------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------
const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}
float fbm2(vec2 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoise2(p);
    p = p * 2.03 + vec2(17.13, 9.27);
    amp *= 0.5;
  }
  return sum / 0.9375;
}
float fbm3(vec3 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 6; i++) {
    sum += amp * vnoise3(p);
    p = p * 2.02 + vec3(13.7, 7.1, 21.3);
    amp *= 0.5;
  }
  return sum / 0.984375;
}
`;

// --- Nebula bake (runs once): layered, domain-warped fbm into an equirect data texture ---
const NEBULA_BAKE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const NEBULA_BAKE_FRAG = /* glsl */ `
varying vec2 vUv;
${GLSL_NOISE}
void main() {
  float lon = (vUv.x * 2.0 - 1.0) * 3.14159265;
  float lat = (vUv.y - 0.5) * 3.14159265;
  vec3 d = vec3(cos(lat) * sin(lon), sin(lat), -cos(lat) * cos(lon));
  vec3 p = d * 2.3;
  vec3 w = vec3(
    fbm3(p + vec3(1.7, 9.2, 3.1)),
    fbm3(p + vec3(8.3, 2.8, 5.5)),
    fbm3(p + vec3(4.1, 6.6, 1.9))
  );
  vec3 q = p + (w - 0.5) * 2.6;
  float cloudA = fbm3(q * 1.25);
  float cloudB = fbm3(q * 2.1 + vec3(31.4, 7.7, 12.9) + (w.zxy - 0.5) * 1.5);
  float lanes = fbm3(p * 3.1 + w * 3.0 + 50.0);
  float fil = 1.0 - abs(2.0 * fbm3(q * 2.9 + 11.0) - 1.0);
  fil = pow(clamp(fil, 0.0, 1.0), 5.0);
  gl_FragColor = vec4(cloudA, cloudB, lanes, fil);
}
`;

// --- Sky: nebula + star field + the star disc with corona ---
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;
const SKY_FRAG = /* glsl */ `
uniform sampler2D tNebula;
uniform float uTime;
uniform float uNebula;
uniform float uStarPower;
uniform float uDiscGain;
uniform float uStarRadius;
uniform float uKick;
uniform float uFlare;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uStarDir;
uniform vec3 uStarU;
uniform vec3 uStarV;
uniform vec3 uStarCore;
uniform vec3 uStarEdge;
varying vec3 vDir;
${GLSL_NOISE}

vec2 equirect(vec3 d) {
  return vec2(atan(d.x, -d.z) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
}
vec3 rotY(vec3 d, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
}
vec3 starLayer(vec3 d, float scale, float radius, float density) {
  vec3 p = d * scale;
  vec3 ip = floor(p);
  vec3 fp = fract(p) - 0.5;
  float rnd = hash31(ip);
  vec3 off = (vec3(hash31(ip + 7.1), hash31(ip + 13.7), hash31(ip + 23.3)) - 0.5) * 0.6;
  float dist = length(fp - off);
  float core = 1.0 - smoothstep(0.0, radius, dist);
  float tw = 0.72 + 0.28 * sin(uTime * (1.0 + rnd * 3.0) + rnd * 40.0);
  vec3 tint = mix(vec3(0.70, 0.85, 1.0), vec3(1.0, 0.86, 0.66), hash31(ip + 3.3));
  return tint * (core * core * step(1.0 - density, rnd) * tw * (0.5 + 1.5 * rnd));
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  // deep space gradient
  vec3 col = mix(vec3(0.004, 0.003, 0.012), vec3(0.020, 0.011, 0.055), pow(max(1.0 - abs(h), 0.0), 2.5));

  // drifting nebula: two counter-rotating samples of the baked field morph against each other
  vec4 n1 = texture2D(tNebula, equirect(rotY(d, uTime * 0.0045)));
  vec4 n2 = texture2D(tNebula, equirect(rotY(d, 2.4 - uTime * 0.0030)));
  float cloud = smoothstep(0.36, 0.78, n1.r * 0.62 + n2.g * 0.38);
  float wisp = smoothstep(0.42, 0.82, n2.r * 0.55 + n1.g * 0.45);
  float lanes = smoothstep(0.42, 0.72, n1.b * 0.6 + n2.b * 0.4);
  float fil = n1.a * (0.4 + 0.6 * n2.r);
  vec3 neb = uColA * (cloud * 0.34) + uColB * (wisp * wisp * 0.22) + mix(uColA, uColC, 0.5) * (fil * cloud * 0.55);
  neb *= 1.0 - lanes * 0.75;
  col += neb * uNebula * (0.78 + 0.22 * uKick);

  // star geometry
  float cosA = clamp(dot(d, uStarDir), -1.0, 1.0);
  float ang = acos(cosA);
  float rn = ang / uStarRadius;
  float aa = fwidth(rn) + 1e-5;
  float discMask = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, rn);
  vec2 lp = vec2(dot(d, uStarU), dot(d, uStarV)) / sin(uStarRadius);

  // star field
  float starVis = smoothstep(-0.02, 0.14, h) * (1.0 - cloud * 0.55) * (1.0 - discMask) * smoothstep(1.0, 1.9, rn);
  col += (starLayer(d, 64.0, 0.075, 0.16) + starLayer(d, 150.0, 0.11, 0.10) * 0.7) * starVis;

  // horizon glow, warmer under the star
  vec2 dxz = normalize(d.xz + vec2(1e-5));
  vec2 sxz = normalize(uStarDir.xz + vec2(0.0, -1e-5));
  float az = max(dot(dxz, sxz), 0.0);
  float hg = exp(-abs(h) * 7.0);
  col += mix(uColA * 0.10, uStarEdge * 0.10, pow(max(az, 0.0), 6.0)) * hg * (0.55 + 0.45 * uStarPower);

  float power = uStarPower * (1.0 + 0.10 * uKick + uFlare);

  // corona with slow streamers
  float o = max(rn - 1.0, 0.0);
  vec2 cdir = lp / max(length(lp), 1e-4);
  float st = vnoise2(cdir * 3.2 + vec2(uTime * 0.030, 0.0));
  float st2 = vnoise2(cdir * 7.5 - vec2(0.0, uTime * 0.021));
  float corona = exp(-o * 6.0) * 0.85 + exp(-o * 2.2) * 0.07 + 0.012 / (1.0 + o * o * 6.0);
  corona *= 0.62 + 0.85 * st * st + 0.33 * st2;
  corona *= smoothstep(-0.2, 0.25, cosA);
  vec3 coronaCol = mix(uStarEdge, uStarCore, exp(-o * 4.0));
  vec3 outside = col + coronaCol * corona * power;

  // the disc: limb darkening, granulation, hot filaments
  vec3 disc = vec3(0.0);
  if (rn < 1.05) {
    float mu = sqrt(max(1.0 - rn * rn, 0.0));
    vec2 flow = vec2(uTime * 0.012, -uTime * 0.008);
    float gran = fbm2(lp * 7.0 + flow * 3.0);
    float cells = vnoise2(lp * 26.0 + flow * 9.0);
    float ridged = 1.0 - abs(2.0 * fbm2(lp * 3.2 - flow * 2.0) - 1.0);
    ridged = pow(clamp(ridged, 0.0, 1.0), 5.0);
    disc = mix(uStarEdge * 0.7, uStarCore * 1.9, pow(max(mu, 0.0), 0.85)); // strong limb darkening: a ball of fire, not a flat plate
    disc *= 0.62 + 0.55 * gran + 0.14 * cells;
    disc += uStarCore * (ridged * 0.55 * mu);
    float limb = (1.0 - rn) * 26.0;
    disc += uStarCore * (exp(-limb * limb) * 0.30);
    disc *= power * uDiscGain;
  }

  col = mix(outside, disc, discMask);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

// --- God-ray fan: a huge additive quad behind the stage, radial shafts leaving the star ---
const RAYS_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const RAYS_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
uniform float uSpan;
uniform vec3 uCore;
uniform vec3 uEdge;
varying vec2 vUv;
varying vec3 vWorld;
${GLSL_NOISE}
void main() {
  vec2 p = (vUv - 0.5) * 2.0 * uSpan; // in star radii
  float r = length(p);
  vec2 c = p / max(r, 1e-4);
  float a1 = vnoise2(c * 4.0 + vec2(uTime * 0.035, 0.0));
  float a2 = vnoise2(c * 9.0 - vec2(0.0, uTime * 0.055));
  float a3 = vnoise2(c * 19.0 + vec2(uTime * 0.02, 7.0));
  float shafts = pow(max(a1, 0.0), 2.2) * 1.3 + pow(max(a2, 0.0), 3.0) * 0.8 + pow(max(a3, 0.0), 4.0) * 0.5;
  float o = max(r - 1.0, 0.0);
  float fall = smoothstep(0.9, 1.12, r) * exp(-o * 0.95);
  float edge = 1.0 - smoothstep(0.55, 1.0, r / uSpan);
  float ground = smoothstep(0.0, 9.0, vWorld.y);
  vec3 col = mix(uEdge, uCore, exp(-o * 1.6)) * (shafts * fall * edge * ground * uPower);
  gl_FragColor = vec4(col, 1.0);
}
`;

// --- Floor: planar reflection + fresnel, LED lines, beat rings, edge ring, hit shockwaves
//     (from any point on the floor, with an LED wake) and the avatars' pads ---
const FLOOR_VERT = /* glsl */ `
uniform mat4 uTexMatrix;
varying vec3 vWorld;
varying vec4 vRefl;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vRefl = uTexMatrix * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FLOOR_FRAG = /* glsl */ `
#define RING_COUNT ${RING_MAX}
uniform sampler2D tRefl;
uniform vec2 uReflTexel;
uniform float uTime;
uniform float uKick;
uniform float uBeatPhase;
uniform float uBeatIndex;
uniform float uEnergy;
uniform float uStageR;
uniform float uReflStrength;
uniform float uFlash;
uniform vec3 uFlashCol;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec4 uRings[RING_COUNT];    // birth, strength, LED wake, duration
uniform vec4 uRingGeo[RING_COUNT];  // centre x, centre z, start radius, end radius
uniform vec3 uRingCols[RING_COUNT];
uniform vec4 uPads[2];              // centre x, centre z, radius, glow
uniform vec3 uPadCols[2];
varying vec3 vWorld;
varying vec4 vRefl;
${GLSL_NOISE}

void main() {
  vec3 wp = vWorld;
  float r = length(wp.xz);
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  float ndv = clamp(V.y, 0.0, 1.0);
  float fr = fwidth(r) + 1e-5;
  float stageMask = 1.0 - smoothstep(uStageR - fr, uStageR + fr, r);

  // --- reflection ---
  vec2 rip = vec2(
    vnoise2(wp.xz * 0.45 + vec2(uTime * 0.10, uTime * 0.07)),
    vnoise2(wp.xz * 0.45 + vec2(41.3 - uTime * 0.08, 17.9 + uTime * 0.11))
  ) - 0.5;
  float ripAmt = mix(0.05, 0.0035, stageMask) / (1.0 + dist * 0.03);
  vec2 ruv = vRefl.xy / max(vRefl.w, 1e-4) + rip * ripAmt;
  ruv = clamp(ruv, vec2(0.002), vec2(0.998));
  vec2 o = uReflTexel * mix(3.5, 1.5, stageMask);
  vec3 refl = texture2D(tRefl, ruv).rgb * 0.28;
  refl += texture2D(tRefl, clamp(ruv + o * vec2(1.0, 0.6), 0.002, 0.998)).rgb * 0.18;
  refl += texture2D(tRefl, clamp(ruv + o * vec2(-1.0, 0.6), 0.002, 0.998)).rgb * 0.18;
  refl += texture2D(tRefl, clamp(ruv + o * vec2(0.6, -1.0), 0.002, 0.998)).rgb * 0.18;
  refl += texture2D(tRefl, clamp(ruv + o * vec2(-0.6, -1.0), 0.002, 0.998)).rgb * 0.18;
  refl = min(refl, vec3(6.0));
  float reflL = max(max(refl.r, refl.g), refl.b);
  refl *= mix(1.0, 0.45, stageMask * smoothstep(0.25, 1.1, reflL)); // no glaring star blob under the HUD lane
  float f0 = mix(0.10, 0.07, stageMask);
  float fres = f0 + (1.0 - f0) * pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
  fres = mix(fres, 1.0, 0.12 * stageMask);

  // --- LED pattern on the stage disc ---
  float ringLine = (1.0 - smoothstep(0.0, fr * 1.5, abs(fract(r + 0.5) - 0.5))) * clamp(1.0 - fr * 3.0, 0.0, 1.0);
  float sp = atan(wp.z, wp.x) * (24.0 / 6.2831853);
  float fs = fwidth(sp) + 1e-5;
  float spoke = (1.0 - smoothstep(0.0, fs * 1.5, abs(fract(sp + 0.5) - 0.5))) * clamp(1.0 - fs * 3.0, 0.0, 1.0);
  spoke *= smoothstep(1.3, 2.2, r);
  float cellRnd = hash21(vec2(floor(r) + uBeatIndex * 7.13, floor(sp) + uBeatIndex * 3.71));
  float lit = step(1.0 - 0.20 * uEnergy, cellRnd) * smoothstep(1.6, 2.4, r);
  float waveQ = (r - uBeatPhase * uStageR * 1.05) * 1.3;
  float wave = exp(-waveQ * waveQ);
  vec3 lineCol = mix(uColB, uColA, smoothstep(0.0, uStageR, r));
  vec3 em = lineCol * (ringLine * 0.55 + spoke * 0.30) * (0.10 + 0.25 * uEnergy + wave * uKick * 1.6);
  em += uColA * (lit * uKick * 0.20);
  em += lineCol * (wave * uKick * 0.06);
  float mark = 1.0 - smoothstep(0.0, 0.02 + fr, abs(r - 0.95));
  em += uColB * mark * (0.30 + 0.40 * uKick);
  // stage-wide flash (PERFECT / gold / combo): the whole LED grid answers in the hit colour
  float ledLines = ringLine * 0.9 + spoke * 0.6;
  em += uFlashCol * (ledLines * uFlash * 0.9);
  em *= stageMask;

  // --- stage rim ---
  float edgeBand = smoothstep(uStageR - 0.16 - fr, uStageR - 0.16 + fr, r) * stageMask;
  em += mix(uColC, vec3(1.0), 0.25) * edgeBand * (1.2 + 1.6 * uKick);
  em += uFlashCol * (edgeBand * uFlash * 3.0);
  em += uColC * exp(-max(r - uStageR, 0.0) * 1.6) * (1.0 - stageMask) * (0.18 + 0.25 * uKick);

  // --- player pads: where each avatar stands, in that player's colour ---
  for (int i = 0; i < 2; i++) {
    float pd = length(wp.xz - uPads[i].xy);
    float pw = fwidth(pd) + 1e-5;
    float pr = uPads[i].z;
    float pg = uPads[i].w;
    float padRim = 1.0 - smoothstep(0.0, 0.022 + pw, abs(pd - pr));
    float padInner = 1.0 - smoothstep(0.0, 0.014 + pw, abs(pd - pr * 0.62));
    padInner += (1.0 - smoothstep(0.0, 0.014 + pw, abs(pd - pr * 0.40))) * float(i); // P2's pad carries a second inner ring
    float padFill = 1.0 - smoothstep(0.0, pr + 1e-4, pd);
    em += uPadCols[i] * (padRim * (0.55 + 1.7 * pg) + padInner * (0.16 + 0.5 * pg) + padFill * padFill * (0.05 + 0.8 * pg));
  }

  // --- hit shockwaves: rings that race out from under a dancer (or collapse inward on a
  //     MISS); the LED lines they have just crossed stay lit in their wake ---
  for (int i = 0; i < RING_COUNT; i++) {
    float age = uTime - uRings[i].x;
    float dur = uRings[i].w;
    if (age > 0.0 && age < dur) {
      float t = age / dur;
      float e = 1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t);
      float rad = mix(uRingGeo[i].z, uRingGeo[i].w, e);
      float d = length(wp.xz - uRingGeo[i].xy);
      float wdt = 0.06 + 0.20 * t;
      float q = (d - rad) / wdt;
      float fade = (1.0 - t) * (1.0 - t);
      float ring = exp(-q * q);
      float wake = (1.0 - smoothstep(rad - 0.03, rad + 0.03, d)) * exp(-max(rad - d, 0.0) * 0.9);
      float amt = ring * uRings[i].y + wake * (ledLines * 2.2 + 0.05) * uRings[i].z;
      em += uRingCols[i] * (amt * fade * mix(0.3, 1.0, stageMask));
    }
  }

  vec3 base = mix(vec3(0.0035, 0.0030, 0.0080), vec3(0.010, 0.008, 0.022), stageMask);
  vec3 col = base + em;
  col += refl * fres * mix(1.0, uReflStrength, stageMask) * mix(vec3(1.0), vec3(0.86, 0.90, 1.0), stageMask);

  // soft contact shadow under the dancer
  vec2 cs = wp.xz * vec2(1.0, 1.35);
  float contact = 1.0 - 0.62 * exp(-dot(cs, cs) / 0.26);
  col *= contact;

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- Volumetric beams (instanced cones) ---
const BEAM_VERT = /* glsl */ `
attribute vec4 aBeam;   // rgb, intensity
attribute float aSeed;
varying vec3 vN;
varying vec3 vV;
varying float vT;
varying vec4 vBeam;
varying float vSeed;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  mat3 m = mat3(instanceMatrix);
  vec3 n = normal / vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2]));
  vN = normalize(mat3(modelMatrix) * (m * n));
  vV = cameraPosition - wp.xyz;
  vT = position.y;
  vBeam = aBeam;
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const BEAM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
varying vec3 vN;
varying vec3 vV;
varying float vT;
varying vec4 vBeam;
varying float vSeed;
${GLSL_NOISE}
void main() {
  float facing = clamp(abs(dot(normalize(vN + vec3(0.0, 1e-5, 0.0)), normalize(vV))), 0.0, 1.0);
  float soft = pow(facing, 1.7);
  float along = pow(max(1.0 - vT, 0.0), 1.35) * smoothstep(0.0, 0.03, vT);
  float dust = 0.72 + 0.28 * vnoise2(vec2(vT * 14.0 - uTime * 0.6, vSeed * 10.0));
  gl_FragColor = vec4(vBeam.rgb * (vBeam.a * soft * along * dust * uPower), 1.0);
}
`;

// --- Equaliser pylons flanking the stage (instanced boxes) ---
const PYLON_VERT = /* glsl */ `
attribute float aSeed;
varying float vY;
varying float vH;
varying float vSeed;
varying float vSide;
void main() {
  vY = position.y;
  vH = length(instanceMatrix[1].xyz);
  vSeed = aSeed;
  vSide = step(0.0, instanceMatrix[3].x); // 0 = the screen-left flank, 1 = the screen-right flank
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const PYLON_FRAG = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uPower;
uniform vec4 uHitL; // rgb = hit colour of the left flank, a = amount
uniform vec4 uHitR;
varying float vY;
varying float vH;
varying float vSeed;
varying float vSide;
void main() {
  float hgt = vY * vH;
  float seg = fract(hgt * 5.0);
  float gap = smoothstep(0.0, 0.14, seg) * smoothstep(1.0, 0.86, seg);
  vec3 c = mix(uColB, uColA, clamp(hgt / 2.4, 0.0, 1.0));
  float cap = smoothstep(1.0 - 0.07 / max(vH, 0.05), 1.0, vY);
  vec3 col = c * (0.22 + 0.85 * vY) * gap * uPower;
  col += mix(c, vec3(1.0), 0.6) * cap * (0.9 + 0.6 * uPower);
  // rating hit on this flank: the stack flares in the hit colour
  vec4 hit = mix(uHitL, uHitR, vSide);
  col += hit.rgb * (hit.a * ((0.35 + 1.5 * vY) * gap + cap * 1.2));
  gl_FragColor = vec4(col + vec3(0.004, 0.003, 0.010), 1.0);
}
`;

// --- Light ribbons (aurora bands arcing behind the stage) ---
const RIBBON_VERT = /* glsl */ `
uniform float uTime;
uniform float uMid;
varying vec3 vP;
void main() {
  float u = position.x;
  float v = position.y;
  float idx = position.z;
  float th = mix(-2.15, 2.15, u);
  float R = 13.0 + idx * 3.5 + sin(th * 2.0 + uTime * 0.21 + idx * 2.1) * 1.2;
  float hgt = 4.4 + idx * 2.1 + sin(th * 3.0 - uTime * 0.33 + idx * 1.7) * 1.1
            + sin(th * 7.0 + uTime * 0.5 + idx) * 0.25 * (1.0 + uMid);
  float tw = th * 1.5 + uTime * 0.4 + idx * 1.3;
  float wdt = (0.55 + 0.25 * sin(th * 5.0 + uTime * 0.7 + idx * 3.0)) * (1.0 + uMid * 0.6);
  vec3 radial = vec3(sin(th), 0.0, -cos(th));
  vec3 p = radial * R + vec3(0.0, hgt, -2.0);
  p += (vec3(0.0, 1.0, 0.0) * cos(tw) + radial * sin(tw)) * (v * wdt);
  vP = vec3(u, v, idx);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
}
`;
const RIBBON_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
varying vec3 vP;
${GLSL_NOISE}
void main() {
  float u = vP.x;
  float v = vP.y;
  float idx = vP.z;
  float across = 1.0 - v * v;
  across *= across;
  float streak = vnoise2(vec2(u * 46.0 - uTime * (1.1 + idx * 0.3), idx * 7.0 + v * 1.6));
  float flow = 0.35 + 0.65 * smoothstep(0.25, 0.85, streak);
  float ends = smoothstep(0.0, 0.14, u) * smoothstep(1.0, 0.86, u);
  float hue = 0.5 + 0.5 * sin(u * 6.2831853 * 1.5 + uTime * 0.25 + idx * 2.0);
  vec3 c = mix(uColA, uColB, hue);
  c = mix(c, uColC, 0.25 * step(1.5, idx));
  c += vec3(1.0) * pow(max(across, 0.0), 6.0) * 0.25;
  gl_FragColor = vec4(c * (across * flow * ends * uPower), 1.0);
}
`;

// --- Point sprites ---
const SPRITE_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = 1.0 - smoothstep(0.0, 0.5, d);
  float glow = a * a + pow(max(a, 0.0), 8.0) * 1.6;
  gl_FragColor = vec4(vCol * (glow * vA), 1.0);
}
`;
const DUST_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
uniform float uMaxSize;
uniform float uPower;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec3 vCol;
varying float vA;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.11 * (0.5 + aSeed.y) + aSeed.x * 40.0) * 0.9;
  p.y += sin(uTime * 0.07 * (0.5 + aSeed.z) + aSeed.x * 17.0) * 0.5;
  p.z += cos(uTime * 0.09 * (0.5 + aSeed.w) + aSeed.y * 23.0) * 0.9;
  p.y = abs(p.y) + 0.05;
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  float size = (0.018 + 0.05 * aSeed.w) * uScale / depth;
  gl_PointSize = min(size, uMaxSize);
  float tw = 0.55 + 0.45 * sin(uTime * (0.6 + aSeed.z * 1.8) + aSeed.x * 60.0);
  float nearFade = smoothstep(0.4, 2.2, depth);
  vA = tw * nearFade * uPower * (0.25 + 0.5 * aSeed.y);
  vCol = mix(uColA, uColB, aSeed.z) * 0.6 + vec3(0.25);
}
`;
const EMBER_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
uniform float uMaxSize;
uniform float uPower;
uniform float uAmount;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec3 vCol;
varying float vA;
void main() {
  float span = 9.5;
  float speed = 0.35 + 0.75 * aSeed.x;
  float y = mod(aSeed.y * span + uTime * speed, span);
  float k = y / span;
  vec3 p = position;
  p.x += sin(y * (0.9 + aSeed.z) + aSeed.w * 30.0) * (0.25 + 0.5 * k);
  p.z += cos(y * (0.7 + aSeed.x) + aSeed.z * 20.0) * (0.25 + 0.5 * k);
  p.y = y + 0.03;
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  float size = (0.03 + 0.05 * aSeed.w) * (1.0 - 0.5 * k) * uScale / depth;
  gl_PointSize = min(size, uMaxSize);
  float fade = smoothstep(0.0, 0.08, k) * (1.0 - k);
  float flick = 0.7 + 0.3 * sin(uTime * (5.0 + aSeed.z * 9.0) + aSeed.w * 80.0);
  float on = step(aSeed.z, uAmount);
  vA = fade * fade * flick * on * uPower * smoothstep(0.4, 2.0, depth);
  vCol = mix(uColA, uColB, k) * 1.5;
}
`;
const BURST_VERT = /* glsl */ `
attribute vec3 aVel;
attribute vec4 aMeta;   // birth, life, size, seed
attribute vec3 aColor;
uniform float uTime;
uniform float uScale;
uniform float uMaxSize;
varying vec3 vCol;
varying float vA;
void main() {
  float age = uTime - aMeta.x;
  float t = age / max(aMeta.y, 1e-3);
  if (t < 0.0 || t > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vA = 0.0;
    vCol = vec3(0.0);
    return;
  }
  float drag = ${BURST_DRAG.toFixed(2)};
  vec3 p = position + aVel * ((1.0 - exp(-age * drag)) / drag);
  p.y -= ${BURST_GRAVITY.toFixed(2)} * age * age;
  p.y = abs(p.y) + 0.02;
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  gl_PointSize = min(aMeta.z * (1.0 - t * 0.5) * uScale / depth, uMaxSize);
  float flick = 0.7 + 0.3 * sin(age * 30.0 + aMeta.w * 50.0);
  vA = pow(max(1.0 - t, 0.0), 1.6) * flick;
  vCol = aColor;
}
`;
const LAMP_VERT = /* glsl */ `
attribute vec4 aColor;
uniform float uScale;
uniform float uMaxSize;
varying vec3 vCol;
varying float vA;
void main() {
  vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  gl_PointSize = min((0.35 + 0.45 * aColor.a) * uScale / depth, uMaxSize);
  vCol = aColor.rgb;
  vA = 0.25 + aColor.a * 1.6;
}
`;

// --- Shockwave rings (one big billboard behind NOVA and the avatars; every ring has its
//     own centre, so a ring can open behind whoever scored) ---
const WAVE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const WAVE_FRAG = /* glsl */ `
#define WAVE_COUNT ${WAVE_MAX}
uniform float uTime;
uniform vec2 uHalf;                  // half size of the quad (m)
uniform vec4 uWaves[WAVE_COUNT];     // birth, strength, end radius (m), duration
uniform vec4 uWaveGeo[WAVE_COUNT];   // centre x, centre y (m, quad space), start radius (m), thickness
uniform vec3 uWaveCols[WAVE_COUNT];
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0 * uHalf;
  vec3 col = vec3(0.0);
  for (int i = 0; i < WAVE_COUNT; i++) {
    float age = uTime - uWaves[i].x;
    float t = age / max(uWaves[i].w, 1e-3);
    if (t > 0.0 && t < 1.0) {
      vec2 dp = p - uWaveGeo[i].xy;
      float r = length(dp);
      float theta = atan(dp.y, dp.x + 1e-4);
      float e = 1.0 - pow(max(1.0 - t, 0.0), 3.0);
      float rad = mix(uWaveGeo[i].z, uWaves[i].z, e);
      float wdt = max(mix(0.20, 0.06, e) * uWaveGeo[i].w, 1e-3);
      float q = (r - rad) / wdt;
      float ring = exp(-q * q);
      float inner = smoothstep(rad - 0.6, rad, r) * (1.0 - step(rad, r)) * 0.05; // hollow: a ring, not a dome
      float spark = 0.78 + 0.22 * sin(theta * 28.0 + age * 9.0 + float(i) * 2.0);
      col += uWaveCols[i] * ((ring * spark + inner) * uWaves[i].y * pow(max(1.0 - t, 0.0), 1.5));
    }
  }
  vec2 ed = abs(vUv - 0.5) * 2.0;
  col *= (1.0 - smoothstep(0.86, 1.0, ed.x)) * (1.0 - smoothstep(0.86, 1.0, ed.y));
  gl_FragColor = vec4(col, 1.0);
}
`;

// --- Light columns at the avatars' spots (instanced open cylinders): a tube of light with
//     bright edges and a faint body, so whoever stands inside it stays readable ---
const COLUMN_VERT = /* glsl */ `
attribute vec4 aColA;   // base colour (the player's), intensity
attribute vec4 aColB;   // top colour (the rating's), seed
varying vec3 vN;
varying vec3 vV;
varying vec2 vXZ;
varying float vT;
varying float vH;
varying vec4 vColA;
varying vec4 vColB;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = mat3(modelMatrix) * (mat3(instanceMatrix) * vec3(normal.x, 0.0, normal.z));
  vV = cameraPosition - wp.xyz;
  vXZ = position.xz;
  vT = position.y;
  vH = length(instanceMatrix[1].xyz);
  vColA = aColA;
  vColB = aColB;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const COLUMN_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
varying vec3 vN;
varying vec3 vV;
varying vec2 vXZ;
varying float vT;
varying float vH;
varying vec4 vColA;
varying vec4 vColB;
${GLSL_NOISE}
void main() {
  float facing = min(abs(dot(normalize(vN + vec3(0.0, 1e-5, 0.0)), normalize(vV))), 1.0);
  float rim = pow(max(1.0 - facing, 0.0), 1.6); // pow of a negative base is NaN, and bloom turns one NaN pixel into a black disc
  float body = 0.14 * facing;
  float y = vT * vH;                                   // metres above the floor
  vec2 c = normalize(vXZ + vec2(1e-5, 0.0));           // seamless angle around the tube
  float n = vnoise3(vec3(c * 2.4 + vColB.a * 17.0, y * 1.5 - uTime * 7.0));
  float streak = 0.45 + 0.95 * n * n;                  // light racing upward
  float foot = exp(-y * 1.3);                          // hot where it meets the pad
  float tip = 1.0 - smoothstep(0.5, 1.0, vT);          // soft top
  float ground = smoothstep(0.0, 0.03, vT);
  vec3 col = mix(vColA.rgb, vColB.rgb, smoothstep(0.0, 0.7, vT)) + vec3(foot * 0.3);
  float a = (rim * streak + body) * tip * ground * (0.55 + 0.9 * foot);
  gl_FragColor = vec4(col * (a * vColA.a * uPower), 1.0);
}
`;

// --- Final pass: light shafts, exposure, ACES-style tone map, grade, vignette, CA, grain ---
const FINAL_SHADER = {
  name: 'StarfallFinalPass',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uExposure: { value: TUNING.exposure },
    uVignette: { value: TUNING.vignette },
    uCA: { value: TUNING.chromaticAberration },
    uGrain: { value: TUNING.grain },
    uRayStrength: { value: 0 },
    uRayDensity: { value: TUNING.rayDensity },
    uSun: { value: new THREE.Vector2(0.5, 1.3) },
    uRayColor: { value: new THREE.Color(1.0, 0.82, 0.6) },
    uHitL: { value: new THREE.Color(0, 0, 0) }, // rating glow on the left / right frame edge (colour x amount)
    uHitR: { value: new THREE.Color(0, 0, 0) },
    uMiss: { value: new THREE.Vector2(0, 0) }, // MISS dip of the left / right half
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.04 },
    uFade: { value: 1 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
  fragmentShader: /* glsl */ `
#define RAY_TAPS 12
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uTime;
uniform float uExposure;
uniform float uVignette;
uniform float uCA;
uniform float uGrain;
uniform float uRayStrength;
uniform float uRayDensity;
uniform vec2 uSun;
uniform vec3 uRayColor;
uniform vec3 uHitL;
uniform vec3 uHitR;
uniform vec2 uMiss;
uniform float uSaturation;
uniform float uContrast;
uniform float uFade;
varying vec2 vUv;

float hashn(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec3 filmic(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 encodeSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);

  // chromatic aberration grows toward the corners; the centre (the dancer) stays clean
  vec2 caOff = c * (r2 * uCA);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + caOff).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - caOff).b;

  // screen-space light shafts streaming from the star (occluded by whatever is in front)
  if (uRayStrength > 0.001) {
    vec2 delta = (uSun - uv) * (uRayDensity / float(RAY_TAPS));
    float jitter = hashn(gl_FragCoord.xy + fract(uTime) * 61.0);
    vec2 p = uv + delta * jitter;
    float w = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < RAY_TAPS; i++) {
      p += delta;
      vec2 inside = step(vec2(0.0), p) * step(p, vec2(1.0));
      vec3 s = texture2D(tDiffuse, clamp(p, 0.001, 0.999)).rgb;
      float l = max(max(s.r, s.g), s.b);
      acc += min(s, vec3(4.0)) * (smoothstep(0.9, 2.0, l) * w * inside.x * inside.y);
      w *= 0.9;
    }
    col += acc * uRayColor * (uRayStrength / float(RAY_TAPS));
  }

  col = max(col, vec3(0.0)) * uExposure;

  // rating colour hit: a glow that lives on the frame edges only (corners plus a bar hugging
  // the left / right edge), on the side of whoever scored. The centre, where NOVA is, gets none.
  float sideR = smoothstep(0.38, 0.62, uv.x);
  float edge = smoothstep(0.10, 0.55, r2);
  float bar = pow(clamp(abs(c.x) * 2.0, 0.0, 1.0), 4.0);
  col += mix(uHitL, uHitR, sideR) * (edge * 0.55 + bar * 0.45);

  // MISS: that player's side of the picture dips and drains for a moment. With two players
  // the middle band, where NOVA stands, only joins in when both miss.
  float missL = 1.0 - smoothstep(0.30, 0.44, uv.x);
  float missR = smoothstep(0.56, 0.70, uv.x);
  float miss = uMiss.x * missL + uMiss.y * missR + min(uMiss.x, uMiss.y) * (1.0 - missL - missR);
  col *= 1.0 - miss * 0.1;

  col = filmic(col);

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation * (1.0 - miss));
  col = (col - 0.5) * uContrast + 0.5;
  col = clamp(col, 0.0, 1.0);

  float vig = 1.0 - uVignette * smoothstep(0.30, 1.05, length(c) * 1.30);
  col *= vig;

  col = encodeSRGB(col);
  float n = hashn(gl_FragCoord.xy * 1.37 + fract(uTime * 0.731) * 173.0) - 0.5;
  col += n * uGrain * (1.0 - 0.55 * luma);
  col += (hashn(gl_FragCoord.xy + 19.19) - 0.5) / 255.0;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * uFade, 1.0);
}
`,
};

// ---------------------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------------------
const STAGE_RADIUS = 6.5;
// The disc rises from the horizon directly behind the dancer: in the play shot it frames her
// head and shoulders as the backlight (its haze is kept low so she stays a clean silhouette).
const STAR_ELEVATION = THREE.MathUtils.degToRad(9);
const STAR_RADIUS = THREE.MathUtils.degToRad(9.5);
const BEAM_TOP = 6;
const BEAM_FAN = 6;
const BEAM_COUNT = BEAM_TOP + BEAM_FAN;
const PYLON_COUNT = 26;
const DUST_COUNT = 720;
const EMBER_COUNT = 440;
const BURST_MAX = 1600; // two players landing gold on the same beat: ~2 x 320 sparks, plus a combo
const RIBBON_COUNT = 3;
const RIBBON_SEGMENTS = 110;

// Reach box of a 1.7 m dancer at the origin (arms overhead / spread, hip shift, hair).
const BOX_X = 1.3;
const BOX_Y0 = -0.06;
const BOX_Y1 = 2.28;
const BOX_Z = 0.55;
const PLAY_CAM_HEIGHT = 1.16;
const PLAY_TARGET_Y = 1.1;
const PLAY_BEAT_DOLLY_MAX = 0.08; // the kick dolly never exceeds this (m)
const PLAY_PUNCH_MAX = 0.3; // nor the hit punch-in this (m)
const PLAY_DOLLY_MAX_IN = PLAY_BEAT_DOLLY_MAX + PLAY_PUNCH_MAX + 0.02; // what the framing assumes
const PLAY_BOB = 0.025;
const PLAY_SHAKE = 0.02; // lateral / vertical camera shake at a full punch (m)

// Where the player avatars stand: beside NOVA and a step behind her, a bit smaller. The left
// spot is P1 (the person on the screen-left of the mirrored camera image), the right one P2.
const SPOT_X = 2.0;
const SPOT_Z = -0.7;
const SPOT_SCALE = 0.9;
const PAD_RADIUS = 0.62; // floor pad under an avatar (x spot scale)
const COLUMN_RADIUS = 0.6; // light column around an avatar (x spot scale)
const WAVE_Z = -2.2; // the shockwave billboard stands this far behind NOVA
const WAVE_Y = 3.0;
const WAVE_HALF_W = 10;
const WAVE_HALF_H = 6;

const ZERO_LEVELS = Object.freeze({ bass: 0, mid: 0, high: 0, kick: 0 });
const EMPTY_STATE = Object.freeze({});

// ---------------------------------------------------------------------------------------
// Player spots and play-camera framing. Pure math with no three.js objects, so these exact
// functions can be run and measured in Node (projected extents per aspect ratio).
// ---------------------------------------------------------------------------------------
const clampPlayers = (n) => (n >= 2 ? 2 : n >= 1 ? 1 : 0);

/**
 * Where main.js puts the avatar groups. 1P: one spot on the screen-left of NOVA; 2P: left
 * (P1) and right (P2). Returns fresh objects: `{ x, z, scale, player }` (y is the floor, 0).
 */
export function getPlayerSpots(n) {
  const count = clampPlayers(n);
  const spots = [];
  for (let i = 0; i < count; i++) {
    spots.push({ x: i === 0 ? -SPOT_X : SPOT_X, z: SPOT_Z, scale: SPOT_SCALE, player: i });
  }
  return spots;
}

/** Default framing parameters of the play shot (the stage overrides them from its tuning). */
export const PLAY_FRAME = Object.freeze({
  fov: TUNING.cameraFov,
  top: TUNING.frameTop,
  bottom: TUNING.frameBottom,
  side: TUNING.frameSide,
  sideAvatar: TUNING.frameSideAvatar,
  sway: TUNING.playSway + 0.02 + PLAY_SHAKE, // worst-case lateral camera offset
  bob: PLAY_BOB + PLAY_SHAKE, // worst-case vertical camera offset
  dollyIn: PLAY_DOLLY_MAX_IN, // worst-case dolly toward the stage
  camHeight: PLAY_CAM_HEIGHT,
  targetY: PLAY_TARGET_Y,
});

const _proj = { x: 0, y: 0, depth: 0 };

/** Perspective projection of a world point for a camera at (cx, cy, cz) looking at (0, targetY, 0). */
function projectPlayPoint(px, py, pz, cx, cy, cz, targetY, tanHalf, aspect, out) {
  let fx = -cx;
  let fy = targetY - cy;
  let fz = -cz;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = forward x up(0,1,0); up' = right x forward
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  const depth = dx * fx + dy * fy + dz * fz;
  out.depth = depth;
  out.x = (dx * rx + dz * rz) / (depth * tanHalf * aspect);
  out.y = (dx * ux + dy * uy + dz * uz) / (depth * tanHalf);
  return out;
}

/**
 * Walks every corner of every reach box (NOVA at the origin plus `nPlayers` avatars at their
 * spots, arms overhead / spread) through every worst-case camera placement (nearest dolly,
 * both sway extremes, both bob extremes). `visit(boxIndex, ndcX, ndcY, depth)` may return
 * false to stop early. Box 0 is NOVA, box 1 the left avatar, box 2 the right one.
 */
function walkPlayBoxes(dist, aspect, nPlayers, frame, visit) {
  const tanHalf = Math.tan((frame.fov * Math.PI) / 360);
  const count = clampPlayers(nPlayers);
  for (let sx = -1; sx <= 1; sx++) {
    for (let sy = -1; sy <= 1; sy += 2) {
      const cx = sx * frame.sway;
      const cy = frame.camHeight + sy * frame.bob;
      const cz = dist - frame.dollyIn;
      for (let b = 0; b <= count; b++) {
        const scale = b === 0 ? 1 : SPOT_SCALE;
        const bx = b === 0 ? 0 : b === 1 ? -SPOT_X : SPOT_X;
        const bz = b === 0 ? 0 : SPOT_Z;
        for (let ix = -1; ix <= 1; ix += 2) {
          for (let iy = 0; iy <= 1; iy++) {
            for (let iz = -1; iz <= 1; iz += 2) {
              const px = bx + ix * BOX_X * scale;
              const py = (iy ? BOX_Y1 : BOX_Y0) * scale;
              const pz = bz + iz * BOX_Z * scale;
              projectPlayPoint(px, py, pz, cx, cy, cz, frame.targetY, tanHalf, aspect, _proj);
              if (visit(b, _proj.x, _proj.y, _proj.depth) === false) return false;
            }
          }
        }
      }
    }
  }
  return true;
}

function playBoxesFit(dist, aspect, nPlayers, frame) {
  return walkPlayBoxes(dist, aspect, nPlayers, frame, (box, x, y, depth) => {
    if (!(depth >= 0.5)) return false; // behind / too close to the lens counts as not fitting
    if (Math.abs(x) > (box === 0 ? frame.side : frame.sideAvatar)) return false;
    if (y > frame.top) return false;
    if (y < -frame.bottom) return false;
    return true;
  });
}

/**
 * Smallest camera distance (m, from the origin) at which NOVA's whole reach box and the reach
 * boxes of `nPlayers` avatars are inside the safe frame. NOVA stays on the optical axis.
 */
export function computePlayDistance(aspect, nPlayers = 0, frame = PLAY_FRAME) {
  let lo = 2.0;
  let hi = 60;
  if (!playBoxesFit(hi, aspect, nPlayers, frame)) return hi;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) * 0.5;
    if (playBoxesFit(mid, aspect, nPlayers, frame)) hi = mid;
    else lo = mid;
  }
  return hi + 0.02;
}

/**
 * Worst-case NDC extents of every reach box at a given camera distance (diagnostics / tests):
 * `[{ minX, maxX, minY, maxY }]`, index 0 = NOVA, then the avatars left to right.
 */
export function measurePlayFrame(dist, aspect, nPlayers = 0, frame = PLAY_FRAME) {
  const boxes = [];
  for (let b = 0; b <= clampPlayers(nPlayers); b++) {
    boxes.push({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  }
  walkPlayBoxes(dist, aspect, nPlayers, frame, (box, x, y) => {
    const e = boxes[box];
    if (x < e.minX) e.minX = x;
    if (x > e.maxX) e.maxX = x;
    if (y < e.minY) e.minY = y;
    if (y > e.maxY) e.maxY = y;
    return true;
  });
  return boxes;
}

/** Launch speed (m/s) that makes a burst spark peak `height` metres above where it is born. */
function launchSpeed(height) {
  const h = Math.max(height, 0.05);
  let v = h * BURST_DRAG + 1;
  for (let pass = 0; pass < 4; pass++) {
    let peak = 0;
    for (let t = 0.05; t <= 3.0; t += 0.05) {
      const y = (v * (1 - Math.exp(-t * BURST_DRAG))) / BURST_DRAG - BURST_GRAVITY * t * t;
      if (y > peak) peak = y;
    }
    v *= h / Math.max(peak, 1e-3);
  }
  return v;
}

// ---------------------------------------------------------------------------------------
// createStage
// ---------------------------------------------------------------------------------------
/**
 * createStage(canvas) ->
 *   { renderer, scene, camera,
 *     add(object3d),                        // dancer / avatar groups
 *     update(time, dt, { beat, levels, energy, section }), render(), resize(w, h),
 *     setMode('menu' | 'play' | 'results'),
 *     setPlayers(n),                        // 0 | 1 | 2 avatars share the stage: re-frames the play shot
 *     getPlayerSpots(n?),                   // -> [{ x, z, scale, player }] where the avatar groups go
 *     pulse(kind, { player, combo }?),      // 'ok' | 'good' | 'super' | 'perfect' | 'gold' | 'miss' | 'combo'
 *     tuning, ladder, ratingColors, playerColors, mode, playerCount, playDistance, soloDistance, dispose() }
 */
export function createStage(canvas) {
  const tuning = { ...TUNING };

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // the scene is rendered into (optionally multisampled) offscreen targets
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the final pass
  renderer.setClearColor(0x000000, 1);
  renderer.autoClear = true;
  renderer.info.autoReset = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(tuning.cameraFov, 16 / 9, 0.1, 4000);
  camera.position.set(0, 1.4, 7);
  scene.add(camera);

  const world = new THREE.Group(); // everything the stage owns
  world.name = 'stage-world';
  scene.add(world);
  const actors = new THREE.Group(); // things added through add()
  actors.name = 'stage-actors';
  scene.add(actors);

  // ---------- shared state ----------
  let clock = 0;
  let lastTimeArg = NaN;
  let mode = 'menu';
  let modeBlend = 1;
  let firstFrame = true;
  let viewW = 1;
  let viewH = 1;
  let pixelRatio = 1;
  let lastDpr = 0;
  let playDist = 6.4; // play shot: NOVA plus the current number of avatars
  let soloDist = 6.4; // NOVA alone (menu and results shots are built on this)
  let playerCount = 0;
  let viewShift = TUNING.menuShift;
  let viewShifted = false;

  const look = makeLook(HEX.violet, HEX.teal, HEX.amber, 1, 1, 0.4, 0.45, 0, 0.8, 0.55);
  let energySm = 0.3;
  let kickSm = 0;
  let bassSm = 0;
  let midSm = 0;
  let highSm = 0;
  let beamPhase = 0;

  // feedback envelopes (decay in update). Index 0 = the screen-left flank (P1), 1 = the right (P2).
  const edgeAmt = [0, 0]; // frame-edge glow
  const edgeCol = [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)];
  const missAmt = [0, 0]; // MISS dip
  const beamAmt = [0, 0]; // overhead beams slamming onto that spot
  const pylonAmt = [0, 0]; // flank pylons jumping
  const sideCol = [new THREE.Color(HEX.teal), new THREE.Color(HEX.coral)]; // colour of the last hit on that flank
  const padAmt = [0, 0]; // pad glow
  const padOn = [0, 0]; // pad presence (eased)
  const padFlash = [new THREE.Color(HEX.teal), new THREE.Color(HEX.coral)];
  const sideW = [1, 1]; // scratch: how much of a pulse each half of the frame gets
  let lightFlash = 0; // whole-rig flash (lights on NOVA, beams, pylons, floor rim + LED grid)
  const flashCol = new THREE.Color(HEX.white);
  let fanFlash = 0; // floor fan beams at the back rim
  let ribbonFlash = 0;
  let skyFlash = 0;
  let camPunch = 0;
  let punchSm = 0;
  let starFlare = 0;
  let caKick = 0;
  let pylonWaveAt = -1000; // combo: a ripple runs outward along both pylon rows
  let pylonWaveGain = 0;
  let wideAt = -1000; // when the last stage-wide answer fired (two players share one)
  let wideLevel = 0;
  let comboAt = -1000; // when the last combo celebration fired (two players share its stage-wide part)
  let comboLevel = 0;

  // scratch objects (never allocate in update/render)
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _c1 = new THREE.Color();
  const _c2 = new THREE.Color();
  const _c3 = new THREE.Color();
  const _h4 = new THREE.Vector4();
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  const COL = {
    violet: new THREE.Color(HEX.violet),
    teal: new THREE.Color(HEX.teal),
    amber: new THREE.Color(HEX.amber),
    coral: new THREE.Color(HEX.coral),
    white: new THREE.Color(HEX.white),
  };
  const PLAYER_COL = [new THREE.Color(PLAYER_COLORS[0]), new THREE.Color(PLAYER_COLORS[1])];
  const RATING_COL = {};
  for (const key of Object.keys(RATING_COLORS)) RATING_COL[key] = new THREE.Color(RATING_COLORS[key]);
  const ladder = {};
  for (const key of Object.keys(LADDER)) ladder[key] = { ...LADDER[key] };
  const SPOT_XS = [-SPOT_X, SPOT_X];
  const STAR_CORE = new THREE.Color().setRGB(1.0, 0.62, 0.2);
  const STAR_EDGE = new THREE.Color().setRGB(0.95, 0.22, 0.14);

  const starDir = new THREE.Vector3(0, Math.sin(STAR_ELEVATION), -Math.cos(STAR_ELEVATION)).normalize();
  const starU = new THREE.Vector3(1, 0, 0);
  const starV = new THREE.Vector3().crossVectors(starU, starDir).normalize(); // points up-ish

  // ---------- sky ----------
  const nebulaRT = new THREE.WebGLRenderTarget(2048, 1024, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  (function bakeNebula() {
    const bakeScene = new THREE.Scene();
    const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const bakeMat = new THREE.ShaderMaterial({
      vertexShader: NEBULA_BAKE_VERT,
      fragmentShader: NEBULA_BAKE_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const bakeGeo = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(bakeGeo, bakeMat);
    quad.frustumCulled = false;
    bakeScene.add(quad);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(nebulaRT);
    renderer.render(bakeScene, bakeCam);
    renderer.setRenderTarget(prev);
    bakeGeo.dispose();
    bakeMat.dispose();
  })();

  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      tNebula: { value: nebulaRT.texture },
      uTime: { value: 0 },
      uNebula: { value: 1 },
      uStarPower: { value: 1 },
      uDiscGain: { value: TUNING.discPower },
      uStarRadius: { value: STAR_RADIUS },
      uKick: { value: 0 },
      uFlare: { value: 0 },
      uColA: { value: new THREE.Color(HEX.violet) },
      uColB: { value: new THREE.Color(HEX.teal) },
      uColC: { value: new THREE.Color(HEX.amber) },
      uStarDir: { value: starDir.clone() },
      uStarU: { value: starU.clone() },
      uStarV: { value: starV.clone() },
      uStarCore: { value: STAR_CORE.clone() },
      uStarEdge: { value: STAR_EDGE.clone() },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.name = 'sky';
  world.add(sky);

  // ---------- god-ray fan ----------
  const RAY_DISTANCE = 220;
  const RAY_SPAN = 4.2; // quad half-size in star radii
  const rayHalf = RAY_DISTANCE * Math.tan(STAR_RADIUS) * RAY_SPAN;
  const raysMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 0.3 },
      uSpan: { value: RAY_SPAN },
      uCore: { value: STAR_CORE.clone() },
      uEdge: { value: STAR_EDGE.clone() },
    },
    vertexShader: RAYS_VERT,
    fragmentShader: RAYS_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const rays = new THREE.Mesh(new THREE.PlaneGeometry(rayHalf * 2, rayHalf * 2), raysMat);
  rays.position.copy(starDir).multiplyScalar(RAY_DISTANCE);
  rays.lookAt(0, 1, 0);
  rays.frustumCulled = false;
  rays.renderOrder = -900;
  rays.name = 'god-rays';
  world.add(rays);

  // ---------- floor with planar reflection ----------
  const reflRT = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  const reflCam = new THREE.PerspectiveCamera();
  reflCam.matrixAutoUpdate = true;
  const texMatrix = new THREE.Matrix4();
  const ringUniforms = []; // birth, strength, LED wake, duration
  const ringGeo = []; // centre x, centre z, start radius, end radius
  const ringColors = [];
  for (let i = 0; i < RING_MAX; i++) {
    ringUniforms.push(new THREE.Vector4(-1000, 0, 0, 0));
    ringGeo.push(new THREE.Vector4(0, 0, 0, 1));
    ringColors.push(new THREE.Color(0, 0, 0));
  }
  let ringCursor = 0;
  const padUniforms = [new THREE.Vector4(-SPOT_X, SPOT_Z, 0, 0), new THREE.Vector4(SPOT_X, SPOT_Z, 0, 0)];
  const padColors = [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)];

  const floorMat = new THREE.ShaderMaterial({
    uniforms: {
      tRefl: { value: reflRT.texture },
      uTexMatrix: { value: texMatrix },
      uReflTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uTime: { value: 0 },
      uKick: { value: 0 },
      uBeatPhase: { value: 0 },
      uBeatIndex: { value: 0 },
      uEnergy: { value: 0.3 },
      uStageR: { value: STAGE_RADIUS },
      uReflStrength: { value: tuning.floorReflectivity },
      uFlash: { value: 0 },
      uFlashCol: { value: new THREE.Color(HEX.white) },
      uColA: { value: new THREE.Color(HEX.violet) },
      uColB: { value: new THREE.Color(HEX.teal) },
      uColC: { value: new THREE.Color(HEX.amber) },
      uRings: { value: ringUniforms },
      uRingGeo: { value: ringGeo },
      uRingCols: { value: ringColors },
      uPads: { value: padUniforms },
      uPadCols: { value: padColors },
    },
    vertexShader: FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
    depthWrite: true,
    depthTest: true,
  });
  const floorGeo = new THREE.CircleGeometry(1800, 96);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.frustumCulled = false;
  floor.name = 'floor';
  world.add(floor);

  // ---------- lights (for the dancer's materials) ----------
  const HEMI_SKY = new THREE.Color(0x4a3f8c);
  const hemi = new THREE.HemisphereLight(0x4a3f8c, 0x150c28, 1.15);
  world.add(hemi);
  const keyLight = new THREE.DirectionalLight(0xfff0e0, 2.3);
  keyLight.position.set(2.6, 5.5, 7.5);
  world.add(keyLight);
  world.add(keyLight.target);
  keyLight.target.position.set(0, 1, 0);
  const backLight = new THREE.DirectionalLight(HEX.amber, 3.2);
  backLight.position.copy(starDir).multiplyScalar(30);
  world.add(backLight);
  world.add(backLight.target);
  backLight.target.position.set(0, 1, 0);
  const rimL = new THREE.DirectionalLight(HEX.teal, 2.6);
  rimL.position.set(-6.5, 3.6, -5.0);
  world.add(rimL);
  world.add(rimL.target);
  rimL.target.position.set(0, 1.1, 0);
  const rimR = new THREE.DirectionalLight(HEX.violet, 2.6);
  rimR.position.set(6.5, 3.6, -5.0);
  world.add(rimR);
  world.add(rimR.target);
  rimR.target.position.set(0, 1.1, 0);

  // ---------- volumetric beams ----------
  const beamGeo = new THREE.CylinderGeometry(1, 0.045, 1, 28, 1, true);
  beamGeo.translate(0, 0.5, 0); // narrow end at y=0 (the lamp), wide end at y=1
  const beamData = new Float32Array(BEAM_COUNT * 4);
  const beamSeed = new Float32Array(BEAM_COUNT);
  for (let i = 0; i < BEAM_COUNT; i++) beamSeed[i] = (i * 0.6180339) % 1;
  const beamAttr = new THREE.InstancedBufferAttribute(beamData, 4);
  beamAttr.setUsage(THREE.DynamicDrawUsage);
  beamGeo.setAttribute('aBeam', beamAttr);
  beamGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(beamSeed, 1));
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: tuning.beamPower } },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const beams = new THREE.InstancedMesh(beamGeo, beamMat, BEAM_COUNT);
  beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  beams.frustumCulled = false;
  beams.renderOrder = 20;
  beams.name = 'beams';
  world.add(beams);

  // lamp positions: 6 overhead on an arc behind the dancer, 6 on the floor at the back rim
  const lampPos = new Float32Array(BEAM_COUNT * 3);
  for (let i = 0; i < BEAM_TOP; i++) {
    const f = (i / (BEAM_TOP - 1)) * 2 - 1;
    const phi = f * 1.05;
    lampPos[i * 3] = Math.sin(phi) * 7.4;
    lampPos[i * 3 + 1] = 8.6 - Math.abs(f) * 0.8;
    lampPos[i * 3 + 2] = -Math.cos(phi) * 7.4 - 0.6;
  }
  for (let i = 0; i < BEAM_FAN; i++) {
    const f = (i / (BEAM_FAN - 1)) * 2 - 1;
    const phi = f * 0.85;
    const k = (BEAM_TOP + i) * 3;
    lampPos[k] = Math.sin(phi) * 7.7;
    lampPos[k + 1] = 0.14;
    lampPos[k + 2] = -Math.cos(phi) * 7.7;
  }
  const lampGeo = new THREE.BufferGeometry();
  lampGeo.setAttribute('position', new THREE.BufferAttribute(lampPos, 3));
  const lampCol = new Float32Array(BEAM_COUNT * 4);
  const lampAttr = new THREE.BufferAttribute(lampCol, 4);
  lampAttr.setUsage(THREE.DynamicDrawUsage);
  lampGeo.setAttribute('aColor', lampAttr);
  const lampMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1000 }, uMaxSize: { value: 96 } },
    vertexShader: LAMP_VERT,
    fragmentShader: SPRITE_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const lamps = new THREE.Points(lampGeo, lampMat);
  lamps.frustumCulled = false;
  lamps.renderOrder = 21;
  lamps.name = 'lamps';
  world.add(lamps);

  function setBeam(i, tx, ty, tz, radius, color, intensity) {
    const k = i * 3;
    const px = lampPos[k];
    const py = lampPos[k + 1];
    const pz = lampPos[k + 2];
    _v1.set(tx - px, ty - py, tz - pz);
    const len = Math.max(_v1.length(), 1e-3);
    _v1.multiplyScalar(1 / len);
    _q.setFromUnitVectors(Y_AXIS, _v1);
    _p.set(px, py, pz);
    _s.set(radius, len, radius);
    _m.compose(_p, _q, _s);
    beams.setMatrixAt(i, _m);
    const j = i * 4;
    beamData[j] = color.r;
    beamData[j + 1] = color.g;
    beamData[j + 2] = color.b;
    beamData[j + 3] = intensity;
    lampCol[j] = color.r;
    lampCol[j + 1] = color.g;
    lampCol[j + 2] = color.b;
    lampCol[j + 3] = clamp01(intensity);
  }

  // ---------- equaliser pylons ----------
  const pylonGeo = new THREE.BoxGeometry(1, 1, 1);
  pylonGeo.translate(0, 0.5, 0);
  const pylonSeed = new Float32Array(PYLON_COUNT);
  const pylonX = new Float32Array(PYLON_COUNT);
  const pylonZ = new Float32Array(PYLON_COUNT);
  const pylonRot = new Float32Array(PYLON_COUNT);
  const pylonBand = new Float32Array(PYLON_COUNT); // 0 = centre (bass) .. 1 = outer (highs)
  const pylonH = new Float32Array(PYLON_COUNT);
  {
    const half = PYLON_COUNT / 2;
    const gap = 0.44; // radians kept clear straight behind the dancer
    const maxPhi = 1.32;
    for (let i = 0; i < PYLON_COUNT; i++) {
      const side = i < half ? -1 : 1;
      const n = i < half ? i : i - half;
      const g = n / (half - 1);
      const phi = side * lerp(gap, maxPhi, g);
      const rad = STAGE_RADIUS + 1.9 + g * 0.6;
      pylonX[i] = Math.sin(phi) * rad;
      pylonZ[i] = -Math.cos(phi) * rad;
      pylonRot[i] = -phi;
      pylonBand[i] = g;
      pylonSeed[i] = (i * 0.7548776) % 1;
      pylonH[i] = 0.3;
    }
  }
  pylonGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(pylonSeed, 1));
  const pylonMat = new THREE.ShaderMaterial({
    uniforms: {
      uColA: { value: new THREE.Color(HEX.violet) },
      uColB: { value: new THREE.Color(HEX.teal) },
      uPower: { value: 1 },
      uHitL: { value: new THREE.Vector4(0, 0, 0, 0) },
      uHitR: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
    vertexShader: PYLON_VERT,
    fragmentShader: PYLON_FRAG,
  });
  const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, PYLON_COUNT);
  pylons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pylons.frustumCulled = false;
  pylons.name = 'pylons';
  world.add(pylons);

  // ---------- light ribbons ----------
  const ribbonGeo = new THREE.BufferGeometry();
  {
    const vertsPer = (RIBBON_SEGMENTS + 1) * 2;
    const pos = new Float32Array(RIBBON_COUNT * vertsPer * 3);
    const idx = [];
    let o = 0;
    for (let rI = 0; rI < RIBBON_COUNT; rI++) {
      const base = rI * vertsPer;
      for (let sI = 0; sI <= RIBBON_SEGMENTS; sI++) {
        const u = sI / RIBBON_SEGMENTS;
        pos[o++] = u;
        pos[o++] = -1;
        pos[o++] = rI;
        pos[o++] = u;
        pos[o++] = 1;
        pos[o++] = rI;
        if (sI < RIBBON_SEGMENTS) {
          const a = base + sI * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    ribbonGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ribbonGeo.setIndex(idx);
  }
  const ribbonMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMid: { value: 0 },
      uPower: { value: 0.5 },
      uColA: { value: new THREE.Color(HEX.violet) },
      uColB: { value: new THREE.Color(HEX.teal) },
      uColC: { value: new THREE.Color(HEX.amber) },
    },
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const ribbons = new THREE.Mesh(ribbonGeo, ribbonMat);
  ribbons.frustumCulled = false;
  ribbons.renderOrder = 10;
  ribbons.name = 'ribbons';
  world.add(ribbons);

  // ---------- particles ----------
  // deterministic pseudo-random for stable layouts
  let seedState = 1337;
  const rnd = () => {
    seedState = (seedState * 1664525 + 1013904223) >>> 0;
    return seedState / 4294967296;
  };

  const dustGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(DUST_COUNT * 3);
    const seed = new Float32Array(DUST_COUNT * 4);
    for (let i = 0; i < DUST_COUNT; i++) {
      pos[i * 3] = (rnd() * 2 - 1) * 13;
      pos[i * 3 + 1] = 0.3 + rnd() * 8.0;
      pos[i * 3 + 2] = -15 + rnd() * 22;
      seed[i * 4] = rnd();
      seed[i * 4 + 1] = rnd();
      seed[i * 4 + 2] = rnd();
      seed[i * 4 + 3] = rnd();
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  }
  const dustMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 1000 },
      uMaxSize: { value: 48 },
      uPower: { value: 0.8 },
      uColA: { value: new THREE.Color(HEX.violet) },
      uColB: { value: new THREE.Color(HEX.teal) },
    },
    vertexShader: DUST_VERT,
    fragmentShader: SPRITE_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  dust.renderOrder = 30;
  dust.name = 'dust';
  world.add(dust);

  const emberGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(EMBER_COUNT * 3);
    const seed = new Float32Array(EMBER_COUNT * 4);
    for (let i = 0; i < EMBER_COUNT; i++) {
      // annulus around the dancer (kept clear of her) biased toward the back of the stage
      const ang = rnd() * TAU;
      const rad = 2.6 + Math.pow(rnd(), 0.8) * 11.5;
      let z = Math.cos(ang) * rad;
      if (z > 2.5) z = -z * 0.9; // fold the front toward the back so nothing rises in front of the lens
      pos[i * 3] = Math.sin(ang) * rad;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = z;
      seed[i * 4] = rnd();
      seed[i * 4 + 1] = rnd();
      seed[i * 4 + 2] = rnd();
      seed[i * 4 + 3] = rnd();
    }
    emberGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    emberGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  }
  const emberMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 1000 },
      uMaxSize: { value: 48 },
      uPower: { value: 1 },
      uAmount: { value: 0.5 },
      uColA: { value: new THREE.Color(HEX.amber) },
      uColB: { value: new THREE.Color(HEX.coral) },
    },
    vertexShader: EMBER_VERT,
    fragmentShader: SPRITE_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const embers = new THREE.Points(emberGeo, emberMat);
  embers.frustumCulled = false;
  embers.renderOrder = 31;
  embers.name = 'embers';
  world.add(embers);

  const burstPos = new Float32Array(BURST_MAX * 3);
  const burstVel = new Float32Array(BURST_MAX * 3);
  const burstMeta = new Float32Array(BURST_MAX * 4);
  const burstCol = new Float32Array(BURST_MAX * 3);
  for (let i = 0; i < BURST_MAX; i++) {
    burstMeta[i * 4] = -1000;
    burstMeta[i * 4 + 1] = 1;
  }
  const burstGeo = new THREE.BufferGeometry();
  const burstPosAttr = new THREE.BufferAttribute(burstPos, 3);
  const burstVelAttr = new THREE.BufferAttribute(burstVel, 3);
  const burstMetaAttr = new THREE.BufferAttribute(burstMeta, 4);
  const burstColAttr = new THREE.BufferAttribute(burstCol, 3);
  burstPosAttr.setUsage(THREE.DynamicDrawUsage);
  burstVelAttr.setUsage(THREE.DynamicDrawUsage);
  burstMetaAttr.setUsage(THREE.DynamicDrawUsage);
  burstColAttr.setUsage(THREE.DynamicDrawUsage);
  burstGeo.setAttribute('position', burstPosAttr);
  burstGeo.setAttribute('aVel', burstVelAttr);
  burstGeo.setAttribute('aMeta', burstMetaAttr);
  burstGeo.setAttribute('aColor', burstColAttr);
  const burstMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 1000 }, uMaxSize: { value: 64 } },
    vertexShader: BURST_VERT,
    fragmentShader: SPRITE_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const burst = new THREE.Points(burstGeo, burstMat);
  burst.frustumCulled = false;
  burst.renderOrder = 32;
  burst.name = 'burst';
  world.add(burst);
  let burstCursor = 0;
  let burstDirty = false;

  /** Writes one spark into the pool (the oldest slot is recycled). Colours are 0..1 blends of colA -> colB. */
  function spawnSpark(px, py, pz, vx, vy, vz, delay, life, size, colA, colB, mix, hot) {
    const i = burstCursor;
    burstCursor = (burstCursor + 1) % BURST_MAX;
    const a = i * 3;
    burstPos[a] = px;
    burstPos[a + 1] = py;
    burstPos[a + 2] = pz;
    burstVel[a] = vx;
    burstVel[a + 1] = vy;
    burstVel[a + 2] = vz;
    const m = i * 4;
    burstMeta[m] = clock + delay;
    burstMeta[m + 1] = life;
    burstMeta[m + 2] = size;
    burstMeta[m + 3] = Math.random();
    burstCol[a] = lerp(colA.r, colB.r, mix) * hot;
    burstCol[a + 1] = lerp(colA.g, colB.g, mix) * hot;
    burstCol[a + 2] = lerp(colA.b, colB.b, mix) * hot;
    burstDirty = true;
  }

  /** Uploads the spark pool once after any number of spawns. */
  function commitSparks() {
    if (!burstDirty) return;
    burstDirty = false;
    burstPosAttr.needsUpdate = true;
    burstVelAttr.needsUpdate = true;
    burstMetaAttr.needsUpdate = true;
    burstColAttr.needsUpdate = true;
  }

  /**
   * Spawn `count` sparks on a halo around NOVA, flying outward (and slightly back) so the
   * burst frames her instead of covering her.
   */
  function emitBurst(count, colA, colB, speed, life, size, lift) {
    for (let n = 0; n < count; n++) {
      const ang = Math.random() * TAU;
      const rr = 0.42 + Math.random() * 0.34;
      const cx = Math.cos(ang);
      const sy = Math.sin(ang);
      const v = speed * (0.3 + Math.random() * 0.7);
      spawnSpark(
        cx * rr * 0.85,
        1.05 + sy * rr * 1.15,
        -0.5 - Math.random() * 0.4, // born behind her, never on top of her body
        cx * v,
        sy * v * 0.85 + lift,
        -Math.random() * v * 0.45, // only ever away from the lens: the halo stays behind her
        Math.random() * 0.06,
        life * (0.55 + Math.random() * 0.45),
        size * (0.5 + Math.random()),
        colA,
        colB,
        Math.random(),
        1.2 + Math.random() * 1.4
      );
    }
    commitSparks();
  }

  /**
   * A fountain of sparks shooting up from the floor around (x, z): born on a ring of
   * `radius`, peaking about `rise` metres up. Each spark is mostly colA or mostly colB
   * (`biasB` = share of colB) so two-tone fountains stay saturated; a few are white-hot.
   * Whatever would drift toward the centre line or the lens is held back, so a fountain
   * beside NOVA never crosses her.
   */
  function emitFountain(x, z, radius, count, rise, spread, size, life, colA, colB, biasB, delay) {
    const v0 = launchSpeed(rise * 1.2); // sparks are fading by the time they peak: aim a little higher
    const toCentre = x > 0 ? -1 : x < 0 ? 1 : 0;
    for (let n = 0; n < count; n++) {
      const ang = Math.random() * TAU;
      const cx = Math.cos(ang);
      const cz = Math.sin(ang);
      const rr = radius * (0.5 + 0.55 * Math.random());
      const up = v0 * (0.42 + 0.58 * Math.pow(Math.random(), 0.6));
      const out = spread * (0.25 + 0.75 * Math.random());
      let vx = cx * out;
      let vz = cz * out * 0.8;
      if (vx * toCentre > 0) vx *= 0.25;
      if (vz > 0) vz *= 0.4;
      const hero = Math.random() < 0.12;
      const white = Math.random() < 0.1;
      const pick = Math.random() < biasB ? 1 - Math.random() * 0.2 : Math.random() * 0.2;
      spawnSpark(
        x + cx * rr,
        0.04 + Math.random() * 0.14,
        z + cz * rr * 0.8,
        vx,
        up,
        vz,
        delay + Math.random() * 0.07,
        life * (0.6 + 0.4 * Math.random()),
        size * (hero ? 1.9 : 0.6 + 0.8 * Math.random()),
        white ? COL.white : colA,
        white ? COL.white : colB,
        pick,
        (hero ? 2.4 : 1.3) + Math.random() * 1.3
      );
    }
  }

  /** Slow glitter falling behind and beside NOVA (never over her): the stage-wide reward. */
  function emitRain(count, colA, colB) {
    for (let n = 0; n < count; n++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      spawnSpark(
        side * (1.7 + Math.random() * 4.6),
        3.3 + Math.random() * 2.6,
        -3.6 + Math.random() * 2.8,
        (Math.random() - 0.5) * 0.5,
        -0.5 - Math.random() * 0.9,
        (Math.random() - 0.6) * 0.3,
        Math.random() * 0.45,
        1.5 + Math.random() * 0.9,
        0.05 + Math.random() * 0.05,
        colA,
        colB,
        Math.random(),
        1.4 + Math.random() * 1.6
      );
    }
  }

  /**
   * A shockwave on the floor: a ring that travels from radius r0 to r1 around (x, z) in
   * `duration` seconds (r1 < r0 collapses inward). `wake` > 0 leaves the LED grid lit behind it.
   */
  function emitRing(x, z, r0, r1, color, strength, wake, duration, delay) {
    ringUniforms[ringCursor].set(clock + delay, strength * tuning.fxPower, wake * tuning.fxPower, duration);
    ringGeo[ringCursor].set(x, z, r0, r1);
    ringColors[ringCursor].copy(color);
    ringCursor = (ringCursor + 1) % RING_MAX;
  }

  // ---------- shockwave billboard ----------
  const waveUniforms = []; // birth, strength, end radius, duration
  const waveGeo = []; // centre x, centre y, start radius, thickness
  const waveColors = [];
  for (let i = 0; i < WAVE_MAX; i++) {
    waveUniforms.push(new THREE.Vector4(-1000, 0, 1, 1));
    waveGeo.push(new THREE.Vector4(0, 0, 0, 1));
    waveColors.push(new THREE.Color(0, 0, 0));
  }
  let waveCursor = 0;
  let waveAliveUntil = -1;
  const waveMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uHalf: { value: new THREE.Vector2(WAVE_HALF_W, WAVE_HALF_H) },
      uWaves: { value: waveUniforms },
      uWaveGeo: { value: waveGeo },
      uWaveCols: { value: waveColors },
    },
    vertexShader: WAVE_VERT,
    fragmentShader: WAVE_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const wave = new THREE.Mesh(new THREE.PlaneGeometry(WAVE_HALF_W * 2, WAVE_HALF_H * 2), waveMat);
  wave.position.set(0, WAVE_Y, WAVE_Z);
  wave.frustumCulled = false;
  wave.renderOrder = 15;
  wave.visible = false;
  wave.name = 'shockwave';
  world.add(wave);

  /**
   * A ring of light on the back wall, opening from radius r0 to r1 (m) behind the world
   * point (x, y, z) as seen from the lens. The billboard is behind NOVA and the avatars and
   * depth-tested, so the ring always passes behind them.
   */
  function emitWave(x, y, z, r0, r1, color, strength, thickness, duration, delay) {
    // slide the centre along the eye ray onto the billboard plane
    const ez = camPos.z;
    const k = (ez - WAVE_Z) / Math.max(ez - z, 0.5);
    const wx = camPos.x + (x - camPos.x) * k;
    const wy = camPos.y + (y - camPos.y) * k;
    waveUniforms[waveCursor].set(clock + delay, strength * tuning.wavePower * tuning.fxPower, r1 * k, duration);
    waveGeo[waveCursor].set(wx, wy - WAVE_Y, r0 * k, thickness);
    waveColors[waveCursor].copy(color);
    waveCursor = (waveCursor + 1) % WAVE_MAX;
    waveAliveUntil = Math.max(waveAliveUntil, clock + delay + duration);
    wave.visible = true;
  }

  // ---------- light columns at the avatars' spots ----------
  const columnGeo = new THREE.CylinderGeometry(1.16, 1, 1, 28, 1, true);
  columnGeo.translate(0, 0.5, 0); // foot at y = 0, top at y = 1 (scaled to the column height)
  const columnColA = new Float32Array(2 * 4);
  const columnColB = new Float32Array(2 * 4);
  columnColB[3] = 0.21;
  columnColB[7] = 0.67;
  const columnAttrA = new THREE.InstancedBufferAttribute(columnColA, 4);
  const columnAttrB = new THREE.InstancedBufferAttribute(columnColB, 4);
  columnAttrA.setUsage(THREE.DynamicDrawUsage);
  columnAttrB.setUsage(THREE.DynamicDrawUsage);
  columnGeo.setAttribute('aColA', columnAttrA);
  columnGeo.setAttribute('aColB', columnAttrB);
  const columnMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: tuning.columnPower } },
    vertexShader: COLUMN_VERT,
    fragmentShader: COLUMN_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const columns = new THREE.InstancedMesh(columnGeo, columnMat, 2);
  columns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  columns.frustumCulled = false;
  columns.renderOrder = 18;
  columns.visible = false;
  columns.name = 'hit-columns';
  world.add(columns);
  const columnBirth = [-1000, -1000];
  const columnTime = [1, 1];
  const columnHeight = [0, 0];
  const columnGain = [0, 0];
  const columnBase = [new THREE.Color(HEX.teal), new THREE.Color(HEX.coral)];
  const columnTop = [new THREE.Color(HEX.white), new THREE.Color(HEX.white)];
  _m.makeScale(0, 0, 0);
  columns.setMatrixAt(0, _m);
  columns.setMatrixAt(1, _m);

  /** Shoots a light column up at spot `s`. A weaker column never cuts off a stronger one still burning. */
  function fireColumn(s, height, gain, duration, baseCol, topCol) {
    const age = clock - columnBirth[s];
    if (age >= 0 && age < columnTime[s]) {
      const left = columnGain[s] * Math.pow(1 - age / columnTime[s], 1.7);
      if (left > gain) return;
    }
    columnBirth[s] = clock;
    columnTime[s] = Math.max(duration, 0.05);
    columnHeight[s] = height;
    columnGain[s] = gain;
    columnBase[s].copy(baseCol);
    columnTop[s].copy(topCol);
    columns.visible = true;
  }

  // ---------- post-processing ----------
  const sceneTarget = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
  });
  const composer = new EffectComposer(renderer, sceneTarget);
  if (composer.renderTarget2) composer.renderTarget2.samples = 0;
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), tuning.bloomStrength, tuning.bloomRadius, tuning.bloomThreshold);
  composer.addPass(bloomPass);
  const finalPass = new ShaderPass(FINAL_SHADER);
  finalPass.renderToScreen = true;
  composer.addPass(finalPass);
  const finalU = finalPass.uniforms || (finalPass.material && finalPass.material.uniforms) || null;

  // ---------- camera director ----------
  const camPos = new THREE.Vector3(0, 1.5, 7.5);
  const camTgt = new THREE.Vector3(0, 1.1, 0);
  const desPos = new THREE.Vector3();
  const desTgt = new THREE.Vector3();

  // Framing parameters of the play shot, refreshed from the live tuning before every fit.
  const playFrame = { ...PLAY_FRAME };
  function refreshPlayFrame() {
    playFrame.fov = tuning.cameraFov;
    playFrame.top = tuning.frameTop;
    playFrame.bottom = tuning.frameBottom;
    playFrame.side = tuning.frameSide;
    playFrame.sideAvatar = tuning.frameSideAvatar;
    playFrame.sway = Math.abs(tuning.playSway) + 0.02 + PLAY_SHAKE;
    return playFrame;
  }

  /**
   * Re-fits the play shot: NOVA's whole reach box plus the reach boxes of the current number
   * of avatars stay inside the safe frame on any aspect ratio. NOVA stays on the optical axis.
   */
  function refitCamera() {
    const frame = refreshPlayFrame();
    soloDist = computePlayDistance(camera.aspect, 0, frame);
    playDist = playerCount > 0 ? computePlayDistance(camera.aspect, playerCount, frame) : soloDist;
  }

  // ---------- resize ----------
  function resize(w, h) {
    let width = finite(w, 0);
    let height = finite(h, 0);
    if (!(width > 0) || !(height > 0)) {
      width = (canvas && canvas.clientWidth) || (typeof window !== 'undefined' ? window.innerWidth : 0) || 1280;
      height = (canvas && canvas.clientHeight) || (typeof window !== 'undefined' ? window.innerHeight : 0) || 720;
    }
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    viewW = width;
    viewH = height;

    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    lastDpr = dpr;
    let pr = Math.min(dpr, tuning.maxPixelRatio);
    const budget = Math.sqrt(tuning.maxPixels / (width * height));
    pr = Math.max(0.5, Math.min(pr, budget));
    pixelRatio = pr;

    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, true);

    const wantSamples = pr < tuning.msaaBelowPixelRatio && renderer.capabilities.isWebGL2 ? 4 : 0;
    if (composer.renderTarget1 && composer.renderTarget1.samples !== wantSamples) {
      composer.renderTarget1.samples = wantSamples;
      composer.renderTarget1.dispose();
    }
    composer.setPixelRatio(pr);
    composer.setSize(width, height);

    const bufW = Math.max(1, Math.round(width * pr));
    const bufH = Math.max(1, Math.round(height * pr));
    const rw = Math.max(64, Math.round(bufW * tuning.reflectionScale));
    const rh = Math.max(64, Math.round(bufH * tuning.reflectionScale));
    reflRT.setSize(rw, rh);
    const texel = floorMat.uniforms.uReflTexel;
    if (texel) texel.value.set(1 / rw, 1 / rh);

    camera.fov = tuning.cameraFov;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    refitCamera();

    const pointScale = bufH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
    setU(dustMat.uniforms, 'uScale', pointScale);
    setU(emberMat.uniforms, 'uScale', pointScale);
    setU(burstMat.uniforms, 'uScale', pointScale);
    setU(lampMat.uniforms, 'uScale', pointScale);
    setU(dustMat.uniforms, 'uMaxSize', 40 * pr);
    setU(emberMat.uniforms, 'uMaxSize', 40 * pr);
    setU(burstMat.uniforms, 'uMaxSize', 56 * pr);
    setU(lampMat.uniforms, 'uMaxSize', 90 * pr);
    if (finalU && finalU.uResolution) finalU.uResolution.value.set(bufW, bufH);
  }

  // ---------- mode ----------
  function setMode(next) {
    const m = next === 'play' || next === 'results' || next === 'menu' ? next : 'menu';
    if (m === mode) return;
    mode = m;
    modeBlend = 0;
    if (m === 'results') {
      emitRing(0, 0, 0.7, STAGE_RADIUS * 1.1, COL.amber, 1.4, 1.0, 1.1, 0);
      emitBurst(120, COL.amber, COL.white, 3.4, 1.8, 0.07, 1.4);
      starFlare = Math.max(starFlare, 0.35);
    }
  }

  // ---------- players ----------
  /**
   * How many player avatars share the stage with NOVA (0 | 1 | 2). Re-frames the play shot
   * so NOVA and that many avatars (see getPlayerSpots) are fully in frame, lights the
   * avatars' floor pads during play, and decides whether per-player hits are split left /
   * right (2 players) or answered by the whole frame (0 or 1).
   */
  function setPlayers(n) {
    const count = clampPlayers(finite(Number(n), 0));
    if (count === playerCount) return;
    playerCount = count;
    refitCamera();
  }

  // ---------- pulse ----------
  /** Splits a pulse over the two halves of the frame: sideW[0] = left, sideW[1] = right. */
  function weighSides(player, whole) {
    if (player < 0 || whole) {
      sideW[0] = 1;
      sideW[1] = 1;
    } else if (playerCount >= 2) {
      sideW[0] = player === 0 ? 1 : 0;
      sideW[1] = player === 1 ? 1 : 0;
    } else {
      // a single player owns the whole frame, a touch stronger on their own side
      sideW[0] = player === 0 ? 1 : 0.6;
      sideW[1] = player === 1 ? 1 : 0.6;
    }
  }

  /** Lights the frame edge on the weighted sides; the stronger event owns the colour. */
  function glowEdges(color, amount) {
    for (let s = 0; s < 2; s++) {
      const a = amount * sideW[s];
      if (a <= 0) continue;
      if (a >= edgeAmt[s] * 0.7) edgeCol[s].copy(color);
      edgeAmt[s] = Math.max(edgeAmt[s], a);
    }
  }

  /**
   * The whole stage answers (PERFECT, gold, combo): rig flash in the hit colour, floor grid
   * and rim, fan beams, ribbons and sky, a floor sweep from the centre and a ring of light
   * on the back wall behind NOVA. Two players landing the same beat share one answer.
   */
  function fireStage(level, color, sparkle) {
    lightFlash = Math.max(lightFlash, 0.8 * level);
    flashCol.copy(color);
    fanFlash = Math.max(fanFlash, level);
    ribbonFlash = Math.max(ribbonFlash, 0.9 * level);
    skyFlash = Math.max(skyFlash, 0.6 * level);
    if (clock - wideAt < 0.09 && level <= wideLevel) return;
    wideAt = clock;
    wideLevel = level;
    emitRing(0, 0, 0.7, STAGE_RADIUS * (0.75 + 0.4 * level), color, 1.1 * level, 1.3 * level, 0.95, 0.03);
    emitWave(0, 1.15, 0, 0.5, 2.6 + 2.2 * level, color, 1.6 * level, 1.0, 0.75 + 0.2 * level, 0);
    if (sparkle) {
      emitRing(0, 0, 0.7, STAGE_RADIUS * 0.85, COL.white, 0.8 * level, 0.5, 0.8, 0.14);
      emitWave(0, 1.15, 0, 0.4, 3.2, COL.white, 0.9 * level, 0.7, 0.7, 0.11);
      emitBurst(Math.round(90 * level * tuning.fxSparks), color, COL.white, 4.6, 1.6, 0.065, 1.3);
      emitRain(Math.round(70 * level * tuning.fxSparks), color, COL.white);
    } else {
      emitBurst(Math.round(40 * level * tuning.fxSparks), color, COL.white, 3.6, 1.0, 0.055, 0.9);
    }
  }

  /** One rung of the ladder (OK .. gold) at player `player`'s spot, or at both flanks when player < 0. */
  function fireHit(kind, player) {
    const fx = ladder[kind];
    const rating = RATING_COL[kind];
    const first = player < 0 ? 0 : player;
    const last = player < 0 ? 1 : player;
    const share = player < 0 ? 0.75 : 1; // a whole-stage call splits its energy over both flanks
    for (let s = first; s <= last; s++) {
      const x = SPOT_XS[s];
      const own = PLAYER_COL[s];
      // 1. floor shockwaves racing out from under the avatar, first in the rating colour
      for (let k = 0; k < fx.rings; k++) {
        const col = k === 0 ? rating : k === 1 ? own : k === 2 ? COL.white : rating;
        emitRing(
          x,
          SPOT_Z,
          0.3 * SPOT_SCALE,
          fx.reach * (1 - 0.2 * k),
          col,
          fx.ring * share * (1 - 0.16 * k),
          k === 0 ? fx.wake : fx.wake * 0.4,
          fx.ringTime * (1 + 0.12 * k),
          k * 0.075
        );
      }
      // 2. fountain of sparks around the avatar, as tall as the rating
      const count = Math.round(fx.sparks * share * tuning.fxSparks);
      emitFountain(x, SPOT_Z, PAD_RADIUS * SPOT_SCALE, count, fx.rise, fx.spread, fx.size, fx.life, rating, own, fx.tint, 0);
      if (fx.encore > 0) {
        const again = Math.round(fx.encore * share * tuning.fxSparks);
        emitFountain(x, SPOT_Z, PAD_RADIUS * SPOT_SCALE, again, fx.rise * 0.7, fx.spread * 1.6, fx.size, fx.life * 0.9, COL.white, rating, 0.5, 0.17);
      }
      // 3. light column: the player's colour at the foot, the rating's colour above
      if (fx.column > 0) fireColumn(s, fx.column, fx.columnGain * share, fx.columnTime, own, rating);
      // 4. the pad flares
      if (fx.pad * share >= padAmt[s]) padFlash[s].copy(own).lerp(rating, fx.padTint);
      padAmt[s] = Math.max(padAmt[s], fx.pad * share);
      // 5. that flank of the rig: beams slam onto the spot, pylons jump
      if (fx.beam * share >= beamAmt[s] * 0.7 && fx.pylon * share >= pylonAmt[s] * 0.7) {
        sideCol[s].copy(rating).lerp(own, fx.tint * 0.4);
      }
      beamAmt[s] = Math.max(beamAmt[s], fx.beam * share);
      pylonAmt[s] = Math.max(pylonAmt[s], fx.pylon * share);
      // 6. a ring of light opens on the back wall behind the avatar
      if (fx.halo > 0) {
        const cy = 1.0 * SPOT_SCALE;
        emitWave(x, cy, SPOT_Z, 0.3, fx.haloReach, rating, fx.halo * share, 1.0, 0.5 + 0.12 * fx.halo, 0);
        if (fx.halo >= 1) emitWave(x, cy, SPOT_Z, 0.2, fx.haloReach * 0.62, own, fx.halo * share * 0.8, 0.8, 0.5, 0.09);
      }
    }
    // frame edge on the scoring side
    weighSides(player, false);
    _c3.copy(rating);
    if (player >= 0) _c3.lerp(PLAYER_COL[player], fx.tint * 0.3);
    glowEdges(_c3, fx.edge);
    caKick = Math.max(caKick, fx.ca);
    // PERFECT and gold: the whole stage answers, the far flank joins in and the camera punches in
    if (fx.stage > 0) {
      for (let s = 0; s < 2; s++) {
        if (s >= first && s <= last) continue;
        if (pylonAmt[s] < 0.2) sideCol[s].copy(rating);
        pylonAmt[s] = Math.max(pylonAmt[s], fx.pylon * 0.6);
      }
      fireStage(fx.stage, rating, kind === 'gold');
      if (kind === 'gold') starFlare = Math.max(starFlare, 0.15);
    }
    camPunch = Math.max(camPunch, fx.punch);
  }

  /** MISS: nothing goes up. The pad's ring collapses inward, that side dims and drains, coral on the edge. */
  function fireMiss(player) {
    const first = player < 0 ? 0 : player;
    const last = player < 0 ? 1 : player;
    for (let s = first; s <= last; s++) {
      emitRing(SPOT_XS[s], SPOT_Z, 1.7 * SPOT_SCALE, 0.25 * SPOT_SCALE, RATING_COL.miss, 1.1, 0, 0.38, 0);
    }
    weighSides(player, playerCount < 2);
    for (let s = 0; s < 2; s++) missAmt[s] = Math.max(missAmt[s], sideW[s]);
    glowEdges(RATING_COL.miss, 0.5);
    caKick = Math.max(caKick, 0.7);
  }

  /**
   * Combo milestone: a celebration from the whole stage, led by the player who earned it.
   * Two players reaching a milestone on the same move each get their own spot and cannons but
   * share ONE centre sweep, ring behind NOVA and glitter (doubling those would only add glare
   * around the coach).
   */
  function fireCombo(player, combo) {
    const level = clamp(0.7 + 0.03 * finite(Number(combo), 10), 0.8, 1.3); // 5 -> 0.85, 10 -> 1.0, 20+ -> 1.3
    const gold = RATING_COL.combo;
    const shared = clock - comboAt < 0.09 && level <= comboLevel;
    if (!shared) {
      comboAt = clock;
      comboLevel = level;
    }
    // spark cannons at both flanks, outside the avatars and inside the frame on any aspect ratio
    const halfWidth = Math.tan(THREE.MathUtils.degToRad(tuning.cameraFov) * 0.5) * camera.aspect * (playDist + 1.6);
    const cannonX = clamp(halfWidth * 0.8, SPOT_X + 0.9, 3.9);
    for (let s = 0; s < 2; s++) {
      const mine = player < 0 || player === s;
      const own = PLAYER_COL[player < 0 ? s : player];
      const count = Math.round((mine ? 70 : 46) * level * tuning.fxSparks);
      emitFountain(s === 0 ? -cannonX : cannonX, -1.6, 0.35, count, 3.4 * level, 1.5, 0.074, 1.5, gold, own, 0.4, s * 0.06);
    }
    // the floor sweeps out from the centre twice
    if (!shared) {
      emitRing(0, 0, 0.7, STAGE_RADIUS * 1.15, gold, 1.3 * level, 1.5, 0.9, 0);
      emitRing(0, 0, 0.7, STAGE_RADIUS * 0.9, COL.white, 0.8 * level, 0.6, 0.8, 0.12);
    }
    // the scoring avatar's own spot (both spots on a whole-stage call)
    for (let s = 0; s < 2; s++) {
      if (player >= 0 && player !== s) continue;
      const own = PLAYER_COL[s];
      emitRing(SPOT_XS[s], SPOT_Z, 0.3 * SPOT_SCALE, 3.2, own, 1.3, 0.8, 0.6, 0.05);
      fireColumn(s, 3.4 * level, 1.05, 0.62, own, gold);
      if (1.2 >= padAmt[s]) padFlash[s].copy(own).lerp(gold, 0.6);
      padAmt[s] = Math.max(padAmt[s], 1.2);
      beamAmt[s] = Math.max(beamAmt[s], 0.8);
    }
    for (let s = 0; s < 2; s++) sideCol[s].copy(gold);
    // a ripple runs outward along both pylon rows
    pylonWaveAt = clock;
    pylonWaveGain = level;
    // rig, ribbons and sky; ring of light behind NOVA; glitter
    lightFlash = Math.max(lightFlash, 0.55 * level);
    flashCol.copy(gold);
    fanFlash = Math.max(fanFlash, 1);
    ribbonFlash = Math.max(ribbonFlash, 1);
    skyFlash = Math.max(skyFlash, 0.5);
    if (!shared) {
      emitWave(0, 1.15, 0, 0.5, 4.2 * level, gold, 1.5, 1.0, 0.85, 0);
      emitWave(0, 1.15, 0, 0.4, 2.8 * level, COL.white, 0.9, 0.7, 0.7, 0.1);
      emitRain(Math.round(50 * level * tuning.fxSparks), gold, COL.white);
    }
    weighSides(player, false);
    sideW[0] = Math.max(sideW[0], 0.6);
    sideW[1] = Math.max(sideW[1], 0.6);
    glowEdges(gold, 0.7);
    camPunch = Math.max(camPunch, 0.4);
    caKick = Math.max(caKick, 0.4);
  }

  /**
   * Rating / combo feedback.
   *   kind:   'ok' | 'good' | 'super' | 'perfect' | 'gold' | 'miss' | 'combo'
   *   opts.player: 0 (P1, screen-left spot) | 1 (P2, screen-right spot). Omitted = the whole
   *           stage: the effect fires at both flanks.
   *   opts.combo:  optional combo count for 'combo' (bigger milestones celebrate harder).
   * The ladder OK < GOOD < SUPER < PERFECT < gold grows in ring count and reach, fountain
   * height, column height and how much of the stage joins in (see LADDER).
   */
  function pulse(kind, opts) {
    const raw = opts && typeof opts === 'object' ? opts.player : undefined;
    const player = raw === 0 || raw === 1 ? raw : -1;
    if (kind === 'miss') fireMiss(player);
    else if (kind === 'combo') fireCombo(player, opts && typeof opts === 'object' ? opts.combo : undefined);
    else if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ladder, kind)) fireHit(kind, player);
    commitSparks();
  }

  // ---------- update ----------
  function update(time, dt, state) {
    // --- time ---
    let delta = finite(dt, NaN);
    if (!(delta >= 0)) {
      const t = finite(time, NaN);
      delta = Number.isFinite(t) && Number.isFinite(lastTimeArg) ? t - lastTimeArg : 1 / 60;
    }
    lastTimeArg = finite(time, lastTimeArg);
    delta = clamp(delta, 0, 0.1);
    clock += delta;

    const st = state || EMPTY_STATE;
    const levels = st.levels || ZERO_LEVELS;
    const playing = mode === 'play';

    // --- beat ---
    const bps = SONG.bpm / 60;
    const realBeat = finite(st.beat, NaN);
    const hasBeat = playing && Number.isFinite(realBeat);
    const beat = hasBeat ? realBeat : clock * bps * 0.5; // ambient half-time pulse outside play
    const beatFloor = Math.floor(beat);
    const beatPhase = beat - beatFloor;
    const beatPulse = Math.exp(-beatPhase * 4.5);

    // --- section / look ---
    let section = st.section;
    if (typeof section === 'string') section = SECTION_BY_NAME[section] || null;
    else if (!section || typeof section.name !== 'string') section = null;
    if (!section && hasBeat) section = sectionAtBeat(realBeat);
    let target = LOOKS.menu;
    if (playing) target = (section && LOOKS[section.name]) || LOOKS.verseA;
    else if (mode === 'results') target = LOOKS.results;

    const kLook = damp(2.4, delta);
    look.a.lerp(target.a, kLook);
    look.b.lerp(target.b, kLook);
    look.c.lerp(target.c, kLook);
    for (let i = 0; i < LOOK_SCALARS.length; i++) {
      const key = LOOK_SCALARS[i];
      look[key] += (target[key] - look[key]) * kLook;
    }

    // riser through the build section
    let rise = 0;
    if (playing && section && section.name === 'build' && hasBeat) {
      rise = clamp01((realBeat / SONG.beatsPerBar - section.startBar) / Math.max(section.bars, 1));
    }

    // --- energy and levels ---
    const sectionEnergy = section ? finite(section.intensity, 0.5) : 0.35;
    const energyIn = playing ? clamp01(finite(st.energy, sectionEnergy)) : mode === 'results' ? 0.5 : 0.35;
    energySm += (energyIn - energySm) * damp(3, delta);
    const energy = energySm;

    let kickIn = finite(levels.kick, NaN);
    if (!Number.isFinite(kickIn)) kickIn = hasBeat ? beatPulse * energy : 0;
    kickIn = clamp01(kickIn);
    if (!playing) kickIn = Math.max(kickIn, 0.22 * beatPulse);
    kickSm += (kickIn - kickSm) * damp(kickIn > kickSm ? 40 : 9, delta);
    const kick = kickSm;
    const bassIn = clamp01(finite(levels.bass, 0));
    const midIn = clamp01(finite(levels.mid, 0));
    const highIn = clamp01(finite(levels.high, 0));
    bassSm += (bassIn - bassSm) * damp(bassIn > bassSm ? 30 : 7, delta);
    midSm += (midIn - midSm) * damp(midIn > midSm ? 30 : 7, delta);
    highSm += (highIn - highSm) * damp(highIn > highSm ? 30 : 7, delta);

    // --- feedback envelopes ---
    const fxPower = tuning.fxPower;
    for (let s = 0; s < 2; s++) {
      edgeAmt[s] *= Math.exp(-delta * 3.4);
      missAmt[s] *= Math.exp(-delta * 3.0);
      beamAmt[s] *= Math.exp(-delta * 4.2);
      pylonAmt[s] *= Math.exp(-delta * 4.6);
      padAmt[s] *= Math.exp(-delta * 3.6);
      const padTarget = playing && s < playerCount ? 1 : 0;
      padOn[s] += (padTarget - padOn[s]) * damp(4, delta);
    }
    lightFlash *= Math.exp(-delta * 5.0);
    fanFlash *= Math.exp(-delta * 3.6);
    ribbonFlash *= Math.exp(-delta * 2.8);
    skyFlash *= Math.exp(-delta * 3.4);
    camPunch *= Math.exp(-delta * 4.0);
    starFlare *= Math.exp(-delta * 1.8);
    caKick *= Math.exp(-delta * 5.0);
    const missMax = Math.max(missAmt[0], missAmt[1]);

    const starPower = tuning.starPower * look.star * (1 + rise * 0.25);

    // --- sky ---
    const su = skyMat.uniforms;
    setU(su, 'uTime', clock);
    setU(su, 'uNebula', look.nebula * (1 + skyFlash * 0.9 * fxPower));
    setU(su, 'uStarPower', starPower);
    setU(su, 'uDiscGain', tuning.discPower);
    setU(su, 'uKick', kick * energy);
    setU(su, 'uFlare', starFlare);
    setU(su, 'uColA', look.a);
    setU(su, 'uColB', look.b);
    setU(su, 'uColC', look.c);

    // --- god-ray fan ---
    const ru = raysMat.uniforms;
    setU(ru, 'uTime', clock);
    setU(ru, 'uPower', (0.2 + 0.16 * energy + 0.1 * kick * energy + starFlare * 0.5 + rise * 0.1) * starPower);

    // --- floor ---
    const fu = floorMat.uniforms;
    setU(fu, 'uTime', clock);
    setU(fu, 'uKick', kick);
    setU(fu, 'uBeatPhase', beatPhase);
    setU(fu, 'uBeatIndex', ((beatFloor % 64) + 64) % 64);
    setU(fu, 'uEnergy', energy);
    setU(fu, 'uFlash', lightFlash * fxPower);
    setU(fu, 'uFlashCol', flashCol);
    setU(fu, 'uReflStrength', tuning.floorReflectivity);
    setU(fu, 'uColA', look.a);
    setU(fu, 'uColB', look.b);
    setU(fu, 'uColC', look.c);
    // avatars' pads: the player's colour, breathing with the kick, flaring on a hit, and
    // guttering toward the MISS colour when that player misses
    for (let s = 0; s < 2; s++) {
      const on = padOn[s] * tuning.padPower;
      const glow = padAmt[s];
      const gutter = missAmt[s];
      _c1.copy(PLAYER_COL[s]).lerp(padFlash[s], clamp01(glow));
      _c1.lerp(RATING_COL.miss, gutter * 0.85);
      const flicker = 1 - gutter * (0.55 + 0.35 * Math.sin(clock * 46));
      padColors[s].copy(_c1).multiplyScalar(on * flicker * fxPower);
      padUniforms[s].set(SPOT_XS[s], SPOT_Z, PAD_RADIUS * SPOT_SCALE * (0.4 + 0.6 * padOn[s]) * (1 + 0.06 * glow), 0.1 + 0.14 * kick + glow);
    }

    // --- lights ---
    const accent = kick * energy;
    hemi.color.copy(HEMI_SKY).lerp(look.a, 0.22);
    hemi.intensity = 1.0 + 0.25 * energy;
    keyLight.intensity = 2.15 + 0.35 * energy + lightFlash * 0.7 - missMax * 0.2;
    backLight.color.copy(STAR_CORE).lerp(look.c, 0.2);
    backLight.intensity = (2.6 + 1.2 * accent + starFlare * 3.0) * clamp(starPower, 0.5, 1.5);
    rimL.color.copy(look.b);
    rimR.color.copy(look.a);
    const rimBase = 2.2 + 0.9 * energy;
    const alt = (((beatFloor % 2) + 2) % 2) === 0 ? 1 : 0; // alternate the kickers on each beat
    // a hit on a flank also kicks NOVA's rim light from that side (light on her edge, never a veil)
    rimL.intensity = rimBase + accent * (0.5 + 1.1 * alt) + lightFlash * 1.5 + beamAmt[0] * 1.2;
    rimR.intensity = rimBase + accent * (0.5 + 1.1 * (1 - alt)) + lightFlash * 1.5 + beamAmt[1] * 1.2;

    // --- beams ---
    beamPhase += delta * bps * (Math.PI / 8) * look.sweep;
    const beamBase = look.beams * (0.4 + 0.6 * energy) * (1 + rise * 0.5);
    const chaseIdx = ((Math.floor(beat * 2) % BEAM_TOP) + BEAM_TOP) % BEAM_TOP;
    for (let i = 0; i < BEAM_TOP; i++) {
      const f = (i / (BEAM_TOP - 1)) * 2 - 1;
      const mirror = i % 2 ? -1 : 1;
      const psi = f * 0.8 + 0.55 * Math.sin(beamPhase + i * 1.05) * mirror;
      const rho = 3.0 + 1.6 * Math.sin(beamPhase * 0.5 + i * 2.1);
      // targets always land behind the dancer so no beam crosses in front of her
      let tx = Math.sin(psi) * rho * 1.55;
      let tz = -1.3 - Math.abs(Math.cos(psi)) * rho * 0.8;
      let col = i % 3 === 2 ? look.c : i % 2 ? look.b : look.a;
      const chase = lerp(1, i === chaseIdx ? 1.35 : 0.3, look.strobe);
      let inten = beamBase * (0.8 + 0.2 * kick) * chase + lightFlash * 0.35;
      let radius = 0.55 + 0.25 * energy;
      // a hit on this flank: its three beams drop what they are doing and slam onto that
      // avatar's spot in the hit colour (the spot is beside and behind NOVA, like every target)
      const side = i < BEAM_TOP / 2 ? 0 : 1;
      const slam = beamAmt[side];
      if (slam > 0.01) {
        const w = clamp01(slam * 1.6);
        tx = lerp(tx, SPOT_XS[side] + ((i % 3) - 1) * 0.3, w);
        tz = lerp(tz, SPOT_Z - 0.6, w);
        col = _c2.copy(col).lerp(sideCol[side], w);
        inten += slam * tuning.sideBeams * fxPower;
        radius = lerp(radius, 0.62, w);
      }
      inten *= 1 - 0.25 * missAmt[side];
      setBeam(i, tx, 0.0, tz, radius, col, inten);
    }
    const fanOpen = Math.min(1, 0.25 + 0.75 * (0.75 * energy + 0.25 * kick) + fanFlash * 0.5);
    const fanChase = ((beatFloor % BEAM_FAN) + BEAM_FAN) % BEAM_FAN;
    const fanTint = clamp01(fanFlash * 1.2);
    for (let i = 0; i < BEAM_FAN; i++) {
      const bi = BEAM_TOP + i;
      const f = (i / (BEAM_FAN - 1)) * 2 - 1;
      const alpha = f * (0.3 + 0.42 * fanOpen) + 0.2 * Math.sin(beamPhase * 1.3 + i * 0.5);
      const k = bi * 3;
      const len = 30;
      _v2.set(Math.sin(alpha), Math.cos(alpha), -0.3).normalize();
      const col = _c2.copy(i % 2 ? look.c : look.b).lerp(flashCol, fanTint);
      const chase = lerp(1, i === fanChase || i === BEAM_FAN - 1 - fanChase ? 1.3 : 0.4, look.strobe);
      // stage-wide answer (PERFECT / gold / combo): the whole fan at the back rim fires at once
      const inten = (beamBase * 0.62 * (0.75 + 0.25 * kick) * chase + lightFlash * 0.25 + fanFlash * 0.9 * fxPower) * (1 - 0.2 * missMax);
      setBeam(bi, lampPos[k] + _v2.x * len, lampPos[k + 1] + _v2.y * len, lampPos[k + 2] + _v2.z * len, 1.5, col, inten);
    }
    beams.instanceMatrix.needsUpdate = true;
    beamAttr.needsUpdate = true;
    lampAttr.needsUpdate = true;
    setU(beamMat.uniforms, 'uTime', clock);
    setU(beamMat.uniforms, 'uPower', tuning.beamPower);

    // --- pylons ---
    const half = PYLON_COUNT / 2;
    const stepIdx = Math.floor(beat * 2);
    const waveAge = clock - pylonWaveAt; // combo ripple: a bump travelling outward along both rows
    const waveOn = waveAge >= 0 && waveAge < 0.9;
    for (let i = 0; i < PYLON_COUNT; i++) {
      const g = pylonBand[i];
      const side = i < half ? 0 : 1;
      const tri = 1 - Math.abs(g * 2 - 1);
      let band = bassSm * (1 - g) * (1 - g) + midSm * tri + highSm * g * g;
      band += kick * (1 - g) * 0.25;
      const jitter = 0.55 + 0.45 * Math.sin(pylonSeed[i] * 91.7 + stepIdx * 2.399);
      const idle = 0.16 + 0.1 * Math.sin(clock * 1.3 + (i % half) * 0.7);
      let targetH = idle + clamp01(band) * jitter * (1.2 + 1.5 * energy);
      // a hit makes that flank jump (the stacks nearest the stage highest); a MISS drops it
      let jump = pylonAmt[side] * (1 - 0.45 * g) * (0.8 + 0.2 * pylonSeed[i]);
      if (waveOn) {
        const x = g - waveAge * 1.5;
        jump += Math.exp(-x * x * 22) * pylonWaveGain * (1 - waveAge / 0.9);
      }
      targetH += jump * tuning.pylonJump * fxPower;
      targetH *= 1 - 0.35 * missAmt[side];
      const h0 = pylonH[i];
      const hNew = h0 + (targetH - h0) * damp(targetH > h0 ? 22 : 6, delta);
      pylonH[i] = hNew;
      _p.set(pylonX[i], 0, pylonZ[i]);
      _q.setFromAxisAngle(Y_AXIS, pylonRot[i]);
      _s.set(0.2, hNew, 0.2);
      _m.compose(_p, _q, _s);
      pylons.setMatrixAt(i, _m);
    }
    pylons.instanceMatrix.needsUpdate = true;
    setU(pylonMat.uniforms, 'uColA', look.a);
    setU(pylonMat.uniforms, 'uColB', look.b);
    setU(pylonMat.uniforms, 'uPower', (0.55 + 0.75 * energy + 0.2 * kick + lightFlash * 0.6) * (1 - 0.2 * missMax));
    const waveGlow = waveOn ? pylonWaveGain * (1 - waveAge / 0.9) : 0;
    _h4.set(sideCol[0].r, sideCol[0].g, sideCol[0].b, Math.min(1.6, pylonAmt[0] + waveGlow) * fxPower);
    setU(pylonMat.uniforms, 'uHitL', _h4);
    _h4.set(sideCol[1].r, sideCol[1].g, sideCol[1].b, Math.min(1.6, pylonAmt[1] + waveGlow) * fxPower);
    setU(pylonMat.uniforms, 'uHitR', _h4);

    // --- ribbons ---
    const rbu = ribbonMat.uniforms;
    const ribbonTint = clamp01(ribbonFlash * 0.8);
    setU(rbu, 'uTime', clock);
    setU(rbu, 'uMid', midSm);
    setU(rbu, 'uPower', look.ribbons * (0.3 + 0.35 * energy + 0.3 * midSm + 0.15 * kick) + ribbonFlash * 0.9 * fxPower);
    setU(rbu, 'uColA', _c1.copy(look.a).lerp(flashCol, ribbonTint));
    setU(rbu, 'uColB', _c1.copy(look.b).lerp(flashCol, ribbonTint * 0.6));
    setU(rbu, 'uColC', look.c);

    // --- light columns ---
    if (columns.visible) {
      let burning = false;
      for (let s = 0; s < 2; s++) {
        const age = clock - columnBirth[s];
        const life = columnTime[s];
        let height = 0;
        let gain = 0;
        let radius = COLUMN_RADIUS * SPOT_SCALE;
        if (age >= 0 && age < life) {
          const t = age / life;
          const up = 1 - Math.pow(1 - clamp01(age / 0.1), 3); // shoots up in a tenth of a second
          height = columnHeight[s] * up;
          gain = columnGain[s] * Math.pow(1 - t, 1.7) * (0.88 + 0.12 * Math.sin(age * 41));
          radius *= 0.85 + 0.4 * t; // swells as it fades
          burning = true;
        }
        _p.set(SPOT_XS[s], 0.01, SPOT_Z);
        _q.identity();
        _s.set(radius, Math.max(height, 1e-3), radius);
        if (gain <= 0) _s.set(0, 0, 0);
        _m.compose(_p, _q, _s);
        columns.setMatrixAt(s, _m);
        const j = s * 4;
        columnColA[j] = columnBase[s].r;
        columnColA[j + 1] = columnBase[s].g;
        columnColA[j + 2] = columnBase[s].b;
        columnColA[j + 3] = gain * fxPower;
        columnColB[j] = columnTop[s].r;
        columnColB[j + 1] = columnTop[s].g;
        columnColB[j + 2] = columnTop[s].b;
      }
      columns.instanceMatrix.needsUpdate = true;
      columnAttrA.needsUpdate = true;
      columnAttrB.needsUpdate = true;
      setU(columnMat.uniforms, 'uTime', clock);
      setU(columnMat.uniforms, 'uPower', tuning.columnPower);
      if (!burning) columns.visible = false;
    }

    // --- particles ---
    setU(dustMat.uniforms, 'uTime', clock);
    setU(dustMat.uniforms, 'uPower', 0.55 + 0.35 * highSm + 0.25 * energy);
    setU(dustMat.uniforms, 'uColA', look.a);
    setU(dustMat.uniforms, 'uColB', look.b);
    setU(emberMat.uniforms, 'uTime', clock);
    setU(emberMat.uniforms, 'uAmount', clamp01(look.embers * (0.45 + 0.55 * energy) + rise * 0.3));
    setU(emberMat.uniforms, 'uPower', 0.85 + 0.2 * kick);
    _c1.copy(COL.amber).lerp(look.c, 0.35);
    _c2.copy(COL.coral).lerp(look.a, 0.35);
    setU(emberMat.uniforms, 'uColA', _c1);
    setU(emberMat.uniforms, 'uColB', _c2);
    setU(burstMat.uniforms, 'uTime', clock);

    // --- shockwave ---
    if (wave.visible) {
      if (clock > waveAliveUntil) wave.visible = false;
      setU(waveMat.uniforms, 'uTime', clock);
    }

    // --- camera ---
    modeBlend = Math.min(1, modeBlend + delta / 1.6);
    let follow = 2;
    let shiftTarget = 0; // lateral view shift (fraction of the width); 0 in play
    const wideAspect = smooth01(1.25, 1.6, viewW / Math.max(viewH, 1));
    camera.up.set(0, 1, 0);
    punchSm += (camPunch - punchSm) * damp(camPunch > punchSm ? 60 : 14, delta);
    if (mode === 'play') {
      // Front camera. Every offset here is bounded by what computePlayDistance() assumed,
      // so NOVA's and the avatars' whole reach boxes stay inside the safe frame on every
      // aspect ratio.
      const sway = Math.sin(beat * (Math.PI / 8)) * tuning.playSway;
      const bob = Math.sin(beat * (Math.PI / 4)) * PLAY_BOB;
      const dollyIn = clamp(tuning.playDollyBeat * kick * energy, 0, PLAY_BEAT_DOLLY_MAX);
      const breathe = 0.12 * (1 - energy); // sits a touch further back in quiet sections
      desPos.set(sway, PLAY_CAM_HEIGHT + bob, playDist + breathe - dollyIn);
      desTgt.set(0, PLAY_TARGET_Y, 0);
      const roll = Math.sin(beat * (Math.PI / 8) + 1.0) * 0.006 + Math.sin(clock * 37) * punchSm * 0.004;
      camera.up.set(Math.sin(roll), Math.cos(roll), 0);
      follow = 9;
    } else if (mode === 'results') {
      // hero shot: closer, low, NOVA in the left third (the score panel sits on the right)
      const ang = Math.sin(clock * 0.2) * 0.26 - 0.1;
      const rad = soloDist * 0.8 + Math.sin(clock * 0.13) * 0.2;
      desPos.set(Math.sin(ang) * rad, 0.9 + Math.sin(clock * 0.17) * 0.1, Math.cos(ang) * rad);
      desTgt.set(0, 1.12, 0);
      follow = 2.2;
      shiftTarget = tuning.resultsShift * wideAspect;
    } else {
      // menu: slow arc across the front of the stage; her face always stays toward the lens
      const ang = Math.sin(clock * 0.14) * 0.42 + Math.sin(clock * 0.047 + 1.3) * 0.06 + 0.12;
      const rad = soloDist * 1.0 + Math.sin(clock * 0.11) * 0.4;
      desPos.set(Math.sin(ang) * rad, 1.25 + Math.sin(clock * 0.09 + 0.6) * 0.25, Math.cos(ang) * rad);
      desTgt.set(0, 1.08 + Math.sin(clock * 0.07) * 0.06, 0);
      follow = 2.2;
      shiftTarget = tuning.menuShift * wideAspect;
    }
    if (firstFrame) {
      camPos.copy(desPos);
      camTgt.copy(desTgt);
      firstFrame = false;
    } else {
      const kCam = damp(lerp(1.7, follow, modeBlend * modeBlend), delta);
      camPos.lerp(desPos, kCam);
      camTgt.lerp(desTgt, kCam);
    }
    viewShift += (shiftTarget - viewShift) * damp(mode === 'play' ? 6 : 2.2, delta);
    if (Math.abs(viewShift) > 5e-4) {
      camera.setViewOffset(viewW, viewH, Math.round(viewShift * viewW), 0, viewW, viewH);
      viewShifted = true;
    } else if (viewShifted) {
      camera.clearViewOffset();
      viewShifted = false;
    }
    if (camPos.y < 0.25) camPos.y = 0.25; // never dip to the mirror plane
    camera.position.copy(camPos);
    if (mode === 'play' && punchSm > 1e-3) {
      // hit punch (PERFECT / gold / combo): a snap toward the stage and a short shake, applied
      // on top of the smoothed move so it lands on the frame of the hit
      // (both are capped at what the framing assumed, whatever the ladder / tuning is set to)
      const shake = Math.min(punchSm, 1) * PLAY_SHAKE;
      camera.position.z -= clamp(punchSm * tuning.punch, 0, PLAY_PUNCH_MAX);
      camera.position.x += Math.sin(clock * 53) * shake;
      camera.position.y += Math.cos(clock * 41) * shake * 0.6;
    }
    camera.lookAt(camTgt);
    camera.updateMatrixWorld(true);

    // shockwave quad faces the lens
    if (wave.visible) wave.quaternion.copy(camera.quaternion);

    // --- post ---
    if (bloomPass) {
      bloomPass.strength = tuning.bloomStrength + 0.03 * kick * energy + starFlare * 0.1 + lightFlash * 0.04;
      bloomPass.radius = tuning.bloomRadius;
      bloomPass.threshold = tuning.bloomThreshold;
    }
    if (finalU) {
      // where the star sits on screen (for the light shafts)
      camera.getWorldDirection(_v1);
      const facing = _v1.dot(starDir);
      _v2.copy(starDir).multiplyScalar(1000).add(camera.position).project(camera);
      if (finalU.uSun) finalU.uSun.value.set(_v2.x * 0.5 + 0.5, _v2.y * 0.5 + 0.5);
      setU(finalU, 'uRayStrength', tuning.rayStrength * smooth01(0.25, 0.7, facing) * clamp(starPower, 0, 1.6) * (0.75 + 0.25 * energy + starFlare));
      setU(finalU, 'uRayDensity', tuning.rayDensity);
      setU(finalU, 'uTime', clock);
      setU(finalU, 'uExposure', tuning.exposure * (1 + lightFlash * 0.04));
      setU(finalU, 'uVignette', tuning.vignette + missMax * 0.06);
      setU(finalU, 'uCA', tuning.chromaticAberration * (1 + caKick * 1.4 + kick * energy * 0.12));
      setU(finalU, 'uGrain', tuning.grain);
      // rating glow on the frame edges, per side; MISS dip of that player's half
      const glow = tuning.edgeGlow * fxPower;
      setU(finalU, 'uHitL', _c1.copy(edgeCol[0]).multiplyScalar(edgeAmt[0] * glow));
      setU(finalU, 'uHitR', _c1.copy(edgeCol[1]).multiplyScalar(edgeAmt[1] * glow));
      if (finalU.uMiss) finalU.uMiss.value.set(missAmt[0] * tuning.missDip, missAmt[1] * tuning.missDip);
    }
  }

  // ---------- render ----------
  function renderReflection() {
    // Mirror the camera through the floor plane (y = 0): a proper rigid camera looking up
    // from below, sampled back through its own projection in the floor shader.
    if (camera.position.y <= 0.01) return;
    camera.getWorldDirection(_v1);
    reflCam.position.set(camera.position.x, -camera.position.y, camera.position.z);
    _v2.set(reflCam.position.x + _v1.x, reflCam.position.y - _v1.y, reflCam.position.z + _v1.z);
    _v3.set(0, 1, 0).applyQuaternion(camera.quaternion);
    reflCam.up.set(_v3.x, -_v3.y, _v3.z);
    reflCam.lookAt(_v2);
    reflCam.near = camera.near;
    reflCam.far = camera.far;
    reflCam.updateMatrixWorld(true);
    reflCam.projectionMatrix.copy(camera.projectionMatrix);
    reflCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);

    texMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    texMatrix.multiply(reflCam.projectionMatrix);
    texMatrix.multiply(reflCam.matrixWorldInverse);

    const waveWasVisible = wave.visible;
    floor.visible = false;
    wave.visible = false;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(reflRT);
    renderer.clear();
    renderer.render(scene, reflCam);
    renderer.setRenderTarget(prevTarget);
    floor.visible = true;
    wave.visible = waveWasVisible;
  }

  function render() {
    if (typeof window !== 'undefined' && window.devicePixelRatio && window.devicePixelRatio !== lastDpr) {
      resize(viewW, viewH);
    }
    renderReflection();
    composer.render();
  }

  // ---------- misc API ----------
  function add(object3d) {
    if (object3d && object3d.isObject3D) actors.add(object3d);
    return object3d;
  }

  function dispose() {
    nebulaRT.dispose();
    reflRT.dispose();
    // EffectComposer.dispose() frees its own targets only; the passes hold targets / materials too
    if (typeof bloomPass.dispose === 'function') bloomPass.dispose();
    if (typeof finalPass.dispose === 'function') finalPass.dispose();
    composer.dispose();
    world.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    renderer.dispose();
  }

  // ---------- boot ----------
  resize();
  update(0, 0, EMPTY_STATE);

  return {
    renderer,
    scene,
    camera,
    add,
    update,
    render,
    resize,
    pulse,
    setMode,
    setPlayers,
    getPlayerSpots: (n) => getPlayerSpots(n === undefined ? playerCount : n),
    // extras (not required by the contract)
    tuning,
    ladder, // the hit ladder (per-rating effect sizes); live, safe to tweak
    ratingColors: RATING_COL, // THREE.Color per rating, used by every hit effect; live
    playerColors: PLAYER_COL,
    dispose,
    get mode() {
      return mode;
    },
    get playerCount() {
      return playerCount;
    },
    /** Camera distance of the play shot for the current player count and aspect ratio. */
    get playDistance() {
      return playDist;
    },
    /** Camera distance NOVA alone would need (the v1 play shot; menu and results build on it). */
    get soloDistance() {
      return soloDist;
    },
  };
}
