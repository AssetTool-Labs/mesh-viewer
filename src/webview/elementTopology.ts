import * as THREE from 'three';

export type ElementMode = 'off' | 'vertex' | 'edge' | 'face';

/**
 * Per-geometry topology for element selection, computed once and cached.
 *
 * Element ids are mode-dependent and seam-aware:
 * - face  → triangle index
 * - vertex → the *canonical* vertex (smallest buffer index among all buffer
 *   vertices sharing a position), so selecting a seam vertex selects every
 *   UV copy of it at once
 * - edge  → canonical key built from the two endpoint canonicals, so a seam
 *   edge selects both of its UV copies
 */
export interface Topology {
  vertCount: number;
  triCount: number;
  /** Triangle corner buffer indices, 3 per triangle (index buffer resolved). */
  tris: Uint32Array;
  /** Canonical (position-merged) representative per buffer vertex. */
  rep: Int32Array;
  /** Buffer vertices per canonical vertex — seam copies included. */
  repVerts: Map<number, number[]>;
  /** Canonical edge key → flattened unique buffer pairs [a0,b0,a1,b1,…]. */
  edgeCopies: Map<number, number[]>;
  /** UV island id per triangle (connectivity over shared buffer vertices). */
  islandOfTri: Int32Array;
  /** 3D component id per triangle (connectivity over merged positions). */
  componentOfTri: Int32Array;
}

export function edgeKeyOf(topo: Topology, a: number, b: number): number {
  const ra = topo.rep[a];
  const rb = topo.rep[b];
  return ra < rb ? ra * topo.vertCount + rb : rb * topo.vertCount + ra;
}

const cache = new WeakMap<THREE.BufferGeometry, Topology | null>();

class UnionFind {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r] = this.parent[this.parent[r]];
    return r;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

export function topologyOf(geom: THREE.BufferGeometry): Topology | null {
  if (cache.has(geom)) return cache.get(geom) ?? null;
  const topo = build(geom);
  cache.set(geom, topo);
  return topo;
}

function build(geom: THREE.BufferGeometry): Topology | null {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const vertCount = pos.count;

  const index = geom.getIndex();
  const triCount = Math.floor((index ? index.count : vertCount) / 3);
  const tris = new Uint32Array(triCount * 3);
  if (index) {
    for (let i = 0; i < triCount * 3; i++) tris[i] = index.getX(i);
  } else {
    for (let i = 0; i < triCount * 3; i++) tris[i] = i;
  }

  // Position-merge on exact float equality: loaders split seam vertices by
  // duplicating identical coordinates, so no epsilon is needed (and rounding
  // could weld genuinely distinct vertices on tiny meshes).
  const rep = new Int32Array(vertCount);
  const repVerts = new Map<number, number[]>();
  {
    const byPos = new Map<string, number>();
    for (let i = 0; i < vertCount; i++) {
      const key = `${pos.getX(i)}|${pos.getY(i)}|${pos.getZ(i)}`;
      let r = byPos.get(key);
      if (r === undefined) {
        r = i;
        byPos.set(key, r);
      }
      rep[i] = r;
      const list = repVerts.get(r);
      if (list) list.push(i);
      else repVerts.set(r, [i]);
    }
  }

  // Unique buffer edges grouped under their canonical key. `seenBuffer` keeps
  // an interior edge (shared by two triangles over the same buffer verts) from
  // being listed twice, while true seam copies (different buffer verts, same
  // canonical endpoints) all survive under one key.
  const edgeCopies = new Map<number, number[]>();
  const seenBuffer = new Set<number>();
  const uvIsles = new UnionFind(vertCount);
  const comps = new UnionFind(vertCount);
  const addEdge = (a: number, b: number): void => {
    const bufKey = a < b ? a * vertCount + b : b * vertCount + a;
    if (seenBuffer.has(bufKey)) return;
    seenBuffer.add(bufKey);
    const ra = rep[a];
    const rb = rep[b];
    const canon = ra < rb ? ra * vertCount + rb : rb * vertCount + ra;
    const list = edgeCopies.get(canon);
    if (list) list.push(a, b);
    else edgeCopies.set(canon, [a, b]);
  };
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3];
    const b = tris[t * 3 + 1];
    const c = tris[t * 3 + 2];
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
    uvIsles.union(a, b);
    uvIsles.union(a, c);
    comps.union(rep[a], rep[b]);
    comps.union(rep[a], rep[c]);
  }

  const islandOfTri = new Int32Array(triCount);
  const componentOfTri = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    islandOfTri[t] = uvIsles.find(tris[t * 3]);
    componentOfTri[t] = comps.find(rep[tris[t * 3]]);
  }

  return { vertCount, triCount, tris, rep, repVerts, edgeCopies, islandOfTri, componentOfTri };
}

const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const tmpSeg = new THREE.Vector3();

/**
 * Element id under a raycast hit: the face itself, its corner nearest to the
 * hit point, or its edge nearest to the hit point (world space, so the choice
 * matches what the cursor is visually closest to).
 */
export function pickFromIntersection(
  hit: THREE.Intersection,
  mode: Exclude<ElementMode, 'off'>,
  topo: Topology,
): number | null {
  const face = hit.faceIndex;
  if (face == null || face < 0 || face >= topo.triCount) return null;
  if (mode === 'face') return face;

  const mesh = hit.object as THREE.Mesh;
  const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const world = (i: number, out: THREE.Vector3): THREE.Vector3 =>
    out.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
  const corners = [topo.tris[face * 3], topo.tris[face * 3 + 1], topo.tris[face * 3 + 2]];

  if (mode === 'vertex') {
    let best = -1;
    let bestD = Infinity;
    for (const c of corners) {
      const d = world(c, vA).distanceToSquared(hit.point);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best >= 0 ? topo.rep[best] : null;
  }

  // edge: nearest of the triangle's three edges to the hit point.
  let bestKey: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 3];
    world(a, vA);
    world(b, vB);
    const d = distPointToSegmentSq(hit.point, vA, vB);
    if (d < bestD) {
      bestD = d;
      bestKey = edgeKeyOf(topo, a, b);
    }
  }
  return bestKey;
}

function distPointToSegmentSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  tmpSeg.subVectors(b, a);
  const len2 = tmpSeg.lengthSq();
  if (len2 === 0) return p.distanceToSquared(a);
  let t = (p.x - a.x) * tmpSeg.x + (p.y - a.y) * tmpSeg.y + (p.z - a.z) * tmpSeg.z;
  t = Math.max(0, Math.min(1, t / len2));
  tmpSeg.multiplyScalar(t).add(a);
  return p.distanceToSquared(tmpSeg);
}

/** All ids of one mode on this topology (for select-all). */
export function allIds(topo: Topology, mode: Exclude<ElementMode, 'off'>): Iterable<number> {
  if (mode === 'face') return { *[Symbol.iterator]() { for (let t = 0; t < topo.triCount; t++) yield t; } };
  if (mode === 'vertex') return topo.repVerts.keys();
  return topo.edgeCopies.keys();
}

/**
 * Ids of the current mode inside an area, driven by two predicates so the UV
 * view (texel space, per-tile shift) and the 3D view (screen projection) share
 * the same seam-aware semantics: a vertex counts if any UV copy is inside, an
 * edge if some copy has both endpoints inside, a face if its center is inside
 * (the predicate owns the center test).
 */
export function idsInRegion(
  topo: Topology,
  mode: Exclude<ElementMode, 'off'>,
  insideVert: (bufferIdx: number) => boolean,
  insideTri: (tri: number) => boolean,
): Set<number> {
  const out = new Set<number>();
  if (mode === 'vertex') {
    for (let i = 0; i < topo.vertCount; i++) if (insideVert(i)) out.add(topo.rep[i]);
  } else if (mode === 'edge') {
    for (const [key, copies] of topo.edgeCopies) {
      for (let i = 0; i < copies.length; i += 2) {
        if (insideVert(copies[i]) && insideVert(copies[i + 1])) {
          out.add(key);
          break;
        }
      }
    }
  } else {
    for (let t = 0; t < topo.triCount; t++) if (insideTri(t)) out.add(t);
  }
  return out;
}

/**
 * Ids of the connected patch containing `seed`, where `labels` picks the
 * connectivity: islandOfTri = UV island, componentOfTri = 3D component.
 */
export function linkedIds(
  topo: Topology,
  mode: Exclude<ElementMode, 'off'>,
  seed: number,
  labels: Int32Array,
): Set<number> {
  // Resolve the seed to one triangle, then take that triangle's label.
  let seedTri = -1;
  if (mode === 'face') {
    seedTri = seed;
  } else if (mode === 'vertex') {
    for (let t = 0; t < topo.triCount && seedTri < 0; t++) {
      for (let k = 0; k < 3; k++) if (topo.rep[topo.tris[t * 3 + k]] === seed) { seedTri = t; break; }
    }
  } else {
    const copies = topo.edgeCopies.get(seed);
    const a = copies ? copies[0] : -1;
    for (let t = 0; t < topo.triCount && seedTri < 0 && a >= 0; t++) {
      for (let k = 0; k < 3; k++) if (topo.tris[t * 3 + k] === a) { seedTri = t; break; }
    }
  }
  const out = new Set<number>();
  if (seedTri < 0 || seedTri >= topo.triCount) return out;
  const label = labels[seedTri];
  for (let t = 0; t < topo.triCount; t++) {
    if (labels[t] !== label) continue;
    const a = topo.tris[t * 3];
    const b = topo.tris[t * 3 + 1];
    const c = topo.tris[t * 3 + 2];
    if (mode === 'face') {
      out.add(t);
    } else if (mode === 'vertex') {
      out.add(topo.rep[a]);
      out.add(topo.rep[b]);
      out.add(topo.rep[c]);
    } else {
      out.add(edgeKeyOf(topo, a, b));
      out.add(edgeKeyOf(topo, b, c));
      out.add(edgeKeyOf(topo, c, a));
    }
  }
  return out;
}

/** Even-odd point-in-polygon in whatever 2D space the points live in. */
export function pointInPolygon(x: number, y: number, pts: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i].y;
    const yj = pts[j].y;
    if (yi > y === yj > y) continue;
    const xi = pts[i].x;
    const xj = pts[j].x;
    if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
