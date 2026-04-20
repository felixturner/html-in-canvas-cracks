import * as THREE from 'three/webgpu';
import {
  uv,
  texture,
  vec2,
  vec3,
  vec4,
  float,
  positionView,
  smoothstep,
  mix,
  fract,
  uniform,
  attribute,
  sin,
  min,
  max,
  pow,
} from 'three/tsl';
import mainSrc from './main.js?raw';
import shatterSrc from './shatter.js?raw';
import tunnelSrc from './tunnel.js?raw';

const GREEN = '#00ff66';
const BG = '#000000';
const FONT_FAMILY = '"VT323", monospace';

// Split a source string into function-ish chunks: split by blank lines,
// keep blocks with 3–20 non-empty lines.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/[ \t]+$/gm, '');
}

function splitIntoChunks(src) {
  const blocks = stripComments(src).split(/\n\s*\n+/);
  const trimmedBlocks = blocks
    .map((b) => b.replace(/^\n+|\n+$/g, ''))
    .filter((b) => b.length > 0);

  // Rejoin up to 3 consecutive blocks into each chunk (separated by a blank
  // line) to produce taller code snippets.
  const GROUP = 3;
  const out = [];
  for (let i = 0; i < trimmedBlocks.length; i += GROUP) {
    const merged = trimmedBlocks.slice(i, i + GROUP).join('\n\n');
    const lines = merged.split('\n');
    if (lines.length < 3 || lines.length > 45) continue;
    if (merged.length < 40) continue;
    out.push(merged);
  }
  return out;
}

// Render a code chunk onto a canvas sized to its natural text dimensions
// (no wrapping, no truncation). Returns the texture and its aspect ratio so
// the caller can size the plane to match.
function makeCodeTexture(chunk) {
  const fontSize = 22;
  const lineHeight = 24;
  const padX = 12;
  const padY = 12;
  const fontSpec = `${fontSize}px ${FONT_FAMILY}`;
  const lines = chunk.split('\n').map((l) => l.replace(/\t/g, '  '));

  // Measure widest line to size the canvas.
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = fontSpec;
  let maxTextW = 0;
  for (const line of lines) {
    const w = measure.measureText(line).width;
    if (w > maxTextW) maxTextW = w;
  }

  const MAX_DIM = 2048;
  const MIN_DIM = 64;
  const width = Math.max(
    MIN_DIM,
    Math.min(MAX_DIM, Math.ceil(maxTextW + padX * 2)),
  );
  const height = Math.max(
    MIN_DIM,
    Math.min(MAX_DIM, Math.ceil(lines.length * lineHeight + padY * 2)),
  );

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  ctx.font = fontSpec;
  ctx.fillStyle = GREEN;
  ctx.textBaseline = 'top';
  ctx.shadowColor = GREEN;
  ctx.shadowBlur = 4;

  let y = padY;
  for (const line of lines) {
    if (y + lineHeight > height - padY) break;
    ctx.fillText(line, padX, y);
    y += lineHeight;
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return { tex, aspect: width / height };
}

// Flat rectangular frame geometry (outer rect minus inner rect), filled —
// gives thick, solid rectangle outlines instead of 1px lines.
function rectFrameGeometry(w, h, thickness) {
  const hw = w / 2;
  const hh = h / 2;
  const t = thickness;
  const positions = new Float32Array([
    // outer: 0=TL, 1=TR, 2=BR, 3=BL
    -hw,
    hh,
    0,
    hw,
    hh,
    0,
    hw,
    -hh,
    0,
    -hw,
    -hh,
    0,
    // inner: 4=TL, 5=TR, 6=BR, 7=BL
    -hw + t,
    hh - t,
    0,
    hw - t,
    hh - t,
    0,
    hw - t,
    -hh + t,
    0,
    -hw + t,
    -hh + t,
    0,
  ]);
  const indices = [
    0,
    4,
    1,
    1,
    4,
    5, // top
    1,
    5,
    2,
    2,
    5,
    6, // right
    2,
    6,
    3,
    3,
    6,
    7, // bottom
    3,
    7,
    0,
    0,
    7,
    4, // left
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Build a "behind the screen" scene: green phosphor code planes drifting
 * toward the camera through a nested-rect tunnel. Returns a Group that can
 * be added to any parent scene, plus an update(dt) and dispose().
 *
 * @param {Object} opts
 * @param {number} [opts.numCodePlanes=100]
 * @param {number} [opts.numRects=24]
 * @param {number} [opts.tunnelDepth=38]  distance camera-relative for far plane
 * @param {number} [opts.spread=4.2]       xy spread of code planes
 * @param {number} [opts.baseSpeed=2.4]    units/sec
 * @param {number} [opts.aspect=16/9]      initial rect aspect — call updateAspect on resize
 */
export function createTunnel(opts = {}) {
  const {
    numCodePlanes = 200,
    numRects = 24,
    tunnelDepth = 38,
    spread = 7.5,
    baseSpeed = 2.4,
    aspect = 16 / 9,
  } = opts;

  const group = new THREE.Group();
  group.name = 'tunnel';

  // Distance-based fog: fade toward fogColor (very dark green) from `fogNear` to `fogFar`.
  const fogNear = 1.0;
  const fogFar = tunnelDepth * 0.9;
  const viewDist = positionView.z.negate();
  const fogFactor = float(1.0).sub(
    smoothstep(float(fogNear), float(fogFar), viewDist),
  );
  const fogColor = vec3(0.0, 0.0, 0.0);

  const chunks = [
    ...splitIntoChunks(mainSrc),
    ...splitIntoChunks(shatterSrc),
    ...splitIntoChunks(tunnelSrc),
  ];
  // If something weird happened with splitting, fall back to a single snippet.
  if (chunks.length === 0) chunks.push(mainSrc.slice(0, 500));

  const textures = [];
  const planes = [];

  // Code planes travel faster than the rect tunnel to give them a sense of
  // passing through the frame.
  const codeSpeedMul = 1.5;

  // Mutable aspect for plane placement — scales the X range of the spawn
  // annulus so wide viewports fill the horizontal edges. Updated via
  // updateAspect() so recycled planes use the current viewport shape.
  let currentAspect = aspect;

  // Inner radius of the code-plane spawn annulus (world units). Keeps a small
  // dead zone around the tunnel axis so planes don't pass through the camera
  // and blow out the center.
  const DEAD_ZONE = 1.0;

  // Live-tunable code opacity (multiplied into every code plane's colorNode).
  // DEBUG: defaulted to 0 so only the grid is visible while we tune.
  const codeOpacityU = uniform(0.52);

  // Live-tunable global speed multiplier applied in update(dt). Not a TSL
  // uniform — update() runs in JS. Exposed as params.speedMultiplier below.
  const params = { speedMultiplier: 1.05 };

  // Cache one texture per chunk so many planes reuse GPU memory.
  const entryByChunkIndex = new Map();
  function getChunkEntry(idx) {
    let entry = entryByChunkIndex.get(idx);
    if (!entry) {
      entry = makeCodeTexture(chunks[idx]);
      entryByChunkIndex.set(idx, entry);
      textures.push(entry.tex);
    }
    return entry;
  }

  for (let i = 0; i < numCodePlanes; i++) {
    const idx = i % chunks.length;
    const { tex, aspect: chunkAspect } = getChunkEntry(idx);

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    // WebGPU TSL doesn't always honor CanvasTexture.flipY, so flip V here.
    mat.colorNode = mix(
      vec4(fogColor, float(0)),
      texture(tex, vec2(uv().x, float(1).sub(uv().y))),
      fogFactor,
    ).mul(codeOpacityU);

    // Plane sized to the chunk's natural text aspect so no stretching.
    const planeH = (0.9 + Math.random() * 1.3) * 1.0;
    const planeW = planeH * chunkAspect;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), mat);
    // Place planes in an elliptical annulus scaled by viewport aspect so
    // landscape viewports fill the wider horizontal extent.
    const ang = Math.random() * Math.PI * 2;
    const rad = DEAD_ZONE + Math.random() * (spread - DEAD_ZONE);
    plane.position.set(
      Math.cos(ang) * rad * currentAspect,
      Math.sin(ang) * rad,
      -Math.random() * tunnelDepth,
    );
    plane.userData = {
      speed: baseSpeed * codeSpeedMul * (0.55 + Math.random() * 0.9),
      spread,
    };
    plane.renderOrder = 10;
    group.add(plane);
    planes.push(plane);
  }

  // Tunnel rectangles: all same size, viewport aspect, evenly spaced along z,
  // uniform speed so recycling to the far end keeps spacing constant. Rebuild
  // geometry on aspect change via updateAspect().
  const RECT_H = 2.2;
  const RECT_THICK = 0.03;
  const RECT_SPACING = (tunnelDepth / numRects) * 2;
  const RECT_SPAN = RECT_SPACING * numRects;
  let rectGeo = rectFrameGeometry(RECT_H * aspect, RECT_H, RECT_THICK);
  const rectSpeed = baseSpeed * 1.1;
  // Same color as code text (#00ff66). Bake opacity directly into rgb because
  // additive + alpha-via-opacity is unreliable under TSL. Exposed as a uniform
  // so the caller can tweak live (via returned uniforms.rectOpacity).
  const rectOpacityU = uniform(0.0);
  const rectColor = vec3(0.0, 1.0, 0.4).mul(rectOpacityU);
  const rects = [];
  for (let i = 0; i < numRects; i++) {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    mat.colorNode = vec4(mix(fogColor, rectColor, fogFactor), float(1.0));

    const mesh = new THREE.Mesh(rectGeo, mat);
    mesh.position.set(0, 0, -i * RECT_SPACING);
    mesh.userData = { speed: rectSpeed };
    mesh.renderOrder = 8;
    group.add(mesh);
    rects.push(mesh);
  }

  // --------------------------------------------------------------------------
  // Wireframe 3D grid box (floor + ceiling + left + right walls) with shader
  // pulses — Trails.js style. Each line is a thin ribbon quad so UV.x drives
  // an edge-fade and UV.y carries actual world-space distance along the line.
  // Per-line `linePhase` attribute randomizes the pulse phase + speed so pulses
  // don't march in lockstep. The group scrolls in +Z, wrapping by one Z-cell.
  // --------------------------------------------------------------------------
  const GRID_HALF_W = 14; // will be scaled by aspect
  const GRID_HALF_H = 3.8; // exactly 4 cells tall at cell size 1.9
  const GRID_DEPTH = tunnelDepth;
  const GRID_CELL_SIZE = 1.9 * 1.4; // world units — cells are cubes of this edge
  const GRID_RIBBON_W = 0.03;

  function buildBoxGridRibbons(halfW, halfH, depth, cellSize, ribbonW) {
    const positions = [];
    const uvs = [];
    const phases = [];
    const lineLens = [];
    const indices = [];
    const scrollEntries = [];
    const halfR = ribbonW / 2;
    const width = halfW * 2;
    const height = halfH * 2;
    const cellsX = Math.max(1, Math.round(width / cellSize));
    const cellsY = Math.max(1, Math.round(height / cellSize));
    const cellsZ = Math.max(1, Math.round(depth / cellSize));
    let base = 0;

    // Extensions push Z-rails forward of z=0 (past the camera) and Y-rungs
    // above the ceiling / below the floor so lines don't visibly stop.
    const Z_FRONT = 3 * 1.4 * cellSize;
    const Z_BACK = 2 * 1.4 * cellSize;
    const Y_EXTRA = 3 * 1.4 * cellSize;
    const zNear = Z_FRONT; // positive z; in front of cam
    const zFar = -depth - Z_BACK; // past far end
    const zLen = zNear - zFar;
    const yLow = -halfH - Y_EXTRA;
    const yHigh = halfH + Y_EXTRA;
    const yLen = yHigh - yLow;

    function addRibbon(p0, p1, p2, p3, uvLen, scrolls) {
      const phase = Math.random();
      positions.push(
        p0.x,
        p0.y,
        p0.z,
        p1.x,
        p1.y,
        p1.z,
        p2.x,
        p2.y,
        p2.z,
        p3.x,
        p3.y,
        p3.z,
      );
      uvs.push(0, 0, 1, 0, 0, uvLen, 1, uvLen);
      phases.push(phase, phase, phase, phase);
      lineLens.push(uvLen, uvLen, uvLen, uvLen);
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      if (scrolls) {
        scrollEntries.push({
          baseIdx: base,
          homeZs: [p0.z, p1.z, p2.z, p3.z],
          offset: 0,
        });
      }
      base += 4;
    }

    // Anchor all grid lines to a HALF-CELL offset from origin so the camera
    // at (0, 0) always sits at the CENTER of a cell. Nearest lines are at
    // ±cellSize/2, ±3cellSize/2, etc. — never at 0.
    const halfC = cellSize / 2;
    const yPlanes = [];
    for (let y = halfC; y <= yHigh + 1e-4; y += cellSize) {
      yPlanes.push(y);
      yPlanes.push(-y);
    }
    yPlanes.sort((a, b) => a - b);
    const xVerticals = [];
    for (let x = halfC; x <= halfW - halfC + 1e-4; x += cellSize) {
      xVerticals.push(x);
      xVerticals.push(-x);
    }
    xVerticals.sort((a, b) => a - b);
    const zRungs = [];
    for (let z = -halfC; z >= -depth + 1e-4; z -= cellSize) zRungs.push(z);

    // Horizontal planes: Z-rails (static, flat — thickness in X) + X-rungs
    // (scroll, thickness in Y so they face the camera).
    for (const y of yPlanes) {
      for (const x of xVerticals) {
        addRibbon(
          { x: x - halfR, y, z: zNear },
          { x: x + halfR, y, z: zNear },
          { x: x - halfR, y, z: zFar },
          { x: x + halfR, y, z: zFar },
          zLen,
          false,
        );
      }
      for (const z of zRungs) {
        addRibbon(
          { x: -halfW, y: y - halfR, z },
          { x: -halfW, y: y + halfR, z },
          { x: halfW, y: y - halfR, z },
          { x: halfW, y: y + halfR, z },
          halfW * 2,
          true,
        );
      }
    }

    // Walls (at ±halfW): Y-rungs (scroll, extended) + Z-rails (static).
    for (const x of [-halfW, halfW]) {
      for (const z of zRungs) {
        addRibbon(
          { x, y: yLow, z: z - halfR },
          { x, y: yLow, z: z + halfR },
          { x, y: yHigh, z: z - halfR },
          { x, y: yHigh, z: z + halfR },
          yLen,
          true,
        );
      }
      for (const y of yPlanes) {
        addRibbon(
          { x, y: y - halfR, z: zNear },
          { x, y: y + halfR, z: zNear },
          { x, y: y - halfR, z: zFar },
          { x, y: y + halfR, z: zFar },
          zLen,
          false,
        );
      }
    }

    // Interior lattice Y-rungs (scroll, extended).
    for (const x of xVerticals) {
      for (const z of zRungs) {
        addRibbon(
          { x: x - halfR, y: yLow, z },
          { x: x + halfR, y: yLow, z },
          { x: x - halfR, y: yHigh, z },
          { x: x + halfR, y: yHigh, z },
          yLen,
          true,
        );
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(positions), 3),
    );
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setAttribute(
      'linePhase',
      new THREE.BufferAttribute(new Float32Array(phases), 1),
    );
    geo.setAttribute(
      'lineLength',
      new THREE.BufferAttribute(new Float32Array(lineLens), 1),
    );
    geo.setIndex(indices);
    return { geo, scrollEntries };
  }

  const gridTimeU = uniform(0);
  const gridOpacityU = uniform(0.39);
  const pulseSpeedU = uniform(25.4);
  const pulseCutoffU = uniform(0.0);
  const pulseFreqU = uniform(2.67);
  const pulseSharpU = uniform(22.5);
  // DEBUG: red so the grid structure is clearly visible while we sort out
  // cell-square issues. Swap back to vec3(0, 1, 0.4) once it's tuned.
  const gridBrightColor = vec3(0.0, 1.0, 0.4);
  const gridDarkColor = gridBrightColor.mul(0.04);

  // 1D smooth noise: hash at integer positions, hermite-smoothed between.
  const hash1 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  const noise1D = (x) => {
    const xi = x.floor();
    const xf = x.fract();
    const s = xf.mul(xf).mul(float(3.0).sub(xf.mul(2.0)));
    return mix(hash1(xi), hash1(xi.add(1.0)), s);
  };

  function makeGridMaterial() {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const crossPos = uv().x;
    const phase = attribute('linePhase');
    const lineLen = attribute('lineLength');
    const normDist = uv().y.div(lineLen);

    // Every ribbon pulses; narrow pulse width keeps each dark most of the
    // time. Direction (up/down along UV.y) is randomized per-ribbon using
    // the linePhase attribute as a coin-flip seed.
    // 1D noise field advancing along each line. Noise coord uses world
    // position (normDist * lineLen) so feature size is consistent across
    // ribbons regardless of length. Cutoff near 1 keeps pulses rare.
    const dirHash = hash1(phase.mul(7.91));
    const flip = smoothstep(float(0.49), float(0.51), dirHash);
    const scrollDir = mix(float(1.0), float(-1.0), flip);
    const worldPos = normDist.mul(lineLen);
    const noiseCoord = worldPos
      .mul(pulseFreqU)
      .add(gridTimeU.mul(pulseSpeedU).mul(scrollDir))
      .add(phase.mul(137.0));
    const n = noise1D(noiseCoord);
    // pow sharpens the noise peaks so the bright region is much narrower
    // without changing the overall rate of pulses.
    const nSharp = pow(n, pulseSharpU);
    const pulse = smoothstep(pulseCutoffU, float(1.0), nSharp);
    const colorRgb = mix(
      fogColor,
      mix(gridDarkColor, gridBrightColor, pulse),
      fogFactor,
    ).mul(gridOpacityU);

    const centerDist = crossPos.sub(0.5).abs().mul(2);
    const edgeFade = smoothstep(float(1.0), float(0.3), centerDist);
    mat.colorNode = vec4(colorRgb, float(1.0));
    mat.opacityNode = edgeFade;
    return mat;
  }

  let gridBuild = buildBoxGridRibbons(
    GRID_HALF_W * aspect,
    GRID_HALF_H,
    GRID_DEPTH,
    GRID_CELL_SIZE,
    GRID_RIBBON_W,
  );
  let gridGeoCurrent = gridBuild.geo;
  let gridScrollEntries = gridBuild.scrollEntries;
  const gridMesh = new THREE.Mesh(gridGeoCurrent, makeGridMaterial());
  gridMesh.renderOrder = 5;
  gridMesh.frustumCulled = false;
  const gridGroup = new THREE.Group();
  // No shift needed — geometry is anchored to half-cell offsets so the
  // camera at (0,0) is always at the center of a cell.
  gridGroup.add(gridMesh);
  group.add(gridGroup);

  function updateAspect(newAspect) {
    currentAspect = newAspect;
    const next = rectFrameGeometry(RECT_H * newAspect, RECT_H, RECT_THICK);
    const prev = rectGeo;
    for (const r of rects) r.geometry = next;
    rectGeo = next;
    prev.dispose();

    // Rebuild grid geometry at new aspect width so it fills the viewport.
    // Also replaces the per-line scroll tracker — existing offsets are lost,
    // which is fine during a viewport resize.
    const nextBuild = buildBoxGridRibbons(
      GRID_HALF_W * newAspect,
      GRID_HALF_H,
      GRID_DEPTH,
      GRID_CELL_SIZE,
      GRID_RIBBON_W,
    );
    const prevGrid = gridGeoCurrent;
    gridMesh.geometry = nextBuild.geo;
    gridGeoCurrent = nextBuild.geo;
    gridScrollEntries = nextBuild.scrollEntries;
    prevGrid.dispose();
  }

  function recyclePlane(p) {
    p.position.z = -tunnelDepth;
    const ang = Math.random() * Math.PI * 2;
    const rad = DEAD_ZONE + Math.random() * (spread - DEAD_ZONE);
    p.position.x = Math.cos(ang) * rad * currentAspect;
    p.position.y = Math.sin(ang) * rad;
    p.userData.speed = baseSpeed * codeSpeedMul * (0.55 + Math.random() * 0.9);
  }

  function recycleRect(r) {
    // Jump back by the full rect span so uniform-speed rects stay evenly spaced.
    r.position.z -= RECT_SPAN;
  }

  function update(dt) {
    const sdt = dt * params.speedMultiplier;
    for (const p of planes) {
      p.position.z += p.userData.speed * sdt;
      if (p.position.z > 2.5) recyclePlane(p);
    }
    for (const r of rects) {
      r.position.z += r.userData.speed * sdt;
      if (r.position.z > 2.5) recycleRect(r);
    }

    // Per-line scroll: fixed-Z ribbons (transverse rungs, wall verticals,
    // lattice verticals) move forward in Z individually; when one passes the
    // camera it jumps back by a full tunnel-depth. The line's phase attribute
    // stays welded to that ribbon, so pulses never jump.
    gridTimeU.value += dt;
    const gridScrollSpeed = baseSpeed * 0.8 * params.speedMultiplier;
    const posArr = gridGeoCurrent.attributes.position.array;
    for (const entry of gridScrollEntries) {
      entry.offset += gridScrollSpeed * dt;
      if (entry.homeZs[0] + entry.offset > 2.5) entry.offset -= GRID_DEPTH;
      for (let v = 0; v < 4; v++) {
        posArr[(entry.baseIdx + v) * 3 + 2] = entry.homeZs[v] + entry.offset;
      }
    }
    gridGeoCurrent.attributes.position.needsUpdate = true;
  }

  function dispose() {
    for (const p of planes) {
      p.geometry.dispose();
      p.material.dispose();
    }
    for (const r of rects) {
      r.material.dispose();
    }
    rectGeo.dispose();
    gridMesh.material.dispose();
    gridGeoCurrent.dispose();
    for (const t of textures) t.dispose();
    group.clear();
  }

  return {
    group,
    update,
    dispose,
    updateAspect,
    uniforms: {
      rectOpacity: rectOpacityU,
      codeOpacity: codeOpacityU,
      gridOpacity: gridOpacityU,
      pulseSpeed: pulseSpeedU,
      pulseCutoff: pulseCutoffU,
      pulseFreq: pulseFreqU,
      pulseSharp: pulseSharpU,
    },
    params,
  };
}

// Helper: wait for VT323 to be ready so canvas text uses the right font.
export async function waitForTunnelFont() {
  if (!document.fonts) return;
  try {
    await document.fonts.load('22px "VT323"');
    await document.fonts.ready;
  } catch {
    // no-op; texture bake will use fallback
  }
}
