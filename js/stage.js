// STARFALL — stage.js
// The world NOVA dances in: shader nebula sky with a giant rising star, god rays, a glossy
// planar-reflective floor, a beat-synced light rig, GPU particles, shockwaves, the camera
// director and the post-processing chain (bloom + filmic final pass).
//
// Everything here is procedural: no textures, models or other assets are loaded.
// Conventions (see CONTRACT.md): +x screen right, +y up, +z toward the viewer, metres,
// dancer at the origin facing +z.

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
  msaaBelowPixelRatio: 1.5, // 4x MSAA on the scene target when the pixel ratio is below this
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
  wavePower: 0.2, // rating shockwave brightness (a thin ring well behind the dancer)
  resultsShift: 0.22, // results: the view is shifted so NOVA stands in the left third (fraction of width)
  menuShift: -0.19, // title: NOVA stands in the right third, clear of the logo and buttons
  cameraFov: 30, // vertical fov, all modes
  // 'play' framing: the dancer's reach box must stay inside these NDC limits
  frameTop: 0.9,
  frameBottom: 0.66, // keeps her feet above the HUD pictogram lane
  frameSide: 0.66,
  playDollyBeat: 0.07, // metres of dolly-in on each kick
  playSway: 0.1, // metres of lateral camera sway
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
  verseA: makeLook(HEX.teal, HEX.violet, HEX.amber, 0.88, 0.68, 0.55, 1.0, 0.15, 0.65, 0.5),
  build: makeLook(HEX.violet, HEX.amber, HEX.coral, 0.95, 0.8, 0.7, 1.4, 0.45, 0.8, 0.7),
  // choruses: violet space with amber/coral as accents (an amber-primary nebula washed the frame out)
  chorus1: makeLook(HEX.violet, HEX.amber, HEX.coral, 0.9, 0.75, 1.0, 2.0, 1.0, 1.0, 1.0),
  verseB: makeLook(HEX.teal, HEX.coral, HEX.violet, 0.9, 0.72, 0.6, 1.1, 0.2, 0.7, 0.55),
  bridge: makeLook(HEX.deepViolet, HEX.teal, HEX.violet, 0.58, 0.85, 0.24, 0.4, 0.0, 0.55, 0.3),
  chorus2: makeLook(HEX.violet, HEX.teal, HEX.amber, 1.0, 0.8, 1.0, 2.0, 1.0, 1.0, 1.0),
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
  vec3 col = mix(vec3(0.004, 0.003, 0.012), vec3(0.020, 0.011, 0.055), pow(1.0 - abs(h), 2.5));

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
  col += mix(uColA * 0.10, uStarEdge * 0.10, pow(az, 6.0)) * hg * (0.55 + 0.45 * uStarPower);

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
    disc = mix(uStarEdge * 0.7, uStarCore * 1.9, pow(mu, 0.85)); // strong limb darkening: a ball of fire, not a flat plate
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
  float shafts = pow(a1, 2.2) * 1.3 + pow(a2, 3.0) * 0.8 + pow(a3, 4.0) * 0.5;
  float o = max(r - 1.0, 0.0);
  float fall = smoothstep(0.9, 1.12, r) * exp(-o * 0.95);
  float edge = 1.0 - smoothstep(0.55, 1.0, r / uSpan);
  float ground = smoothstep(0.0, 9.0, vWorld.y);
  vec3 col = mix(uEdge, uCore, exp(-o * 1.6)) * (shafts * fall * edge * ground * uPower);
  gl_FragColor = vec4(col, 1.0);
}
`;

// --- Floor: planar reflection + fresnel, LED lines, beat rings, edge ring ---
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
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec4 uRings[4];
uniform vec3 uRingCols[4];
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
  float fres = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);
  fres = mix(fres, 1.0, 0.12 * stageMask);

  // --- LED pattern on the stage disc ---
  float ringLine = (1.0 - smoothstep(0.0, fr * 1.5, abs(fract(r + 0.5) - 0.5))) * clamp(1.0 - fr * 3.0, 0.0, 1.0);
  float sp = atan(wp.z, wp.x) * (24.0 / 6.2831853);
  float fs = fwidth(sp) + 1e-5;
  float spoke = (1.0 - smoothstep(0.0, fs * 1.5, abs(fract(sp + 0.5) - 0.5))) * clamp(1.0 - fs * 3.0, 0.0, 1.0);
  spoke *= smoothstep(1.3, 2.2, r);
  float cellRnd = hash21(vec2(floor(r) + uBeatIndex * 7.13, floor(sp) + uBeatIndex * 3.71));
  float lit = step(1.0 - 0.20 * uEnergy, cellRnd) * smoothstep(1.6, 2.4, r);
  float wave = exp(-pow((r - uBeatPhase * uStageR * 1.05) * 1.3, 2.0));
  vec3 lineCol = mix(uColB, uColA, smoothstep(0.0, uStageR, r));
  vec3 em = lineCol * (ringLine * 0.55 + spoke * 0.30) * (0.10 + 0.25 * uEnergy + wave * uKick * 1.6);
  em += uColA * (lit * uKick * 0.20);
  em += lineCol * (wave * uKick * 0.06);
  float mark = 1.0 - smoothstep(0.0, 0.02 + fr, abs(r - 0.95));
  em += uColB * mark * (0.30 + 0.40 * uKick);
  em *= stageMask;

  // --- stage rim ---
  float edgeBand = smoothstep(uStageR - 0.16 - fr, uStageR - 0.16 + fr, r) * stageMask;
  em += mix(uColC, vec3(1.0), 0.25) * edgeBand * (1.2 + 1.6 * uKick + uFlash * 2.0);
  em += uColC * exp(-max(r - uStageR, 0.0) * 1.6) * (1.0 - stageMask) * (0.18 + 0.25 * uKick);

  // --- pulse rings (rating feedback) ---
  for (int i = 0; i < 4; i++) {
    float age = uTime - uRings[i].x;
    if (age > 0.0 && age < 3.0) {
      float rad = age * uRings[i].z + 0.6;
      float wdt = 0.10 + age * 0.22;
      float q = (r - rad) / wdt;
      float ring = exp(-q * q) * uRings[i].y * exp(-age * 1.7);
      em += uRingCols[i] * ring * mix(0.35, 1.0, stageMask);
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
  float facing = abs(dot(normalize(vN), normalize(vV)));
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
void main() {
  vY = position.y;
  vH = length(instanceMatrix[1].xyz);
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const PYLON_FRAG = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uPower;
varying float vY;
varying float vH;
varying float vSeed;
void main() {
  float hgt = vY * vH;
  float seg = fract(hgt * 5.0);
  float gap = smoothstep(0.0, 0.14, seg) * smoothstep(1.0, 0.86, seg);
  vec3 c = mix(uColB, uColA, clamp(hgt / 2.4, 0.0, 1.0));
  float cap = smoothstep(1.0 - 0.07 / max(vH, 0.05), 1.0, vY);
  vec3 col = c * (0.22 + 0.85 * vY) * gap * uPower;
  col += mix(c, vec3(1.0), 0.6) * cap * (0.9 + 0.6 * uPower);
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
  c += vec3(1.0) * pow(across, 6.0) * 0.25;
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
  float glow = a * a + pow(a, 8.0) * 1.6;
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
  float drag = 1.9;
  vec3 p = position + aVel * ((1.0 - exp(-age * drag)) / drag);
  p.y -= 0.55 * age * age;
  p.y = abs(p.y) + 0.02;
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  gl_PointSize = min(aMeta.z * (1.0 - t * 0.5) * uScale / depth, uMaxSize);
  float flick = 0.7 + 0.3 * sin(age * 30.0 + aMeta.w * 50.0);
  vA = pow(1.0 - t, 1.6) * flick;
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

// --- Shockwave rings (billboard behind the dancer) ---
const WAVE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const WAVE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec4 uWaves[3];     // birth, strength, max radius (0..1 of the quad), duration
uniform vec3 uWaveCols[3];
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float theta = atan(p.y, p.x);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float age = uTime - uWaves[i].x;
    float t = age / max(uWaves[i].w, 1e-3);
    if (t > 0.0 && t < 1.0) {
      float e = 1.0 - pow(1.0 - t, 3.0);
      float rad = mix(0.07, uWaves[i].z, e);
      float wdt = mix(0.035, 0.010, e);
      float q = (r - rad) / wdt;
      float ring = exp(-q * q);
      float inner = smoothstep(rad - 0.10, rad, r) * (1.0 - step(rad, r)) * 0.04; // hollow: a ring, not a dome
      float spark = 0.80 + 0.20 * sin(theta * 28.0 + age * 9.0 + float(i) * 2.0);
      col += uWaveCols[i] * ((ring * spark + inner) * uWaves[i].y * pow(1.0 - t, 1.5));
    }
  }
  col *= 1.0 - smoothstep(0.86, 1.0, r);
  gl_FragColor = vec4(col, 1.0);
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
    uHit: { value: 0 },
    uHitColor: { value: new THREE.Color(0, 0, 0) },
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
uniform float uHit;
uniform vec3 uHitColor;
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

  // rating colour hit: a glow that lives on the frame edges only
  float edge = smoothstep(0.10, 0.55, r2);
  col += uHitColor * (uHit * edge * 0.55);

  col = filmic(col);

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
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
const BURST_MAX = 800;
const RIBBON_COUNT = 3;
const RIBBON_SEGMENTS = 110;

// Reach box of a 1.7 m dancer at the origin (arms overhead / spread, hip shift, hair).
const BOX_X = 1.3;
const BOX_Y0 = -0.06;
const BOX_Y1 = 2.28;
const BOX_Z = 0.55;
const PLAY_CAM_HEIGHT = 1.16;
const PLAY_TARGET_Y = 1.1;
const PLAY_DOLLY_MAX_IN = 0.24;
const PLAY_BOB = 0.025;

const ZERO_LEVELS = Object.freeze({ bass: 0, mid: 0, high: 0, kick: 0 });
const EMPTY_STATE = Object.freeze({});

// ---------------------------------------------------------------------------------------
// createStage
// ---------------------------------------------------------------------------------------
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
  let playDist = 6.4;
  let viewShift = TUNING.menuShift;
  let viewShifted = false;

  const look = makeLook(HEX.violet, HEX.teal, HEX.amber, 1, 1, 0.4, 0.45, 0, 0.8, 0.55);
  let energySm = 0.3;
  let kickSm = 0;
  let bassSm = 0;
  let midSm = 0;
  let highSm = 0;
  let beamPhase = 0;

  // feedback envelopes (decay in update)
  let hitAmt = 0;
  const hitColor = new THREE.Color(0, 0, 0);
  let lightFlash = 0;
  let camPunch = 0;
  let starFlare = 0;
  let missAmt = 0;
  let caKick = 0;

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
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  const COL = {
    violet: new THREE.Color(HEX.violet),
    teal: new THREE.Color(HEX.teal),
    amber: new THREE.Color(HEX.amber),
    coral: new THREE.Color(HEX.coral),
    white: new THREE.Color(HEX.white),
  };
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
  const ringUniforms = [];
  const ringColors = [];
  for (let i = 0; i < 4; i++) {
    ringUniforms.push(new THREE.Vector4(-1000, 0, 7, 0));
    ringColors.push(new THREE.Color(0, 0, 0));
  }
  let ringCursor = 0;

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
      uColA: { value: new THREE.Color(HEX.violet) },
      uColB: { value: new THREE.Color(HEX.teal) },
      uColC: { value: new THREE.Color(HEX.amber) },
      uRings: { value: ringUniforms },
      uRingCols: { value: ringColors },
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

  /**
   * Spawn `count` sparks on a halo around the dancer, flying outward (and slightly back) so
   * the burst frames her instead of covering her.
   */
  function emitBurst(count, colA, colB, speed, life, size, lift) {
    for (let n = 0; n < count; n++) {
      const i = burstCursor;
      burstCursor = (burstCursor + 1) % BURST_MAX;
      const ang = Math.random() * TAU;
      const rr = 0.42 + Math.random() * 0.34;
      const cx = Math.cos(ang);
      const sy = Math.sin(ang);
      const v = speed * (0.3 + Math.random() * 0.7);
      const a = i * 3;
      burstPos[a] = cx * rr * 0.85;
      burstPos[a + 1] = 1.05 + sy * rr * 1.15;
      burstPos[a + 2] = -0.5 - Math.random() * 0.4; // born behind her, never on top of her body
      burstVel[a] = cx * v;
      burstVel[a + 1] = sy * v * 0.85 + lift;
      burstVel[a + 2] = (Math.random() - 0.7) * v * 0.6;
      const m = i * 4;
      burstMeta[m] = clock + Math.random() * 0.06;
      burstMeta[m + 1] = life * (0.55 + Math.random() * 0.45);
      burstMeta[m + 2] = size * (0.5 + Math.random());
      burstMeta[m + 3] = Math.random();
      const t = Math.random();
      const hot = 1.2 + Math.random() * 1.4;
      burstCol[a] = lerp(colA.r, colB.r, t) * hot;
      burstCol[a + 1] = lerp(colA.g, colB.g, t) * hot;
      burstCol[a + 2] = lerp(colA.b, colB.b, t) * hot;
    }
    burstPosAttr.needsUpdate = true;
    burstVelAttr.needsUpdate = true;
    burstMetaAttr.needsUpdate = true;
    burstColAttr.needsUpdate = true;
  }

  function emitRing(color, strength, speed, delay) {
    const v = ringUniforms[ringCursor];
    v.set(clock + delay, strength, speed, 0);
    ringColors[ringCursor].copy(color);
    ringCursor = (ringCursor + 1) % ringUniforms.length;
  }

  // ---------- shockwave billboard ----------
  const waveUniforms = [];
  const waveColors = [];
  for (let i = 0; i < 3; i++) {
    waveUniforms.push(new THREE.Vector4(-1000, 0, 0.8, 1));
    waveColors.push(new THREE.Color(0, 0, 0));
  }
  let waveCursor = 0;
  let waveAliveUntil = -1;
  const waveMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWaves: { value: waveUniforms },
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
  const wave = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), waveMat);
  wave.position.set(0, 1.05, -2.0);
  wave.frustumCulled = false;
  wave.renderOrder = 15;
  wave.visible = false;
  wave.name = 'shockwave';
  world.add(wave);

  function emitWave(color, strength, maxRadius, duration, delay) {
    const v = waveUniforms[waveCursor];
    v.set(clock + delay, strength * tuning.wavePower, maxRadius, duration);
    waveColors[waveCursor].copy(color);
    waveCursor = (waveCursor + 1) % waveUniforms.length;
    waveAliveUntil = Math.max(waveAliveUntil, clock + delay + duration);
    wave.visible = true;
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
  const fitCam = new THREE.PerspectiveCamera(tuning.cameraFov, 16 / 9, 0.1, 100);
  const fitTarget = new THREE.Vector3(0, PLAY_TARGET_Y, 0);
  const camPos = new THREE.Vector3(0, 1.5, 7.5);
  const camTgt = new THREE.Vector3(0, 1.1, 0);
  const desPos = new THREE.Vector3();
  const desTgt = new THREE.Vector3();

  function boxFits(dist, aspect) {
    fitCam.fov = tuning.cameraFov;
    fitCam.aspect = aspect;
    fitCam.updateProjectionMatrix();
    const sway = Math.abs(tuning.playSway) + 0.02;
    // worst-case camera placements: nearest dolly, both sway extremes, both bob extremes
    for (let sx = -1; sx <= 1; sx++) {
      for (let sy = -1; sy <= 1; sy += 2) {
        fitCam.position.set(sx * sway, PLAY_CAM_HEIGHT + sy * PLAY_BOB, dist - PLAY_DOLLY_MAX_IN);
        fitCam.up.set(0, 1, 0);
        fitCam.lookAt(fitTarget);
        fitCam.updateMatrixWorld(true);
        for (let cx = -1; cx <= 1; cx += 2) {
          for (let cy = 0; cy <= 1; cy++) {
            for (let cz = -1; cz <= 1; cz += 2) {
              _v3.set(cx * BOX_X, cy ? BOX_Y1 : BOX_Y0, cz * BOX_Z);
              // behind / too close to the lens counts as not fitting
              if (fitCam.position.z - _v3.z < 0.5) return false;
              _v3.project(fitCam);
              if (Math.abs(_v3.x) > tuning.frameSide) return false;
              if (_v3.y > tuning.frameTop) return false;
              if (_v3.y < -tuning.frameBottom) return false;
            }
          }
        }
      }
    }
    return true;
  }

  /** Smallest camera distance at which the dancer's whole reach box is inside the safe frame. */
  function computePlayDistance(aspect) {
    let lo = 2.0;
    let hi = 60;
    if (!boxFits(hi, aspect)) return hi;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) * 0.5;
      if (boxFits(mid, aspect)) hi = mid;
      else lo = mid;
    }
    return hi + 0.02;
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
    playDist = computePlayDistance(camera.aspect);

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
      emitRing(COL.amber, 1.0, 6.0, 0);
      emitBurst(120, COL.amber, COL.white, 3.4, 1.8, 0.07, 1.4);
      starFlare = Math.max(starFlare, 0.35);
    }
  }

  // ---------- pulse ----------
  function pulse(kind) {
    switch (kind) {
      case 'perfect':
        emitBurst(56, COL.teal, COL.white, 3.6, 1.0, 0.055, 0.9);
        emitRing(COL.teal, 1.15, 8.0, 0);
        emitWave(COL.teal, 0.5, 0.45, 0.6, 0);
        hitColor.copy(COL.teal);
        hitAmt = Math.max(hitAmt, 0.75);
        lightFlash = Math.max(lightFlash, 0.6);
        camPunch = Math.max(camPunch, 0.4);
        caKick = Math.max(caKick, 0.5);
        break;
      case 'super':
        emitBurst(60, COL.violet, COL.teal, 3.0, 1.0, 0.055, 0.7);
        emitRing(COL.violet, 0.95, 7.0, 0);
        hitColor.copy(COL.violet);
        hitAmt = Math.max(hitAmt, 0.6);
        lightFlash = Math.max(lightFlash, 0.4);
        camPunch = Math.max(camPunch, 0.2);
        break;
      case 'good':
        emitBurst(34, COL.teal, COL.violet, 2.3, 0.85, 0.045, 0.5);
        emitRing(COL.teal, 0.55, 6.0, 0);
        hitColor.copy(COL.teal);
        hitAmt = Math.max(hitAmt, 0.32);
        lightFlash = Math.max(lightFlash, 0.2);
        break;
      case 'ok':
        emitBurst(14, COL.violet, COL.violet, 1.6, 0.7, 0.036, 0.3);
        emitRing(COL.violet, 0.28, 5.0, 0);
        hitColor.copy(COL.violet);
        hitAmt = Math.max(hitAmt, 0.16);
        break;
      case 'miss':
        hitColor.copy(COL.coral);
        hitAmt = Math.max(hitAmt, 0.5);
        missAmt = 1;
        caKick = Math.max(caKick, 0.8);
        break;
      case 'gold':
        emitBurst(160, COL.amber, COL.white, 4.8, 1.7, 0.06, 1.3);
        emitRing(COL.amber, 1.5, 9.0, 0);
        emitRing(COL.white, 0.9, 6.5, 0.12);
        emitWave(COL.amber, 1.2, 0.8, 0.9, 0);
        emitWave(COL.white, 0.5, 0.5, 0.7, 0.1);
        hitColor.copy(COL.amber);
        hitAmt = 1;
        lightFlash = 0.8;
        camPunch = 1;
        starFlare = Math.max(starFlare, 0.15);
        caKick = 1;
        break;
      default:
        break;
    }
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
    hitAmt *= Math.exp(-delta * 3.2);
    lightFlash *= Math.exp(-delta * 5.0);
    camPunch *= Math.exp(-delta * 4.0);
    starFlare *= Math.exp(-delta * 1.8);
    missAmt *= Math.exp(-delta * 2.6);
    caKick *= Math.exp(-delta * 5.0);

    const starPower = tuning.starPower * look.star * (1 + rise * 0.25);

    // --- sky ---
    const su = skyMat.uniforms;
    setU(su, 'uTime', clock);
    setU(su, 'uNebula', look.nebula);
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
    setU(fu, 'uFlash', lightFlash);
    setU(fu, 'uReflStrength', tuning.floorReflectivity);
    setU(fu, 'uColA', look.a);
    setU(fu, 'uColB', look.b);
    setU(fu, 'uColC', look.c);

    // --- lights ---
    const accent = kick * energy;
    hemi.color.copy(HEMI_SKY).lerp(look.a, 0.22);
    hemi.intensity = 1.0 + 0.25 * energy;
    keyLight.intensity = 2.15 + 0.35 * energy + lightFlash * 1.1 - missAmt * 0.6;
    backLight.color.copy(STAR_CORE).lerp(look.c, 0.2);
    backLight.intensity = (2.6 + 1.2 * accent + starFlare * 3.0) * clamp(starPower, 0.5, 1.5);
    rimL.color.copy(look.b);
    rimR.color.copy(look.a);
    const rimBase = 2.2 + 0.9 * energy;
    const alt = (((beatFloor % 2) + 2) % 2) === 0 ? 1 : 0; // alternate the kickers on each beat
    rimL.intensity = rimBase + accent * (0.5 + 1.1 * alt) + lightFlash * 1.5;
    rimR.intensity = rimBase + accent * (0.5 + 1.1 * (1 - alt)) + lightFlash * 1.5;

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
      const tx = Math.sin(psi) * rho * 1.55;
      const tz = -1.3 - Math.abs(Math.cos(psi)) * rho * 0.8;
      const col = i % 3 === 2 ? look.c : i % 2 ? look.b : look.a;
      const chase = lerp(1, i === chaseIdx ? 1.35 : 0.3, look.strobe);
      const inten = beamBase * (0.55 + 0.45 * kick) * chase + lightFlash * 0.5;
      setBeam(i, tx, 0.0, tz, 0.55 + 0.25 * energy, col, inten);
    }
    const fanOpen = 0.25 + 0.75 * (0.35 * energy + 0.65 * kick);
    const fanChase = ((beatFloor % BEAM_FAN) + BEAM_FAN) % BEAM_FAN;
    for (let i = 0; i < BEAM_FAN; i++) {
      const bi = BEAM_TOP + i;
      const f = (i / (BEAM_FAN - 1)) * 2 - 1;
      const alpha = f * (0.3 + 0.42 * fanOpen) + 0.2 * Math.sin(beamPhase * 1.3 + i * 0.5);
      const k = bi * 3;
      const len = 30;
      _v2.set(Math.sin(alpha), Math.cos(alpha), -0.3).normalize();
      const col = i % 2 ? look.c : look.b;
      const chase = lerp(1, i === fanChase || i === BEAM_FAN - 1 - fanChase ? 1.3 : 0.4, look.strobe);
      const inten = beamBase * 0.62 * (0.4 + 0.6 * kick) * chase + lightFlash * 0.35;
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
    for (let i = 0; i < PYLON_COUNT; i++) {
      const g = pylonBand[i];
      const tri = 1 - Math.abs(g * 2 - 1);
      let band = bassSm * (1 - g) * (1 - g) + midSm * tri + highSm * g * g;
      band += kick * (1 - g) * 0.5;
      const jitter = 0.55 + 0.45 * Math.sin(pylonSeed[i] * 91.7 + stepIdx * 2.399);
      const idle = 0.16 + 0.1 * Math.sin(clock * 1.3 + (i % half) * 0.7);
      const targetH = idle + clamp01(band) * jitter * (1.2 + 1.5 * energy);
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
    setU(pylonMat.uniforms, 'uPower', 0.55 + 0.9 * energy + 0.5 * kick + lightFlash);

    // --- ribbons ---
    const rbu = ribbonMat.uniforms;
    setU(rbu, 'uTime', clock);
    setU(rbu, 'uMid', midSm);
    setU(rbu, 'uPower', look.ribbons * (0.3 + 0.35 * energy + 0.3 * midSm + 0.15 * kick));
    setU(rbu, 'uColA', look.a);
    setU(rbu, 'uColB', look.b);
    setU(rbu, 'uColC', look.c);

    // --- particles ---
    setU(dustMat.uniforms, 'uTime', clock);
    setU(dustMat.uniforms, 'uPower', 0.55 + 0.35 * highSm + 0.25 * energy);
    setU(dustMat.uniforms, 'uColA', look.a);
    setU(dustMat.uniforms, 'uColB', look.b);
    setU(emberMat.uniforms, 'uTime', clock);
    setU(emberMat.uniforms, 'uAmount', clamp01(look.embers * (0.45 + 0.55 * energy) + rise * 0.3));
    setU(emberMat.uniforms, 'uPower', 0.8 + 0.5 * kick);
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
    if (mode === 'play') {
      // Front camera. Every offset here is bounded by what computePlayDistance() assumed,
      // so the dancer's whole reach box stays inside the safe frame on every aspect ratio.
      const sway = Math.sin(beat * (Math.PI / 8)) * tuning.playSway;
      const bob = Math.sin(beat * (Math.PI / 4)) * PLAY_BOB;
      const dollyIn = clamp(tuning.playDollyBeat * kick * energy + camPunch * 0.13, 0, PLAY_DOLLY_MAX_IN);
      const breathe = 0.12 * (1 - energy); // sits a touch further back in quiet sections
      desPos.set(sway, PLAY_CAM_HEIGHT + bob, playDist + breathe - dollyIn);
      desTgt.set(0, PLAY_TARGET_Y, 0);
      const roll = Math.sin(beat * (Math.PI / 8) + 1.0) * 0.006;
      camera.up.set(Math.sin(roll), Math.cos(roll), 0);
      follow = 9;
    } else if (mode === 'results') {
      // hero shot: closer, low, NOVA in the left third (the score panel sits on the right)
      const ang = Math.sin(clock * 0.2) * 0.26 - 0.1;
      const rad = playDist * 0.8 + Math.sin(clock * 0.13) * 0.2;
      desPos.set(Math.sin(ang) * rad, 0.9 + Math.sin(clock * 0.17) * 0.1, Math.cos(ang) * rad);
      desTgt.set(0, 1.12, 0);
      follow = 2.2;
      shiftTarget = tuning.resultsShift * wideAspect;
    } else {
      // menu: slow arc across the front of the stage; her face always stays toward the lens
      const ang = Math.sin(clock * 0.14) * 0.42 + Math.sin(clock * 0.047 + 1.3) * 0.06 + 0.12;
      const rad = playDist * 1.0 + Math.sin(clock * 0.11) * 0.4;
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
    camera.lookAt(camTgt);
    camera.updateMatrixWorld(true);

    // shockwave quad faces the lens
    if (wave.visible) wave.quaternion.copy(camera.quaternion);

    // --- post ---
    if (bloomPass) {
      bloomPass.strength = tuning.bloomStrength + 0.1 * kick * energy + starFlare * 0.12 + lightFlash * 0.04;
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
      setU(finalU, 'uExposure', tuning.exposure * (1 + lightFlash * 0.06 - missAmt * 0.12));
      setU(finalU, 'uVignette', tuning.vignette + missAmt * 0.18);
      setU(finalU, 'uCA', tuning.chromaticAberration * (1 + caKick * 2.2 + kick * energy * 0.35));
      setU(finalU, 'uGrain', tuning.grain);
      setU(finalU, 'uHit', hitAmt);
      setU(finalU, 'uHitColor', hitColor);
      setU(finalU, 'uSaturation', 1.06 - missAmt * 0.45);
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
    // extras (not required by the contract)
    tuning,
    dispose,
    get mode() {
      return mode;
    },
    get playDistance() {
      return playDist;
    },
  };
}
