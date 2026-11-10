// NOVA — the original procedural idol-dancer of STARFALL.
//
// Everything here is generated from code: lofted organic body parts, a canvas-painted face,
// a spring-simulated ponytail, a lagging halo ring and a custom cel/rim shader.
//
// Pose convention (see CONTRACT.md): every segment is a unit direction parent -> child in stage
// space (+x screen right, +y up, +z toward the viewer); `l*` limbs are on the SCREEN-LEFT (-x).
import * as THREE from 'three';

/* ------------------------------------------------------------------------------------------ */
/* Proportions (metres)                                                                        */
/* ------------------------------------------------------------------------------------------ */

const DIM = {
  ankle: 0.095, // sole -> ankle joint (chunky sneaker)
  shin: 0.43,
  thigh: 0.44,
  hipDrop: 0.035, // hip sockets sit slightly below the hip centre
  hipHalf: 0.088,
  spine: 0.47, // hip centre -> neck base
  shoulderY: 0.407, // along the spine
  shoulderHalf: 0.121, // tucked in so the sleeve grows out of the jacket instead of sitting beside it
  upperArm: 0.265,
  forearm: 0.235,
  headCentre: 0.146, // neck base -> head centre
  headLen: 0.268, // neck base -> top of skull (headCentre + headRY * headScale)
  headRY: 0.115, // modelling radius of the skull, before headScale
  headScale: 1.06,
  footHeel: -0.092,
  footToe: 0.2,
  footHalfW: 0.058,
};

const HEIGHT = DIM.ankle + DIM.shin + DIM.thigh + DIM.hipDrop + DIM.spine + DIM.headLen + 0.012;

const SEGMENTS = [
  'spine', 'head',
  'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm',
  'lThigh', 'lShin', 'rThigh', 'rShin',
];

const IDLE_POSE = {
  spine: [0, 1, 0],
  head: [0, 1, 0],
  lUpperArm: [-0.2, -1, 0], lForearm: [-0.1, -1, 0.1],
  rUpperArm: [0.2, -1, 0], rForearm: [0.1, -1, 0.1],
  lThigh: [-0.08, -1, 0], lShin: [0, -1, 0],
  rThigh: [0.08, -1, 0], rShin: [0, -1, 0],
  hipX: 0,
  yaw: 0,
};

/* ------------------------------------------------------------------------------------------ */
/* Palette                                                                                     */
/* ------------------------------------------------------------------------------------------ */

function lin(hex, mul = 1) {
  const c = new THREE.Color(hex);
  return [c.r * mul, c.g * mul, c.b * mul];
}

const COL = {
  skin: lin('#b9774c'),
  hair: lin('#c4cbe6'), // silver-white that stays under the bloom threshold
  hairTip: lin('#3fe6da'),
  jacket: lin('#261c78'),
  jacketRib: lin('#1a1356'),
  jacketInner: lin('#1a1250'),
  black: lin('#16141f'),
  blackHi: lin('#221f30'),
  glove: lin('#1c1929'),
  white: lin('#f5f5fa'),
  offWhite: lin('#dcdde8'),
  teal: lin('#19e3d2'),
  amber: lin('#ffc24a'),
  coral: lin('#ff5a6e'),
};

const GLOW = {
  none: [0, 0, 0],
  teal: lin('#19e3d2', 1.8),
  tealSoft: lin('#19e3d2', 1.25),
  amber: lin('#ffc24a', 1.5),
  amberHot: lin('#ffd27a', 1.8),
  sole: lin('#8ff5ee', 1.5),
};

// aShade = (specular strength, skin amount, face-texture weight, hair amount)
const SH = {
  cloth: [0.0, 0, 0, 0],
  satin: [0.12, 0, 0, 0],
  skin: [0.0, 1, 0, 0],
  hair: [0.0, 0, 0, 1],
  gloss: [0.9, 0, 0, 0],
  glow: [0.0, 0, 0, 0],
};

/* ------------------------------------------------------------------------------------------ */
/* Tiny raw-geometry toolkit (plain arrays; merged into one BufferGeometry per rigid part)     */
/* ------------------------------------------------------------------------------------------ */

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Ring = elliptical (super-elliptical) cross-section in the xz-plane at height y. */
function R(y, rx, zf, zb = zf, x = 0, z = 0, e = 2) {
  return { y, rx, zf, zb, x, z, e };
}

function grow(r, off) {
  return { y: r.y, rx: r.rx + off, zf: r.zf + off, zb: r.zb + off, x: r.x, z: r.z, e: r.e };
}

function ringPoint(r, a, off, out, o) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const ex = 2 / (r.e || 2);
  const ax = Math.sign(c) * Math.pow(Math.abs(c), ex);
  const az = Math.sign(s) * Math.pow(Math.abs(s), ex);
  const rz = s >= 0 ? r.zf : r.zb;
  out[o] = r.x + (r.rx + off) * ax;
  out[o + 1] = r.y;
  out[o + 2] = r.z + (rz + off) * az;
}

const RING_KEYS = ['rx', 'zf', 'zb', 'x', 'z', 'e'];

/** Smooth (cubic Hermite) profile through control rings sorted by ascending y. */
function makeProfile(ctrl) {
  const n = ctrl.length;
  const tang = {};
  for (const k of RING_KEYS) {
    tang[k] = ctrl.map((c, i) => {
      const a = ctrl[Math.max(i - 1, 0)];
      const b = ctrl[Math.min(i + 1, n - 1)];
      const dy = b.y - a.y;
      return dy !== 0 ? (b[k] - a[k]) / dy : 0;
    });
  }
  const at = (y) => {
    const yy = clamp(y, ctrl[0].y, ctrl[n - 1].y);
    let i = 0;
    while (i < n - 2 && yy > ctrl[i + 1].y) i++;
    const a = ctrl[i];
    const b = ctrl[i + 1];
    const h = b.y - a.y || 1e-6;
    const t = (yy - a.y) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const out = { y };
    for (const k of RING_KEYS) {
      out[k] = h00 * a[k] + h10 * h * tang[k][i] + h01 * b[k] + h11 * h * tang[k][i + 1];
    }
    out.rx = Math.max(out.rx, 0.0005);
    out.zf = Math.max(out.zf, 0.0005);
    out.zb = Math.max(out.zb, 0.0005);
    return out;
  };
  at.y0 = ctrl[0].y;
  at.y1 = ctrl[n - 1].y;
  return at;
}

function sampleRings(at, y0, y1, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(at(mix(y0, y1, i / (n - 1))));
  return out;
}

/** Quarter-ellipse dome rings moving away from `ring` by dy (not including the ring itself). */
function domeRings(ring, dy, n = 4) {
  const out = [];
  for (let k = 1; k <= n; k++) {
    const th = (k / n) * HALF_PI * 0.94;
    const c = Math.cos(th);
    out.push({
      y: ring.y + dy * Math.sin(th),
      rx: ring.rx * c, zf: ring.zf * c, zb: ring.zb * c,
      x: ring.x, z: ring.z, e: mix(ring.e, 2, k / n),
    });
  }
  return out;
}

/** Loft through rings (ascending y => outward-facing). Vertices are shared around the seam. */
function loft(rings, seg = 16, capA = true, capB = true) {
  const n = rings.length;
  const p = new Array((n * seg + (capA ? 1 : 0) + (capB ? 1 : 0)) * 3);
  const idx = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < seg; j++) ringPoint(rings[i], (j / seg) * TAU, 0, p, (i * seg + j) * 3);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      const a = i * seg + j;
      const b = (i + 1) * seg + j;
      const c = i * seg + j1;
      const d = (i + 1) * seg + j1;
      idx.push(a, b, c, b, d, c);
    }
  }
  let v = n * seg;
  if (capA) {
    const r = rings[0];
    p[v * 3] = r.x; p[v * 3 + 1] = r.y; p[v * 3 + 2] = r.z;
    for (let j = 0; j < seg; j++) idx.push(v, j, (j + 1) % seg);
    v++;
  }
  if (capB) {
    const r = rings[n - 1];
    const base = (n - 1) * seg;
    p[v * 3] = r.x; p[v * 3 + 1] = r.y; p[v * 3 + 2] = r.z;
    for (let j = 0; j < seg; j++) idx.push(v, base + ((j + 1) % seg), base + j);
  }
  return { p, i: idx };
}

/** Capsule-like limb: smooth profile + rounded ends. */
function capsule(ctrl, { n = 10, seg = 16, bot = 0.03, top = 0.03, dome = 4 } = {}) {
  const at = makeProfile(ctrl);
  const body = sampleRings(at, at.y0, at.y1, n);
  const rings = [];
  if (bot > 0) rings.push(...domeRings(body[0], -bot, dome).reverse());
  rings.push(...body);
  if (top > 0) rings.push(...domeRings(body[n - 1], top, dome));
  const raw = loft(rings, seg, true, true);
  raw.at = at;
  return raw;
}

/** Raised strip (piping) lying on a profile surface between two heights and two angles. */
function strip(at, y0, y1, a0, a1, off = 0.003, ny = 8, na = 2) {
  const ys = [y0];
  for (let i = 0; i <= ny; i++) ys.push(mix(y0, y1, i / ny));
  ys.push(y1);
  const da = (a1 - a0) * 0.18;
  const as = [a0 - da];
  for (let j = 0; j <= na; j++) as.push(mix(a0, a1, j / na));
  as.push(a1 + da);
  const rows = ys.length;
  const cols = as.length;
  const p = new Array(rows * cols * 3);
  const idx = [];
  for (let i = 0; i < rows; i++) {
    const ring = at(ys[i]);
    for (let j = 0; j < cols; j++) {
      const border = i === 0 || i === rows - 1 || j === 0 || j === cols - 1;
      ringPoint(ring, as[j], border ? -0.004 : off, p, (i * cols + j) * 3);
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = (i + 1) * cols + j;
      const c = i * cols + j + 1;
      const d = (i + 1) * cols + j + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { p, i: idx };
}

/** Raised band (piping ring) all the way around a profile at height y. */
function band(at, y, h, off = 0.003, seg = 24) {
  const rings = [
    grow(at(y - h), -0.004),
    grow(at(y - h * 0.5), off),
    grow(at(y + h * 0.5), off),
    grow(at(y + h), -0.004),
  ];
  return loft(rings, seg, false, false);
}

/** Five-point star draped over a profile surface, centred at (yc, ac). */
function starOn(at, yc, ac, radius, off = 0.003, rot = 0) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const r = k % 2 === 0 ? radius : radius * 0.44;
    const a = HALF_PI + rot + (k / 10) * TAU;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const sub = 3;
  const p = [];
  const idx = [];
  const tmp = [0, 0, 0];
  const ringMid = at(yc);
  const rLocal = Math.max(0.02, (ringMid.rx + (Math.sin(ac) >= 0 ? ringMid.zf : ringMid.zb)) * 0.5);
  const push = (u, v) => {
    ringPoint(at(yc + v), ac - u / rLocal, off, tmp, 0);
    p.push(tmp[0], tmp[1], tmp[2]);
    return p.length / 3 - 1;
  };
  for (let k = 0; k < 10; k++) {
    const A = pts[k];
    const B = pts[(k + 1) % 10];
    // barycentric grid over triangle (centre, A, B)
    const grid = [];
    for (let i = 0; i <= sub; i++) {
      grid.push([]);
      for (let j = 0; j <= sub - i; j++) {
        const wa = i / sub;
        const wb = j / sub;
        grid[i].push(push(A[0] * wa + B[0] * wb, A[1] * wa + B[1] * wb));
      }
    }
    for (let i = 0; i < sub; i++) {
      for (let j = 0; j < sub - i; j++) {
        idx.push(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
        if (j < sub - i - 1) idx.push(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
      }
    }
  }
  const raw = { p, i: idx };
  // make sure it faces away from the profile axis
  computeNormals(raw);
  const cx = p[0] - ringMid.x;
  const cz = p[2] - ringMid.z;
  if (raw.n[0] * cx + raw.n[2] * cz < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const s = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = s;
    }
    raw.n = null;
  }
  return raw;
}

function computeNormals(raw) {
  const p = raw.p;
  const idx = raw.i;
  const n = new Array(p.length).fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let v = 0; v < n.length; v += 3) {
    const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
    n[v] /= l; n[v + 1] /= l; n[v + 2] /= l;
  }
  raw.n = n;
  return raw;
}

const _tv = new THREE.Vector3();
const _tm3 = new THREE.Matrix3();

/** Rigidly transform a raw part in place. */
function xform(raw, m4) {
  const p = raw.p;
  for (let v = 0; v < p.length; v += 3) {
    _tv.set(p[v], p[v + 1], p[v + 2]).applyMatrix4(m4);
    p[v] = _tv.x; p[v + 1] = _tv.y; p[v + 2] = _tv.z;
  }
  if (raw.n) {
    _tm3.setFromMatrix4(m4);
    const n = raw.n;
    for (let v = 0; v < n.length; v += 3) {
      _tv.set(n[v], n[v + 1], n[v + 2]).applyMatrix3(_tm3).normalize();
      n[v] = _tv.x; n[v + 1] = _tv.y; n[v + 2] = _tv.z;
    }
  }
  return raw;
}

function displace(raw, fn) {
  const p = raw.p;
  const o = [0, 0, 0];
  for (let v = 0; v < p.length; v += 3) {
    o[0] = p[v]; o[1] = p[v + 1]; o[2] = p[v + 2];
    fn(o);
    p[v] = o[0]; p[v + 1] = o[1]; p[v + 2] = o[2];
  }
  raw.n = null;
  return raw;
}

function fromThree(geo) {
  const g = geo;
  const p = Array.from(g.attributes.position.array);
  const n = Array.from(g.attributes.normal.array);
  let i;
  if (g.index) i = Array.from(g.index.array);
  else {
    i = [];
    for (let k = 0; k < p.length / 3; k++) i.push(k);
  }
  geo.dispose();
  return { p, i, n };
}

/** Assign constant material attributes to a raw part. */
function paint(raw, color, glow = GLOW.none, shade = SH.cloth) {
  const count = raw.p.length / 3;
  raw.col = new Array(count * 3);
  raw.glow = new Array(count * 3);
  raw.shade = new Array(count * 4);
  for (let v = 0; v < count; v++) {
    raw.col[v * 3] = color[0]; raw.col[v * 3 + 1] = color[1]; raw.col[v * 3 + 2] = color[2];
    raw.glow[v * 3] = glow[0]; raw.glow[v * 3 + 1] = glow[1]; raw.glow[v * 3 + 2] = glow[2];
    raw.shade[v * 4] = shade[0]; raw.shade[v * 4 + 1] = shade[1];
    raw.shade[v * 4 + 2] = shade[2]; raw.shade[v * 4 + 3] = shade[3];
  }
  return raw;
}

function mergeParts(parts) {
  let vCount = 0;
  let iCount = 0;
  for (const part of parts) {
    if (!part.n) computeNormals(part);
    vCount += part.p.length / 3;
    iCount += part.i.length;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const glo = new Float32Array(vCount * 3);
  const sha = new Float32Array(vCount * 4);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const part of parts) {
    const c = part.p.length / 3;
    pos.set(part.p, vo * 3);
    nor.set(part.n, vo * 3);
    col.set(part.col, vo * 3);
    glo.set(part.glow, vo * 3);
    sha.set(part.shade, vo * 4);
    for (let k = 0; k < part.i.length; k++) idx[io + k] = part.i[k] + vo;
    vo += c;
    io += part.i.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glo, 3));
  geo.setAttribute('aShade', new THREE.BufferAttribute(sha, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);

/** Matrix that takes +y onto `dir` and then translates. */
function alignY(dir, pos) {
  _q.setFromUnitVectors(_yAxis, new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());
  return new THREE.Matrix4().compose(new THREE.Vector3(pos[0], pos[1], pos[2]), _q, _one);
}

/* ------------------------------------------------------------------------------------------ */
/* Shading                                                                                     */
/* ------------------------------------------------------------------------------------------ */

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec3 aGlow;
attribute vec4 aShade;

varying vec3 vN;
varying vec3 vWN;
varying vec3 vView;
varying vec3 vCol;
varying vec3 vGlow;
varying vec4 vShade;
varying vec3 vObj;
varying vec2 vFaceUv;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vWN = normalize(mat3(modelMatrix) * normal);
  vView = -mv.xyz;
  vCol = aColor;
  vGlow = aGlow;
  vShade = aShade;
  vObj = position;
  vFaceUv = vec2(position.x / 0.17 + 0.5, (position.y + 0.025) / 0.17 + 0.5);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uRimA;
uniform vec3 uRimB;
uniform float uRim;
uniform float uGlow;
uniform vec3 uFlashColor;
uniform float uFlash;
uniform float uTime;
#ifdef USE_FACE
uniform sampler2D uFace;
#endif

varying vec3 vN;
varying vec3 vWN;
varying vec3 vView;
varying vec3 vCol;
varying vec3 vGlow;
varying vec4 vShade;
varying vec3 vObj;
varying vec2 vFaceUv;

void main() {
  vec3 N = normalize(vN);
  vec3 WN = normalize(vWN);
  vec3 V = normalize(vView);
  vec3 Lv = normalize((viewMatrix * vec4(uKeyDir, 0.0)).xyz);

  float spec = vShade.x;
  float skin = vShade.y;
  float hair = vShade.w;

  vec3 base = vCol;
  float ndl = dot(WN, uKeyDir);

  // two-step cel ramp with a soft terminator
  float band = smoothstep(-0.05, 0.07, ndl);
  float band2 = smoothstep(0.35, 0.95, ndl); // soft sheen, not a hard-edged patch

#ifdef USE_FACE
  vec4 ft = texture2D(uFace, vFaceUv);
  float fw = ft.a * vShade.z;
  base = mix(base, ft.rgb, fw);
  // keep the face readable: anime faces carry very little form shadow
  band = mix(band, max(band, 0.82), vShade.z);
#endif

  vec3 shadowTint = mix(vec3(0.36, 0.31, 0.62), vec3(0.62, 0.38, 0.44), skin);
  shadowTint = mix(shadowTint, vec3(0.52, 0.54, 0.84), hair);
  // hair: darker underside so the mass has form instead of reading as a flat white blob
  base *= mix(1.0, mix(0.62, 1.0, smoothstep(-0.55, 0.35, WN.y)), hair);
  vec3 hemi = mix(uAmbGround, uAmbSky, WN.y * 0.5 + 0.5);

  vec3 lit = base * (mix(shadowTint, vec3(1.0), band) * uKeyColor + hemi);
  lit += base * band2 * 0.10 * uKeyColor;

  // warm saturated terminator on skin (cheap subsurface feel)
  float term = band * (1.0 - band) * 4.0;
  lit += skin * term * base * vec3(0.22, 0.06, 0.03);

  float ndv = clamp(dot(N, V), 0.0, 1.0);

  // stylised specular: a hard-edged glint
  vec3 H = normalize(Lv + V);
  float nh = max(dot(N, H), 0.0);
  float glint = smoothstep(0.45, 0.60, pow(nh, 40.0)) * spec;
  lit += glint * uKeyColor * 0.6;

  // hair: broken "angel ring" sheen
  float ring = 1.0 - smoothstep(0.0, 0.16, abs(N.y - 0.52));
  float streak = 0.55 + 0.45 * sin(vObj.x * 170.0 + sin(vObj.z * 37.0) * 2.0);
  lit += hair * ring * streak * band * 0.30 * uKeyColor;

  // fresnel rim, split-toned left/right, crisp core + soft falloff
  float fres = pow(1.0 - ndv, 2.6);
  float rimCore = smoothstep(0.32, 0.70, fres);
  float side = smoothstep(-0.35, 0.35, N.x);
  vec3 rimCol = mix(uRimB, uRimA, side);
  float rimUp = 0.62 + 0.38 * smoothstep(-0.7, 0.4, WN.y);
  vec3 rim = rimCol * (rimCore * 0.9 + fres * 0.2) * uRim * rimUp;
  rim *= mix(1.0, 0.55, skin * (1.0 - rimCore));

  // emissive trims
  float shimmer = 0.88 + 0.12 * sin(uTime * 5.0 + vObj.y * 18.0);
  vec3 em = vGlow * uGlow * shimmer * (1.0 + uFlash * 0.5);

  // rating flash
  vec3 flash = uFlashColor * uFlash * (0.6 * fres); // rim only: the body keeps its own colours

  gl_FragColor = vec4(lit + rim + em + flash, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------------------ */
/* Face texture (canvas)                                                                       */
/* ------------------------------------------------------------------------------------------ */

const FACE_PX = 512;
const EXPRESSIONS = {
  neutral: { tilt: -0.06, top: 1.0, bot: 1.0, browIn: 0, browOut: 0, browLift: 0, mouth: 'soft' },
  smile: { tilt: -0.04, top: 0.96, bot: 0.74, browIn: -2, browOut: -3, browLift: -7, mouth: 'open' },
  fierce: { tilt: -0.15, top: 0.80, bot: 0.9, browIn: 13, browOut: -7, browLift: 3, mouth: 'smirk' },
};

const EYE_SCALE = 1.3;

function drawEye(ctx, cx, cy, sx, ex, open) {
  const w = 49;
  const hTop = 40 * ex.top * open;
  const hBot = 30 * ex.bot * Math.max(open, 0.25);
  const ink = '#1d0f2c';
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(sx * EYE_SCALE, EYE_SCALE); // local +x = toward the ear
  ctx.rotate(ex.tilt);

  if (open < 0.2) {
    // closed: a soft downward lash arc
    ctx.strokeStyle = ink;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-w, 2);
    ctx.quadraticCurveTo(0, 20, w, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w - 4, 2);
    ctx.lineTo(w + 11, -4);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(-w, 5);
    ctx.bezierCurveTo(-w * 0.55, -hTop * 1.28, w * 0.45, -hTop * 1.25, w, -3);
    ctx.bezierCurveTo(w * 0.6, hBot * 1.05, -w * 0.5, hBot * 1.15, -w, 5);
    ctx.closePath();
  };

  // sclera
  ctx.save();
  shape();
  ctx.clip();
  ctx.fillStyle = '#fbfaff';
  ctx.fillRect(-w - 4, -60, 2 * w + 8, 120);

  // iris
  const iy = (hBot - hTop) * 0.22;
  const ir = 31;
  const g = ctx.createRadialGradient(0, iy + 6, 3, 0, iy, ir);
  g.addColorStop(0, '#7ff7ec');
  g.addColorStop(0.45, '#19d9c9');
  g.addColorStop(0.82, '#0d8f93');
  g.addColorStop(1, '#083f52');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, iy, ir, 0, TAU);
  ctx.fill();
  // pupil
  ctx.fillStyle = '#0b1230';
  ctx.beginPath();
  ctx.ellipse(0, iy - 1, 11.5, 13.5, 0, 0, TAU);
  ctx.fill();
  // lower iris glow crescent
  ctx.strokeStyle = 'rgba(190,255,248,0.75)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, iy, ir - 8, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
  // upper-lid shadow
  const sh = ctx.createLinearGradient(0, -hTop * 1.1, 0, -hTop * 1.1 + 30);
  sh.addColorStop(0, 'rgba(24,12,48,0.62)');
  sh.addColorStop(1, 'rgba(24,12,48,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(-w - 4, -60, 2 * w + 8, 90);
  ctx.restore();

  // upper lash line with a wing
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 9.5;
  ctx.beginPath();
  ctx.moveTo(-w, 5);
  ctx.bezierCurveTo(-w * 0.55, -hTop * 1.28, w * 0.45, -hTop * 1.25, w, -3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w - 10, -8);
  ctx.lineTo(w + 15, -15);
  ctx.lineTo(w + 1, 3);
  ctx.closePath();
  ctx.fill();
  // lower lash, outer half
  ctx.lineWidth = 3.2;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(w, -3);
  ctx.bezierCurveTo(w * 0.6, hBot * 1.05, w * 0.1, hBot * 1.1, -w * 0.25, hBot * 0.98);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // lid crease
  ctx.lineWidth = 2.4;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(-w * 0.7, -hTop * 0.95 - 9);
  ctx.quadraticCurveTo(0, -hTop * 1.25 - 12, w * 0.8, -hTop * 0.55 - 10);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  // catch-lights (same side on both eyes, so drawn un-mirrored)
  if (open > 0.6) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const k = EYE_SCALE;
    const iy = (hBot - hTop) * 0.22;
    ctx.ellipse(cx - 11 * k, cy + (iy - 15) * k, 8.5 * k, 9.5 * k, -0.3, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 12 * k, cy + (iy + 9) * k, 3.6 * k, 0, TAU);
    ctx.fill();
  }
}

function drawFace(ctx, exprName, open) {
  const ex = EXPRESSIONS[exprName] || EXPRESSIONS.neutral;
  const S = FACE_PX;
  const mid = S / 2;
  ctx.clearRect(0, 0, S, S);

  // blush
  for (const sx of [-1, 1]) {
    const bx = mid + sx * 128;
    const by = 318;
    const g = ctx.createRadialGradient(bx, by, 2, bx, by, 46);
    g.addColorStop(0, 'rgba(255,96,104,0.34)');
    g.addColorStop(1, 'rgba(255,96,104,0)');
    ctx.fillStyle = g;
    ctx.fillRect(bx - 50, by - 50, 100, 100);
  }

  const eyeY = 236;
  const eyeX = 116;
  drawEye(ctx, mid - eyeX, eyeY, -1, ex, open);
  drawEye(ctx, mid + eyeX, eyeY, 1, ex, open);

  // brows (silver, like the hair, with a darker under-line so they read on warm skin)
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(mid + sx * eyeX, eyeY);
    ctx.scale(sx * 1.15, 1.15);
    const yIn = -70 + ex.browIn + ex.browLift;
    const yOut = -74 + ex.browOut + ex.browLift;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(-42, yIn);
      ctx.quadraticCurveTo(4, Math.min(yIn, yOut) - 9 + (ex.browIn > 6 ? 8 : 0), 52, yOut + 5);
    };
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(70,40,60,0.55)';
    ctx.lineWidth = 11;
    path();
    ctx.stroke();
    ctx.strokeStyle = '#e9ecf8';
    ctx.lineWidth = 7.5;
    path();
    ctx.stroke();
    ctx.restore();
  }

  // nose hint
  ctx.strokeStyle = 'rgba(92,44,34,0.55)';
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(mid - 5, 338);
  ctx.quadraticCurveTo(mid + 2, 344, mid + 8, 337);
  ctx.stroke();

  // mouth
  const my = 396;
  const lip = '#5c1a2b';
  ctx.save();
  ctx.translate(mid, my);
  ctx.scale(1.22, 1.22);
  ctx.translate(-mid, -my);
  ctx.strokeStyle = lip;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (ex.mouth === 'open') {
    ctx.beginPath();
    ctx.moveTo(mid - 31, my - 7);
    ctx.quadraticCurveTo(mid, my + 1, mid + 31, my - 7);
    ctx.bezierCurveTo(mid + 25, my + 22, mid + 9, my + 29, mid, my + 29);
    ctx.bezierCurveTo(mid - 9, my + 29, mid - 25, my + 22, mid - 31, my - 7);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#7a1c33';
    ctx.fillRect(mid - 40, my - 12, 80, 50);
    ctx.fillStyle = '#ff8d93';
    ctx.beginPath();
    ctx.ellipse(mid, my + 27, 17, 10, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(mid - 31, my - 9);
    ctx.quadraticCurveTo(mid, my - 1, mid + 31, my - 9);
    ctx.lineTo(mid + 27, my + 2);
    ctx.quadraticCurveTo(mid, my + 8, mid - 27, my + 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 4.5;
    ctx.stroke();
  } else if (ex.mouth === 'smirk') {
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.moveTo(mid - 21, my + 4);
    ctx.quadraticCurveTo(mid + 4, my + 9, mid + 26, my - 8);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(mid + 25, my - 13);
    ctx.lineTo(mid + 30, my - 6);
    ctx.stroke();
  } else {
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.moveTo(mid - 24, my - 3);
    ctx.quadraticCurveTo(mid + 1, my + 13, mid + 25, my - 6);
    ctx.stroke();
    // lower-lip highlight
    ctx.strokeStyle = 'rgba(255,170,150,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(mid - 8, my + 16);
    ctx.quadraticCurveTo(mid, my + 18, mid + 8, my + 15);
    ctx.stroke();
  }
  ctx.restore();
}

function createFaceTexture() {
  if (typeof document === 'undefined') {
    // headless (Node) fallback so the module can be exercised without a DOM
    const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    tex.needsUpdate = true;
    return { texture: tex, redraw() {} };
  }
  const canvas = document.createElement('canvas');
  canvas.width = FACE_PX;
  canvas.height = FACE_PX;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return {
    texture,
    redraw(expr, open) {
      drawFace(ctx, expr, open);
      texture.needsUpdate = true;
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Body part geometry                                                                          */
/* ------------------------------------------------------------------------------------------ */

function headRing(y) {
  const s = clamp(y / DIM.headRY, -1, 1);
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  const t = Math.max(0, -s);
  const cheek = 1 + 0.05 * Math.exp(-Math.pow((s + 0.38) / 0.26, 2));
  return R(
    y,
    Math.max(0.0005, 0.088 * c * (1 - 0.3 * Math.pow(t, 1.5)) * cheek),
    Math.max(0.0005, 0.1 * c * (1 + 0.1 * t)),
    Math.max(0.0005, 0.1 * c * (1 - 0.34 * Math.pow(t, 1.3))),
  );
}

// ponytail anchor in head space, and the direction it leaves the head
// (set high and a little to the screen-left so the tail swings out past her shoulder and is
// visible from the front, not hidden behind the head and torso)
const TAIL_BASE = [-0.034, 0.112, -0.058];
const TAIL_DIR = (() => {
  const v = [-0.5, 0.42, -0.72];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

function buildHead() {
  const parts = [];
  const SEG = 64;
  const RINGS = 44;

  // skull + face
  const skullRings = [];
  for (let i = 0; i < RINGS; i++) {
    const phi = mix(-HALF_PI * 0.965, HALF_PI * 0.965, i / (RINGS - 1));
    skullRings.push(headRing(DIM.headRY * Math.sin(phi)));
  }
  const skull = loft(skullRings, SEG, true, true);
  displace(skull, (o) => {
    if (o[2] > 0) {
      // nose hint + faint brow/eye-socket plane
      o[2] += 0.0105 * Math.exp(-Math.pow(o[0] / 0.0105, 2) - Math.pow((o[1] + 0.036) / 0.017, 2));
      o[2] -= 0.0022 * Math.exp(-Math.pow((Math.abs(o[0]) - 0.038) / 0.022, 2) - Math.pow((o[1] + 0.016) / 0.02, 2));
    }
  });
  computeNormals(skull);
  paint(skull, COL.skin, GLOW.none, SH.skin);
  for (let v = 0; v < skull.p.length / 3; v++) {
    const nz = skull.n[v * 3 + 2];
    const y = skull.p[v * 3 + 1];
    skull.shade[v * 4 + 2] = smoothstep(0.12, 0.42, nz) * smoothstep(-0.112, -0.1, y);
  }
  parts.push(skull);

  // hair cap: a shell just outside the skull that dives into the head along the hairline
  const hairRings = [];
  const HR = 60;
  for (let i = 0; i < HR; i++) {
    const phi = mix(-HALF_PI * 0.8, HALF_PI * 0.97, i / (HR - 1));
    const y = DIM.headRY * Math.sin(phi);
    const r = headRing(y);
    const up = Math.max(0, y / DIM.headRY);
    hairRings.push(R(
      y * (y > 0 ? 1.085 : 1.0) + 0.003,
      r.rx * 1.075 + 0.0035,
      r.zf * 1.07 + 0.004 + 0.002 * (1 - up),
      r.zb * 1.1 + 0.006,
    ));
  }
  const cap = loft(hairRings, SEG, true, true);
  displace(cap, (o) => {
    const theta = Math.atan2(o[2], Math.abs(o[0])) * (180 / Math.PI); // -90 back .. +90 front
    const fringe = smoothstep(31, 38, theta);
    const back = 1 - smoothstep(-12, 6, theta);
    let line = mix(-0.06, 0.031, fringe); // sides fall past the ears; blunt fringe across the brow
    line = mix(line, -0.08, back);
    const k = smoothstep(line - 0.003, line + 0.003, o[1]);
    const s = mix(0.72, 1, k); // below the hairline the shell tucks well inside the skull
    o[0] *= s; o[1] *= mix(0.9, 1, k); o[2] *= s;
    // fringe volume
    if (fringe > 0 && o[2] > 0) o[2] += 0.004 * fringe * k * smoothstep(0.09, 0.03, o[1]);
  });
  parts.push(paint(cap, COL.hair, GLOW.none, SH.hair));

  // side locks framing the face
  for (const sx of [-1, 1]) {
    const lock = capsule([
      R(-0.128, 0.004, 0.006, 0.006, sx * 0.064, 0.05),
      R(-0.1, 0.0085, 0.014, 0.014, sx * 0.071, 0.05),
      R(-0.06, 0.0115, 0.019, 0.019, sx * 0.079, 0.046),
      R(-0.02, 0.012, 0.02, 0.02, sx * 0.083, 0.04),
    ], { n: 8, seg: 10, bot: 0.012, top: 0.012, dome: 3 });
    parts.push(paint(lock, COL.hair, GLOW.none, SH.hair));
  }

  // ponytail root: a small bun + glowing tie
  const bun = fromThree(new THREE.SphereGeometry(0.041, 16, 12));
  xform(bun, _m4.makeTranslation(TAIL_BASE[0], TAIL_BASE[1] - 0.012, TAIL_BASE[2] + 0.012));
  parts.push(paint(bun, COL.hair, GLOW.none, SH.hair));
  const tie = fromThree(new THREE.TorusGeometry(0.031, 0.0085, 8, 20));
  xform(tie, _m4.makeRotationX(HALF_PI)); // torus axis z -> y
  xform(tie, alignY(TAIL_DIR, [
    TAIL_BASE[0] + TAIL_DIR[0] * 0.022,
    TAIL_BASE[1] + TAIL_DIR[1] * 0.022,
    TAIL_BASE[2] + TAIL_DIR[2] * 0.022,
  ]));
  parts.push(paint(tie, COL.teal, GLOW.teal, SH.glow));

  return mergeParts(parts);
}

function buildNeck() {
  const neck = capsule([
    R(-0.04, 0.04, 0.036, 0.038),
    R(0.02, 0.034, 0.032, 0.034),
    R(0.1, 0.031, 0.031, 0.033),
  ], { n: 6, seg: 14, bot: 0.01, top: 0.012, dome: 2 });
  return mergeParts([paint(neck, COL.skin, GLOW.none, SH.skin)]);
}

function buildChest() {
  const parts = [];
  const E = 2.3;
  const jacketCtrl = [
    R(0.2, 0.106, 0.086, 0.082, 0, 0, E),
    R(0.214, 0.114, 0.094, 0.088, 0, 0, E),
    R(0.246, 0.117, 0.097, 0.091, 0, 0, E),
    R(0.268, 0.129, 0.11, 0.1, 0, 0, E),
    R(0.322, 0.137, 0.119, 0.104, 0, 0, E),
    R(0.375, 0.133, 0.112, 0.104, 0, 0, E),
    R(0.415, 0.121, 0.096, 0.098, 0, 0, E),
    R(0.444, 0.093, 0.078, 0.084, 0, 0, E),
    R(0.462, 0.07, 0.062, 0.067, 0, 0, 2),
  ];
  const at = makeProfile(jacketCtrl);
  const body = loft(sampleRings(at, at.y0, at.y1, 26), 32, true, true);
  parts.push(paint(body, COL.jacket, GLOW.none, SH.satin));

  // ribbed hem
  const hem = loft([
    grow(at(0.198), 0.0005),
    grow(at(0.206), 0.004),
    grow(at(0.238), 0.004),
    grow(at(0.248), 0.0005),
  ], 32, false, false);
  parts.push(paint(hem, COL.jacketRib, GLOW.none, SH.cloth));
  parts.push(paint(band(at, 0.25, 0.0045, 0.0035, 32), COL.teal, GLOW.teal, SH.glow));
  parts.push(paint(band(at, 0.203, 0.0035, 0.0052, 32), COL.teal, GLOW.tealSoft, SH.glow));

  // centre-front zip piping
  parts.push(paint(strip(at, 0.206, 0.452, HALF_PI - 0.04, HALF_PI + 0.04, 0.0035, 14, 2),
    COL.teal, GLOW.teal, SH.glow));

  // star emblems: small on the chest, large on the back
  parts.push(paint(starOn(at, 0.335, HALF_PI - 0.62, 0.026, 0.0032, 0.0),
    COL.amber, GLOW.amber, SH.glow));
  parts.push(paint(starOn(at, 0.325, -HALF_PI, 0.06, 0.0032, 0.0),
    COL.amber, GLOW.amber, SH.glow));

  // high collar: up the outside, over the lip, back down the inside
  const collarTilt = (o) => {
    if (o[1] > 0.455) o[1] -= 0.016 * smoothstep(0.455, 0.49, o[1]) * smoothstep(-0.02, 0.06, o[2]);
  };
  const collar = loft([
    R(0.436, 0.067, 0.061, 0.066, 0, -0.003),
    R(0.465, 0.066, 0.06, 0.066, 0, -0.003),
    R(0.488, 0.07, 0.064, 0.07, 0, -0.003),
    R(0.494, 0.0665, 0.0605, 0.0665, 0, -0.003),
    R(0.486, 0.061, 0.055, 0.061, 0, -0.003),
    R(0.44, 0.056, 0.05, 0.056, 0, -0.003),
  ], 28, false, false);
  displace(collar, collarTilt);
  parts.push(paint(collar, COL.jacket, GLOW.none, SH.satin));
  const collarPipe = loft([
    R(0.4865, 0.0672, 0.0612, 0.0672, 0, -0.003),
    R(0.4905, 0.0718, 0.0658, 0.0718, 0, -0.003),
    R(0.4965, 0.0705, 0.0645, 0.0705, 0, -0.003),
    R(0.4975, 0.0655, 0.0595, 0.0655, 0, -0.003),
  ], 28, false, false);
  displace(collarPipe, collarTilt);
  parts.push(paint(collarPipe, COL.teal, GLOW.teal, SH.glow));

  return mergeParts(parts);
}

function buildWaist() {
  const waist = capsule([
    R(0.09, 0.094, 0.08, 0.078, 0, 0, 2.2),
    R(0.2, 0.09, 0.077, 0.074, 0, 0, 2.2),
    R(0.31, 0.1, 0.084, 0.078, 0, 0, 2.2),
  ], { n: 8, seg: 20, bot: 0.01, top: 0.01, dome: 2 });
  return mergeParts([paint(waist, COL.skin, GLOW.none, SH.skin)]);
}

function buildPelvis() {
  const parts = [];
  const E = 2.2;
  const ctrl = [
    // ends just below the hip sockets, flat underneath: the thigh tops close the inseam
    R(-0.072, 0.086, 0.07, 0.076, 0, 0, E),
    R(-0.04, 0.128, 0.096, 0.106, 0, 0, E),
    R(-0.005, 0.143, 0.104, 0.115, 0, 0, E),
    R(0.03, 0.136, 0.102, 0.112, 0, 0, E),
    R(0.1, 0.111, 0.089, 0.091, 0, 0, E),
    R(0.16, 0.098, 0.083, 0.082, 0, 0, E),
    R(0.196, 0.097, 0.082, 0.081, 0, 0, E),
  ];
  const at = makeProfile(ctrl);
  const rings = [
    ...domeRings(at(at.y0), -0.008, 3).reverse(),
    ...sampleRings(at, at.y0, at.y1, 18),
  ];
  parts.push(paint(loft(rings, 28, true, true), COL.black, GLOW.none, SH.cloth));
  // high waistband with a hairline of amber
  const wb = loft([
    grow(at(0.158), 0.0005), grow(at(0.164), 0.0032), grow(at(0.193), 0.0032), grow(at(0.1975), 0.0005),
  ], 28, false, false);
  parts.push(paint(wb, COL.blackHi, GLOW.none, SH.cloth));
  parts.push(paint(band(at, 0.1955, 0.003, 0.0048, 28), COL.amber, GLOW.amber, SH.glow));
  return mergeParts(parts);
}

/** Outer side of a limb in its local frame: +x for the screen-right limb, -x for the screen-left. */
const outerAngle = (sg, fwd = 0) => (sg > 0 ? fwd : Math.PI - fwd);

const KNEE_R = 0.074; // thigh and shin share a sphere of this radius at the knee: no gaps
const ELBOW_R = 0.043;
const STRIPE_FWD = 0.78; // side stripes sit slightly forward of the true side so they read from the front

function buildThigh(sg) {
  const parts = [];
  const L = DIM.thigh;
  const ctrl = [
    R(-L, KNEE_R, KNEE_R, KNEE_R),
    R(-L * 0.68, 0.076, 0.079, 0.078),
    R(-L * 0.28, 0.081, 0.085, 0.088, -sg * 0.006),
    R(0, 0.084, 0.088, 0.093, -sg * 0.008),
  ];
  const leg = capsule(ctrl, { n: 12, seg: 20, bot: KNEE_R, top: 0.08, dome: 6 });
  parts.push(paint(leg, COL.black, GLOW.none, SH.cloth));
  const a = outerAngle(sg, STRIPE_FWD);
  parts.push(paint(strip(leg.at, -L, 0.015, a - 0.088, a + 0.088, 0.003, 12, 2),
    COL.amber, GLOW.amber, SH.glow));
  return mergeParts(parts);
}

function buildShin(sg) {
  const parts = [];
  // wide-leg: flares from the knee to a hem ~1.4x the knee, breaking over the sneaker
  const hemY = -(DIM.shin + 0.046);
  const ctrl = [
    R(hemY, 0.104, 0.112, 0.102),
    R(hemY * 0.74, 0.097, 0.102, 0.095),
    R(hemY * 0.38, 0.085, 0.088, 0.085),
    R(0, KNEE_R, KNEE_R, KNEE_R),
  ];
  const at = makeProfile(ctrl);
  const hem = at(hemY);
  const rings = [
    // recessed, closed hem so nothing is see-through from low angles
    { ...hem, y: hemY + 0.012, rx: 0.05, zf: 0.05, zb: 0.05 },
    { ...hem, y: hemY + 0.002, rx: hem.rx * 0.9, zf: hem.zf * 0.9, zb: hem.zb * 0.9 },
    { ...hem, y: hemY - 0.004, rx: hem.rx * 0.985, zf: hem.zf * 0.985, zb: hem.zb * 0.985 },
    ...sampleRings(at, hemY, 0, 13),
    ...domeRings(at(0), KNEE_R, 5),
  ];
  // the first rings climb back up inside the hem: build them inverted so the fold shades right
  const raw = loft(rings.slice(2), 20, false, true);
  const inner = loft([rings[0], rings[1], rings[2]].map((r) => ({ ...r })).reverse(), 20, false, true);
  // flip the inner fold so it faces down/out of the hem
  for (let t = 0; t < inner.i.length; t += 3) {
    const s = inner.i[t + 1];
    inner.i[t + 1] = inner.i[t + 2];
    inner.i[t + 2] = s;
  }
  parts.push(paint(raw, COL.black, GLOW.none, SH.cloth));
  parts.push(paint(inner, COL.black, GLOW.none, SH.cloth));
  const a = outerAngle(sg, STRIPE_FWD);
  parts.push(paint(strip(at, hemY + 0.004, 0, a - 0.08, a + 0.08, 0.003, 12, 2),
    COL.amber, GLOW.amber, SH.glow));
  return mergeParts(parts);
}

function buildFoot() {
  const parts = [];
  const rot = new THREE.Matrix4().makeRotationX(HALF_PI); // loft +y -> +z (toe), loft +z -> -y (down)
  const E = 2.5;
  // upper: rings are (z along foot, half width, extent DOWN, extent UP, 0, -centreY)
  const upperCtrl = [
    R(-0.064, 0.036, 0.004, 0.056, 0, 0.06, E),
    R(-0.022, 0.044, 0.004, 0.064, 0, 0.06, E),
    R(0.028, 0.047, 0.004, 0.056, 0, 0.06, E),
    R(0.074, 0.051, 0.004, 0.042, 0, 0.06, E),
    R(0.118, 0.052, 0.004, 0.034, 0, 0.06, E),
    R(0.15, 0.045, 0.004, 0.028, 0, 0.06, E),
  ];
  const upper = capsule(upperCtrl, { n: 12, seg: 18, bot: 0.012, top: 0.018, dome: 4 });
  const upAt = upper.at;
  parts.push(paint(xform(upper, rot), COL.white, GLOW.none, SH.gloss));

  // coral side flashes (plain colour accent, not emissive)
  for (const a of [[-0.86, -0.5], [Math.PI + 0.5, Math.PI + 0.86]]) {
    const fl = strip(upAt, 0.0, 0.105, a[0], a[1], 0.0022, 6, 2);
    parts.push(paint(xform(fl, rot), COL.coral, GLOW.none, SH.gloss));
  }
  // toe cap
  const toe = strip(upAt, 0.125, 0.15, -Math.PI + 0.25, -0.25, 0.002, 2, 10);
  parts.push(paint(xform(toe, rot), COL.offWhite, GLOW.none, SH.gloss));

  // chunky midsole
  const soleCtrl = (cy, h, grow_) => upperCtrl.map((r, k) => R(
    mix(-0.07, 0.158, k / (upperCtrl.length - 1)), r.rx + grow_, h, h, 0, cy, 3.6));
  const mid = capsule(soleCtrl(0.0695, 0.0115, 0.0065), { n: 12, seg: 20, bot: 0.012, top: 0.014, dome: 3 });
  parts.push(paint(xform(mid, rot), COL.white, GLOW.none, SH.cloth));
  // emissive outsole
  const out = capsule(soleCtrl(0.0875, 0.0075, 0.0045), { n: 12, seg: 20, bot: 0.011, top: 0.013, dome: 3 });
  parts.push(paint(xform(out, rot), COL.hairTip, GLOW.sole, SH.glow));

  // padded high-top collar reaching into the trouser hem
  const collar = capsule([
    R(-0.05, 0.039, 0.044, 0.04, 0, -0.004),
    R(0.0, 0.041, 0.043, 0.041, 0, -0.006),
    R(0.062, 0.043, 0.044, 0.043, 0, -0.006),
  ], { n: 6, seg: 16, bot: 0.006, top: 0.012, dome: 2 });
  const collarAt = collar.at;
  parts.push(paint(collar, COL.white, GLOW.none, SH.cloth));
  parts.push(paint(band(collarAt, 0.03, 0.004, 0.003, 16), COL.teal, GLOW.tealSoft, SH.glow));
  // heel pull-tab on the outer back
  const tab = strip(collarAt, -0.03, 0.045, -HALF_PI - 0.2, -HALF_PI + 0.2, 0.003, 4, 2);
  parts.push(paint(tab, COL.coral, GLOW.none, SH.cloth));
  // chunky: widen and lengthen everything but keep the sole height (ankle stays DIM.ankle up)
  for (const part of parts) {
    for (let v = 0; v < part.p.length; v += 3) {
      part.p[v] *= 1.14;
      part.p[v + 2] *= 1.12;
    }
    part.n = null;
  }
  return mergeParts(parts);
}

function buildUpperArm(sg) {
  const parts = [];
  const L = DIM.upperArm;
  const ctrl = [
    R(-L, ELBOW_R, ELBOW_R, ELBOW_R),
    R(-L * 0.55, 0.047, 0.048, 0.047),
    R(-L * 0.2, 0.051, 0.053, 0.052), // deltoid mass
    R(0, 0.05, 0.053, 0.053),
  ];
  const arm = capsule(ctrl, { n: 9, seg: 16, bot: ELBOW_R, top: 0.04, dome: 6 });
  parts.push(paint(arm, COL.jacket, GLOW.none, SH.satin));
  const a = outerAngle(sg, 0.4);
  parts.push(paint(strip(arm.at, -L, -0.01, a - 0.13, a + 0.13, 0.003, 8, 2),
    COL.teal, GLOW.teal, SH.glow));
  return mergeParts(parts);
}

function buildForearm(sg) {
  const parts = [];
  const L = DIM.forearm;
  const ctrl = [
    R(-L + 0.03, 0.034, 0.034, 0.034),
    R(-L + 0.052, 0.041, 0.041, 0.041),
    R(-L * 0.45, 0.045, 0.045, 0.045),
    R(0, ELBOW_R, ELBOW_R, ELBOW_R),
  ];
  const arm = capsule(ctrl, { n: 10, seg: 16, bot: 0.006, top: ELBOW_R, dome: 5 });
  parts.push(paint(arm, COL.jacket, GLOW.none, SH.satin));
  // ribbed cuff
  const cuffAt = makeProfile([
    R(-L - 0.012, 0.029, 0.029, 0.029),
    R(-L + 0.01, 0.0325, 0.0325, 0.0325),
    R(-L + 0.034, 0.0335, 0.0335, 0.0335),
  ]);
  const cuff = loft([
    ...domeRings(cuffAt(cuffAt.y0), -0.006, 2).reverse(),
    ...sampleRings(cuffAt, cuffAt.y0, cuffAt.y1, 5),
    ...domeRings(cuffAt(cuffAt.y1), 0.004, 2),
  ], 16, true, true);
  parts.push(paint(cuff, COL.jacketRib, GLOW.none, SH.cloth));
  parts.push(paint(band(cuffAt, -L + 0.031, 0.004, 0.0035, 16), COL.teal, GLOW.teal, SH.glow));
  const a = outerAngle(sg, 0.4);
  parts.push(paint(strip(arm.at, -L + 0.05, 0.0, a - 0.14, a + 0.14, 0.003, 8, 2),
    COL.teal, GLOW.teal, SH.glow));
  return mergeParts(parts);
}

/** p = +1 when the palm normal is local +x (screen-left hand), -1 otherwise. */
function buildHand(p) {
  const parts = [];
  const handCtrl = [
    R(-0.1, 0.0115, 0.034, 0.031, p * 0.007),
    R(-0.078, 0.0145, 0.039, 0.035, p * 0.004),
    R(-0.035, 0.0165, 0.036, 0.033, 0),
    R(0.012, 0.019, 0.024, 0.024, 0),
  ];
  const hand = capsule(handCtrl, { n: 12, seg: 14, bot: 0.009, top: 0.008, dome: 3 });
  const handAt = hand.at;
  parts.push(paint(hand, COL.skin, GLOW.none, SH.skin));

  // four fingers, lightly curled toward the palm
  const fingers = [[0.0255, 0.05, 0.0072], [0.0085, 0.062, 0.0078], [-0.0085, 0.058, 0.0076], [-0.024, 0.046, 0.0066]];
  fingers.forEach(([fz, len, fr], k) => {
    const finger = capsule([
      R(0, fr, fr, fr),
      R(len * 0.55, fr * 0.94, fr * 0.94, fr * 0.94),
      R(len, fr * 0.8, fr * 0.8, fr * 0.8),
    ], { n: 4, seg: 8, bot: fr, top: fr * 0.8, dome: 3 });
    const curl = 0.3 + 0.05 * k;
    xform(finger, alignY([p * Math.sin(curl), -Math.cos(curl), fz * 2.2], [p * 0.007, -0.096, fz]));
    parts.push(paint(finger, COL.skin, GLOW.none, SH.skin));
  });

  // thumb
  const thumbDir = [p * 0.32, -0.74, 0.6];
  const thumb = capsule([
    R(0, 0.0125, 0.0135, 0.0135),
    R(0.03, 0.0115, 0.012, 0.012),
    R(0.056, 0.009, 0.0095, 0.0095),
  ], { n: 5, seg: 10, bot: 0.01, top: 0.009, dome: 3 });
  xform(thumb, alignY(thumbDir, [p * 0.003, -0.034, 0.027]));
  parts.push(paint(thumb, COL.skin, GLOW.none, SH.skin));

  // fingerless glove: wrist to knuckles, a touch proud of the skin
  const gloveRings = sampleRings(handAt, -0.086, 0.012, 8).map((r) => grow(r, 0.0032));
  const glove = loft([
    grow(handAt(-0.088), 0.0005),
    ...gloveRings,
    ...domeRings(gloveRings[gloveRings.length - 1], 0.008, 2),
  ], 14, false, true);
  parts.push(paint(glove, COL.glove, GLOW.none, SH.satin));
  const gloveThumb = capsule([
    R(0, 0.0155, 0.0165, 0.0165),
    R(0.026, 0.0145, 0.015, 0.015),
  ], { n: 3, seg: 10, bot: 0.012, top: 0.002, dome: 3 });
  xform(gloveThumb, alignY(thumbDir, [p * 0.003, -0.034, 0.027]));
  parts.push(paint(gloveThumb, COL.glove, GLOW.none, SH.satin));
  // teal knuckle trim + a tiny amber stud on the back of the hand
  parts.push(paint(band(handAt, -0.084, 0.0035, 0.0058, 14), COL.teal, GLOW.teal, SH.glow));
  const stud = fromThree(new THREE.SphereGeometry(0.0075, 8, 6));
  xform(stud, _m4.makeScale(0.5, 1, 1));
  xform(stud, _m4.makeTranslation(-p * 0.0195, -0.04, 0.0));
  parts.push(paint(stud, COL.amber, GLOW.amber, SH.glow));
  return mergeParts(parts);
}

function buildHalo() {
  const parts = [];
  const ring = fromThree(new THREE.TorusGeometry(0.188, 0.004, 8, 72));
  parts.push(paint(ring, COL.amber, GLOW.amberHot, SH.glow));
  const inner = fromThree(new THREE.TorusGeometry(0.166, 0.0016, 6, 64));
  parts.push(paint(inner, COL.amber, GLOW.amber, SH.glow));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + HALF_PI;
    const bead = fromThree(new THREE.OctahedronGeometry(0.0135, 0));
    computeNormals(bead);
    xform(bead, _m4.makeScale(1, 1.5, 0.7));
    xform(bead, _m4.makeRotationZ(a - HALF_PI));
    xform(bead, new THREE.Matrix4().makeTranslation(Math.cos(a) * 0.188, Math.sin(a) * 0.188, 0));
    bead.n = null;
    parts.push(paint(bead, COL.white, GLOW.amberHot, SH.glow));
  }
  return mergeParts(parts);
}

/* ------------------------------------------------------------------------------------------ */
/* Ponytail: verlet chain + skinned tapered tube                                               */
/* ------------------------------------------------------------------------------------------ */

function createTail(material, opts) {
  const N = opts.segments; // links
  const segLen = opts.length / N;
  const RAD = opts.radius;
  const SUB = 2;
  const K = N * SUB + 1; // rings along the tube
  const SEG = 10;

  const p = [];
  const q = [];
  for (let i = 0; i <= N; i++) {
    p.push(new THREE.Vector3());
    q.push(new THREE.Vector3());
  }

  const vCount = K * SEG + 1;
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const glo = new Float32Array(vCount * 3);
  const sha = new Float32Array(vCount * 4);
  const radii = new Float32Array(K);
  const idx = [];

  for (let k = 0; k < K; k++) {
    const t = k / (K - 1);
    let r;
    if (t < 0.12) r = mix(0.75, 1, smoothstep(0, 0.12, t));
    else r = Math.max(0.05, 1 - 0.95 * Math.pow((t - 0.12) / 0.88, 2.1)); // stays full longer, then tapers
    radii[k] = r * RAD;
    const tip = smoothstep(opts.tipStart, 0.97, t);
    for (let j = 0; j < SEG; j++) {
      const v = k * SEG + j;
      col[v * 3] = mix(COL.hair[0], COL.hairTip[0], tip);
      col[v * 3 + 1] = mix(COL.hair[1], COL.hairTip[1], tip);
      col[v * 3 + 2] = mix(COL.hair[2], COL.hairTip[2], tip);
      const g = tip * tip;
      glo[v * 3] = GLOW.teal[0] * g;
      glo[v * 3 + 1] = GLOW.teal[1] * g;
      glo[v * 3 + 2] = GLOW.teal[2] * g;
      sha[v * 4 + 3] = 1 - tip * 0.7;
    }
  }
  {
    const v = K * SEG;
    col[v * 3] = COL.hairTip[0]; col[v * 3 + 1] = COL.hairTip[1]; col[v * 3 + 2] = COL.hairTip[2];
    glo[v * 3] = GLOW.teal[0]; glo[v * 3 + 1] = GLOW.teal[1]; glo[v * 3 + 2] = GLOW.teal[2];
    sha[v * 4 + 3] = 0.3;
  }
  // (side, binormal, tangent) is right-handed, i.e. mirrored w.r.t. loft(): flipped winding
  for (let k = 0; k < K - 1; k++) {
    for (let j = 0; j < SEG; j++) {
      const j1 = (j + 1) % SEG;
      const a = k * SEG + j;
      const b = (k + 1) * SEG + j;
      const c = k * SEG + j1;
      const d = (k + 1) * SEG + j1;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let j = 0; j < SEG; j++) idx.push(K * SEG, (K - 1) * SEG + j, (K - 1) * SEG + ((j + 1) % SEG));

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const norAttr = new THREE.BufferAttribute(nor, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  norAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('normal', norAttr);
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glo, 3));
  geo.setAttribute('aShade', new THREE.BufferAttribute(sha, 4));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.2, 0), 3);

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.name = 'nova-ponytail';

  const stiff = [0, 0.5, 0.24, 0.1, 0.03];
  const restBlend = [0, 0, 0.3, 0.6, 0.85];
  const base = new THREE.Vector3();
  const basePrev = new THREE.Vector3();
  const baseNow = new THREE.Vector3();
  const dir0 = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const side = new THREE.Vector3();
  const bin = new THREE.Vector3();
  const c0 = new THREE.Vector3();
  let ready = false;
  let acc = 0;
  const H = 1 / 120;

  // Position-based chain: symmetric distance constraints (momentum-friendly, so the tip does not
  // whip around forever), a little bending stiffness near the root, and sphere collisions.
  function constrain(colliders) {
    for (let it = 0; it < 5; it++) {
      for (let i = 1; i <= N; i++) {
        const pi = p[i];
        if (i < stiff.length) {
          tmp.copy(dir0).multiplyScalar(1 - restBlend[i]);
          tmp.y -= restBlend[i];
          tmp.normalize().multiplyScalar(segLen).add(p[i - 1]);
          pi.lerp(tmp, stiff[i]);
        }
        tmp.subVectors(pi, p[i - 1]);
        const l = tmp.length() || 1e-5;
        const diff = (l - segLen) / l;
        if (i === 1) pi.addScaledVector(tmp, -diff);
        else {
          p[i - 1].addScaledVector(tmp, diff * 0.36);
          pi.addScaledVector(tmp, -diff * 0.64);
        }
      }
      for (let i = 2; i <= N; i++) {
        const pi = p[i];
        for (let c = 0; c < colliders.length; c++) {
          const col_ = colliders[c];
          tmp.subVectors(pi, col_.c);
          const rr = col_.r + radii[Math.min(i * SUB, K - 1)] * 0.7;
          const d2 = tmp.lengthSq();
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 1e-5;
            pi.addScaledVector(tmp, (rr - d) / d);
          }
        }
        if (pi.y < 0.02) pi.y = 0.02;
      }
    }
  }

  function reset(anchor, dir) {
    p[0].copy(anchor);
    q[0].copy(anchor);
    for (let i = 1; i <= N; i++) {
      const w = Math.min(1, i / 4);
      tmp.copy(dir).multiplyScalar(1 - w);
      tmp.y -= w;
      tmp.normalize();
      p[i].copy(p[i - 1]).addScaledVector(tmp, segLen);
      q[i].copy(p[i]);
    }
    basePrev.copy(anchor);
    ready = true;
  }

  function catmull(out, a, b, c, d, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    out.x = 0.5 * (2 * b.x + (-a.x + c.x) * t + (2 * a.x - 5 * b.x + 4 * c.x - d.x) * t2 + (-a.x + 3 * b.x - 3 * c.x + d.x) * t3);
    out.y = 0.5 * (2 * b.y + (-a.y + c.y) * t + (2 * a.y - 5 * b.y + 4 * c.y - d.y) * t2 + (-a.y + 3 * b.y - 3 * c.y + d.y) * t3);
    out.z = 0.5 * (2 * b.z + (-a.z + c.z) * t + (2 * a.z - 5 * b.z + 4 * c.z - d.z) * t2 + (-a.z + 3 * b.z - 3 * c.z + d.z) * t3);
  }

  const centre = [];
  for (let k = 0; k < K; k++) centre.push(new THREE.Vector3());

  function skin(sideRef) {
    for (let k = 0; k < K; k++) {
      const i = Math.min(Math.floor(k / SUB), N - 1);
      const t = k / SUB - i;
      catmull(centre[k], p[Math.max(i - 1, 0)], p[i], p[i + 1], p[Math.min(i + 2, N)], t);
    }
    side.copy(sideRef);
    for (let k = 0; k < K; k++) {
      const a = centre[Math.max(k - 1, 0)];
      const b = centre[Math.min(k + 1, K - 1)];
      tan.subVectors(b, a);
      if (tan.lengthSq() < 1e-10) tan.set(0, -1, 0);
      tan.normalize();
      side.addScaledVector(tan, -tan.dot(side));
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0).addScaledVector(tan, -tan.x);
      side.normalize();
      bin.crossVectors(tan, side);
      const rs = radii[k];
      const rb = radii[k] * 0.74;
      const c = centre[k];
      for (let j = 0; j < SEG; j++) {
        const ang = (j / SEG) * TAU;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const v = (k * SEG + j) * 3;
        pos[v] = c.x + side.x * cs * rs + bin.x * sn * rb;
        pos[v + 1] = c.y + side.y * cs * rs + bin.y * sn * rb;
        pos[v + 2] = c.z + side.z * cs * rs + bin.z * sn * rb;
        let nx = side.x * cs * rb + bin.x * sn * rs;
        let ny = side.y * cs * rb + bin.y * sn * rs;
        let nz = side.z * cs * rb + bin.z * sn * rs;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nor[v] = nx / nl; nor[v + 1] = ny / nl; nor[v + 2] = nz / nl;
      }
    }
    const v = K * SEG * 3;
    const last = centre[K - 1];
    pos[v] = last.x + tan.x * radii[K - 1] * 1.6;
    pos[v + 1] = last.y + tan.y * radii[K - 1] * 1.6;
    pos[v + 2] = last.z + tan.z * radii[K - 1] * 1.6;
    nor[v] = tan.x; nor[v + 1] = tan.y; nor[v + 2] = tan.z;
    posAttr.needsUpdate = true;
    norAttr.needsUpdate = true;
  }

  /**
   * @param anchor root position, @param dir root direction, @param sideRef head right vector,
   * @param colliders [{c: Vector3, r}], all in the dancer group's space.
   */
  function update(dt, time, anchor, dir, sideRef, colliders, sway) {
    dir0.copy(dir);
    if (!ready || anchor.distanceToSquared(basePrev) > 0.36) {
      reset(anchor, dir);
      // let it fall into its natural drape
      for (let s = 0; s < 360; s++) {
        for (let i = 1; i <= N; i++) {
          tmp2.subVectors(p[i], q[i]).multiplyScalar(0.9);
          q[i].copy(p[i]);
          p[i].add(tmp2);
          p[i].y -= 9.8 * H * H;
        }
        constrain(colliders);
      }
      for (let i = 0; i <= N; i++) q[i].copy(p[i]);
      acc = 0;
    }
    baseNow.copy(anchor);
    acc += Math.min(dt, 0.1);
    const steps = Math.min(8, Math.floor(acc / H));
    acc -= steps * H;
    if (acc > H * 2) acc = 0;
    const damp = Math.exp(-H * opts.damping);
    c0.copy(basePrev);
    for (let s = 1; s <= steps; s++) {
      base.lerpVectors(c0, baseNow, s / steps);
      p[0].copy(base);
      q[0].copy(base);
      for (let i = 1; i <= N; i++) {
        tmp2.subVectors(p[i], q[i]).multiplyScalar(damp);
        q[i].copy(p[i]);
        p[i].add(tmp2);
        p[i].y -= 9.8 * opts.gravity * H * H;
        // a breath of idle air so the tail never looks frozen
        const w = (i / N) * sway * H * H;
        p[i].x += Math.sin(time * 1.9 + i * 0.6) * w;
        p[i].z += Math.cos(time * 1.3 + i * 0.45) * w * 0.6;
      }
      constrain(colliders);
    }
    if (steps > 0) basePrev.copy(baseNow);
    else {
      // sub-step frame: keep the root glued to the head
      p[0].copy(c0);
    }
    skin(sideRef);
  }

  return { mesh, update, points: p, segLen };
}

/* ------------------------------------------------------------------------------------------ */
/* The dancer                                                                                  */
/* ------------------------------------------------------------------------------------------ */

function makeFrame() {
  return { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _WY = new THREE.Vector3(0, 1, 0);
const _WZ = new THREE.Vector3(0, 0, 1);

/** Orthonormal frame with y = up and z as close as possible to zref. */
function frameYZ(fr, up, zref, fallback) {
  fr.y.copy(up);
  fr.z.copy(zref).addScaledVector(up, -up.dot(zref));
  if (fr.z.lengthSq() < 1e-6) {
    fr.z.copy(fallback).addScaledVector(up, -up.dot(fallback));
    if (fr.z.lengthSq() < 1e-6) {
      if (Math.abs(up.x) < 0.9) fr.z.set(1, 0, 0);
      else fr.z.set(0, 0, 1);
      fr.z.addScaledVector(up, -up.dot(fr.z));
    }
  }
  fr.z.normalize();
  fr.x.crossVectors(fr.y, fr.z);
  return fr;
}

/** Orthonormal frame with y = up and x as close as possible to xref. */
function frameYX(fr, up, xref, fallback) {
  fr.y.copy(up);
  fr.x.copy(xref).addScaledVector(up, -up.dot(xref));
  if (fr.x.lengthSq() < 1e-6) {
    fr.x.copy(fallback).addScaledVector(up, -up.dot(fallback));
    if (fr.x.lengthSq() < 1e-6) {
      if (Math.abs(up.z) < 0.9) fr.x.set(0, 0, 1);
      else fr.x.set(1, 0, 0);
      fr.x.addScaledVector(up, -up.dot(fr.x));
    }
  }
  fr.x.normalize();
  fr.z.crossVectors(fr.x, fr.y);
  return fr;
}

function place(mesh, fr, pos) {
  mesh.matrix.makeBasis(fr.x, fr.y, fr.z);
  mesh.matrix.setPosition(pos);
  mesh.matrixWorldNeedsUpdate = true;
}

/**
 * Create NOVA.
 * @param {object} [options]
 * @param {number} [options.smoothing=46]  pose spring frequency (rad/s); higher = snappier
 * @returns {{group: THREE.Group, setPose: Function, update: Function, setExpression: Function,
 *            flash: Function, height: number}}
 */
export function createDancer(options = {}) {
  const group = new THREE.Group();
  group.name = 'NOVA';

  /* ---- materials ---- */
  const face = createFaceTexture();
  const uniforms = {
    uKeyDir: { value: new THREE.Vector3(-0.38, 0.62, 0.68).normalize() },
    uKeyColor: { value: new THREE.Color(1.0, 0.96, 0.92) },
    uAmbSky: { value: new THREE.Color(0.2, 0.19, 0.34) },
    uAmbGround: { value: new THREE.Color(0.1, 0.07, 0.16) },
    uRimA: { value: new THREE.Color('#19e3d2') },
    uRimB: { value: new THREE.Color('#8a5cff') },
    uRim: { value: 1.2 },
    uGlow: { value: 1.0 },
    uFlashColor: { value: new THREE.Color('#ffffff') },
    uFlash: { value: 0 },
    uTime: { value: 0 },
  };
  const bodyMat = new THREE.ShaderMaterial({
    name: 'nova-body',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const headMat = new THREE.ShaderMaterial({
    name: 'nova-head',
    uniforms: { ...uniforms, uFace: { value: face.texture } },
    defines: { USE_FACE: '' },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  /* ---- meshes (one per rigid part) ---- */
  const meshes = [];
  function part(name, geo, mat = bodyMat) {
    const m = new THREE.Mesh(geo, mat);
    m.name = `nova-${name}`;
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.castShadow = true;
    group.add(m);
    meshes.push(m);
    return m;
  }

  const M = {
    pelvis: part('pelvis', buildPelvis()),
    waist: part('waist', buildWaist()),
    chest: part('chest', buildChest()),
    neck: part('neck', buildNeck()),
    head: part('head', buildHead(), headMat),
    halo: part('halo', buildHalo()),
    l: {
      upperArm: part('l-upperarm', buildUpperArm(-1)),
      forearm: part('l-forearm', buildForearm(-1)),
      hand: part('l-hand', buildHand(1)),
      thigh: part('l-thigh', buildThigh(-1)),
      shin: part('l-shin', buildShin(-1)),
      foot: part('l-foot', buildFoot()),
    },
    r: {
      upperArm: part('r-upperarm', buildUpperArm(1)),
      forearm: part('r-forearm', buildForearm(1)),
      hand: part('r-hand', buildHand(-1)),
      thigh: part('r-thigh', buildThigh(1)),
      shin: part('r-shin', buildShin(1)),
      foot: part('r-foot', buildFoot()),
    },
  };
  M.halo.castShadow = false;

  const tail = createTail(bodyMat, {
    segments: 11, length: 0.82, radius: 0.057, tipStart: 0.55, damping: 1.7, gravity: 1.0,
  });
  const wisp = createTail(bodyMat, {
    segments: 7, length: 0.46, radius: 0.022, tipStart: 0.55, damping: 3.2, gravity: 0.9,
  });
  group.add(tail.mesh, wisp.mesh);

  /* ---- pose state (critically damped springs on every direction) ---- */
  const omega = options.smoothing ?? 46;
  const cur = {};
  const vel = {};
  const tgt = {};
  for (const s of SEGMENTS) {
    cur[s] = new THREE.Vector3().fromArray(IDLE_POSE[s]).normalize();
    tgt[s] = cur[s].clone();
    vel[s] = new THREE.Vector3();
  }
  const scal = { hipX: 0, yaw: 0 };
  const scalT = { hipX: 0, yaw: 0 };
  const scalV = { hipX: 0, yaw: 0 };
  let hasPose = false;
  let snapNext = true;

  function readVec(out, v, fallback) {
    let x = 0, y = 0, z = 0;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      x = +v[0] || 0; y = +v[1] || 0; z = +v[2] || 0;
    } else if (v && typeof v === 'object') {
      x = +v.x || 0; y = +v.y || 0; z = +v.z || 0;
    }
    const l = Math.hypot(x, y, z);
    if (!(l > 1e-6)) return out.copy(fallback);
    return out.set(x / l, y / l, z / l);
  }

  function setPose(pose) {
    if (!pose) return;
    for (const s of SEGMENTS) readVec(tgt[s], pose[s], tgt[s]);
    scalT.hipX = Number.isFinite(pose.hipX) ? clamp(pose.hipX, -0.6, 0.6) : 0;
    scalT.yaw = Number.isFinite(pose.yaw) ? pose.yaw : 0;
    if (!hasPose) {
      hasPose = true;
      snapNext = true;
    }
  }

  function stepPose(dt) {
    if (snapNext) {
      for (const s of SEGMENTS) {
        cur[s].copy(tgt[s]);
        vel[s].set(0, 0, 0);
      }
      scal.hipX = scalT.hipX; scal.yaw = scalT.yaw;
      scalV.hipX = 0; scalV.yaw = 0;
      snapNext = false;
      return;
    }
    // exact critically-damped step (stable for any dt)
    const e = Math.exp(-omega * dt);
    for (const s of SEGMENTS) {
      const c = cur[s];
      const v = vel[s];
      const t = tgt[s];
      _a.subVectors(c, t); // displacement
      _b.copy(v).addScaledVector(_a, omega).multiplyScalar(dt);
      v.addScaledVector(_b, -omega).multiplyScalar(e);
      c.copy(t).add(_a.add(_b).multiplyScalar(e));
      const l = c.length();
      if (l > 1e-5) c.multiplyScalar(1 / l);
      else c.copy(t);
    }
    for (const k of ['hipX', 'yaw']) {
      const d = scal[k] - scalT[k];
      const tmp = (scalV[k] + omega * d) * dt;
      scalV[k] = (scalV[k] - omega * tmp) * e;
      scal[k] = scalT[k] + (d + tmp) * e;
    }
  }

  /* ---- FK scratch ---- */
  const F = {
    pelvis: makeFrame(), waist: makeFrame(), chest: makeFrame(), neck: makeFrame(), head: makeFrame(),
    l: { ua: makeFrame(), fa: makeFrame(), hand: makeFrame(), th: makeFrame(), sh: makeFrame(), foot: makeFrame() },
    r: { ua: makeFrame(), fa: makeFrame(), hand: makeFrame(), th: makeFrame(), sh: makeFrame(), foot: makeFrame() },
  };
  const J = {
    hip: new THREE.Vector3(), neck: new THREE.Vector3(), headC: new THREE.Vector3(),
    l: {
      shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), wrist: new THREE.Vector3(),
      hipJ: new THREE.Vector3(), knee: new THREE.Vector3(), ankle: new THREE.Vector3(),
    },
    r: {
      shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), wrist: new THREE.Vector3(),
      hipJ: new THREE.Vector3(), knee: new THREE.Vector3(), ankle: new THREE.Vector3(),
    },
  };
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const up = new THREE.Vector3();
  const xr = new THREE.Vector3();
  const hinge = new THREE.Vector3();
  const toeRef = { l: new THREE.Vector3(), r: new THREE.Vector3() };
  const TOE_OUT = 0.17;

  function torsoFrame(fr, S, blend, yaw) {
    up.copy(_WY).lerp(S, blend).normalize();
    xr.set(Math.cos(yaw), 0, -Math.sin(yaw));
    frameYX(fr, up, xr, _WZ);
  }

  function legJoints(side, sg, t, s) {
    const j = J[side];
    const P = F.pelvis;
    j.hipJ.copy(J.hip).addScaledVector(P.x, sg * DIM.hipHalf).addScaledVector(P.y, -DIM.hipDrop);
    j.knee.copy(j.hipJ).addScaledVector(t, DIM.thigh);
    j.ankle.copy(j.knee).addScaledVector(s, DIM.shin);

    // knee faces mostly forward (toe-out), pulled toward the outside of the bend
    const toe = toeRef[side];
    toe.copy(P.z).multiplyScalar(Math.cos(TOE_OUT)).addScaledVector(P.x, sg * Math.sin(TOE_OUT));
    v0.copy(toe).multiplyScalar(0.6).add(t).sub(s); // f
    v1.copy(t).negate(); // thigh "up"
    v2.copy(s).negate(); // shin "up"
    hinge.crossVectors(v1, v0);
    v3.crossVectors(v2, v0);
    hinge.add(v3);
    if (hinge.lengthSq() < 1e-6) hinge.copy(P.x);
    hinge.normalize();
    frameYX(F[side].th, v1, hinge, P.x);
    frameYX(F[side].sh, v2, hinge, P.x);
  }

  function footFrame(side, minAnkleY) {
    const sh = F[side].sh;
    const ankle = J[side].ankle;
    const shinFlat = smoothstep(0.3, 0.75, sh.y.y);
    const planted = 1 - smoothstep(0.03, 0.13, ankle.y - minAnkleY);
    const flat = Math.max(shinFlat, planted * smoothstep(-0.2, 0.25, sh.y.y));
    up.copy(sh.y).lerp(_WY, flat).normalize();
    v0.copy(sh.z).lerp(toeRef[side], flat * 0.65);
    frameYZ(F[side].foot, up, v0, toeRef[side]);
  }

  function soleMinY(side) {
    const fr = F[side].foot;
    const a = J[side].ankle;
    let m = Infinity;
    for (let k = 0; k < 4; k++) {
      const lx = k & 1 ? DIM.footHalfW : -DIM.footHalfW;
      const lz = k & 2 ? DIM.footToe : DIM.footHeel;
      const y = a.y + fr.x.y * lx - fr.y.y * DIM.ankle + fr.z.y * lz;
      if (y < m) m = y;
    }
    return m;
  }

  function armSolve(side, sg, a, b) {
    const C = F.chest;
    const j = J[side];
    const p = -sg; // palm normal sign along local x
    const raise = smoothstep(0, 0.9, a.dot(C.y));
    j.shoulder.copy(J.hip)
      .addScaledVector(C.y, DIM.shoulderY + 0.028 * raise)
      .addScaledVector(C.x, sg * (DIM.shoulderHalf - 0.012 * raise));
    j.elbow.copy(j.shoulder).addScaledVector(a, DIM.upperArm);
    j.wrist.copy(j.elbow).addScaledVector(b, DIM.forearm);

    // elbow frame: local +z is the inside of the elbow
    v0.copy(C.z).multiplyScalar(0.4).addScaledVector(C.y, 0.2).add(b).sub(a);
    v1.copy(a).negate();
    v2.copy(b).negate();
    hinge.crossVectors(v1, v0);
    v3.crossVectors(v2, v0);
    hinge.add(v3);
    if (hinge.lengthSq() < 1e-6) hinge.copy(C.x);
    hinge.normalize();
    frameYX(F[side].ua, v1, hinge, C.x);
    frameYX(F[side].fa, v2, hinge, C.x);

    // hand: thumb forward when the arm hangs, palm to the audience when it is raised
    const k = 0.85 * smoothstep(-0.5, 0.25, b.dot(C.y));
    v3.crossVectors(C.z, v2).multiplyScalar(p * k);
    v0.copy(C.z).multiplyScalar(1 - k).add(v3)
      .addScaledVector(b, 0.3).addScaledVector(a, -0.3)
      .addScaledVector(C.y, 0.1);
    const hf = F[side].hand;
    frameYZ(hf, v2, v0, C.x);
    // relaxed wrist: flex slightly toward the palm
    v1.copy(b).addScaledVector(hf.x, p * 0.14).normalize().negate();
    v0.copy(hf.z);
    frameYZ(hf, v1, v0, C.x);
  }

  /* ---- secondary-motion state ---- */
  const halo = {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(),
    target: new THREE.Vector3(), tq: new THREE.Quaternion(), init: false,
    m: new THREE.Matrix4(), spin: new THREE.Quaternion(), tiltQ: new THREE.Quaternion(),
  };
  halo.tiltQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.22);
  const colliders = [
    { c: new THREE.Vector3(), r: 0.128 * DIM.headScale }, // head
    { c: new THREE.Vector3(), r: 0.122 }, // shoulder blades L
    { c: new THREE.Vector3(), r: 0.122 }, // shoulder blades R
    { c: new THREE.Vector3(), r: 0.118 }, // waist
    { c: new THREE.Vector3(), r: 0.15 }, // hips
    { c: new THREE.Vector3(), r: 0.07 }, // neck
  ];
  const tailAnchor = new THREE.Vector3();
  const tailDir = new THREE.Vector3();
  const wispAnchor = new THREE.Vector3();
  const wispDir = new THREE.Vector3();

  const HS = DIM.headScale;

  function solve() {
    const S = cur.spine;
    const yaw = scal.yaw;

    torsoFrame(F.pelvis, S, 0.32, yaw * 0.55);
    torsoFrame(F.waist, S, 0.68, yaw * 0.8);
    torsoFrame(F.chest, S, 1.0, yaw);
    const C = F.chest;

    // legs first, hip centre at height 0, then ground the lowest sole
    J.hip.set(scal.hipX, 0, 0);
    legJoints('l', -1, cur.lThigh, cur.lShin);
    legJoints('r', 1, cur.rThigh, cur.rShin);
    const minAnkle = Math.min(J.l.ankle.y, J.r.ankle.y);
    footFrame('l', minAnkle);
    footFrame('r', minAnkle);
    const lift = -Math.min(soleMinY('l'), soleMinY('r'));
    J.hip.y = lift;
    for (const side of ['l', 'r']) {
      J[side].hipJ.y += lift;
      J[side].knee.y += lift;
      J[side].ankle.y += lift;
    }

    // torso
    J.neck.copy(J.hip).addScaledVector(S, DIM.spine);
    armSolve('l', -1, cur.lUpperArm, cur.lForearm);
    armSolve('r', 1, cur.rUpperArm, cur.rForearm);

    // head keeps half an eye on the audience even when the torso twists
    const hd = cur.head;
    v0.copy(C.z).add(_WZ);
    if (v0.lengthSq() < 1e-4) v0.copy(C.z);
    frameYZ(F.head, hd, v0, C.z);
    J.headC.copy(J.neck).addScaledVector(hd, DIM.headCentre);
    up.copy(S).add(hd);
    if (up.lengthSq() < 1e-4) up.copy(S);
    up.normalize();
    frameYZ(F.neck, up, C.z, F.head.z);

    // write matrices
    place(M.pelvis, F.pelvis, J.hip);
    place(M.waist, F.waist, J.hip);
    place(M.chest, F.chest, J.hip);
    place(M.neck, F.neck, J.neck);
    place(M.head, F.head, J.headC);
    M.head.matrix.scale(_a.set(HS, HS, HS));
    for (const side of ['l', 'r']) {
      const m = M[side];
      const f = F[side];
      const j = J[side];
      place(m.upperArm, f.ua, j.shoulder);
      place(m.forearm, f.fa, j.elbow);
      place(m.hand, f.hand, j.wrist);
      place(m.thigh, f.th, j.hipJ);
      place(m.shin, f.sh, j.knee);
      place(m.foot, f.foot, j.ankle);
    }
  }

  function secondary(time, dt, energy) {
    const H = F.head;
    const C = F.chest;

    // colliders
    colliders[0].c.copy(J.headC);
    colliders[1].c.copy(J.hip).addScaledVector(C.y, 0.36).addScaledVector(C.x, -0.062);
    colliders[2].c.copy(J.hip).addScaledVector(C.y, 0.36).addScaledVector(C.x, 0.062);
    colliders[3].c.copy(J.hip).addScaledVector(F.waist.y, 0.2);
    colliders[4].c.copy(J.hip).addScaledVector(F.pelvis.y, -0.01);
    colliders[5].c.copy(J.neck).addScaledVector(C.y, 0.02);

    // ponytail root
    tailAnchor.copy(J.headC)
      .addScaledVector(H.x, TAIL_BASE[0] * HS).addScaledVector(H.y, TAIL_BASE[1] * HS)
      .addScaledVector(H.z, TAIL_BASE[2] * HS);
    tailDir.set(0, 0, 0)
      .addScaledVector(H.x, TAIL_DIR[0]).addScaledVector(H.y, TAIL_DIR[1]).addScaledVector(H.z, TAIL_DIR[2]);
    const sway = 0.5 + energy * 0.9; // lateral idle acceleration (m/s^2) at the tip
    tail.update(dt, time, tailAnchor, tailDir, H.x, colliders, sway);

    wispAnchor.copy(tailAnchor).addScaledVector(H.x, 0.014).addScaledVector(H.y, -0.012);
    wispDir.copy(tailDir).addScaledVector(H.x, 0.35).addScaledVector(H.y, -0.25).normalize();
    wisp.update(dt, time + 3.1, wispAnchor, wispDir, H.x, colliders, sway * 1.4);

    // halo: floats behind the head on a soft, slightly under-damped spring
    const bob = Math.sin(time * 1.7) * 0.012;
    halo.target.copy(J.headC).addScaledVector(H.z, -0.14).addScaledVector(H.y, 0.076 + bob);
    halo.m.makeBasis(H.x, H.y, H.z);
    halo.tq.setFromRotationMatrix(halo.m).multiply(halo.tiltQ);
    if (!halo.init || halo.pos.distanceToSquared(halo.target) > 0.25) {
      halo.pos.copy(halo.target);
      halo.vel.set(0, 0, 0);
      halo.quat.copy(halo.tq);
      halo.init = true;
    } else {
      const w = 15;
      const zeta = 0.5;
      const h = Math.min(dt, 1 / 30);
      const n = Math.max(1, Math.ceil(dt / h));
      for (let s = 0; s < n; s++) {
        _a.subVectors(halo.target, halo.pos).multiplyScalar(w * w);
        _a.addScaledVector(halo.vel, -2 * zeta * w);
        halo.vel.addScaledVector(_a, h);
        halo.pos.addScaledVector(halo.vel, h);
      }
      // never let it drift far from her
      _a.subVectors(halo.pos, halo.target);
      const d = _a.length();
      if (d > 0.11) {
        halo.pos.copy(halo.target).addScaledVector(_a, 0.11 / d);
        halo.vel.multiplyScalar(0.6);
      }
      halo.quat.slerp(halo.tq, 1 - Math.exp(-dt * 9));
    }
    halo.spin.setFromAxisAngle(_WZ, time * 0.55);
    _q.copy(halo.quat).multiply(halo.spin);
    const breathe = 1 + 0.03 * Math.sin(time * 2.3) + 0.05 * kickEnv;
    _a.set(breathe, breathe, breathe);
    M.halo.matrix.compose(halo.pos, _q, _a);
    M.halo.matrixWorldNeedsUpdate = true;
  }

  /* ---- face / expression ---- */
  let expression = 'neutral';
  let faceKey = '';
  let blinkIn = 1.6;
  let blinkT = -1;
  let blinkQueue = 0;
  const BLINK_LEN = 0.15;

  function updateFace(dt) {
    let open = 1;
    if (blinkT >= 0) {
      blinkT += dt;
      const ph = blinkT / BLINK_LEN;
      if (ph >= 1) {
        blinkT = -1;
        if (blinkQueue > 0) {
          blinkQueue--;
          blinkIn = 0.09;
        }
      } else open = ph < 0.3 || ph > 0.75 ? 0.5 : 0;
    } else {
      blinkIn -= dt;
      if (blinkIn <= 0) {
        blinkT = 0;
        blinkIn = 2.2 + Math.random() * 3.4;
        if (Math.random() < 0.18) blinkQueue = 1;
      }
    }
    const key = `${expression}:${open}`;
    if (key !== faceKey) {
      faceKey = key;
      face.redraw(expression, open);
    }
  }

  function setExpression(name) {
    const next = EXPRESSIONS[name] ? name : 'neutral';
    if (next === expression) return;
    expression = next;
    // change expression behind a blink so it never pops
    if (blinkT < 0) blinkT = BLINK_LEN * 0.3;
  }

  /* ---- glow / flash ---- */
  let flashAmt = 0;
  let kickEnv = 0;
  let energyS = 0.5;
  const rimA = new THREE.Color();
  const rimB = new THREE.Color();
  const rimTeal = new THREE.Color('#3df2e2');
  const rimViolet = new THREE.Color('#8a5cff');
  const rimAmber = new THREE.Color('#ffc24a');
  const rimCoral = new THREE.Color('#ff5a6e');
  let rimOverrideA = null;
  let rimOverrideB = null;

  function flash(colorHex) {
    uniforms.uFlashColor.value.set(colorHex ?? 0xffffff);
    flashAmt = 1;
  }

  /** Optional extra: tint the rim light from the stage palette (null = automatic). */
  function setRimColors(a, b) {
    rimOverrideA = a == null ? null : new THREE.Color(a);
    rimOverrideB = b == null ? null : new THREE.Color(b);
  }

  let lastTime = 0;

  function update(time = lastTime, dt = 1 / 60, opts = {}) {
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    lastTime = time;
    const levels = (opts && opts.levels) || {};
    const energy = clamp(Number.isFinite(opts && opts.energy) ? opts.energy : 0.5, 0, 1);
    const kick = clamp(+levels.kick || 0, 0, 1);
    const bass = clamp(+levels.bass || 0, 0, 1);
    const high = clamp(+levels.high || 0, 0, 1);

    energyS += (energy - energyS) * (1 - Math.exp(-dt * 3));
    kickEnv = Math.max(kick, kickEnv * Math.exp(-dt * 9));

    stepPose(dt);
    solve();
    secondary(time, dt, energyS);
    updateFace(dt);

    // uniforms
    flashAmt *= Math.exp(-dt * 9);
    if (flashAmt < 0.002) flashAmt = 0;
    uniforms.uFlash.value = flashAmt;
    uniforms.uTime.value = time;
    uniforms.uGlow.value = 0.8 + 0.5 * energyS + 0.95 * kickEnv + 0.2 * bass + 0.12 * high;
    uniforms.uRim.value = 0.75 + 0.3 * energyS + 0.2 * kickEnv;

    const drift = 0.5 + 0.5 * Math.sin(time * 0.35);
    if (opts && opts.rimColor != null) rimA.set(opts.rimColor);
    else if (rimOverrideA) rimA.copy(rimOverrideA);
    else rimA.copy(rimTeal).lerp(rimAmber, energyS * 0.35 * drift);
    if (opts && opts.rimColorB != null) rimB.set(opts.rimColorB);
    else if (rimOverrideB) rimB.copy(rimOverrideB);
    else rimB.copy(rimViolet).lerp(rimCoral, energyS * 0.45 * (1 - drift));
    uniforms.uRimA.value.copy(rimA);
    uniforms.uRimB.value.copy(rimB);
  }

  function dispose() {
    for (const m of meshes) m.geometry.dispose();
    tail.mesh.geometry.dispose();
    wisp.mesh.geometry.dispose();
    bodyMat.dispose();
    headMat.dispose();
    face.texture.dispose();
  }

  // stand in idle immediately so she is never seen un-posed
  face.redraw(expression, 1);
  faceKey = `${expression}:1`;
  update(0, 0, {});
  snapNext = true;

  return {
    group,
    setPose,
    update,
    setExpression,
    flash,
    height: HEIGHT,
    // ---- extras beyond the contract (safe to ignore) ----
    setRimColors,
    dispose,
    uniforms,
    /** Joint positions (group space) of the last solved frame; handy for VFX anchoring. */
    joints: J,
  };
}
