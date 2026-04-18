import * as THREE from 'three/webgpu';
import {
  uv,
  vec2,
  vec4,
  vec3,
  texture,
  float,
  uniform,
  attribute,
  step,
  pass,
  positionView,
  normalView,
  oneMinus,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import Stats from 'three/addons/libs/stats.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MathUtils } from 'three';
import gsap from 'gsap';
import { computeFaces, triangulateFace, pointInPolygon } from './shatter.js';
import { playCrack, startGamma, setGammaVolume } from './sfx.js';
import { createTunnel, waitForTunnelFont } from './tunnel.js';

const source = document.getElementById('source');
const stage = document.getElementById('stage');
const divider = document.getElementById('divider');
const warning = document.getElementById('warning');
const nativePage = document.getElementById('native-page');
const page = nativePage.cloneNode(true);
page.id = 'canvas-page';
source.appendChild(page);
const ctx2d = source.getContext('2d');

if (typeof ctx2d.drawElementImage !== 'function') {
  warning.hidden = false;
  source.style.display = 'none';
  stage.style.display = 'none';
  throw new Error('drawElementImage not available — enable chrome://flags/#canvas-draw-element');
}

const scene = new THREE.Scene();
const FOV = 60;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 200);
camera.position.set(0, 0, 1 / Math.tan(((FOV / 2) * Math.PI) / 180));
camera.lookAt(0, 0, 0);

scene.fog = new THREE.Fog(0x000000, 8, 60);

const sceneRoot = new THREE.Group();
scene.add(sceneRoot);

const timer = new THREE.Timer();
const tunnelScene = new THREE.Scene();
let tunnelApi = null;

// Feedback/decay setup — render tunnel to this RT each frame, with a decay
// quad that fades the prior frame for trailing effect.
const rtOpts = {
  type: THREE.HalfFloatType,
  magFilter: THREE.LinearFilter,
  minFilter: THREE.LinearFilter,
  colorSpace: THREE.LinearSRGBColorSpace,
  depthBuffer: false,
  stencilBuffer: false,
};
const feedbackRT = new THREE.RenderTarget(1, 1, rtOpts);
// foreground RT for shards — needs depth buffer, alpha-cleared each frame
const fgRT = new THREE.RenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  magFilter: THREE.LinearFilter,
  minFilter: THREE.LinearFilter,
  colorSpace: THREE.LinearSRGBColorSpace,
});
const decayScene = new THREE.Scene();
const decayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const decayAlphaU = uniform(0.26);
const crackColorU = uniform(1.0);
const crackOpacityU = uniform(0.1);
const decayMat = new THREE.MeshBasicNodeMaterial({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
decayMat.colorNode = vec4(float(0), float(0), float(0), decayAlphaU);
const decayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), decayMat);
decayQuad.frustumCulled = false;
decayScene.add(decayQuad);

// display scene: fullscreen quad sampling feedbackRT, fed into bloom pass.
const displayScene = new THREE.Scene();
const displayMat = new THREE.MeshBasicNodeMaterial({
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
displayMat.colorNode = texture(feedbackRT.texture, uv());
const displayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), displayMat);
displayQuad.frustumCulled = false;
displayScene.add(displayQuad);

waitForTunnelFont().then(() => {
  tunnelApi = createTunnel({ aspect: window.innerWidth / window.innerHeight });
  tunnelScene.add(tunnelApi.group);
});

let htmlTexture = null;
let mesh = null;

function createPipeline() {
  if (mesh) {
    sceneRoot.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  if (htmlTexture) htmlTexture.dispose();

  htmlTexture = new THREE.CanvasTexture(source);
  htmlTexture.colorSpace = THREE.SRGBColorSpace;
  htmlTexture.minFilter = THREE.LinearFilter;
  htmlTexture.magFilter = THREE.LinearFilter;

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = texture(htmlTexture, uv());

  mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  sceneRoot.add(mesh);
}

createPipeline();

const renderer = new THREE.WebGPURenderer({ canvas: stage, antialias: true });
await renderer.init();
renderer.setClearColor(0x000000, 1);

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
scene.environmentIntensity = 0;

new HDRLoader().load('/studio_kominka_01_1k.hdr', (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  hdr.dispose();
});

const controls = new OrbitControls(camera, stage);
controls.enabled = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.update();

let lastContentH = 0;
let paintScheduled = false;

function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => {
    paintScheduled = false;
    paint();
  });
}

const devMode = new URLSearchParams(window.location.search).has('dev');
const debug = document.getElementById('debug');
if (!devMode) debug.style.display = 'none';

function findShardAt(p, excludeShard) {
  for (const m of shardMeshes) {
    if (m === excludeShard) continue;
    if (pointInPolygon(p, m.userData.polygon)) return m;
  }
  return null;
}

function addSegToShard(map, shardMesh, seg) {
  let arr = map.get(shardMesh);
  if (!arr) {
    arr = [];
    map.set(shardMesh, arr);
  }
  arr.push(seg);
}

function walkBranch(x, y, angle, startShard, segsByShard, allSegs, steps, depth) {
  if (depth > 3) return;
  let cx = x,
    cy = y,
    ca = angle;
  let currentShard = startShard;
  for (let i = 0; i < steps; i++) {
    ca += MathUtils.randFloatSpread(1.3);
    const nx = cx + Math.cos(ca) * 60;
    const ny = cy + Math.sin(ca) * 60;
    const np = { x: nx, y: ny };
    const seg = [cx, cy, nx, ny, depth];
    allSegs.push(seg);
    if (currentShard) {
      addSegToShard(segsByShard, currentShard, seg);
      if (!pointInPolygon(np, currentShard.userData.polygon)) {
        const nextShard = findShardAt(np, currentShard);
        if (nextShard) {
          addSegToShard(segsByShard, nextShard, seg);
        }
        currentShard = nextShard;
      }
    }
    cx = nx;
    cy = ny;
    if (Math.random() < 0.18 * Math.pow(0.6, depth)) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const ba = ca + side * (Math.PI / 3 + MathUtils.randFloatSpread(0.4));
      walkBranch(
        cx,
        cy,
        ba,
        currentShard,
        segsByShard,
        allSegs,
        Math.floor(steps * 0.7),
        depth + 1,
      );
    }
  }
}

function walkMainCrack(x, y, angle, startShard, segsByShard, allSegs) {
  let cx = x,
    cy = y,
    ca = angle;
  let currentShard = startShard;
  let safety = 0;
  while (safety++ < 200) {
    if (!currentShard) return;
    ca += MathUtils.randFloatSpread(0.3);
    const nx = cx + Math.cos(ca) * 60;
    const ny = cy + Math.sin(ca) * 60;
    const np = { x: nx, y: ny };
    const seg = [cx, cy, nx, ny, 0];
    allSegs.push(seg);
    addSegToShard(segsByShard, currentShard, seg);
    if (!pointInPolygon(np, currentShard.userData.polygon)) {
      const nextShard = findShardAt(np, currentShard);
      if (nextShard) {
        addSegToShard(segsByShard, nextShard, seg);
      }
      currentShard = nextShard;
    }
    cx = nx;
    cy = ny;
    if (Math.random() < 0.22) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const ba = ca + side * (Math.PI / 3 + MathUtils.randFloatSpread(0.4));
      walkBranch(cx, cy, ba, currentShard, segsByShard, allSegs, 3, 1);
    }
  }
}

function propagateCracks(x, y, startShard) {
  const segsByShard = new Map();
  const allSegs = [];
  const mainAngle = Math.random() * Math.PI;
  walkMainCrack(x, y, mainAngle, startShard, segsByShard, allSegs);
  walkMainCrack(x, y, mainAngle + Math.PI, startShard, segsByShard, allSegs);
  return { segsByShard, allSegs };
}

function computeTipInfo(segs) {
  const tol = 0.5;
  const keyFn = (x, y) => `${Math.round(x / tol)},${Math.round(y / tol)}`;
  const counts = new Map();
  for (const seg of segs) {
    const k0 = keyFn(seg[0], seg[1]);
    const k1 = keyFn(seg[2], seg[3]);
    counts.set(k0, (counts.get(k0) || 0) + 1);
    counts.set(k1, (counts.get(k1) || 0) + 1);
  }
  const tips = new Set();
  for (const [k, c] of counts) if (c === 1) tips.add(k);
  return { tips, keyFn };
}

let paintCount = 0;
let lastPaintErr = '';
function paint() {
  paintCount++;
  try {
    ctx2d.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx2d.drawElementImage(page, 0, 0);
    htmlTexture.needsUpdate = true;
    const contentH = page.offsetHeight;
    if (contentH > 0 && contentH !== lastContentH) {
      document.body.style.minHeight = contentH + 'px';
      lastContentH = contentH;
    }
    const vh = window.innerHeight;
    const docH = Math.max(vh, nativePage.offsetHeight);
    const ratio = docH / vh;
    sceneRoot.position.y = 1 - ratio + (2 * window.scrollY) / vh;
    updateShardScroll();
  } catch (err) {
    lastPaintErr = String(err && err.message ? err.message : err);
    schedulePaint();
  }
  debug.textContent =
    `vp    ${window.innerWidth}x${window.innerHeight}  dpr ${window.devicePixelRatio}\n` +
    `src   attr ${source.width}x${source.height}  css h ${source.offsetHeight}\n` +
    `clone ${page.offsetWidth}x${page.offsetHeight}\n` +
    `live  ${nativePage.offsetWidth}x${nativePage.offsetHeight}\n` +
    `scroll ${Math.round(window.scrollY)}/${document.body.scrollHeight - window.innerHeight}\n` +
    `paint ${paintCount}  err ${lastPaintErr || '-'}`;
}

let split = devMode ? 0.9 : 1.0;
let htmlSplit = devMode ? 0.95 : 1.0;
const dividerHtml = document.getElementById('divider-html');
if (!devMode) {
  divider.style.display = 'none';
  dividerHtml.style.display = 'none';
}

function applySplit() {
  divider.style.left = split * 100 + 'vw';
  stage.style.clipPath = `inset(0 ${(1 - split) * 100}% 0 0)`;
  dividerHtml.style.left = htmlSplit * 100 + 'vw';
  // Source spans [0, htmlSplit] — stage occludes [0, split] visually, but
  // pointer-events pass through stage so hovers/selection reach source.
  source.style.clipPath = `inset(0 ${(1 - htmlSplit) * 100}% 0 0)`;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const docH = Math.max(h, nativePage.offsetHeight);
  const srcDpr = Math.min(window.devicePixelRatio, 2);
  source.width = Math.floor(w * srcDpr);
  source.height = Math.floor(docH * srcDpr);
  source.style.width = w + 'px';
  source.style.height = docH + 'px';
  createPipeline();
  renderer.setPixelRatio(srcDpr);
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  const ratio = docH / h;
  sceneRoot.scale.set(aspect, ratio, 1);
  if (tunnelApi) tunnelApi.updateAspect(aspect);
  const dpr = Math.min(window.devicePixelRatio, 2);
  const rw = Math.max(1, Math.floor(w * dpr));
  const rh = Math.max(1, Math.floor(h * dpr));
  feedbackRT.setSize(rw, rh);
  fgRT.setSize(rw, rh);
  applySplit();
  paint();
}

divider.addEventListener('pointerdown', (e) => {
  divider.classList.add('dragging');
  divider.setPointerCapture(e.pointerId);
  e.preventDefault();
});
divider.addEventListener('pointermove', (e) => {
  if (!divider.hasPointerCapture(e.pointerId)) return;
  split = Math.max(0.0, Math.min(1.0, e.clientX / window.innerWidth));
  applySplit();
});
divider.addEventListener('pointerup', (e) => {
  divider.classList.remove('dragging');
  divider.releasePointerCapture(e.pointerId);
});

dividerHtml.addEventListener('pointerdown', (e) => {
  dividerHtml.classList.add('dragging');
  dividerHtml.setPointerCapture(e.pointerId);
  e.preventDefault();
});
dividerHtml.addEventListener('pointermove', (e) => {
  if (!dividerHtml.hasPointerCapture(e.pointerId)) return;
  htmlSplit = Math.max(0.0, Math.min(1.0, e.clientX / window.innerWidth));
  applySplit();
});
dividerHtml.addEventListener('pointerup', (e) => {
  dividerHtml.classList.remove('dragging');
  dividerHtml.releasePointerCapture(e.pointerId);
});

source.onpaint = schedulePaint;

const themeToggle = document.getElementById('theme-toggle');
const themeToggleHit = document.getElementById('theme-toggle-hit');
function syncThemeHit() {
  const r = themeToggle.getBoundingClientRect();
  themeToggleHit.style.left = r.left + 'px';
  themeToggleHit.style.top = r.top + 'px';
  themeToggleHit.style.width = r.width + 'px';
  themeToggleHit.style.height = r.height + 'px';
}
syncThemeHit();
window.addEventListener('resize', syncThemeHit);
window.addEventListener('scroll', syncThemeHit, { passive: true });
themeToggleHit.addEventListener('click', (e) => {
  e.stopPropagation();
  themeToggle.click();
});
themeToggle.addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const nextLight = !isLight;
  document.documentElement.setAttribute('data-theme', nextLight ? 'light' : 'dark');
  themeToggle.textContent = nextLight ? '☀' : '☾';
  crackColorU.value = nextLight ? 0.0 : 1.0;
  crackOpacityU.value = nextLight ? 0.2 : 0.1;
  schedulePaint();
});
window.addEventListener('resize', resize);
window.addEventListener('scroll', schedulePaint, { passive: true });
new ResizeObserver(schedulePaint).observe(page);

window.addEventListener('click', (e) => {
  if (controls.enabled) return;
  if (e.target.closest('#divider')) return;
  if (e.target.closest('#divider-html')) return;
  if (e.target.closest('#theme-toggle')) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  const x = e.clientX * dpr;
  const y = (e.clientY + window.scrollY) * dpr;
  if (shardMeshes.length === 0 && rootRect === null) {
    initializeRootShard();
    if (mesh) mesh.visible = false;
  }
  const hit = hitShard(x, y);
  if (!hit) return;
  playCrack();
  startGamma();
  const { segsByShard, allSegs } = propagateCracks(x, y, hit);
  const tipInfo = computeTipInfo(allSegs);
  for (const seg of allSegs) {
    const [x0, y0, x1, y1, depth] = seg;
    const baseW = widthForDepth(depth);
    seg[5] = tipInfo.tips.has(tipInfo.keyFn(x0, y0)) ? 0 : baseW;
    seg[6] = tipInfo.tips.has(tipInfo.keyFn(x1, y1)) ? 0 : baseW;
  }
  const clickPoint = { x, y };
  let maxDist = 1;
  for (const seg of allSegs) {
    const d0 = Math.hypot(seg[0] - x, seg[1] - y);
    const d1 = Math.hypot(seg[2] - x, seg[3] - y);
    if (d0 > maxDist) maxDist = d0;
    if (d1 > maxDist) maxDist = d1;
  }
  const newMeshes = [];
  for (const [shard, segs] of segsByShard) {
    const created = fractureShardWithCracks(shard, segs, clickPoint, maxDist);
    newMeshes.push(...created);
  }
  const screenArea = source.width * source.height;
  const frac = screenArea > 0 ? droppedArea / screenArea : 0;
  setGammaVolume(Math.min(1, frac));
  for (const m of newMeshes) {
    const prog = m.userData.lineProgress;
    if (!prog) continue;
    prog.value = 0;
    const tracker = { v: 0 };
    gsap.to(tracker, {
      v: 1,
      duration: GROW_DURATION,
      ease: 'power2.out',
      onUpdate() {
        prog.value = tracker.v;
      },
    });
  }
  schedulePaint();
});

let shardMeshes = [];
let exploded = false;
let rootRect = null;
let shardHueCounter = 0;

resize();

const stats = new Stats();
stats.dom.style.position = 'fixed';
stats.dom.style.bottom = '8px';
stats.dom.style.left = '8px';
stats.dom.style.top = 'auto';
stats.dom.style.right = 'auto';
stats.dom.style.zIndex = '100';
stats.dom.style.pointerEvents = 'none';
if (devMode) document.body.appendChild(stats.dom);


// Fresnel rim light — shared across all shard materials
const rimStrengthU = uniform(0.8);
const RIM_COLOR = new THREE.Color(0, 1, 0.4);
const rimFactor = oneMinus(normalView.dot(positionView.normalize().negate()).abs()).pow(3);
const rimR = float(RIM_COLOR.r).mul(rimFactor).mul(rimStrengthU);
const rimG = float(RIM_COLOR.g).mul(rimFactor).mul(rimStrengthU);
const rimB = float(RIM_COLOR.b).mul(rimFactor).mul(rimStrengthU);

const pageBgColor = new THREE.Color(getComputedStyle(page).backgroundColor);
const pageBgLum = pageBgColor.r * 0.299 + pageBgColor.g * 0.587 + pageBgColor.b * 0.114;

function updateShardScroll() {
  // sceneRoot scrolls via position.y, so shards don't need per-frame compensation.
}

function buildExtrudedShardGeometry(flatPositions, flatUvs, topTriIndices, depthNdc) {
  const n = flatPositions.length / 3;
  const topZ = 0;
  const botZ = -depthNdc;

  const totalV = 2 * n + 4 * n;
  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = [];

  // top (0..n-1)
  for (let i = 0; i < n; i++) {
    positions[i * 3 + 0] = flatPositions[i * 3 + 0];
    positions[i * 3 + 1] = flatPositions[i * 3 + 1];
    positions[i * 3 + 2] = topZ;
    normals[i * 3 + 0] = 0;
    normals[i * 3 + 1] = 0;
    normals[i * 3 + 2] = 1;
    uvs[i * 2 + 0] = flatUvs[i * 2 + 0];
    uvs[i * 2 + 1] = flatUvs[i * 2 + 1];
  }
  // bottom (n..2n-1) — same xy, -z, -normal
  for (let i = 0; i < n; i++) {
    const o = n + i;
    positions[o * 3 + 0] = flatPositions[i * 3 + 0];
    positions[o * 3 + 1] = flatPositions[i * 3 + 1];
    positions[o * 3 + 2] = botZ;
    normals[o * 3 + 0] = 0;
    normals[o * 3 + 1] = 0;
    normals[o * 3 + 2] = -1;
    uvs[o * 2 + 0] = flatUvs[i * 2 + 0];
    uvs[o * 2 + 1] = flatUvs[i * 2 + 1];
  }

  // top triangles (reversed winding so +Z face is front-facing correctly)
  for (let i = 0; i < topTriIndices.length; i += 3) {
    indices.push(topTriIndices[i + 0], topTriIndices[i + 2], topTriIndices[i + 1]);
  }
  // bottom triangles (direct, offset by n)
  for (let i = 0; i < topTriIndices.length; i++) {
    indices.push(topTriIndices[i] + n);
  }
  const topBotCount = indices.length;

  // side walls: 4 unique verts per edge for flat shading
  const sideBase = 2 * n;
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    const ax = flatPositions[i * 3 + 0];
    const ay = flatPositions[i * 3 + 1];
    const bx = flatPositions[ni * 3 + 0];
    const by = flatPositions[ni * 3 + 1];
    const ex = bx - ax;
    const ey = by - ay;
    // outward normal for CCW polygon (right-hand of edge direction)
    const len = Math.hypot(ex, ey) || 1;
    const nx = ey / len;
    const ny = -ex / len;

    const v0 = sideBase + i * 4 + 0; // top-i
    const v1 = sideBase + i * 4 + 1; // top-ni
    const v2 = sideBase + i * 4 + 2; // bot-ni
    const v3 = sideBase + i * 4 + 3; // bot-i

    positions[v0 * 3 + 0] = ax;
    positions[v0 * 3 + 1] = ay;
    positions[v0 * 3 + 2] = topZ;
    positions[v1 * 3 + 0] = bx;
    positions[v1 * 3 + 1] = by;
    positions[v1 * 3 + 2] = topZ;
    positions[v2 * 3 + 0] = bx;
    positions[v2 * 3 + 1] = by;
    positions[v2 * 3 + 2] = botZ;
    positions[v3 * 3 + 0] = ax;
    positions[v3 * 3 + 1] = ay;
    positions[v3 * 3 + 2] = botZ;

    for (const v of [v0, v1, v2, v3]) {
      normals[v * 3 + 0] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = 0;
    }

    uvs[v0 * 2 + 0] = 0;
    uvs[v0 * 2 + 1] = 0;
    uvs[v1 * 2 + 0] = 1;
    uvs[v1 * 2 + 1] = 0;
    uvs[v2 * 2 + 0] = 1;
    uvs[v2 * 2 + 1] = 1;
    uvs[v3 * 2 + 0] = 0;
    uvs[v3 * 2 + 1] = 1;

    indices.push(v0, v2, v1);
    indices.push(v0, v3, v2);
  }
  const sideCount = indices.length - topBotCount;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.addGroup(0, topBotCount, 0);
  geom.addGroup(topBotCount, sideCount, 1);
  return geom;
}

const GROW_FROM_EDGE_PROB = 0.5;

function createShardMesh(
  polygon,
  buildScrollY,
  newDanglings = [],
  inheritedDanglings = [],
  clickPoint = null,
  maxDist = 1,
  parentPolygon = null,
) {
  // either use click point (default wave) or a random shard vertex as anchor
  let anchor = clickPoint;
  let anchorMax = maxDist;
  if (clickPoint && Math.random() < GROW_FROM_EDGE_PROB && polygon.length > 0) {
    anchor = polygon[Math.floor(Math.random() * polygon.length)];
    let m = 1;
    for (const v of polygon) {
      m = Math.max(m, Math.hypot(v.x - anchor.x, v.y - anchor.y));
    }
    anchorMax = m;
  }
  const face = [...polygon].reverse();
  if (face.length < 3) return null;
  const indices = triangulateFace(face);
  if (indices.length === 0) return null;

  const w = source.width;
  const h = source.height;

  let cxSum = 0,
    cySum = 0;
  const positions = new Float32Array(face.length * 3);
  const uvs = new Float32Array(face.length * 2);
  for (let i = 0; i < face.length; i++) {
    positions[i * 3 + 0] = (face[i].x / w) * 2 - 1;
    positions[i * 3 + 1] = 1 - ((face[i].y - buildScrollY) / h) * 2;
    positions[i * 3 + 2] = 0;
    uvs[i * 2 + 0] = face[i].x / w;
    uvs[i * 2 + 1] = 1 - (face[i].y - buildScrollY) / h;
    cxSum += positions[i * 3 + 0];
    cySum += positions[i * 3 + 1];
  }
  const centroidX = cxSum / face.length;
  const centroidY = cySum / face.length;

  for (let i = 0; i < face.length; i++) {
    positions[i * 3 + 0] -= centroidX;
    positions[i * 3 + 1] -= centroidY;
  }

  const depthNdc = (30 / h) * 2;
  const geom = buildExtrudedShardGeometry(positions, uvs, indices, depthNdc);

  const HUE_MIX = 0; // set to 0.05 to re-enable per-shard tint
  const hue = (shardHueCounter++ * 137.5) % 360;
  const c = HUE_MIX > 0 ? new THREE.Color().setHSL(hue / 360, 1.0, 0.6) : new THREE.Color(0, 0, 0);

  const opacityU = uniform(1);
  const topMat = new THREE.MeshStandardNodeMaterial({
    metalness: 0,
    roughness: 0.1,
    transparent: true,
  });
  topMat.color = new THREE.Color(0, 0, 0);
  topMat.opacityNode = opacityU;
  const tex = texture(htmlTexture, uv());
  const texKeep = 1 - HUE_MIX;
  topMat.emissiveNode = vec4(
    tex.r.mul(texKeep).add(c.r * HUE_MIX),
    tex.g.mul(texKeep).add(c.g * HUE_MIX),
    tex.b.mul(texKeep).add(c.b * HUE_MIX),
    1,
  );

  const sideMat = new THREE.MeshStandardNodeMaterial({
    metalness: 0,
    roughness: 0.1,
    transparent: true,
  });
  sideMat.color = new THREE.Color(0, 0, 0);
  sideMat.opacityNode = opacityU;
  const sideBaseR = pageBgColor.r * texKeep + c.r * HUE_MIX;
  const sideBaseG = pageBgColor.g * texKeep + c.g * HUE_MIX;
  const sideBaseB = pageBgColor.b * texKeep + c.b * HUE_MIX;
  sideMat.emissiveNode = vec4(
    float(sideBaseR).add(rimR),
    float(sideBaseG).add(rimG),
    float(sideBaseB).add(rimB),
    1,
  );

  const shardMesh = new THREE.Mesh(geom, [topMat, sideMat]);
  shardMesh.frustumCulled = false;
  shardMesh.renderOrder = 2;
  shardMesh.userData.polygon = polygon;
  shardMesh.userData.centroid = { x: centroidX, y: centroidY };
  shardMesh.userData.buildScrollY = buildScrollY;
  shardMesh.userData.dangleSegs = [...newDanglings, ...inheritedDanglings];
  shardMesh.userData.opacityU = opacityU;
  shardMesh.position.set(centroidX, centroidY, 0);

  const lineChild = buildCrackLineChild(
    polygon,
    newDanglings,
    inheritedDanglings,
    centroidX,
    centroidY,
    buildScrollY,
    anchor,
    anchorMax,
    parentPolygon,
  );
  if (lineChild) {
    shardMesh.add(lineChild);
    shardMesh.userData.lineProgress = lineChild.userData.progress;
  }

  return shardMesh;
}

function initializeRootShard() {
  const w = source.width;
  const h = source.height;
  rootRect = { x0: 0, y0: 0, x1: w, y1: h };
  const polygon = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const m = createShardMesh(polygon, 0);
  if (m) {
    sceneRoot.add(m);
    shardMeshes.push(m);
  }
}

function hitShard(x, y) {
  const p = { x, y };
  for (const m of shardMeshes) {
    if (pointInPolygon(p, m.userData.polygon)) return m;
  }
  return null;
}

function disposeShardResources(m) {
  m.geometry.dispose();
  if (Array.isArray(m.material)) {
    for (const mm of m.material) mm.dispose();
  } else {
    m.material.dispose();
  }
  for (const child of m.children) {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }
}

function removeShard(m) {
  const idx = shardMeshes.indexOf(m);
  if (idx >= 0) shardMeshes.splice(idx, 1);
  sceneRoot.remove(m);
  disposeShardResources(m);
}

function isInteriorPolygon(polygon, rect) {
  const tol = 1.0;
  for (const v of polygon) {
    if (Math.abs(v.x - rect.x0) < tol) return false;
    if (Math.abs(v.x - rect.x1) < tol) return false;
    if (Math.abs(v.y - rect.y0) < tol) return false;
    if (Math.abs(v.y - rect.y1) < tol) return false;
  }
  return true;
}

function distPointToSegment(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function isEdgeOnViewportRect(a, b, rect) {
  const tol = 1.0;
  if (Math.abs(a.y - rect.y0) < tol && Math.abs(b.y - rect.y0) < tol) return true;
  if (Math.abs(a.y - rect.y1) < tol && Math.abs(b.y - rect.y1) < tol) return true;
  if (Math.abs(a.x - rect.x0) < tol && Math.abs(b.x - rect.x0) < tol) return true;
  if (Math.abs(a.x - rect.x1) < tol && Math.abs(b.x - rect.x1) < tol) return true;
  return false;
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a * 0.5);
}

function isEdgeOnPolygon(a, b, polygon, tol) {
  for (let i = 0; i < polygon.length; i++) {
    const pa = polygon[i];
    const pb = polygon[(i + 1) % polygon.length];
    if (distPointToSegment(a, pa, pb) < tol && distPointToSegment(b, pa, pb) < tol) return true;
  }
  return false;
}

const BOUNDARY_LINE_WIDTH = 4; // pixels
const DANGLING_BASE_WIDTH = 4; // pixels (depth 0)
const DANGLING_DEPTH_FALLOFF = 0.8; // width *= this^depth

function widthForDepth(depth) {
  return DANGLING_BASE_WIDTH * Math.pow(DANGLING_DEPTH_FALLOFF, depth);
}

function buildCrackLineChild(
  polygon,
  newDanglings,
  inheritedDanglings,
  centroidX,
  centroidY,
  buildScrollY,
  clickPoint,
  maxDist,
  parentPolygon,
) {
  const w = source.width;
  const h = source.height;
  const rect = rootRect;
  const tol = 1.0;

  const positions = [];
  const delays = [];
  const indices = [];
  let vi = 0;

  function toNdcLocal(px, py) {
    return [(px / w) * 2 - 1 - centroidX, 1 - ((py - buildScrollY) / h) * 2 - centroidY];
  }

  function delayFor(px, py) {
    if (!clickPoint || !maxDist) return 0;
    return Math.min(1, Math.hypot(px - clickPoint.x, py - clickPoint.y) / maxDist);
  }

  function addSeg(x0, y0, x1, y1, w0, w1, isNew) {
    const pxDx = x1 - x0;
    const pxDy = y1 - y0;
    const pxLen = Math.hypot(pxDx, pxDy);
    if (pxLen < 1e-6) return;
    const pxNormX = -pxDy / pxLen;
    const pxNormY = pxDx / pxLen;
    const hw0 = w0 / 2,
      hw1 = w1 / 2;

    const [v0x, v0y] = toNdcLocal(x0 + pxNormX * hw0, y0 + pxNormY * hw0);
    const [v1x, v1y] = toNdcLocal(x0 - pxNormX * hw0, y0 - pxNormY * hw0);
    const [v2x, v2y] = toNdcLocal(x1 + pxNormX * hw1, y1 + pxNormY * hw1);
    const [v3x, v3y] = toNdcLocal(x1 - pxNormX * hw1, y1 - pxNormY * hw1);

    positions.push(v0x, v0y, 0);
    positions.push(v1x, v1y, 0);
    positions.push(v2x, v2y, 0);
    positions.push(v3x, v3y, 0);

    const d0 = isNew ? delayFor(x0, y0) : -1;
    const d1 = isNew ? delayFor(x1, y1) : -1;
    delays.push(d0, d0, d1, d1);

    indices.push(vi, vi + 1, vi + 2);
    indices.push(vi + 2, vi + 1, vi + 3);
    vi += 4;
  }

  // polygon boundary edges
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (rect && isEdgeOnViewportRect(a, b, rect)) continue;
    // edge is "new" if NOT on the parent's polygon boundary (i.e., it's a fresh crack cut)
    const isNew = parentPolygon ? !isEdgeOnPolygon(a, b, parentPolygon, tol) : true;
    addSeg(a.x, a.y, b.x, b.y, BOUNDARY_LINE_WIDTH, BOUNDARY_LINE_WIDTH, isNew);
  }

  // new dangling segs (from this click)
  for (const seg of newDanglings) {
    const [x0, y0, x1, y1, , w0 = DANGLING_BASE_WIDTH, w1 = DANGLING_BASE_WIDTH] = seg;
    addSeg(x0, y0, x1, y1, w0, w1, true);
  }

  // inherited dangling segs (pre-existing hair from parent)
  for (const seg of inheritedDanglings) {
    const [x0, y0, x1, y1, , w0 = DANGLING_BASE_WIDTH, w1 = DANGLING_BASE_WIDTH] = seg;
    addSeg(x0, y0, x1, y1, w0, w1, false);
  }

  if (positions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute('growDelay', new THREE.BufferAttribute(new Float32Array(delays), 1));
  geom.setIndex(indices);

  const progressNode = uniform(clickPoint ? 0 : 1);
  const delayAttr = attribute('growDelay', 'float');

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // gate: 1 when progress >= delay, else 0; then scale by opacity
  const alpha = progressNode.sub(delayAttr).mul(1000).clamp(0, 1).mul(crackOpacityU);
  mat.colorNode = vec4(crackColorU, crackColorU, crackColorU, alpha);

  const lineMesh = new THREE.Mesh(geom, mat);
  lineMesh.frustumCulled = false;
  lineMesh.position.z = 0.001;
  lineMesh.renderOrder = 3;
  lineMesh.userData.progress = progressNode;
  return lineMesh;
}

function dropShard(m, delay = 0) {
  sceneRoot.add(m);
  const dx = MathUtils.randFloatSpread(0.4);
  const dy = -4.0 - Math.random() * 3.0;
  const dz = -40 - Math.random() * 30;
  const duration = DROP_DURATION;
  gsap.to(m.position, {
    x: `+=${dx}`,
    y: `+=${dy}`,
    z: dz,
    duration,
    delay,
    ease: 'power2.in',
    onComplete: () => {
      sceneRoot.remove(m);
      disposeShardResources(m);
    },
  });
  gsap.to(m.rotation, {
    x: MathUtils.randFloatSpread(Math.PI * 2),
    y: MathUtils.randFloatSpread(Math.PI * 2),
    z: MathUtils.randFloatSpread(Math.PI),
    duration,
    delay,
    ease: 'power1.in',
  });
  // Fade opacity over the last half of the drop so shards dissolve instead of pop.
  const opacityU = m.userData.opacityU;
  if (opacityU) {
    const tracker = { v: 1 };
    gsap.to(tracker, {
      v: 0,
      duration: duration * 0.3,
      delay: delay + duration * 0.7,
      ease: 'power1.in',
      onUpdate() {
        opacityU.value = tracker.v;
      },
    });
  }
}

const GROW_DURATION = 0.6;
const DROP_DURATION = 1.6;
const DROP_START_DELAY = 0.1;
const DROP_MAX_DELAY = 0.4;
const EDGE_DROP_PROB = 0.2;
const EDGE_DROP_MAX_AREA_FRAC = 0.15; // edge shard can only drop if polygon area < this * viewport area

let droppedArea = 0;

function fractureShardWithCracks(shardMesh, shardCracks, clickPoint, maxDist) {
  const created = [];
  if (!shardCracks || shardCracks.length === 0) return created;
  if (shardMeshes.indexOf(shardMesh) === -1) return created;

  const polygon = shardMesh.userData.polygon;
  const buildScrollY = shardMesh.userData.buildScrollY;
  const inherited = shardMesh.userData.dangleSegs || [];

  const faces = computeFaces(shardCracks, polygon);
  if (faces.length < 2) {
    // Crack didn't split the shard (e.g. capped before reaching an edge).
    // Rebuild the shard in place with the cracks added as dangling lines.
    const addedDanglings = [];
    for (const seg of shardCracks) {
      const mid = { x: (seg[0] + seg[2]) / 2, y: (seg[1] + seg[3]) / 2 };
      if (!pointInPolygon(mid, polygon)) continue;
      let onEdge = false;
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        if (distPointToSegment(mid, a, b) < 1.0) {
          onEdge = true;
          break;
        }
      }
      if (!onEdge) addedDanglings.push(seg);
    }
    if (addedDanglings.length === 0) return created;
    removeShard(shardMesh);
    const rebuilt = createShardMesh(
      polygon,
      buildScrollY,
      addedDanglings,
      inherited,
      clickPoint,
      maxDist,
      polygon,
    );
    if (rebuilt) {
      sceneRoot.add(rebuilt);
      shardMeshes.push(rebuilt);
      created.push(rebuilt);
    }
    return created;
  }

  removeShard(shardMesh);

  const tol = 1.0;
  const toDrop = [];
  // Precompute midpoints once — reused for every face.
  const shardMids = shardCracks.map((seg) => ({
    x: (seg[0] + seg[2]) / 2,
    y: (seg[1] + seg[3]) / 2,
  }));
  const inheritedMids = inherited.map((seg) => ({
    x: (seg[0] + seg[2]) / 2,
    y: (seg[1] + seg[3]) / 2,
  }));
  for (const face of faces) {
    if (face.length < 3) continue;
    // Face AABB for cheap PIP reject.
    let fMinX = Infinity,
      fMinY = Infinity,
      fMaxX = -Infinity,
      fMaxY = -Infinity;
    for (const v of face) {
      if (v.x < fMinX) fMinX = v.x;
      if (v.x > fMaxX) fMaxX = v.x;
      if (v.y < fMinY) fMinY = v.y;
      if (v.y > fMaxY) fMaxY = v.y;
    }
    const newDanglings = [];
    for (let k = 0; k < shardCracks.length; k++) {
      const mid = shardMids[k];
      if (mid.x < fMinX || mid.x > fMaxX || mid.y < fMinY || mid.y > fMaxY) continue;
      if (!pointInPolygon(mid, face)) continue;
      let onEdge = false;
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        if (distPointToSegment(mid, a, b) < tol) {
          onEdge = true;
          break;
        }
      }
      if (!onEdge) newDanglings.push(shardCracks[k]);
    }
    const inheritedDanglings = [];
    for (let k = 0; k < inherited.length; k++) {
      const mid = inheritedMids[k];
      if (mid.x < fMinX || mid.x > fMaxX || mid.y < fMinY || mid.y > fMaxY) continue;
      if (pointInPolygon(mid, face)) inheritedDanglings.push(inherited[k]);
    }
    const newMesh = createShardMesh(
      face,
      buildScrollY,
      newDanglings,
      inheritedDanglings,
      clickPoint,
      maxDist,
      polygon,
    );
    if (!newMesh) continue;
    created.push(newMesh);

    const interior = isInteriorPolygon(face, rootRect);

    const smallEdge =
      polygonArea(face) < source.width * source.height * EDGE_DROP_MAX_AREA_FRAC &&
      Math.random() < EDGE_DROP_PROB;

    if (interior || smallEdge) {
      newMesh.rotation.x = MathUtils.randFloatSpread(0.1);
      newMesh.rotation.y = MathUtils.randFloatSpread(0.1);

      droppedArea += polygonArea(face);
      toDrop.push(newMesh);
    } else {
      sceneRoot.add(newMesh);
      shardMeshes.push(newMesh);
    }
  }
  for (const m of toDrop) {
    dropShard(m, DROP_START_DELAY + Math.random() * DROP_MAX_DELAY);
  }
  return created;
}

function explodeShards() {
  if (shardMeshes.length === 0) return;
  exploded = true;
  mesh.visible = false;
  renderer.setClearColor(0x000000, 1);

  for (const m of shardMeshes) {
    const c = m.userData.centroid || { x: 0, y: 0 };
    const len = Math.hypot(c.x, c.y);
    const dx = len > 0.01 ? c.x / len : MathUtils.randFloatSpread(1);
    const dy = len > 0.01 ? c.y / len : MathUtils.randFloatSpread(1);
    const outDist = Math.random() * 0.08;

    const dur = 3 + Math.random() * 1.5;
    const delay = Math.random() * 1.0;

    gsap.to(m.position, {
      x: `+=${dx * outDist}`,
      y: `+=${dy * outDist}`,
      z: -(15 + Math.random() * 10),
      duration: dur,
      delay,
      ease: 'power2.in',
    });
    gsap.to(m.rotation, {
      x: MathUtils.randFloatSpread(Math.PI),
      y: MathUtils.randFloatSpread(Math.PI),
      z: MathUtils.randFloatSpread(Math.PI * 0.6),
      duration: dur,
      delay,
      ease: 'power2.in',
    });
  }
}

function resetShards() {
  if (shardMeshes.length === 0) return;
  exploded = false;
  for (const m of shardMeshes) {
    gsap.killTweensOf(m.position);
    gsap.killTweensOf(m.rotation);
    m.position.set(m.userData.centroid.x, m.userData.centroid.y, 0);
    m.rotation.set(0, 0, 0);
  }
  updateShardScroll();
}

function tiltShards() {
  if (shardMeshes.length === 0) return;
  const maxAng = 0.3;
  for (const m of shardMeshes) {
    gsap.killTweensOf(m.rotation);
    gsap.to(m.rotation, {
      x: MathUtils.randFloatSpread(maxAng),
      y: MathUtils.randFloatSpread(maxAng),
      z: MathUtils.randFloatSpread(maxAng * 0.5),
      duration: 0.6,
      ease: 'power2.out',
    });
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'x' || e.key === 'X') {
    explodeShards();
  } else if (e.key === 'r' || e.key === 'R') {
    resetShards();
  } else if (e.key === 't' || e.key === 'T') {
    tiltShards();
  } else if (e.key === 'o' || e.key === 'O') {
    controls.enabled = !controls.enabled;
    stage.style.pointerEvents = controls.enabled ? 'auto' : 'none';
    console.log(`[orbit] ${controls.enabled ? 'on' : 'off'}`);
  }
});

const ENV_GAIN = 2.5;

function updateEnvIntensity() {
  let maxMag = 0;
  for (const m of shardMeshes) {
    const r = m.rotation;
    const mag = Math.abs(r.x) + Math.abs(r.y) + Math.abs(r.z);
    if (mag > maxMag) maxMag = mag;
  }
  scene.environmentIntensity = Math.min(maxMag * ENV_GAIN, 1);
}

const postProcessing = new THREE.RenderPipeline(renderer);
const displayPass = pass(displayScene, decayCam);
const bloomPass = bloom(displayPass, 0.38, 0.0, 0.0);
// Composite shards over bloomed tunnel inside the outputNode so Three applies
// the final tonemap/sRGB encode in one pass (matches tunnel-test's look).
// RT sampling is Y-flipped for WebGPU.
const bgNode = displayPass.add(bloomPass);
const fgNode = texture(fgRT.texture, uv());
postProcessing.outputNode = vec4(bgNode.rgb.mul(oneMinus(fgNode.a)).add(fgNode.rgb), 1);
renderer.autoClear = false;

let firstFrame = true;
renderer.setAnimationLoop(() => {
  stats.update();
  if (controls.enabled) controls.update();
  updateEnvIntensity();
  if (tunnelApi) {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    tunnelApi.update(dt);
    // 1) decay + tunnel → feedbackRT (trail feedback intentional)
    renderer.setRenderTarget(feedbackRT);
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.render(decayScene, decayCam);
    renderer.render(tunnelScene, camera);
    // 2) shards → fgRT with transparent bg
    renderer.setRenderTarget(fgRT);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setClearColor(0x000000, 1);
    // 3) postProcessing outputNode composites bloom + fg → screen.
    renderer.setRenderTarget(null);
    postProcessing.render();
  } else {
    renderer.autoClear = true;
    renderer.render(scene, camera);
  }
  if (firstFrame) {
    firstFrame = false;
    document.body.classList.add('ready');
  }
});
