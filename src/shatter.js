import earcut from 'earcut';

const EPS = 0.5;

export function computeFaces(segments, boundaryPolygon) {
  const boundarySegs = [];
  const bn = boundaryPolygon.length;
  for (let i = 0; i < bn; i++) {
    const a = boundaryPolygon[i];
    const b = boundaryPolygon[(i + 1) % bn];
    boundarySegs.push([a.x, a.y, b.x, b.y]);
  }
  const allSegs = [...segments, ...boundarySegs];

  const splits = allSegs.map((s) => {
    const ax = s[0],
      ay = s[1],
      bx = s[2],
      by = s[3];
    return {
      ax,
      ay,
      bx,
      by,
      ts: [0, 1],
      minX: ax < bx ? ax : bx,
      maxX: ax > bx ? ax : bx,
      minY: ay < by ? ay : by,
      maxY: ay > by ? ay : by,
    };
  });

  for (let i = 0; i < splits.length; i++) {
    const si = splits[i];
    for (let j = i + 1; j < splits.length; j++) {
      const sj = splits[j];
      if (si.maxX < sj.minX || sj.maxX < si.minX || si.maxY < sj.minY || sj.maxY < si.minY) {
        continue;
      }
      const hit = segSeg(si, sj);
      if (hit) {
        si.ts.push(hit.t);
        sj.ts.push(hit.u);
      }
    }
  }

  const subSegs = [];
  for (const s of splits) {
    const unique = [...new Set(s.ts.map((t) => Math.round(t * 1e8) / 1e8))].sort((a, b) => a - b);
    const dx = s.bx - s.ax,
      dy = s.by - s.ay;
    for (let i = 0; i < unique.length - 1; i++) {
      const t0 = unique[i],
        t1 = unique[i + 1];
      if (t1 - t0 < 1e-9) continue;
      const p0 = { x: s.ax + t0 * dx, y: s.ay + t0 * dy };
      const p1 = { x: s.ax + t1 * dx, y: s.ay + t1 * dy };
      if (dist(p0, p1) > EPS) subSegs.push([p0, p1]);
    }
  }

  const verts = [];
  const vertMap = new Map();

  function addVert(p) {
    const k = `${Math.round(p.x / EPS)}_${Math.round(p.y / EPS)}`;
    if (vertMap.has(k)) return vertMap.get(k);
    const id = verts.length;
    verts.push({ x: p.x, y: p.y });
    vertMap.set(k, id);
    return id;
  }

  const edges = [];
  for (const [a, b] of subSegs) {
    const va = addVert(a),
      vb = addVert(b);
    if (va !== vb) edges.push([va, vb]);
  }

  // prune dangling edges (degree-1 vertices)
  const adj = verts.map(() => new Set());
  for (const [a, b] of edges) {
    adj[a].add(b);
    adj[b].add(a);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let v = 0; v < verts.length; v++) {
      if (adj[v].size === 1) {
        const other = [...adj[v]][0];
        adj[v].delete(other);
        adj[other].delete(v);
        changed = true;
      }
    }
  }

  const prunedEdges = [];
  const edgeSet = new Set();
  for (let v = 0; v < verts.length; v++) {
    for (const u of adj[v]) {
      const key = v < u ? `${v}_${u}` : `${u}_${v}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        prunedEdges.push([v, u]);
      }
    }
  }

  if (prunedEdges.length === 0) return [];

  // half-edge DCEL
  const he = [];
  for (const [a, b] of prunedEdges) {
    const i = he.length;
    he.push({ from: a, to: b, twin: i + 1, next: -1 });
    he.push({ from: b, to: a, twin: i, next: -1 });
  }

  const outgoing = verts.map(() => []);
  for (let i = 0; i < he.length; i++) outgoing[he[i].from].push(i);

  for (let v = 0; v < verts.length; v++) {
    outgoing[v].sort((a, b) => {
      const pa = verts[he[a].to],
        pb = verts[he[b].to];
      return (
        Math.atan2(pa.y - verts[v].y, pa.x - verts[v].x) -
        Math.atan2(pb.y - verts[v].y, pb.x - verts[v].x)
      );
    });
  }

  for (let i = 0; i < he.length; i++) {
    const dest = he[i].to;
    const outs = outgoing[dest];
    const twinIdx = outs.indexOf(he[i].twin);
    he[i].next = outs[(twinIdx - 1 + outs.length) % outs.length];
  }

  // walk faces
  const visited = new Uint8Array(he.length);
  const faces = [];

  for (let i = 0; i < he.length; i++) {
    if (visited[i]) continue;
    const face = [];
    let cur = i,
      safety = 0;
    do {
      if (safety++ > 50000) break;
      visited[cur] = 1;
      face.push(he[cur].from);
      cur = he[cur].next;
    } while (cur !== i && !visited[cur]);

    if (face.length >= 3) {
      const poly = face.map((vi) => verts[vi]);
      if (signedArea(poly) > 1) faces.push(poly);
    }
  }

  return faces;
}

export function triangulateFace(face) {
  const coords = [];
  for (const v of face) coords.push(v.x, v.y);
  return earcut(coords);
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function segSeg(s1, s2) {
  const dx1 = s1.bx - s1.ax,
    dy1 = s1.by - s1.ay;
  const dx2 = s2.bx - s2.ax,
    dy2 = s2.by - s2.ay;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const acx = s2.ax - s1.ax,
    acy = s2.ay - s1.ay;
  const t = (acx * dy2 - acy * dx2) / denom;
  const u = (acx * dy1 - acy * dx1) / denom;
  if (t < 1e-8 || t > 1 - 1e-8 || u < 1e-8 || u > 1 - 1e-8) return null;
  return { t, u };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function signedArea(poly) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area / 2;
}
