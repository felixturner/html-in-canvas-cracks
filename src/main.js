import * as THREE from 'three/webgpu';
import { uv, vec4, texture } from 'three/tsl';
import Stats from 'three/addons/libs/stats.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MathUtils } from 'three';
import gsap from 'gsap';
import { computeFaces, triangulateFace } from './shatter.js';

const source = document.getElementById('source');
const stage = document.getElementById('stage');
const divider = document.getElementById('divider');
const warning = document.getElementById('warning');
const page = source.querySelector('.gh-page');
const ctx2d = source.getContext('2d');

if (typeof ctx2d.drawElementImage !== 'function') {
  warning.hidden = false;
  source.style.display = 'none';
  stage.style.display = 'none';
  throw new Error('drawElementImage not available — enable chrome://flags/#canvas-draw-element');
}

const scene = new THREE.Scene();
const FOV = 60;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
camera.position.set(0, 0, 1 / Math.tan((FOV / 2) * Math.PI / 180));
camera.lookAt(0, 0, 0);

const sceneRoot = new THREE.Group();
scene.add(sceneRoot);

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

new RGBELoader().load('/studio_kominka_01_1k.hdr', (hdr) => {
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

const debug = document.getElementById('debug');

const cracks = [];

function growBranch(x, y, angle, steps, depth) {
  if (depth > 3) return;
  for (let i = 0; i < steps; i++) {
    angle += (Math.random() - 0.5) * 1.3;
    const nx = x + Math.cos(angle) * 60;
    const ny = y + Math.sin(angle) * 60;
    cracks.push([x, y, nx, ny]);
    x = nx;
    y = ny;
    if (Math.random() < 0.18 * Math.pow(0.6, depth)) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const branchAngle = angle + side * (Math.PI / 3 + (Math.random() - 0.5) * 0.4);
      growBranch(x, y, branchAngle, Math.floor(steps * 0.7), depth + 1);
    }
  }
}

function walkMainCrack(x, y, angle) {
  const w = source.width;
  const h = source.height;
  const sy = window.scrollY;
  const minX = -50, maxX = w + 50;
  const minY = sy - 50, maxY = sy + h + 50;
  let cx = x, cy = y, ca = angle;
  while (cx > minX && cx < maxX && cy > minY && cy < maxY) {
    ca += (Math.random() - 0.5) * 0.3;
    const nx = cx + Math.cos(ca) * 60;
    const ny = cy + Math.sin(ca) * 60;
    cracks.push([cx, cy, nx, ny]);
    cx = nx;
    cy = ny;
    if (Math.random() < 0.22) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const ba = ca + side * (Math.PI / 3 + (Math.random() - 0.5) * 0.4);
      growBranch(cx, cy, ba, 3, 1);
    }
  }
}

function seedCrack(x, y) {
  const mainAngle = Math.random() * Math.PI;
  walkMainCrack(x, y, mainAngle);
  walkMainCrack(x, y, mainAngle + Math.PI);
}

const crackGeometry = new THREE.BufferGeometry();
crackGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
const crackMaterial = new THREE.LineBasicNodeMaterial({
  color: 0xffffff,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});
const crackLines = new THREE.LineSegments(crackGeometry, crackMaterial);
crackLines.frustumCulled = false;
crackLines.renderOrder = 1;
sceneRoot.add(crackLines);

function updateCrackGeometry() {
  const n = cracks.length;
  if (n === 0) {
    crackGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    return;
  }
  const arr = new Float32Array(n * 6);
  const w = source.width;
  const h = source.height;
  const sy = window.scrollY;
  for (let i = 0; i < n; i++) {
    const s = cracks[i];
    arr[i * 6 + 0] = (s[0] / w) * 2 - 1;
    arr[i * 6 + 1] = 1 - ((s[1] - sy) / h) * 2;
    arr[i * 6 + 2] = 0;
    arr[i * 6 + 3] = (s[2] / w) * 2 - 1;
    arr[i * 6 + 4] = 1 - ((s[3] - sy) / h) * 2;
    arr[i * 6 + 5] = 0;
  }
  crackGeometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
}

function paint() {
  try {
    ctx2d.clearRect(0, 0, source.width, source.height);
    ctx2d.drawElementImage(page, 0, -window.scrollY);
    htmlTexture.needsUpdate = true;
    updateCrackGeometry();
    const contentH = page.offsetHeight;
    if (contentH > 0 && contentH !== lastContentH) {
      document.body.style.minHeight = contentH + 'px';
      lastContentH = contentH;
    }
    updateShardScroll();
    const mainInner = page.querySelector('.gh-main-inner');
    debug.textContent =
      `vp    ${window.innerWidth}x${window.innerHeight}  dpr ${window.devicePixelRatio}\n` +
      `src   attr ${source.width}x${source.height}  css ${source.offsetWidth}x${source.offsetHeight}\n` +
      `page  ${page.offsetWidth}x${page.offsetHeight}\n` +
      `main  ${mainInner ? mainInner.offsetWidth : '-'}  split ${split.toFixed(2)}`;
  } catch (err) {
    schedulePaint();
  }
}

let split = 0.8;

function applySplit() {
  divider.style.left = (split * 100) + 'vw';
  stage.style.clipPath = `inset(0 ${(1 - split) * 100}% 0 0)`;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  source.width = w;
  source.height = h;
  createPipeline();
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  sceneRoot.scale.set(aspect, 1, 1);
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

source.onpaint = schedulePaint;
window.addEventListener('resize', resize);
window.addEventListener('scroll', schedulePaint, { passive: true });
new ResizeObserver(schedulePaint).observe(page);

window.addEventListener('click', (e) => {
  if (controls.enabled) return;
  if (e.target.closest('#divider')) return;
  seedCrack(e.clientX, e.clientY + window.scrollY);
  buildShards();
  schedulePaint();
});

resize();

const stats = new Stats();
stats.dom.style.position = 'fixed';
stats.dom.style.top = '8px';
stats.dom.style.right = '8px';
stats.dom.style.left = 'auto';
stats.dom.style.zIndex = '100';
stats.dom.style.pointerEvents = 'none';
document.body.appendChild(stats.dom);

let shardMeshes = [];
let shardBuildScrollY = 0;
let exploded = false;

function updateShardScroll() {
  if (exploded) return;
  if (shardMeshes.length === 0) return;
  const h = source.height;
  const ndcOffset = ((window.scrollY - shardBuildScrollY) / h) * 2;
  for (const m of shardMeshes) m.position.y = m.userData.centroid.y + ndcOffset;
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
    indices.push(
      topTriIndices[i + 0],
      topTriIndices[i + 2],
      topTriIndices[i + 1]
    );
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

    positions[v0 * 3 + 0] = ax; positions[v0 * 3 + 1] = ay; positions[v0 * 3 + 2] = topZ;
    positions[v1 * 3 + 0] = bx; positions[v1 * 3 + 1] = by; positions[v1 * 3 + 2] = topZ;
    positions[v2 * 3 + 0] = bx; positions[v2 * 3 + 1] = by; positions[v2 * 3 + 2] = botZ;
    positions[v3 * 3 + 0] = ax; positions[v3 * 3 + 1] = ay; positions[v3 * 3 + 2] = botZ;

    for (const v of [v0, v1, v2, v3]) {
      normals[v * 3 + 0] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = 0;
    }

    uvs[v0 * 2 + 0] = 0; uvs[v0 * 2 + 1] = 0;
    uvs[v1 * 2 + 0] = 1; uvs[v1 * 2 + 1] = 0;
    uvs[v2 * 2 + 0] = 1; uvs[v2 * 2 + 1] = 1;
    uvs[v3 * 2 + 0] = 0; uvs[v3 * 2 + 1] = 1;

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

function buildShards() {
  exploded = false;
  crackLines.visible = true;
  renderer.setClearColor(0x000000, 1);

  for (const m of shardMeshes) {
    sceneRoot.remove(m);
    m.geometry.dispose();
    if (Array.isArray(m.material)) {
      for (const mm of m.material) mm.dispose();
    } else {
      m.material.dispose();
    }
  }
  shardMeshes = [];

  if (cracks.length === 0) {
    if (mesh) mesh.visible = true;
    return;
  }

  const w = source.width;
  const h = source.height;
  const sy = window.scrollY;
  const contentH = page.offsetHeight;
  shardBuildScrollY = sy;

  const faces = computeFaces(cracks, w, contentH);
  console.log(`[shatter] ${faces.length} faces from ${cracks.length} segments (contentH=${contentH})`);

  for (let fi = 0; fi < faces.length; fi++) {
    const face = [...faces[fi]].reverse();
    if (face.length < 3) continue;

    const indices = triangulateFace(face);
    if (indices.length === 0) continue;

    let cxSum = 0, cySum = 0;
    const positions = new Float32Array(face.length * 3);
    const uvs = new Float32Array(face.length * 2);
    for (let i = 0; i < face.length; i++) {
      positions[i * 3 + 0] = (face[i].x / w) * 2 - 1;
      positions[i * 3 + 1] = 1 - ((face[i].y - sy) / h) * 2;
      positions[i * 3 + 2] = 0;
      uvs[i * 2 + 0] = face[i].x / w;
      uvs[i * 2 + 1] = 1 - (face[i].y - sy) / h;
      cxSum += positions[i * 3 + 0];
      cySum += positions[i * 3 + 1];
    }
    const centroidX = cxSum / face.length;
    const centroidY = cySum / face.length;

    for (let i = 0; i < face.length; i++) {
      positions[i * 3 + 0] -= centroidX;
      positions[i * 3 + 1] -= centroidY;
    }

    const depthNdc = 30 / h * 2;
    const geom = buildExtrudedShardGeometry(positions, uvs, indices, depthNdc);

    const hue = (fi * 137.5) % 360;
    const c = new THREE.Color().setHSL(hue / 360, 1.0, 0.6);

    const topMat = new THREE.MeshStandardNodeMaterial({
      metalness: 0,
      roughness: 0.1,
    });
    topMat.color = new THREE.Color(0, 0, 0);
    const tex = texture(htmlTexture, uv());
    topMat.emissiveNode = vec4(
      tex.r.mul(0.95).add(c.r * 0.05),
      tex.g.mul(0.95).add(c.g * 0.05),
      tex.b.mul(0.95).add(c.b * 0.05),
      1
    );

    const sideMat = new THREE.MeshStandardNodeMaterial({
      metalness: 0,
      roughness: 0.1,
    });
    sideMat.color = new THREE.Color(0, 0, 0);
    sideMat.emissive = c;

    const shardMesh = new THREE.Mesh(geom, [topMat, sideMat]);
    shardMesh.frustumCulled = false;
    shardMesh.renderOrder = 2;
    shardMesh.userData.centroid = { x: centroidX, y: centroidY };
    shardMesh.position.set(centroidX, centroidY, 0);
    sceneRoot.add(shardMesh);
    shardMeshes.push(shardMesh);

    const maxAng = 0.5;
    // shardMesh.rotation.x = MathUtils.randFloatSpread(maxAng);
    // shardMesh.rotation.y = MathUtils.randFloatSpread(maxAng);

    // gsap.to(shardMesh.rotation,{
    //   x: MathUtils.randFloatSpread(maxAng),
    //   y: MathUtils.randFloatSpread(maxAng),
    //   duration: 0.1,
    // })
  }

  if (mesh) mesh.visible = false;
}

function explodeShards() {
  if (shardMeshes.length === 0) return;
  exploded = true;
  mesh.visible = false;
  crackLines.visible = false;
  renderer.setClearColor(0x000000, 1);

  for (const m of shardMeshes) {
    const c = m.userData.centroid || { x: 0, y: 0 };
    const len = Math.hypot(c.x, c.y);
    const dx = len > 0.01 ? c.x / len : (Math.random() - 0.5);
    const dy = len > 0.01 ? c.y / len : (Math.random() - 0.5);
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
      x: (Math.random() - 0.5) * Math.PI,
      y: (Math.random() - 0.5) * Math.PI,
      z: (Math.random() - 0.5) * Math.PI * 0.6,
      duration: dur,
      delay,
      ease: 'power2.in',
    });
  }
}

function resetShards() {
  if (shardMeshes.length === 0) return;
  exploded = false;
  crackLines.visible = true;
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

renderer.setAnimationLoop(() => {
  stats.update();
  if (controls.enabled) controls.update();
  updateEnvIntensity();
  renderer.render(scene, camera);
});
