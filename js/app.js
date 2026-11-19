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
  return new THREE.Color().lerpColors(new THREE.Color(0x2e5be0), new THREE.Color(0xff1f3d), t);
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
      if (shared >= 1) out.push({ a: A, b: B, score: shared });
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
function roundRectPath(x, px, py, w, h, r) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

function makeLabel(track) {
  const c = document.createElement('canvas');
  c.width = 768; c.height = 224;
  const x = c.getContext('2d');
  x.textAlign = 'center';
  let fs = 58;
  x.font = `700 ${fs}px system-ui, sans-serif`;
  while (x.measureText(track.title).width > 700 && fs > 30) { fs -= 2; x.font = `700 ${fs}px system-ui, sans-serif`; }
  const as = Math.max(26, Math.round(fs * 0.62));
  // slightly opaque plate behind the text
  x.fillStyle = 'rgba(10, 10, 18, 0.55)';
  roundRectPath(x, 14, 14, 740, 196, 26); x.fill();
  x.strokeStyle = 'rgba(255,255,255,0.14)';
  x.lineWidth = 3;
  roundRectPath(x, 14, 14, 740, 196, 26); x.stroke();
  x.font = `700 ${fs}px system-ui, sans-serif`;
  x.fillStyle = '#ffffff';
  x.fillText(track.title, 384, 96);
  x.font = `400 ${as}px system-ui, sans-serif`;
  x.fillStyle = 'rgba(255,255,255,0.62)';
  x.fillText(track.artist, 384, 170);
  const tex = new THREE.CanvasTexture(c);
  // depthTest off + high renderOrder: the title card always renders on top of
  // any synapse passing in front, so it never gets visually blocked
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0.96 }));
  spr.scale.set(18.5, 5.4, 1);
  spr.renderOrder = 999;
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
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.72, 'rgba(255,255,255,1)');
  g.addColorStop(0.88, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function buildNode(track, sOut) {
  const group = new THREE.Group();
  const col = keyColor(track.camelot);

  // defined outer outline — thin muted grey (low energy) to thick bright white (high energy)
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

  // key-colored glow disc, inset inside the ring with a visible gap
  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeCoreTexture(),
    color: col,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  core.scale.setScalar(sOut * 0.62);
  group.add(core);

  const label = makeLabel(track);
  label.position.y = sOut / 2 + 2.4;
  label.visible = false;
  group.add(label);

  group.userData = { kind: 'node', track, ring, core, label, baseRingColor: ring.material.color.clone(), radius: sOut / 2 };
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

function buildEdge(edge, posA, posB, radA, radB, trackA, trackB) {
  const t = (edge.freq - 5) / 95;
  const r = 0.13 + t * 0.5;
  const baseColor = edgeColor(edge.freq);
  const mat = new THREE.MeshBasicMaterial({ color: baseColor.clone(), transparent: true, opacity: 0.55 + t * 0.45 });
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

  // flared dendrite-bout sockets where the synapse meets each node
  const flareR = r * 2.3;
  const flareLen = Math.max(len * (edgeStyle === 'neural' ? 0.2 : 0.16), 2.2);
  for (const [pt, dir] of [[a, d], [b, d.clone().negate()]]) {
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.15, flareR, flareLen, 12, 1, true), mat);
    cone.position.copy(pt).addScaledVector(dir, flareLen / 2);
    cone.quaternion.setFromUnitVectors(UP, dir);
    cone.userData = { kind: 'edge', edge };
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(flareR * 0.7, 14, 12), mat);
    bulb.position.copy(pt).addScaledVector(dir, flareR * 0.3);
    bulb.userData = { kind: 'edge', edge };
    extra.push(cone, bulb);
  }
  extra.forEach(o => { if (!o.userData.basePos) o.userData.basePos = o.position.clone(); });

  // sway axes (perpendicular to the synapse) for the music wiggle
  const ref = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const side1 = new THREE.Vector3().crossVectors(d, ref).normalize();
  const side2 = new THREE.Vector3().crossVectors(d, side1).normalize();

  // traveling light pulse: symmetric 3D oval, energy-colored A -> B
  const pulse = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(0.16, r * 1.9), 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  pulse.scale.set(1, 2.3, 1);
  if (!curve) alignY(pulse.quaternion, d);

  return {
    mesh, pulse, a, b, baseColor,
    speed: 0.06 + t * 0.3, offset: (hashStr(edge.a + edge.b) % 100) / 100,
    highFreq: edge.freq >= 70, curve, extra,
    swayMeshes: extra, // tube branches + end flares: everything that sways with the synapse
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
  const e = { a: s.a, b: s.b, freq: 60 };
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
  const genres = [...new Set(tracks.map(t => t.genre))].sort();
  const R = genres.length > 1 ? 40 : 0;
  const pos = new Map();
  genres.forEach((genre, gi) => {
    const ang = (gi / genres.length) * Math.PI * 2;
    const cx = Math.cos(ang) * R, cz = Math.sin(ang) * R;
    const members = tracks.filter(t => t.genre === genre).sort((a, b) => a.energy - b.energy);
    members.forEach((t, i) => {
      const rng = mulberry32(hashStr(t.id) ^ 7);
      const y = (t.energy - 5.5) * 9.0;
      const rr = 4.0 + rng() * 4.0;
      const aa = rng() * Math.PI * 2;
      pos.set(t.id, new THREE.Vector3(cx + Math.cos(aa) * rr, y, cz + Math.sin(aa) * rr));
    });
  });
  return pos;
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
  const pos = (mode === 'free')
    ? forceLayout(tracks, edges)
    : clusterLayout(tracks);

  const trackById = new Map(tracks.map(t => [t.id, t]));
  // node size = connection count (degree); ring still encodes energy
  const degree = new Map(tracks.map(t => [t.id, 0]));
  for (const e of edges) {
    if (degree.has(e.a)) degree.set(e.a, degree.get(e.a) + 1);
    if (degree.has(e.b)) degree.set(e.b, degree.get(e.b) + 1);
  }
  const sizes = new Map(tracks.map(t => [t.id, 6.0 + Math.min(degree.get(t.id), 12) * 0.7]));

  const nodeById = new Map();
  for (const t of tracks) {
    const node = buildNode(t, sizes.get(t.id));
    node.position.copy(pos.get(t.id));
    node.userData.track = t;
    group.add(node);
    nodeById.set(t.id, node);
  }
  const edgeObjs = [];
  for (const e of edges) {
    const eo = buildEdge(e, pos.get(e.a), pos.get(e.b), sizes.get(e.a) / 2, sizes.get(e.b) / 2, trackById.get(e.a), trackById.get(e.b));
    group.add(eo.mesh);
    group.add(eo.pulse);
    eo.extra.forEach(o => group.add(o));
    edgeObjs.push(eo);
  }

  // dendrite wings reaching toward the mutual-connection threshold
  const suggestions = computeSuggestions(tracks, edges)
    .filter(s => !dismissedPairs.has(pairKey(s.a, s.b)))
    .map(s => buildSuggestion(s, pos, sizes, group));

  scene.add(group);
  brain = { tracks, edges, group, nodeById, edgeObjs, trackById, suggestions };
  // bounding sphere of the whole network (neurons + synapses) — used by the
  // infinite-void loop to test whether everything is out of view
  brain.boundSphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());

  controls.target.set(0, 0, 0);
  if (mode === 'free') camera.position.set(0, 10, 95);
  else camera.position.set(0, 4, 78);

  renderTrackList(); // keep the track list in sync with the active brain
  showPromptIfNeeded();
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
    .map(e => ({ other: e.a === track.id ? e.b : e.a, freq: e.freq }))
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
    row.innerHTML =
      `<div class="info"><div class="t">${other.title}</div><div class="a">${other.artist} &middot; ${other.camelot}</div></div>` +
      `<div class="f">${n.freq}%</div>` +
      `<button class="qplay" data-id="${other.id}">▶ QUICK-PLAY</button>`;
    row.querySelector('.qplay').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;
      audio.playTransition(track, other, { seconds: 16, mixBeats: 8 });
      cascade.querySelectorAll('.qplay').forEach(b => b.classList.remove('playing'));
      btn.classList.add('playing');
      updateNowPlaying(track, other, 'quick');
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
      trackPanel.classList.add('hidden');
      tSearchEl.blur();
      closeModal();
      focusNode(t); // fly there + play; click the node again to open its card
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
  trackPanel.classList.add('hidden');
  tSearchEl.blur();
  closeModal();
  focusNode(m);
}
tSearchEl.addEventListener('input', () => renderTrackList(tSearchEl.value));
tSearchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') flyToSearchResult();
  else if (e.key === 'Escape') { trackPanel.classList.add('hidden'); tSearchEl.blur(); }
  e.stopPropagation(); // typing must not drive the camera
});
document.getElementById('trackToggle').addEventListener('click', () => {
  trackPanel.classList.toggle('hidden');
  if (!trackPanel.classList.contains('hidden')) {
    tSearchEl.value = '';
    renderTrackList();
  }
});
document.getElementById('tClose').addEventListener('click', () => trackPanel.classList.add('hidden'));

/* "/" hotkey: open the track panel and jump to search from anywhere */
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === '/') {
    e.preventDefault();
    trackPanel.classList.remove('hidden');
    renderTrackList();
    tSearchEl.focus();
  }
});

/* collapsible HUD: clicking the header hides the options, showing only the title */
const hudEl = document.getElementById('hud');
const hudToggleEl = document.getElementById('hudToggle');
document.getElementById('hudHead').addEventListener('click', () => {
  hudEl.classList.toggle('collapsed');
  hudToggleEl.innerHTML = hudEl.classList.contains('collapsed') ? '&#9656;' : '&#9662;';
});

/* ---------- UI wiring ---------- */
const brainSel = document.getElementById('brainSel');
brainSel.innerHTML = '<option>Master Brain</option>' +
  Object.keys(DATA.playlists).map(p => `<option>${p}</option>`).join('');
brainSel.addEventListener('change', () => { brainName = brainSel.value; rebuildBrain(brainName); });

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
let flySpeed = 25; // units/sec; Shift boosts
let lastWTap = 0, lastSTap = 0;
const flySpeedEl = document.getElementById('flySpeed');
const flySpeedVal = document.getElementById('flySpeedVal');
function setFlySpeed(v) {
  flySpeed = Math.round(Math.min(80, Math.max(5, v)));
  flySpeedEl.value = flySpeed;
  flySpeedVal.textContent = flySpeed;
}
flySpeedEl.addEventListener('input', () => setFlySpeed(+flySpeedEl.value));

/* auto-fly: forward propulsion; pointer position steers the aim */
let autoFly = false;
const autoFlyBtn = document.getElementById('autoFly');
const crosshairEl = document.getElementById('crosshair');
function setAutoFly(on) {
  autoFly = on;
  autoFlyBtn.classList.toggle('active', autoFly);
  autoFlyBtn.innerHTML = autoFly ? '&#9632; Stop Fly' : '&#9654; Auto-Fly';
  crosshairEl.classList.toggle('active', autoFly);
  renderer.domElement.style.cursor = autoFly ? 'none' : 'default';
  controls.enableRotate = !autoFly; // aim is driven by pointer position, not orbit-drag
}
autoFlyBtn.addEventListener('click', () => { setAutoFly(!autoFly); if (autoFly) flight = null; });

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // typing in search / selects must not fly
  const k = e.key.toLowerCase();
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
      eo.pulse.material.color.lerpColors(eo.colA, eo.colB, u);
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

  // keep the open modal floating over its node
  if (modalTrack && brain) {
    const node = brain.nodeById.get(modalTrack.id);
    if (node) {
      const v = node.position.clone().project(camera);
      const x = (v.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      const el = document.getElementById('modalWrap');
      const w = el.offsetWidth || 440, h = el.offsetHeight || 300;
      el.style.left = Math.min(Math.max(x, w / 2 + 10), window.innerWidth - w / 2 - 10) + 'px';
      el.style.top = Math.min(Math.max(y, h / 2 + 10), window.innerHeight - h / 2 - 10) + 'px';
    }
  }

  // auto-fly: propel forward; pointer position steers aim (center = straight ahead)
  if (autoFly && !pf.previewing) {
    flight = null;
    if (aimX !== 0 || aimY !== 0) {
      const turn = 2.3 * dt;
      camera.rotateY(-aimX * turn);
      camera.rotateX(aimY * turn);
      const dist = controls.target.distanceTo(camera.position);
      camera.getWorldDirection(fwd);
      controls.target.copy(camera.position).addScaledVector(fwd, dist);
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
