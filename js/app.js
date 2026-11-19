/* DJ Brain prototype — Three.js spatial transition network */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BrainAudio } from './audio.js';

const DATA = window.BRAIN_DATA;
const audio = new BrainAudio();

/* ---------- helpers ---------- */
function keyColor(key) {
  const n = parseInt(key);
  const major = key.endsWith('B');
  const h = ((n - 1) % 12) / 12;
  return new THREE.Color().setHSL(h, major ? 0.9 : 1.0, major ? 0.58 : 0.45);
}
function edgeColor(freq) {
  const t = Math.pow((freq - 5) / 95, 1.2);
  return new THREE.Color().lerpColors(new THREE.Color(0x38bdf8), new THREE.Color(0xff2a4b), t);
}

/* H/E/S classification for synapses (same rule as trackdata.js edgeType):
   'H' — Harmonic: shared harmony (same / adjacent Camelot key)
   'E' — Energetic: shared energy level (within 1 step)
   'S' — Sonic: otherwise — it just objectively sounds good together */
function keyClose(a, b) {
  const d = Math.abs(parseInt(a) - parseInt(b));
  return d === 0 || d === 1 || d === 11;
}
function edgeTypeOf(A, B) {
  if (keyClose(A.camelot, B.camelot)) return 'H';
  if (Math.abs(A.energy - B.energy) <= 1) return 'E';
  return 'S';
}
function hashStr(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) || 1;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const energyT = (e) => (e - 2) / 8;
const ENERGY_STOPS = [0x2e6bff, 0x2ecc40, 0xffd500, 0xff8c1a, 0xff2d2d]; // blue -> green -> yellow -> orange -> red
function energyColor(e) {
  const t = Math.min(Math.max(energyT(e), 0), 1) * (ENERGY_STOPS.length - 1);
  const i = Math.min(Math.floor(t), ENERGY_STOPS.length - 2);
  return new THREE.Color(ENERGY_STOPS[i]).lerp(new THREE.Color(ENERGY_STOPS[i + 1]), t - i);
}
const UP = new THREE.Vector3(0, 1, 0);
function alignY(q, v) {
  if (v.dot(UP) < -0.9999) return q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  return q.setFromUnitVectors(UP, v);
}

/* ---------- mutual-connection suggestions (dendrite wings) ---------- */
const MUTUAL_THRESHOLD = 3; // shared connections needed to prompt a new synapse
const approvedPairs = new Set();
const dismissedPairs = new Set();
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

function computeSuggestions(tracks, edges) {
  const ids = new Set(tracks.map(t => t.id));
  const adj = new Map();
  const linked = new Set();
  for (const e of edges) {
    if (!ids.has(e.a) || !ids.has(e.b)) continue;
    if (!adj.has(e.a)) adj.set(e.a, new Set());
    if (!adj.has(e.b)) adj.set(e.b, new Set());
    adj.get(e.a).add(e.b);
    adj.get(e.b).add(e.a);
    linked.add(pairKey(e.a, e.b));
  }
  const out = [];
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const A = tracks[i].id, B = tracks[j].id;
      if (linked.has(pairKey(A, B))) continue;
      const nA = adj.get(A), nB = adj.get(B);
      if (!nA || !nB) continue;
      let shared = 0;
      for (const n of nA) if (nB.has(n)) shared++;
      if (shared >= MUTUAL_THRESHOLD) out.push({ a: A, b: B, score: shared }); // wings only where approval is required
    }
  }
  out.sort((x, y) => y.score - x.score || hashStr(x.a + x.b) - hashStr(y.a + y.b));
  return out.slice(0, 8);
}

/* ---------- renderer / scene ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101014);
scene.fog = new THREE.FogExp2(0x101014, 0.0038);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 12, 95);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(6, 12, 8);
scene.add(dir);

/* dust for the void */
{
  const n = 500;
  const pos = new Float32Array(n * 3);
  const rng = mulberry32(99);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rng() - 0.5) * 400;
    pos[i * 3 + 1] = (rng() - 0.5) * 400;
    pos[i * 3 + 2] = (rng() - 0.5) * 400;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x2c2c38, size: 0.5, sizeAttenuation: true })));
}

/* glow texture for node rims */
const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();

/* ---------- state ---------- */
let brainName = 'Master Brain';
let mode = 'free';
let spreadFactor = 1.0; // live Spread slider (0.4x..2.5x): scales inter-node distance only — node sizes, line thickness and labels never scale
let brain = null; // { tracks, edges, group, nodeById, edgeById }

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoveredNode = null;
let hoveredEdge = null;
let modalTrack = null;
let focusTrack = null; // node the camera is focused on (1st click); card opens on 2nd click
let flight = null; // { camTo, tgtTo }
let approval = null; // active Create-Link animation state
const pf = { path: [], previewing: false, t0: 0, total: 0, camPlan: [], camIdx: 0 };

/* ---------- scene building ---------- */
function makeLabel(track) {
  const c = document.createElement('canvas');
  c.width = 768; c.height = 200;
  const x = c.getContext('2d');
  x.textAlign = 'center';
  let fs = 58;
  x.font = `700 ${fs}px system-ui, sans-serif`;
  while (x.measureText(track.title).width > 700 && fs > 30) { fs -= 2; x.font = `700 ${fs}px system-ui, sans-serif`; }
  const as = Math.max(26, Math.round(fs * 0.62));
  // minimalist: crisp white title + muted grey artist, subtle drop shadow (no plate)
  x.shadowColor = 'rgba(0,0,0,0.8)';
  x.shadowBlur = 10;
  x.shadowOffsetY = 3;
  x.font = `700 ${fs}px system-ui, sans-serif`;
  x.fillStyle = '#ffffff';
  x.fillText(track.title, 384, 88);
  x.font = `400 ${as}px system-ui, sans-serif`;
  x.fillStyle = 'rgba(158,166,180,0.95)';
  x.fillText(track.artist, 384, 158);
  const tex = new THREE.CanvasTexture(c);
  // depthTest off + high renderOrder: the title card always renders on top of
  // any synapse passing in front, so it never gets visually blocked
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0.96 }));
  spr.scale.set(18.5, 4.8, 1);
  spr.renderOrder = 999;
  return spr;
}

/* tracked-out uppercase genre label for the orbital column view */
function makeGenreLabel(genre) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const x = c.getContext('2d');
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  let fs = 96;
  const draw = () => {
    x.font = `600 ${fs}px system-ui, sans-serif`;
    x.letterSpacing = '16px';
    const text = genre.toUpperCase();
    while (x.measureText(text).width > 960 && fs > 40) {
      fs -= 4;
      x.font = `600 ${fs}px system-ui, sans-serif`;
    }
    x.shadowColor = 'rgba(0,0,0,0.8)';
    x.shadowBlur = 8;
    x.shadowOffsetY = 3;
    x.fillStyle = 'rgba(160,168,182,0.85)';
    x.fillText(text, 512, 128);
  };
  draw();
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(26, 6.5, 1);
  spr.renderOrder = 500;
  return spr;
}

/* node textures: defined outer ring + soft inner key-glow disc */
function makeRingTexture(energy) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const lw = 5 + energy * 1.5; // thickness encodes energy
  x.beginPath();
  x.arc(128, 128, 128 - lw * 0.75, lw, 0, Math.PI * 2);
  x.lineWidth = lw;
  x.strokeStyle = '#ffffff';
  x.stroke();
  return new THREE.CanvasTexture(c);
}
function makeCoreTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  // hot white center with a soft radial falloff — reads as a glowing neon orb
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function buildNode(track, sOut) {
  const group = new THREE.Group();
  const col = keyColor(track.camelot);

  // soft outer halo — additive bloom around the core, stronger at high energy.
  // own texture instance (cloned): disposeGroup frees every material's map, so
  // the shared global glowTex must not be referenced by rebuildable nodes
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex.clone(),
    color: 0xffffff,
    transparent: true,
    opacity: 0.06 + 0.3 * Math.pow(energyT(track.energy), 1.6),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  halo.scale.setScalar(sOut * 1.55);
  group.add(halo);

  // defined outer outline — energy-colored ring (thin at low energy, thick at high)
  const ring = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRingTexture(track.energy),
    color: energyColor(track.energy),
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  }));
  ring.scale.setScalar(sOut);
  ring.userData = { kind: 'node', track };
  group.add(ring);

  // key-colored neon core — hot center + soft radial glow, inset inside the ring
  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeCoreTexture(),
    color: col,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  core.scale.setScalar(sOut * 0.72);
  group.add(core);

  const label = makeLabel(track);
  label.position.y = sOut / 2 + 2.4;
  label.visible = false;
  group.add(label);

  group.userData = { kind: 'node', track, ring, core, label, halo, baseRingColor: ring.material.color.clone(), radius: sOut / 2 };
  return group;
}

/* smooth organic wavy path between two points (deterministic per edge) */
function wavyCurve(a, b, rng) {
  const dir = b.clone().sub(a).normalize();
  const len = a.distanceTo(b);
  const ref = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u1 = new THREE.Vector3().crossVectors(dir, ref).normalize();
  const u2 = new THREE.Vector3().crossVectors(dir, u1).normalize();
  const p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
  const f1 = 1.5 + rng() * 2, f2 = 3.5 + rng() * 2.5;
  const amp = len * (0.05 + rng() * 0.09);
  const N = 11;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const env = Math.sin(t * Math.PI); // taper to 0 at the endpoints
    const off = u1.clone().multiplyScalar(Math.sin(t * f1 * Math.PI + p1) * amp * env)
      .add(u2.clone().multiplyScalar(Math.sin(t * f2 * Math.PI + p2) * amp * 0.6 * env));
    pts.push(a.clone().lerp(b, t).add(off));
  }
  return new THREE.CatmullRomCurve3(pts);
}

/* small dendrite-like twig branching off a curve at parameter t */
function makeBranch(curve, t, rng, r, mat) {
  const p = curve.getPointAt(t);
  const tan = curve.getTangentAt(t).normalize();
  const ref = Math.abs(tan.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const side = new THREE.Vector3().crossVectors(tan, ref).normalize();
  if (rng() < 0.5) side.multiplyScalar(-1);
  const ang = 0.6 + rng() * 0.7;
  const dir = tan.clone().multiplyScalar(Math.cos(ang)).add(side.clone().multiplyScalar(Math.sin(ang))).normalize();
  const L = 1.5 + rng() * 2.5;
  const mid = p.clone().add(dir.clone().multiplyScalar(L * 0.6)).add(side.clone().multiplyScalar((rng() - 0.5) * L * 0.5));
  const end = p.clone().add(dir.clone().multiplyScalar(L)).add(side.clone().multiplyScalar((rng() - 0.5) * L * 0.8));
  const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([p.clone(), mid, end]), 8, r * 0.45, 6, false), mat);
  tube.userData = { kind: 'edge' };
  return tube;
}

/* dash/dot pattern textures for 'E'/'S' synapses — white pattern on black;
   with AdditiveBlending the black parts add nothing, so they read as gaps.
   'x' = pattern runs along UV.x (TubeGeometry path length),
   'y' = along UV.y (CylinderGeometry height). Each edge owns its OWN texture
   instance: disposeGroup frees every material's map, so a shared one would
   break sibling edges after a rebuild. */
function makePatternTexture(kind, along) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#000';
  x.fillRect(0, 0, 256, 256);
  x.fillStyle = '#fff';
  if (kind === 'E') {
    // crisp dashes: two per tile
    const dash = 76, gap = 52;
    for (let i = 0; i < 256; i += dash + gap) {
      if (along === 'x') x.fillRect(i - 10, 0, dash, 256);
      else x.fillRect(0, i - 10, 256, dash);
    }
  } else {
    // beaded dots: eight per tile (wraps cleanly at the tile edge)
    const period = 32, r = 8;
    for (let i = 0; i < 256; i += period) {
      for (const o of [i + period / 2 - 256, i + period / 2, i + period / 2 + 256]) {
        if (o < -16 || o > 272) continue;
        x.beginPath();
        if (along === 'x') x.arc(o, 128, r, 0, Math.PI * 2);
        else x.arc(128, o, r, 0, Math.PI * 2);
        x.fill();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildEdge(edge, posA, posB, radA, radB, trackA, trackB) {
  const t = (edge.freq - 5) / 95;
  const type = edge.type || 'S';
  const r = 0.04 + t * 0.14; // sleek thin glowing filament, not a bulky tube
  const baseColor = edgeColor(edge.freq);
  const matOpts = { color: baseColor.clone(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };
  // type-differentiated lines: 'H' solid, 'E' dashed, 'S' dotted
  if (type === 'E') matOpts.opacity = 0.95;
  else if (type === 'S') matOpts.opacity = 0.9;
  else matOpts.opacity = 0.55 + t * 0.45;
  const mat = new THREE.MeshBasicMaterial(matOpts);
  // anchor synapses at the node surface, not the center
  const d = posB.clone().sub(posA).normalize();
  const a = posA.clone().addScaledVector(d, radA);
  const b = posB.clone().addScaledVector(d, -radB);
  const len = a.distanceTo(b);
  let mesh, curve = null, extra = [];
  if (edgeStyle === 'neural') {
    const rng = mulberry32(hashStr(edge.a + edge.b) ^ 991);
    curve = wavyCurve(a, b, rng);
    mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, r, 8, false), mat);
    mesh.userData = { kind: 'edge', edge };
    // more dendrite twigs for higher mutual transition frequency
    const nb = 1 + Math.floor(t * 3);
    for (let k = 0; k < nb; k++) extra.push(makeBranch(curve, 0.25 + rng() * 0.5, rng, r, mat));
  } else {
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8, 1, true), mat);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(UP, d);
    mesh.userData = { kind: 'edge', edge };
  }

  // 'E'/'S' pattern: dashes scroll fast (spark), dots drift slow (throb)
  const texAxis = curve ? 'x' : 'y'; // tube: U = path length, cylinder: V = height
  let dashTex = null, dashRate = 0;
  if (type === 'E' || type === 'S') {
    dashTex = makePatternTexture(type, texAxis);
    const tiles = Math.max(4, Math.min(140, Math.round(len / (type === 'E' ? 12 : 20))));
    if (texAxis === 'x') dashTex.repeat.set(tiles, 1);
    else dashTex.repeat.set(1, tiles);
    dashRate = type === 'E' ? 1.8 : 0.35;
    mat.map = dashTex;
    mat.needsUpdate = true;
  }

  // fat invisible hover hit-area: makes thin synapses much easier to grab
  const hitR = Math.max(r * 3.5, 1.5); // generous invisible corridor around the thin visible line
  const hitMat = new THREE.MeshBasicMaterial();
  const hitMesh = curve
    ? new THREE.Mesh(new THREE.TubeGeometry(curve, 16, hitR, 6, false), hitMat)
    : new THREE.Mesh(new THREE.CylinderGeometry(hitR, hitR, len, 6, 1, true), hitMat);
  if (!curve) {
    hitMesh.position.copy(a).add(b).multiplyScalar(0.5);
    hitMesh.quaternion.setFromUnitVectors(UP, d);
  }
  hitMesh.visible = false; // renderer skips it; this three build still raycasts it
  hitMesh.userData = { kind: 'edge', edge };
  extra.push(hitMesh);

  extra.forEach(o => { if (!o.userData.basePos) o.userData.basePos = o.position.clone(); });

  // sway axes (perpendicular to the synapse) for the music wiggle
  const ref = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const side1 = new THREE.Vector3().crossVectors(d, ref).normalize();
  const side2 = new THREE.Vector3().crossVectors(d, side1).normalize();

  // traveling light pulse: small, bright, additive — per-type character:
  // 'H' steady glide, 'E' fast spark (elongated), 'S' slow (throbs in animate)
  const pulseScale = type === 'E' ? 0.75 : type === 'S' ? 1.15 : 1;
  const pulseLen = type === 'E' ? 3.2 : 2.3;
  const pulse = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(0.16, r * 2.2), 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: type === 'E' ? 1.0 : 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  pulse.scale.set(pulseScale, pulseLen, pulseScale);
  if (!curve) alignY(pulse.quaternion, d);

  return {
    mesh, pulse, a, b, baseColor, type, dashTex, dashRate, texAxis, pulseScale, pulseLen,
    speed: (0.06 + t * 0.3) * (type === 'E' ? 2.2 : type === 'S' ? 0.85 : 1),
    offset: (hashStr(edge.a + edge.b) % 100) / 100,
    highFreq: edge.freq >= 70, curve, extra,
    swayMeshes: extra,
    basePos: mesh.position.clone(),
    baseOp: mat.opacity,
    side1, side2,
    phase: ((hashStr(edge.a + edge.b) % 997) / 997) * Math.PI * 2,
    trackA, trackB,
    colA: energyColor(trackA.energy), colB: energyColor(trackB.energy),
  };
}

/* dendrite wing: tube in local space, growing along +X toward the other node */
function buildWing(L, rng, mat) {
  const p0 = new THREE.Vector3(0, 0, 0);
  const p1 = new THREE.Vector3(L * 0.55, (rng() - 0.5) * L * 0.55, (rng() - 0.5) * L * 0.55);
  const p2 = new THREE.Vector3(L, (rng() - 0.5) * L * 0.35, (rng() - 0.5) * L * 0.35);
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3([p0, p1, p2]), 16, 0.09, 6, false), mat
  );
  const g = new THREE.Group();
  g.add(tube);
  return g;
}

function buildSuggestion(s, pos, sizes, group) {
  const ratio = Math.min(s.score / MUTUAL_THRESHOLD, 1);
  const posA = pos.get(s.a), posB = pos.get(s.b);
  const d = posB.clone().sub(posA).normalize();
  const radA = sizes.get(s.a) / 2, radB = sizes.get(s.b) / 2;
  const gap = Math.max(posA.distanceTo(posB) - radA - radB, 4);
  const L = gap * 0.48; // each wing reaches ~halfway, so they meet at threshold
  const rng = mulberry32(hashStr(pairKey(s.a, s.b)) ^ 137);
  const mat = new THREE.MeshBasicMaterial({
    color: ratio >= 1 ? 0xff6a80 : 0x7fb8ff,
    transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const wingA = buildWing(L, rng, mat);
  wingA.position.copy(posA).addScaledVector(d, radA);
  wingA.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d);
  const wingB = buildWing(L, rng, mat);
  wingB.position.copy(posB).addScaledVector(d, -radB);
  wingB.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.clone().negate());
  wingA.scale.x = wingB.scale.x = 0.3;
  group.add(wingA, wingB);
  return { a: s.a, b: s.b, score: s.score, ratio, mat, wingA, wingB, phase: rng() * Math.PI * 2 };
}

/* ---------- Create-Link approval animation ---------- */
const easeInOutSine = p => -(Math.cos(Math.PI * p) - 1) / 2;
const easeOutBack = p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
const APPROVAL_DUR = 1.6; // seconds

function makeWaveTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(255,255,255,0)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.9, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function startApproval(s) {
  if (!brain || approval) return;
  const nA = brain.nodeById.get(s.a), nB = brain.nodeById.get(s.b);
  const posA = nA.position, posB = nB.position;
  const radA = nA.userData.radius, radB = nB.userData.radius;
  const mid = posA.clone().add(posB).multiplyScalar(0.5);
  const gap = Math.max(posA.distanceTo(posB) - radA - radB, 4);
  // glow waves: one expanding ring each, mid -> neuron A and mid -> neuron B
  const waveTex = makeWaveTexture();
  const waveMat = () => new THREE.SpriteMaterial({
    map: waveTex, color: 0xffffff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const waveA = new THREE.Sprite(waveMat());
  const waveB = new THREE.Sprite(waveMat());
  brain.group.add(waveA, waveB);
  approval = { s, t0: clock.elapsedTime, mid, gap, waveA, waveB,
    preView: { cam: camera.position.clone(), tgt: controls.target.clone() } };
  // zoom the link to center screen
  flyTo(mid, Math.min(Math.max(gap * 1.15 + 10, 26), 90));
}

/* ---------- in-place link commit: the snapped wings become the new synapse ---------- */
const wingDissolve = []; // { s, t0 } — fading-out suggestion wings
let lastPreView = null;

function growNode(id) {
  const deg = brain.edges.reduce((n, e) => n + (e.a === id || e.b === id ? 1 : 0), 0);
  const target = 4.2 + Math.min(deg, 12) * 0.55;
  const node = brain.nodeById.get(id);
  const cur = node.userData.radius * 2;
  if (target > cur) {
    node.scale.multiplyScalar(target / cur);
    node.userData.radius = target / 2;
  }
}

function dissolveSuggestion(s) {
  wingDissolve.push({ s, t0: clock.elapsedTime });
  const i = brain.suggestions.indexOf(s);
  if (i >= 0) brain.suggestions.splice(i, 1);
}

/* update the surviving suggestions in place (no full rebuild, no camera reset) */
function refreshSuggestions() {
  if (!brain) return;
  const pos = new Map(), sizes = new Map();
  brain.nodeById.forEach((n, id) => { pos.set(id, n.position); sizes.set(id, n.userData.radius * 2); });
  const fresh = computeSuggestions(brain.tracks, brain.edges)
    .filter(s => !dismissedPairs.has(pairKey(s.a, s.b)));
  const freshKey = new Set(fresh.map(f => pairKey(f.a, f.b)));
  for (const s of [...brain.suggestions]) {
    if (!freshKey.has(pairKey(s.a, s.b))) { dissolveSuggestion(s); continue; }
    const f = fresh.find(x => pairKey(x.a, x.b) === pairKey(s.a, s.b));
    s.score = f.score;
    s.ratio = Math.min(f.score / MUTUAL_THRESHOLD, 1);
  }
  const have = new Set(brain.suggestions.map(x => pairKey(x.a, x.b)));
  for (const f of fresh) {
    if (!have.has(pairKey(f.a, f.b))) brain.suggestions.push(buildSuggestion(f, pos, sizes, brain.group));
  }
}

function commitConnection(s) {
  const nA = brain.nodeById.get(s.a), nB = brain.nodeById.get(s.b);
  const radA = nA.userData.radius, radB = nB.userData.radius;
  const e = { a: s.a, b: s.b, freq: 60, type: edgeTypeOf(brain.trackById.get(s.a), brain.trackById.get(s.b)) };
  const eo = buildEdge(e, nA.position, nB.position, radA, radB,
    brain.trackById.get(s.a), brain.trackById.get(s.b));
  eo.baseOp = eo.mesh.material.opacity;
  eo.fadingIn = true;
  eo.fadeT0 = clock.elapsedTime;
  brain.group.add(eo.mesh, eo.pulse);
  eo.extra.forEach(o => brain.group.add(o));
  brain.edgeObjs.push(eo);
  brain.edges.push(e);
  if (brain.edges !== DATA.edges) DATA.edges.push(e);
  approvedPairs.add(pairKey(s.a, s.b));
  growNode(s.a);
  growNode(s.b);
  refreshSuggestions(); // dissolves the committed pair's wings, re-scores the rest
  showPromptIfNeeded();
}

function hideReturnView() {
  document.getElementById('returnView').classList.add('hidden');
}

document.getElementById('returnView').addEventListener('click', () => {
  if (lastPreView) flight = { camTo: lastPreView.cam.clone(), tgtTo: lastPreView.tgt.clone() };
  hideReturnView();
});

function showPromptIfNeeded() {
  const el = document.getElementById('synapsePrompt');
  if (!brain) { el.classList.add('hidden'); return; }
  const cand = brain.suggestions.find(s => s.ratio >= 1);
  if (!cand) { el.classList.add('hidden'); return; }
  const ta = brain.trackById.get(cand.a), tb = brain.trackById.get(cand.b);
  document.getElementById('spTitle').textContent = `${ta.title}  \u2194  ${tb.title}`;
  document.getElementById('spSub').textContent =
    `${ta.artist} \u00d7 ${tb.artist} \u00b7 ${cand.score} shared connections crossed the mutual threshold`;
  el.dataset.a = cand.a;
  el.dataset.b = cand.b;
  el.classList.remove('hidden');
}

function forceLayout(tracks, edges) {
  const idx = new Map(tracks.map((t, i) => [t.id, i]));
  const arr = tracks.map((t) => {
    const rng = mulberry32(hashStr(t.id));
    return new THREE.Vector3((rng() - 0.5) * 60, (rng() - 0.5) * 60, (rng() - 0.5) * 60);
  });
  const es = edges.map(e => [idx.get(e.a), idx.get(e.b)]);
  const tmp = new THREE.Vector3();
  for (let it = 0; it < 220; it++) {
    const f = arr.map(() => new THREE.Vector3());
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        tmp.subVectors(arr[i], arr[j]);
        const l = Math.max(tmp.length(), 0.1);
        tmp.multiplyScalar(1050 / (l * l) / l);
        f[i].add(tmp); f[j].sub(tmp);
      }
    }
    for (const [i, j] of es) {
      tmp.subVectors(arr[j], arr[i]);
      const l = Math.max(tmp.length(), 0.1);
      tmp.multiplyScalar((l - 28) * 0.03 / l);
      f[i].add(tmp);
      f[j].sub(tmp);
    }
    for (let i = 0; i < arr.length; i++) {
      f[i].addScaledVector(arr[i], -0.002);
      if (f[i].length() > 1.5) f[i].setLength(1.5);
      arr[i].add(f[i]);
    }
  }
  return new Map(tracks.map((t, i) => [t.id, arr[i]]));
}

function clusterLayout(tracks) {
  // orbital cluster view: one clean vertical "planetary column" per genre,
  // spread across the X-axis; tracks stacked strictly by energy (low at the
  // bottom, high at the top) with radial X/Z jitter so nodes don't overlap
  const genres = [...new Set(tracks.map(t => t.genre))].sort();
  const pos = new Map();
  const labels = [];
  const spacing = genres.length > 1 ? 36 : 0;
  genres.forEach((genre, gi) => {
    const cx = (gi - (genres.length - 1) / 2) * spacing;
    const members = tracks.filter(t => t.genre === genre).sort((a, b) => a.energy - b.energy);
    let yMin = Infinity;
    members.forEach((t) => {
      const rng = mulberry32(hashStr(t.id) ^ 7);
      const y = (t.energy - 5.5) * 9.0;
      const rr = 3.0 + rng() * 4.0;
      const aa = rng() * Math.PI * 2;
      pos.set(t.id, new THREE.Vector3(cx + Math.cos(aa) * rr, y, Math.sin(aa) * rr));
      yMin = Math.min(yMin, y);
    });
    // tracked-out uppercase genre label under the column
    const spr = makeGenreLabel(genre);
    spr.position.set(cx, yMin - 11, 0);
    labels.push(spr);
  });
  return { pos, labels };
}

function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
  scene.remove(g);
}

function rebuildBrain(name) {
  if (pf.previewing) pfStopPreview(); // cancel any path preview
  approval = null; // cancel any in-flight Create-Link animation
  wingDissolve.length = 0;
  hideReturnView();
  if (brain) disposeGroup(brain.group);
  closeModal();

  let tracks, edges;
  if (name === 'Master Brain') {
    tracks = DATA.tracks;
    edges = DATA.edges;
  } else {
    const ids = new Set(DATA.playlists[name]);
    tracks = DATA.tracks.filter(t => ids.has(t.id));
    edges = DATA.edges.filter(e => ids.has(e.a) && ids.has(e.b));
  }

  const group = new THREE.Group();
  const seed = hashStr(name + (mode === 'free' ? ':free' : ':cluster'));
  let pos, clusterLabels = null;
  if (mode === 'free') {
    pos = forceLayout(tracks, edges);
  } else {
    const cl = clusterLayout(tracks);
    pos = cl.pos;
    clusterLabels = cl.labels;
  }

  const trackById = new Map(tracks.map(t => [t.id, t]));
  // node size = connection count (degree); ring still encodes energy
  const degree = new Map(tracks.map(t => [t.id, 0]));
  for (const e of edges) {
    if (degree.has(e.a)) degree.set(e.a, degree.get(e.a) + 1);
    if (degree.has(e.b)) degree.set(e.b, degree.get(e.b) + 1);
  }
  const sizes = new Map(tracks.map(t => [t.id, 6.0 + Math.min(degree.get(t.id), 12) * 0.7]));

  // apply the current Spread immediately so mode / playlist switches keep it
  const spreadPos = new Map();
  for (const [id, p] of pos) spreadPos.set(id, p.clone().multiplyScalar(spreadFactor));

  const nodeById = new Map();
  for (const t of tracks) {
    const node = buildNode(t, sizes.get(t.id));
    node.userData.track = t;
    node.userData.basePos = pos.get(t.id).clone(); // unscaled layout position (Spread source of truth)
    node.position.copy(node.userData.basePos).multiplyScalar(spreadFactor);
    group.add(node);
    nodeById.set(t.id, node);
  }
  const edgeObjs = [];
  for (const e of edges) {
    const eo = buildEdge(e, spreadPos.get(e.a), spreadPos.get(e.b), sizes.get(e.a) / 2, sizes.get(e.b) / 2, trackById.get(e.a), trackById.get(e.b));
    group.add(eo.mesh);
    group.add(eo.pulse);
    eo.extra.forEach(o => group.add(o));
    edgeObjs.push(eo);
  }

  // dendrite wings reaching toward the mutual-connection threshold
  const suggestions = computeSuggestions(tracks, edges)
    .filter(s => !dismissedPairs.has(pairKey(s.a, s.b)))
    .map(s => buildSuggestion(s, spreadPos, sizes, group));

  if (clusterLabels) {
    clusterLabels.forEach(l => {
      l.userData.basePos = l.position.clone(); // unscaled genre-label position
      l.position.copy(l.userData.basePos).multiplyScalar(spreadFactor);
    });
    clusterLabels.forEach(l => group.add(l));
  }

  scene.add(group);
  brain = { tracks, edges, group, nodeById, edgeObjs, trackById, suggestions, clusterLabels };
  // bounding sphere of the whole network (neurons + synapses) — used by the
  // infinite-void loop to test whether everything is out of view
  brain.boundSphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());

  controls.target.set(0, 0, 0);
  if (mode === 'free') camera.position.set(0, 10, 95);
  else camera.position.set(0, 4, 96); // wider spread of genre columns

  renderTrackList(); // keep the track list in sync with the active brain
  showPromptIfNeeded();
}

/* ---------- live Spread: reposition the whole network in place ----------
   Never scales brain.group (that would stretch nodes/labels/lines); every node,
   label, synapse and dendrite wing is rebuilt against the new distances. The
   camera is left exactly where the user put it. */
function applySpread(factor) {
  spreadFactor = Math.min(2.5, Math.max(0.4, +factor || 1));
  const val = document.getElementById('brainSpreadVal');
  if (val) val.textContent = spreadFactor.toFixed(2).replace(/0$/, '') + 'x';
  if (!brain) return;

  // cancel any in-flight Create-Link sequence: its geometry is about to be rebuilt
  if (approval) {
    brain.group.remove(approval.waveA, approval.waveB);
    for (const wv of [approval.waveA, approval.waveB]) {
      if (wv.material.map) wv.material.map.dispose();
      wv.material.dispose();
    }
    approval = null;
  }

  // 1) reposition nodes + genre labels from their unscaled base positions
  const pos = new Map(), sizes = new Map();
  brain.nodeById.forEach((n, id) => {
    const p = n.userData.basePos.clone().multiplyScalar(spreadFactor);
    n.position.copy(p);
    pos.set(id, p);
    sizes.set(id, n.userData.radius * 2);
  });
  for (const l of (brain.clusterLabels || [])) {
    l.position.copy(l.userData.basePos).multiplyScalar(spreadFactor);
  }

  // 2) rebuild every synapse (mesh, pulses, branches, hit corridors) so it
  //    spans the new node distance — node sizes & line radii stay constant
  const hoverEdgeData = hoveredEdge ? hoveredEdge.mesh.userData.edge : null;
  const fadingEdges = new Set(brain.edgeObjs.filter(eo => eo.fadingIn).map(eo => eo.mesh.userData.edge));
  for (const eo of brain.edgeObjs) {
    brain.group.remove(eo.mesh, eo.pulse);
    eo.extra.forEach(o => brain.group.remove(o));
    eo.mesh.geometry.dispose();
    eo.pulse.geometry.dispose();
    eo.extra.forEach(o => { if (o.geometry) o.geometry.dispose(); });
    const mats = new Set([eo.mesh.material, eo.pulse.material]);
    eo.extra.forEach(o => { if (o.material) mats.add(o.material); });
    mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
  }
  brain.edgeObjs.length = 0;
  for (const e of brain.edges) {
    const eo = buildEdge(e, pos.get(e.a), pos.get(e.b), sizes.get(e.a) / 2, sizes.get(e.b) / 2,
      brain.trackById.get(e.a), brain.trackById.get(e.b));
    brain.group.add(eo.mesh);
    brain.group.add(eo.pulse);
    eo.extra.forEach(o => brain.group.add(o));
    if (fadingEdges.has(e)) { eo.fadingIn = true; eo.fadeT0 = clock.elapsedTime; } // keep committed-synapse fade-in alive
    brain.edgeObjs.push(eo);
  }

  // 3) rebuild the dendrite wings (incl. any dissolving ones) for the new distances
  for (const w of wingDissolve) {
    brain.group.remove(w.s.wingA, w.s.wingB);
    w.s.wingA.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    w.s.wingB.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    w.s.mat.dispose();
  }
  wingDissolve.length = 0;
  for (const s of brain.suggestions) {
    brain.group.remove(s.wingA, s.wingB);
    s.wingA.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    s.wingB.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    s.mat.dispose();
  }
  brain.suggestions.length = 0;
  for (const f of computeSuggestions(brain.tracks, brain.edges).filter(s => !dismissedPairs.has(pairKey(s.a, s.b)))) {
    brain.suggestions.push(buildSuggestion(f, pos, sizes, brain.group));
  }
  showPromptIfNeeded();

  // 4) restore the hover highlight on the rebuilt synapse (node refs were never rebuilt)
  hoveredEdge = hoverEdgeData
    ? (brain.edgeObjs.find(x => x.mesh.userData.edge === hoverEdgeData) || null)
    : null;
  if (hoveredEdge) {
    hoveredEdge.mesh.material.color.copy(hoveredEdge.baseColor).lerp(_whiteC, 0.65);
    hoveredEdge.pulse.material.opacity = 1;
  }

  // 5) recompute the wrap-test sphere so the infinite-void loop stays accurate
  brain.boundSphere = new THREE.Box3().setFromObject(brain.group).getBoundingSphere(new THREE.Sphere());
}

/* ---------- interaction ---------- */
function pick(x, y) {
  pointer.x = (x / window.innerWidth) * 2 - 1;
  pointer.y = -(y / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const targets = [];
  brain.group.children.forEach(o => {
    if (o.userData && o.userData.kind === 'node') targets.push(o.userData.ring);
    if (o.userData && o.userData.kind === 'edge') targets.push(o);
  });
  const hits = raycaster.intersectObjects(targets, false);
  return hits.length ? hits[0].object : null;
}

/* ---------- hover toast (top center) ---------- */
const toastEl = document.getElementById('toast');
function toastTrack(t) {
  const col = '#' + keyColor(t.camelot).getHexString();
  return '<div class="trow"><span class="k" style="background:' + col + '33;color:' + col + ';border-color:' + col + '88">' + t.camelot + '</span>' +
    '<div><div class="t">' + t.title + '</div><div class="a">' + t.artist + '</div></div></div>';
}
function showToast(html) { toastEl.innerHTML = html; toastEl.classList.add('show'); }
function hideToast() { toastEl.classList.remove('show'); }

function setHoveredNode(nodeObj) {
  if (hoveredNode === nodeObj) return;
  if (hoveredNode) hoveredNode.userData.label.visible = false;
  // leaving a node: stop its hover preview (only if the hover owns the audio —
  // a click-promoted "play until ■" must survive hover-out)
  if (hoveredNode && hoverSource === 'node-hover') {
    if (!pf.previewing) { audio.stop(); hoverSource = null; updateNowPlaying(null, null); }
    else hoverSource = null;
  }
  hoveredNode = nodeObj;
  if (hoveredNode && mode === 'free') hoveredNode.userData.label.visible = true;
  // hovering a node = instant preview of that track
  if (hoveredNode && !pf.previewing) {
    hoverSource = 'node-hover';
    audio.playTrack(hoveredNode.userData.track, { seconds: 12 });
    updateNowPlaying(hoveredNode.userData.track, hoveredNode.userData.track, 'node-hover');
  }
  renderer.domElement.style.cursor = (typeof autoFly !== 'undefined' && autoFly) ? 'none' : (nodeObj ? 'pointer' : 'default');
  if (nodeObj) showToast(toastTrack(nodeObj.userData.track));
  else hideToast();
}

let hoverSource = null; // who owns the audio: 'node-hover' | 'node-click' | 'synapse-click' | null
function setHoveredEdge(eo) {
  // synapse hover = visual highlight only; audio comes from a click
  if (hoveredEdge === eo) return;
  if (hoveredEdge) {
    hoveredEdge.mesh.material.color.copy(hoveredEdge.baseColor);
    hoveredEdge.pulse.material.opacity = 0.95;
  }
  hoveredEdge = eo;
  if (hoveredEdge) {
    hoveredEdge.mesh.material.color.copy(hoveredEdge.baseColor).lerp(new THREE.Color(0xffffff), 0.65);
    hoveredEdge.pulse.material.opacity = 1;
    showToast(toastTrack(eo.trackA) + toastTrack(eo.trackB));
  } else {
    hideToast();
  }
}

function updateNowPlaying(a, b, source) {
  const el = document.getElementById('nowPlaying');
  if (!a) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  document.getElementById('npText').textContent =
    (source === 'node-hover' ? 'PREVIEW  ' : 'PLAYING  ') +
    (a === b ? `${a.title}` : `${a.title} → ${b.title}`);
}

/* ---------- modal ---------- */
/* 1st click on a node: zoom in + start the preview (no card) */
function focusNode(track) {
  if (pf.previewing) pfStopPreview();
  if (focusTrack && brain) {
    const prev = brain.nodeById.get(focusTrack.id);
    if (prev) {
      prev.userData.ring.material.color.copy(prev.userData.baseRingColor);
      prev.userData.ring.material.opacity = 0.9;
    }
  }
  focusTrack = track;
  const node = brain.nodeById.get(track.id);
  if (node) {
    node.userData.ring.material.color.set(0xffffff);
    node.userData.ring.material.opacity = 1;
    flyTo(node.position, 26);
  }
  // click = play until the user presses ■ (loops the 30s preview clip).
  // If a hover preview of this same track is already running, just promote it.
  if (hoverSource !== 'node-hover') audio.playTrack(track, { loop: true });
  hoverSource = 'node-click';
  updateNowPlaying(track, track, 'node');
}

/* 2nd click: open the inspection card (focusNode already zoomed + played) */
function openModal(track) {
  const neighbors = brain.edges
    .filter(e => e.a === track.id || e.b === track.id)
    .map(e => ({ other: e.a === track.id ? e.b : e.a, freq: e.freq, type: e.type || 'S' }))
    .sort((x, y) => y.freq - x.freq);

  document.getElementById('mTitle').textContent = track.title;
  document.getElementById('mArtist').textContent = track.artist;
  const badges = document.getElementById('mBadges');
  const keyCol = '#' + keyColor(track.camelot).getHexString();
  badges.innerHTML =
    `<span class="badge key" style="background:${keyCol}33;border-color:${keyCol}88">${track.camelot}</span>` +
    `<span class="badge">${track.genre}</span>` +
    `<span class="badge">Energy ${track.energy}/10</span>` +
    `<span class="badge">${track.bpm} BPM</span>`;

  const cascade = document.getElementById('mCascade');
  cascade.innerHTML = '';
  neighbors.forEach((n, i) => {
    const other = brain.tracks.find(t => t.id === n.other);
    const col = '#' + edgeColor(n.freq).getHexString();
    const row = document.createElement('div');
    row.className = 'crow';
    row.style.setProperty('--ec', col);
    row.style.animationDelay = (i * 70) + 'ms';
    const etName = { H: 'HARMONIC', E: 'ENERGETIC', S: 'SONIC' }[n.type] || 'SONIC';
    row.innerHTML =
      `<span class="etype et-${n.type}" title="${etName} connection">${n.type}</span>` +
      `<div class="info"><div class="t">${other.title}</div><div class="a">${other.artist} &middot; ${other.camelot}</div></div>` +
      `<div class="f">${n.freq}%</div>` +
      `<button class="qplay" data-id="${other.id}">▶ QUICK-PLAY</button>`;
    row.querySelector('.qplay').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;
      // the button's own track plays primary (immediate, full EQ);
      // the focused track fades in as the incoming side
      audio.playTransition(other, track, { seconds: 16, mixBeats: 8 });
      cascade.querySelectorAll('.qplay').forEach(b => b.classList.remove('playing'));
      btn.classList.add('playing');
      updateNowPlaying(other, track, 'quick');
    });
    cascade.appendChild(row);
  });
  if (!neighbors.length) {
    cascade.innerHTML = '<div style="font-size:12px;color:var(--dim)">No proven transitions yet.</div>';
  }
  document.getElementById('modalWrap').classList.remove('hidden');
  modalTrack = track;
}

/* closing the card keeps the node focused (ring stays lit) until another node is clicked */
function closeModal() {
  document.getElementById('modalWrap').classList.add('hidden');
  modalTrack = null;
  if (hoveredNode) hoveredNode.userData.label.visible = false;
}

function flyTo(pos, dist) {
  const d = camera.position.clone().sub(pos);
  if (d.lengthSq() < 0.001) d.set(0, 0.3, 1);
  d.normalize();
  flight = { camTo: pos.clone().add(d.multiplyScalar(dist)), tgtTo: pos.clone() };
}

/* ---------- Pathfinder ----------
   Build a path through proven transitions (no track twice), save it, and
   preview it as a continuous 4-bar mix chain. */
const PF_STORE = 'djbrain.paths';
const pfEl = (id) => document.getElementById(id);

function pfLoadSaved() {
  try { return JSON.parse(localStorage.getItem(PF_STORE)) || []; } catch (e) { return []; }
}
function pfStoreSaved(list) {
  try { localStorage.setItem(PF_STORE, JSON.stringify(list)); } catch (e) { /* private mode */ }
}
function pfTrackOf(id) {
  if (brain && brain.trackById.has(id)) return brain.trackById.get(id);
  return DATA.tracks.find(t => t.id === id) || null;
}

function pfOptions() {
  const cur = pf.path.length ? pf.path[pf.path.length - 1] : null;
  if (!brain) return [];
  if (!cur) return [...brain.tracks].sort((a, b) => a.title.localeCompare(b.title)).map(t => ({ track: t, freq: null }));
  const used = new Set(pf.path);
  return brain.edges
    .filter(e => e.a === cur || e.b === cur)
    .map(e => ({ other: e.a === cur ? e.b : e.a, freq: e.freq }))
    .filter(o => !used.has(o.other))
    .sort((x, y) => y.freq - x.freq)
    .map(o => ({ track: brain.trackById.get(o.other), freq: o.freq }))
    .filter(o => o.track);
}

function pfRender() {
  const chips = pfEl('pfChips'), list = pfEl('pfList');
  chips.innerHTML = pf.path.length
    ? pf.path.map((id, i) => {
        const t = pfTrackOf(id);
        return `<span class="pfChip">${i + 1} &middot; ${t ? t.title : id}${i > 0 ? `<b data-x="${i}">&times;</b>` : ''}</span>`;
      }).join('')
    : '<span class="pfEmpty">Pick a starting track to begin the path.</span>';
  chips.querySelectorAll('b[data-x]').forEach(b => b.addEventListener('click', () => {
    pf.path = pf.path.slice(0, +b.dataset.x);
    pfRender();
  }));

  const opts = pfOptions();
  list.innerHTML = opts.length
    ? opts.map((o, i) => `<div class="pfOpt" data-i="${i}">
        <div><div class="t">${o.track.title}</div>
        <div class="a">${o.track.artist} &middot; ${o.track.bpm} BPM${o.freq != null ? ' &middot; ' + o.freq + '%' : ''}</div></div>
        <span class="go">&#10148;</span></div>`).join('')
    : '<div class="pfEmpty">No new connections from here &mdash; the path ends. Save or step back.</div>';
  list.querySelectorAll('.pfOpt').forEach(el => el.addEventListener('click', () => {
    const o = pfOptions()[+el.dataset.i];
    if (o) { pf.path.push(o.track.id); pfRender(); }
  }));
  pfEl('pfSave').disabled = pf.path.length < 2;
}

function pfSave() {
  if (pf.path.length < 2) return;
  const first = pfTrackOf(pf.path[0]), last = pfTrackOf(pf.path[pf.path.length - 1]);
  const def = first && last ? `${first.title} \u2192 ${last.title}` : 'My Path';
  const name = ((prompt('Name this path:', def) || def)).trim() || def;
  const list = pfLoadSaved();
  list.unshift({ id: 'p' + Date.now(), name, trackIds: [...pf.path], createdAt: Date.now() });
  pfStoreSaved(list.slice(0, 50));
  pf.path = [];
  pfRender(); pfRenderSaved();
}

function pfRenderSaved() {
  const wrap = pfEl('pfSaved');
  const list = pfLoadSaved();
  wrap.innerHTML = list.length
    ? list.map(p => `<div class="pfSavedRow" data-id="${p.id}">
        <button class="pfPlay" title="Preview">&#9654;</button>
        <div class="meta"><div class="t">${p.name}</div><div class="a">${p.trackIds.length} tracks</div></div>
        <button class="pfSB" title="Open in Set Builder (coming soon)" disabled>Set Builder</button>
        <button class="pfDel" title="Delete">&times;</button>
      </div>`).join('')
    : '<div class="pfEmpty">No saved paths yet.</div>';
  wrap.querySelectorAll('.pfSavedRow').forEach(row => {
    const p = list.find(x => x.id === row.dataset.id);
    if (!p) return;
    row.querySelector('.pfPlay').addEventListener('click', () => pfPreview(p));
    row.querySelector('.pfDel').addEventListener('click', () => {
      pfStoreSaved(pfLoadSaved().filter(x => x.id !== p.id));
      pfRenderSaved();
    });
  });
}

async function pfPreview(p) {
  if (pf.previewing) pfStopPreview();
  const tracks = p.trackIds.map(pfTrackOf).filter(Boolean);
  if (!tracks.length) return;
  closeModal();
  const r = await audio.playPath(tracks);
  if (!r) return;
  pf.previewing = true;
  pf.t0 = r.t0;
  pf.total = r.total;
  pf.camPlan = tracks.map((t, i) => ({
    at: (r.kf[i] && r.kf[i].length) ? r.kf[i][0].t : 0,
    pos: (brain && brain.nodeById.get(t.id)) ? brain.nodeById.get(t.id).position : null,
  }));
  pf.camIdx = 0;
  pf.tracks = tracks;
  const first = pf.camPlan[0];
  if (first && first.pos) flyTo(first.pos, 30);
  pfEl('pfBarName').textContent = 'PATH PREVIEW  \u00b7  ' + tracks[0].title;
  pfEl('pfBarFill').style.width = '0%';
  pfEl('pfBar').classList.remove('hidden');
}

function pfStopPreview() {
  if (!pf.previewing) return;
  pf.previewing = false;
  audio.stop();
  pfEl('pfBar').classList.add('hidden');
  updateNowPlaying(null, null);
}

function pfEndPreview() {
  pf.previewing = false;
  pfEl('pfBar').classList.add('hidden');
  updateNowPlaying(null, null);
}

/* panel wiring */
{
  const pfPanel = pfEl('pfPanel');
  const setPfOpen = (open) => {
    pfPanel.classList.toggle('hidden', !open);
    document.body.classList.toggle('pfOpen', open);
    pfEl('pfToggle').classList.toggle('active', open);
  };
  pfEl('pfToggle').addEventListener('click', () => setPfOpen(pfPanel.classList.contains('hidden')));
  pfEl('pfClose').addEventListener('click', () => setPfOpen(false));
  pfEl('pfBack').addEventListener('click', () => { pf.path.pop(); pfRender(); });
  pfEl('pfClear').addEventListener('click', () => { pf.path = []; pfRender(); });
  pfEl('pfSave').addEventListener('click', pfSave);
  pfEl('pfStop').addEventListener('click', pfStopPreview);
  pfRender();
  pfRenderSaved();
}

/* track list panel: browse the active brain's tracks, click = fly to node + play */
const trackPanel = document.getElementById('trackPanel');
const tListEl = document.getElementById('tList');
const tSearchEl = document.getElementById('tSearch');
function renderTrackList(query = '') {
  if (!brain) return;
  const q = query.trim().toLowerCase();
  const matches = q
    ? brain.tracks.filter(t => `${t.title} ${t.artist} ${t.camelot} ${t.bpm}`.toLowerCase().includes(q))
    : brain.tracks;
  document.getElementById('tCount').textContent =
    (q ? matches.length + ' MATCHES \u00b7 ' : '') + brain.tracks.length + ' TRACKS \u00b7 ' + brainName.toUpperCase();
  tListEl.innerHTML = '';
  if (matches.length === 0) {
    const d = document.createElement('div');
    d.className = 'tEmpty';
    d.textContent = `No tracks match \u201c${query}\u201d`;
    tListEl.appendChild(d);
    return;
  }
  matches.forEach((t, i) => {
    const kc = '#' + keyColor(t.camelot).getHexString();
    const row = document.createElement('div');
    row.className = 'tRow';
    row.innerHTML =
      `<span class="num">${i + 1}</span>` +
      `<span class="meta"><span class="t">${t.title}</span>` +
      `<span class="a">${t.artist} \u00b7 ${t.bpm} BPM \u00b7 Energy ${t.energy}/10</span></span>` +
      `<span class="k" style="background:${kc}22;color:${kc};border:1px solid ${kc}55">${t.camelot}</span>`;
    row.addEventListener('click', () => {
      tSearchEl.blur();
      closeModal();
      focusNode(t); // fly there + play; click the node again to open its card
      // panel stays open so you can click through tracks in a row
    });
    tListEl.appendChild(row);
  });
}
function flyToSearchResult() {
  if (!brain) return;
  const q = tSearchEl.value.trim().toLowerCase();
  const m = q
    ? brain.tracks.find(t => `${t.title} ${t.artist} ${t.camelot} ${t.bpm}`.toLowerCase().includes(q))
    : brain.tracks[0];
  if (!m) return;
  tSearchEl.blur();
  closeModal();
  focusNode(m);
  // panel stays open so you can keep browsing the search results
}
tSearchEl.addEventListener('input', () => renderTrackList(tSearchEl.value));
tSearchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') flyToSearchResult();
  else if (e.key === 'Escape') { trackPanel.classList.add('hidden'); tSearchEl.blur(); }
  e.stopPropagation(); // typing must not drive the camera
});
/* docked sidebar: header hamburger toggles visibility */
function toggleSidebar(force) {
  const hide = force !== undefined ? force : !trackPanel.classList.contains('hidden');
  trackPanel.classList.toggle('hidden', hide);
  document.getElementById('hudToggle').classList.toggle('active', !hide);
  if (!hide) renderTrackList();
}
document.getElementById('hudToggle').addEventListener('click', () => toggleSidebar());

/* "/" hotkey: reveal the sidebar and jump to search from anywhere */
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === '/') {
    e.preventDefault();
    toggleSidebar(false);
    tSearchEl.focus();
  }
});

/* ---------- UI wiring ---------- */
/* sidebar brain list: MASTER BRAIN + playlists as clickable items */
const MASTER_BRAIN = 'Master Brain';
const brainListEl = document.getElementById('brainList');
function renderBrainList() {
  const names = [MASTER_BRAIN, ...Object.keys(DATA.playlists)];
  brainListEl.innerHTML = '';
  names.forEach(name => {
    const b = document.createElement('button');
    b.className = 'brainItem' + (name === brainName ? ' active' : '');
    b.textContent = name === MASTER_BRAIN ? 'MASTER BRAIN' : name;
    b.addEventListener('click', () => {
      if (brainName === name) return;
      brainName = name;
      rebuildBrain(brainName);
      renderBrainList();
    });
    brainListEl.appendChild(b);
  });
}
renderBrainList();

let edgeStyle = 'clean';
const freeBtn = document.getElementById('modeFree');
const clusterBtn = document.getElementById('modeCluster');
function setMode(m) {
  mode = m;
  freeBtn.classList.toggle('active', m === 'free');
  clusterBtn.classList.toggle('active', m === 'cluster');
  rebuildBrain(brainName);
}
freeBtn.addEventListener('click', () => setMode('free'));
clusterBtn.addEventListener('click', () => setMode('cluster'));

const edgeCleanBtn = document.getElementById('edgeClean');
const edgeNeuralBtn = document.getElementById('edgeNeural');
function setEdgeStyle(s) {
  if (edgeStyle === s) return;
  edgeStyle = s;
  edgeCleanBtn.classList.toggle('active', s === 'clean');
  edgeNeuralBtn.classList.toggle('active', s === 'neural');
  rebuildBrain(brainName);
}
edgeCleanBtn.addEventListener('click', () => setEdgeStyle('clean'));
edgeNeuralBtn.addEventListener('click', () => setEdgeStyle('neural'));

document.getElementById('mClose').addEventListener('click', closeModal);
document.getElementById('npStop').addEventListener('click', () => {
  if (pf.previewing) pfStopPreview();
  else { audio.stop(); hoverSource = null; updateNowPlaying(null, null); }
});

/* synapse prompt: approve a suggested mutual connection or dismiss it */
const spEl = document.getElementById('synapsePrompt');
document.getElementById('spApprove').addEventListener('click', () => {
  const a = spEl.dataset.a, b = spEl.dataset.b;
  if (a && b) {
    const s = brain && brain.suggestions.find(x => pairKey(x.a, x.b) === pairKey(a, b));
    if (s) startApproval(s);
    spEl.classList.add('hidden');
    // the synapse is committed at the end of the approval animation (animate loop)
  }
});
document.getElementById('spDismiss').addEventListener('click', () => {
  const a = spEl.dataset.a, b = spEl.dataset.b;
  if (a && b) dismissedPairs.add(pairKey(a, b));
  spEl.classList.add('hidden');
  showPromptIfNeeded(); // move on to the next pair at threshold, if any
});

/* key swatches */
{
  const wrap = document.getElementById('keySwatches');
  for (let n = 1; n <= 12; n++) {
    const s = document.createElement('div');
    s.className = 'sw';
    s.style.background = '#' + keyColor(n + 'B').getHexString();
    s.title = n;
    wrap.appendChild(s);
  }
}

/* header: export the current brain (tracks + typed synapses + playlists) as XML */
{
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  document.getElementById('exportXml').addEventListener('click', () => {
    const tracks = (brain ? brain.tracks : []).map(t =>
      `    <track id="${xmlEsc(t.id)}" title="${xmlEsc(t.title)}" artist="${xmlEsc(t.artist)}" ` +
      `camelot="${xmlEsc(t.camelot)}" bpm="${t.bpm}" energy="${t.energy}" genre="${xmlEsc(t.genre)}"/>`)
      .join('\n');
    const edges = (brain ? brain.edges : []).map(e =>
      `    <synapse a="${xmlEsc(e.a)}" b="${xmlEsc(e.b)}" type="${e.type || 'S'}" freq="${e.freq}"/>`)
      .join('\n');
    const playlists = Object.entries(DATA.playlists).map(([name, ids]) =>
      `  <playlist name="${xmlEsc(name)}">\n` +
      ids.map(id => `    <ref id="${xmlEsc(id)}"/>`).join('\n') + '\n  </playlist>').join('\n');
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<cratkit-dj-brain brain="${xmlEsc(brainName)}" exported="${new Date().toISOString()}">\n` +
      `  <tracks>\n${tracks}\n  </tracks>\n` +
      `  <synapses>\n${edges}\n  </synapses>\n` +
      `  <playlists>\n${playlists}\n  </playlists>\n` +
      `</cratkit-dj-brain>\n`;
    const blob = new Blob([xml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cratkit-dj-brain.xml';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* bottom-right help button: toggle the controls popover */
{
  const helpBtn = document.getElementById('helpBtn');
  const hint = document.getElementById('hint');
  helpBtn.addEventListener('click', (e) => { e.stopPropagation(); hint.classList.toggle('show'); });
  window.addEventListener('click', (e) => {
    if (!hint.contains(e.target) && !helpBtn.contains(e.target)) hint.classList.remove('show');
  });
}

/* pointer events */
let downPos = null;
let aimX = 0, aimY = 0; // pointer aim (NDC) — steers auto-fly
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointermove', (e) => {
  aimX = (e.clientX / window.innerWidth) * 2 - 1;
  aimY = -(e.clientY / window.innerHeight) * 2 + 1;
  if (!brain) return;
  const obj = pick(e.clientX, e.clientY);
  const nodeObj = obj && obj.userData.kind === 'node' ? brain.nodeById.get(obj.userData.track.id) : null;
  const edgeObj = obj && obj.userData.kind === 'edge' ? brain.edgeObjs.find(x => x.mesh === obj || x.swayMeshes.includes(obj)) : null;
  if (edgeObj) { setHoveredNode(null); setHoveredEdge(edgeObj); }
  else { setHoveredEdge(null); setHoveredNode(nodeObj); }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'mouse') { aimX = 0; aimY = 0; } // touch released — stop steering
  if (!downPos || !brain) return;
  const dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
  if (dx * dx + dy * dy > 36) return; // was a drag
  const obj = pick(e.clientX, e.clientY);
  if (obj && obj.userData.kind === 'node') {
    if (autoFly) setAutoFly(false); // node click takes over navigation
    const track = obj.userData.track;
    if (modalTrack && modalTrack.id === track.id) {
      closeModal(); // clicking the focused node while its card is open closes it
    } else if (modalTrack) {
      closeModal();
      focusNode(track); // navigate: close card, zoom + play the new node
    } else if (focusTrack && focusTrack.id === track.id) {
      openModal(track); // 2nd click on the focused node opens the card
    } else {
      focusNode(track); // 1st click: zoom + play, no card
    }
  } else if (obj && obj.userData.kind === 'edge') {
    closeModal();
    // clicking a synapse = transition preview until ■ (hover alone stays silent)
    const eo = brain.edgeObjs.find(x => x.mesh === obj || x.swayMeshes.includes(obj));
    if (eo && !pf.previewing) {
      if (autoFly) setAutoFly(false);
      audio.playTransition(eo.trackA, eo.trackB, { loop: true, fade: 0.15, cutoff: 0 });
      hoverSource = 'synapse-click';
      updateNowPlaying(eo.trackA, eo.trackB, 'synapse');
    }
  } else {
    closeModal();
  }
});

/* WASD/QE fly + speed (slider, double-tap W/S) */
const keys = {};
let flySpeed = 12; // units/sec (gentle start; double-tap W / S to boost); Shift boosts
let lastWTap = 0, lastSTap = 0;
const flySpeedEl = document.getElementById('flySpeed');
const flySpeedVal = document.getElementById('flySpeedVal');
function setFlySpeed(v) {
  flySpeed = Math.round(Math.min(80, Math.max(5, v)));
  flySpeedEl.value = flySpeed;
  flySpeedVal.textContent = flySpeed;
}
flySpeedEl.addEventListener('input', () => setFlySpeed(+flySpeedEl.value));
const brainSpreadEl = document.getElementById('brainSpread');
brainSpreadEl.addEventListener('input', () => applySpread(+brainSpreadEl.value));

/* auto-fly: forward propulsion; pointer position steers the aim */
let autoFly = false;
const autoFlyBtn = document.getElementById('autoFly');
const crosshairEl = document.getElementById('crosshair');
function setAutoFly(on) {
  autoFly = on;
  autoFlyBtn.classList.toggle('active', autoFly);
  autoFlyBtn.innerHTML = autoFly ? '&#9632; Stop Fly' : '&#9654; Auto-Fly <span style="opacity:.6">(F)</span>';
  crosshairEl.classList.toggle('active', autoFly);
  renderer.domElement.style.cursor = autoFly ? 'none' : 'default';
  syncFlyAim(); // orbit-drag stays free (full 360°) unless the pointer is FPS-locked
  if (on) {
    // FPS-style aim: lock the pointer so raw mouse deltas steer the camera.
    // If the lock is refused (mobile / denied), the pointer-position steering
    // in animate() takes over as the fallback.
    const el = renderer.domElement;
    if (el.requestPointerLock) {
      try {
        const p = el.requestPointerLock();
        if (p && p.catch) p.catch(syncFlyAim); // lock denied -> orbit-drag aim stays on
      } catch (e) { /* fall back */ }
    }
  } else if (document.pointerLockElement) {
    document.exitPointerLock();
  }
}
/* Full 360° mouse aim while flying: with the pointer locked, raw FPS deltas
   steer the view in every direction; if the lock is refused or lost (mobile /
   denied / Esc), normal orbit-drag rotates a full 360° instead of freezing. */
function syncFlyAim() {
  controls.enableRotate = !(autoFly && document.pointerLockElement === renderer.domElement);
}
document.addEventListener('pointerlockchange', syncFlyAim);
autoFlyBtn.addEventListener('click', () => { setAutoFly(!autoFly); if (autoFly) flight = null; });

/* FPS mouse aim while the pointer is locked: raw movement deltas rotate the
   camera around its own center (like a shooter) — full 360° pan in every
   direction, no pitch or yaw limits. */
const _aimDir = new THREE.Vector3();
document.addEventListener('mousemove', (e) => {
  if (!autoFly || document.pointerLockElement !== renderer.domElement) return;
  const sens = 0.0022;
  camera.rotateY(-e.movementX * sens);
  camera.rotateX(-e.movementY * sens);
  camera.getWorldDirection(_aimDir);
  const dist = controls.target.distanceTo(camera.position);
  controls.target.copy(camera.position).addScaledVector(_aimDir, dist);
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // typing in search / selects must not fly
  const k = e.key.toLowerCase();
  if (!e.repeat && k === 'f') { setAutoFly(!autoFly); if (autoFly) flight = null; return; } // F = enter/exit auto-fly
  keys[k] = true;
  if (autoFly && 'wasdqe'.includes(k)) setAutoFly(false); // manual keys take over
  if (!e.repeat) {
    const now = performance.now();
    if (k === 'w') { if (now - lastWTap < 320) setFlySpeed(flySpeed + 15); lastWTap = now; }
    else if (k === 's') { if (now - lastSTap < 320) setFlySpeed(flySpeed - 15); lastSTap = now; }
  }
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
// scrolling to zoom takes over from auto-fly (clicks/taps no longer kill it — the pointer steers)
renderer.domElement.addEventListener('wheel', () => setAutoFly(false), { passive: true });
renderer.domElement.addEventListener('pointercancel', () => { aimX = 0; aimY = 0; });

/* enable audio on first real gesture (incl. mobile touch) */
const unlock = () => { audio.ensure(); };
window.addEventListener('click', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });
window.addEventListener('touchstart', unlock, { once: true });
window.addEventListener('pointerdown', unlock, { once: true });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ---------- infinite void ----------
   Zoom or fly past the network and the view fades to the void, reappearing
   from the far side of the brain — the void loops, so you can't get lost in it. */
const voidFadeEl = document.getElementById('voidFade');
let wrapState = null; // null | 'out' | 'in'
let wrapHold = null;  // how long the out-of-view condition has persisted
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _boundTest = new THREE.Sphere();
function maybeWrap(dt) {
  const op = () => parseFloat(voidFadeEl.style.opacity || 0);
  if (!wrapState) {
    if (!brain || !brain.boundSphere) { wrapHold = null; return; }
    // the void loops only when the ENTIRE network (neurons + synapses) is out
    // of the view frustum, padded with extra room so you can zoom past a node
    // and pan around to face it from the other side before the loop kicks in
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    _boundTest.copy(brain.boundSphere);
    _boundTest.radius *= 1.45; // margin beyond the network's true extent
    const outside = !_frustum.intersectsSphere(_boundTest);
    // debounce: the condition must persist before arming the wrap
    if (!outside) { wrapHold = null; return; }
    wrapHold = (wrapHold || 0) + dt;
    if (wrapHold < 0.35) return;
    wrapHold = null;
    wrapState = 'out';
  }
  if (wrapState === 'out') {
    voidFadeEl.style.opacity = Math.min(1, op() + dt / 0.3);
    if (op() >= 1) {
      // emerge from the far side of the brain, comfortably framed:
      // distance is derived from the brain's bounding sphere + FOV so the
      // whole network is guaranteed inside the frustum after the loop-back
      // (a fixed distance re-armed the wrap instantly on large brains →
      // endless fade loop / blank void)
      const d = camera.position.clone().sub(controls.target).normalize();
      const r = (brain && brain.boundSphere) ? brain.boundSphere.radius : 60;
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      // must exceed the 1.45x test radius, or the wrap re-arms immediately
      const dist = (r * 1.6) / Math.sin(Math.min(vFov, hFov) / 2);
      camera.position.copy(controls.target).addScaledVector(d, -Math.max(60, dist));
      wrapState = 'in';
    }
  } else {
    voidFadeEl.style.opacity = Math.max(0, op() - dt / 0.3);
    if (op() <= 0) wrapState = null;
  }
}

/* ---------- main loop ---------- */
const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
const _sway = new THREE.Vector3(), _glowC = new THREE.Color(), _whiteC = new THREE.Color(0xffffff);

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (brain) {
    // pulses + beat-synced glow: every synapse pulses with the audio level
    // (louder / closer to the beat peak = stronger glow); oval pulses move
    // faster while audio is playing. Hover state overrides the per-frame glow.
    const lvl = typeof audio.level === 'function' ? audio.level() : 0;
    const pulseSpeed = lvl > 0.02 ? 1 + 2.5 * Math.min(1, lvl * 2) : 1;
    for (const eo of brain.edgeObjs) {
      // accumulate u per frame so the speed boost changes smoothly (no jumps)
      eo.u = ((eo.u === undefined ? eo.offset : eo.u) + eo.speed * dt * pulseSpeed) % 1;
      const u = (hashStr(eo.trackA.id + eo.trackB.id) & 1) === 0 ? 1 - eo.u : eo.u;
      if (eo.curve) {
        eo.pulse.position.copy(eo.curve.getPointAt(u));
        alignY(eo.pulse.quaternion, eo.curve.getTangentAt(u));
      } else {
        eo.pulse.position.lerpVectors(eo.a, eo.b, u);
      }
      eo.pulse.material.color.lerpColors(eo.colA, eo.colB, u).lerp(_whiteC, 0.55);
      if (eo.type === 'S') {
        // Sonic synapses throb rhythmically instead of gliding steadily
        const th = eo.pulseScale * (1 + 0.5 * Math.sin(t * 4.6 + eo.phase));
        eo.pulse.scale.set(th, eo.pulseLen, th);
      }
      // 'E'/'S' lines scroll their dash/dot pattern along the synapse
      if (eo.dashTex) {
        if (eo.texAxis === 'x') eo.dashTex.offset.x += eo.dashRate * dt;
        else eo.dashTex.offset.y += eo.dashRate * dt;
      }
      // glow pulse driven by the audio level (high-frequency synapses glow more)
      if (hoveredEdge !== eo) {
        const g = (eo.highFreq ? 0.72 : 0.88) + (eo.highFreq ? 1.55 : 1.1) * lvl;
        _glowC.copy(eo.baseColor).multiplyScalar(g);
        if (eo.highFreq) _glowC.lerp(_whiteC, 0.18);
        eo.mesh.material.color.copy(_glowC);
        eo.mesh.material.opacity = eo.baseOp * (0.85 + 0.15 * lvl);
      }
    }
    // newly committed synapses fade in out of the snapped dendrite wings
    for (const eo of brain.edgeObjs) {
      if (!eo.fadingIn) continue;
      const p = Math.min((t - eo.fadeT0) / 0.5, 1);
      eo.mesh.material.opacity = eo.baseOp * p;
      eo.pulse.material.opacity = 0.95 * p;
      if (p >= 1) eo.fadingIn = false;
    }
    // dissolved suggestion wings fade out, then are removed from the scene
    for (let i = wingDissolve.length - 1; i >= 0; i--) {
      const w = wingDissolve[i];
      const p = Math.min((t - w.t0) / 0.4, 1);
      w.s.mat.opacity = 0.9 * (1 - p);
      if (p >= 1) {
        brain.group.remove(w.s.wingA, w.s.wingB);
        w.s.wingA.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        w.s.wingB.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        w.s.mat.dispose();
        wingDissolve.splice(i, 1);
      }
    }
    // nearest 5 nodes to the camera show title cards
    const nodesArr = [...brain.nodeById.values()];
    nodesArr.sort((a, b) => a.position.distanceTo(camera.position) - b.position.distanceTo(camera.position));
    nodesArr.forEach((n, i) => { n.userData.label.visible = i < 5 || n === hoveredNode; });

    // dendrite wings: reach grows as the pair nears the mutual threshold
    for (const s of brain.suggestions) {
      if (approval && approval.s === s) continue; // driven by the approval sequence
      const reach = Math.max(0.18, s.ratio * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.6 + s.phase))));
      s.wingA.scale.x = reach;
      s.wingB.scale.x = reach;
      if (s.ratio >= 1) s.mat.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3.5 + s.phase));
    }

    // Create-Link sequence: slight repel -> snap together -> glow wave to both neurons
    if (approval) {
      const ap = approval;
      const u = Math.min((t - ap.t0) / APPROVAL_DUR, 1);
      const s = ap.s;
      let reach;
      if (u < 0.3) {
        reach = 1 - 0.28 * easeInOutSine(u / 0.3); // repel: tendrils recoil slightly
        s.mat.opacity = 0.8;
      } else if (u < 0.72) {
        reach = 0.72 + 0.28 * easeOutBack((u - 0.3) / 0.42); // snap together (slight overshoot)
        s.mat.opacity = 0.95;
        s.mat.color.set(0xffb3c4);
      } else {
        reach = 1;
        s.mat.opacity = 1;
      }
      s.wingA.scale.x = reach;
      s.wingB.scale.x = reach;

      if (u >= 0.72) {
        // one glow wave emanating from the midpoint out to each neuron
        const w = (u - 0.72) / 0.28;
        const e = 1 - Math.pow(1 - w, 3);
        const dirA = ap.mid.clone().sub(brain.nodeById.get(s.a).position);
        const dirB = ap.mid.clone().sub(brain.nodeById.get(s.b).position);
        const dA = dirA.length(), dB = dirB.length();
        dirA.normalize(); dirB.normalize();
        ap.waveA.position.copy(ap.mid).addScaledVector(dirA, -dA * e);
        ap.waveB.position.copy(ap.mid).addScaledVector(dirB, -dB * e);
        const scale = 2 + ap.gap * 0.9 * e;
        ap.waveA.scale.set(scale, scale, 1);
        ap.waveB.scale.set(scale, scale, 1);
        const fade = Math.min(w / 0.12, 1) * (1 - e);
        ap.waveA.material.opacity = 0.95 * fade;
        ap.waveB.material.opacity = 0.95 * fade;
      }

      if (u >= 1) {
        const pre = approval.preView;
        // dispose the snap glow waves
        brain.group.remove(ap.waveA, ap.waveB);
        for (const wv of [ap.waveA, ap.waveB]) {
          if (wv.material.map) wv.material.map.dispose();
          wv.material.dispose();
        }
        approval = null;
        commitConnection(s); // wings become the new synapse; camera stays on it
        lastPreView = pre || null; // offer a way back to where we were
        document.getElementById('returnView').classList.toggle('hidden', !lastPreView);
      }
    }
  }

  // camera flight (zoom to clicked node)
  if (flight) {
    camera.position.lerp(flight.camTo, 0.07);
    controls.target.lerp(flight.tgtTo, 0.07);
    if (camera.position.distanceTo(flight.camTo) < 0.2) flight = null;
  }

  // pathfinder preview: progress bar + camera follows the mix chain
  if (pf.previewing) {
    const el = audio.ctx ? audio.ctx.currentTime - pf.t0 : 9999;
    if (el >= pf.total || el < 0 || !audio.pathActive) { pfEndPreview(); }
    else {
      pfEl('pfBarFill').style.width = Math.min(100, (el / pf.total) * 100) + '%';
      while (pf.camIdx < pf.camPlan.length - 1 && pf.camPlan[pf.camIdx + 1].at <= el) pf.camIdx++;
      const c = pf.camPlan[pf.camIdx];
      if (c && c.pos) flyTo(c.pos, 30);
      const cur = pf.tracks ? pf.tracks[pf.camIdx] : null;
      const nxt = pf.tracks ? pf.tracks[pf.camIdx + 1] : null;
      if (cur) {
        pfEl('pfBarName').textContent = 'PATH PREVIEW  \u00b7  ' + (nxt ? cur.title + ' \u2192 ' + nxt.title : cur.title);
      }
    }
  }

  // auto-fly: propel forward. With the pointer locked, FPS mouse deltas
  // (mousemove handler) drive the aim; otherwise the pointer's position on
  // screen steers it (center = straight ahead).
  if (autoFly && !pf.previewing) {
    flight = null;
    if (document.pointerLockElement !== renderer.domElement) {
      if (aimX !== 0 || aimY !== 0) {
        const turn = 2.3 * dt;
        camera.rotateY(-aimX * turn);
        camera.rotateX(aimY * turn);
        const dist = controls.target.distanceTo(camera.position);
        camera.getWorldDirection(fwd);
        controls.target.copy(camera.position).addScaledVector(fwd, dist);
      }
    }
    const sp = flySpeed * dt;
    camera.getWorldDirection(fwd);
    camera.position.addScaledVector(fwd, sp);
    controls.target.addScaledVector(fwd, sp);
  }

  // fly
  if (!pf.previewing && (keys.w || keys.a || keys.s || keys.d || keys.q || keys.e)) {
    flight = null;
    const sp = (keys.shift ? flySpeed * 2.4 : flySpeed) * dt;
    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, camera.up).normalize();
    move.set(0, 0, 0);
    if (keys.w) move.add(fwd);
    if (keys.s) move.sub(fwd);
    if (keys.a) move.sub(right);
    if (keys.d) move.add(right);
    if (keys.q) move.y -= 1;
    if (keys.e) move.y += 1;
    move.normalize().multiplyScalar(sp);
    camera.position.add(move);
    controls.target.add(move);
  }

  controls.update();
  maybeWrap(dt);
  renderer.render(scene, camera);
}

rebuildBrain(brainName);
animate();
