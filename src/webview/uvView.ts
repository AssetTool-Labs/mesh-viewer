import type { BufferGeometry, BufferAttribute } from 'three';
import { edgeKeyOf, idsInRegion, pointInPolygon, type ElementMode, type Topology } from './elementTopology';

export type AreaTool = 'box' | 'lasso';

/** Everything the view needs to draw and pick elements; owned by main.ts and
 *  swapped on every selection change (the sets are live references). */
export interface UVElementContext {
  mode: Exclude<ElementMode, 'off'>;
  tool: AreaTool;
  topo: Topology;
  geometry: BufferGeometry;
  selected: ReadonlySet<number>;
  hovered: number | null;
  onHover(id: number | null): void;
  onClick(id: number | null, extend: boolean): void;
  onArea(ids: Set<number>, extend: boolean): void;
  onLinked(id: number, extend: boolean): void;
}

/** Full-resolution image the view paints; whatever the texture already holds
 *  (no copy) or a GPU read-back canvas for compressed textures. */
export interface UVBacking {
  source: CanvasImageSource;
  width: number;
  height: number;
}

interface WireCache {
  key: string;
  path: Path2D;
}

/**
 * Pan/zoom viewport for one texture plus its UV wireframe. Everything is
 * drawn by hand through one `setTransform`, so the image and the overlay can
 * never drift apart, and the wireframe keeps a 1px screen-space stroke at any
 * zoom. Texture space is in texels (x right, y down), matching the image; UV
 * → texel conversion follows the flipY rule the Textures tab already used.
 */
export class UVView {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly zoomLabel: HTMLElement;

  private backing: UVBacking | null = null;
  private backingKey = '';
  private flipped = true;
  private geometry: BufferGeometry | null = null;
  private wire: WireCache | null = null;
  private showWire = false;

  /** Screen (CSS px) = offset + scale * texel. */
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private fitScale = 1;
  private cssW = 1;
  private cssH = 1;

  private drawQueued = false;
  private dragging: { id: number; lastX: number; lastY: number; moved: number } | null = null;
  private elements: UVElementContext | null = null;
  /** Highlight paths are rebuilt only when the selection changes, not per
   *  frame — a box-selected patch can be tens of thousands of triangles, and
   *  rebuilding that every pan/zoom frame stalls the canvas for seconds. */
  private hlDirty = true;
  private hlSel: Path2D | null = null;
  private hlSelCount = 0;
  private hlHov: Path2D | null = null;
  /** In-progress box/lasso, in screen (CSS px) space. */
  private marquee: { tool: AreaTool; pts: Array<{ x: number; y: number }>; extend: boolean } | null = null;
  private readonly observer: ResizeObserver;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'uv-view';
    this.canvas = document.createElement('canvas');
    this.zoomLabel = document.createElement('div');
    this.zoomLabel.className = 'uv-zoom';
    this.root.append(this.canvas, this.zoomLabel);

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('dblclick', (ev) => this.onDblClick(ev));
    this.observer = new ResizeObserver(() => this.onResize());
    this.observer.observe(this.root);
  }

  /** Swap the image. The same `key` (e.g. a texture entry's stable key) keeps
   *  the current pan/zoom, so a panel rebuild does not throw the view away. */
  setTexture(backing: UVBacking, flipY: boolean, key: string): void {
    const sameView = key === this.backingKey && this.backing !== null;
    this.backing = backing;
    this.backingKey = key;
    this.flipped = flipY;
    this.wire = null; // texel mapping depends on size/flip
    if (!sameView) this.fit();
    this.requestDraw();
  }

  /** Geometry whose `uv` attribute is overlaid, or null to draw none. */
  /** Enable element picking/highlighting (null while selection mode is off). */
  setElementContext(ctx: UVElementContext | null): void {
    this.elements = ctx;
    this.hlDirty = true;
    this.root.classList.toggle('picking', !!ctx);
    this.requestDraw();
  }

  setWireframe(geometry: BufferGeometry | null): void {
    this.geometry = geometry;
    this.showWire = geometry !== null;
    this.requestDraw();
  }

  resetView(): void {
    this.fit();
    this.requestDraw();
  }

  /** Map a client-space point to UV (unwrapped, may fall outside [0,1]). */
  clientToUV(clientX: number, clientY: number): { u: number; v: number } | null {
    if (!this.backing) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left - this.offX) / this.scale;
    const y = (clientY - rect.top - this.offY) / this.scale;
    const u = x / this.backing.width;
    const v = this.flipped ? 1 - y / this.backing.height : y / this.backing.height;
    return { u, v };
  }

  dispose(): void {
    this.observer.disconnect();
    this.root.remove();
  }

  // ---- View transform ----

  private fit(): void {
    if (!this.backing) return;
    const pad = 0.96;
    this.fitScale = Math.min(this.cssW / this.backing.width, this.cssH / this.backing.height) * pad;
    this.scale = this.fitScale;
    this.offX = (this.cssW - this.backing.width * this.scale) / 2;
    this.offY = (this.cssH - this.backing.height * this.scale) / 2;
  }

  private onResize(): void {
    const rect = this.root.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    // Keep the texel under the viewport center fixed across a panel resize.
    const cx = (this.cssW / 2 - this.offX) / this.scale;
    const cy = (this.cssH / 2 - this.offY) / this.scale;
    const atFit = Math.abs(this.scale - this.fitScale) < 1e-6;
    this.cssW = w;
    this.cssH = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    if (atFit || !this.backing) {
      this.fit();
    } else {
      this.offX = w / 2 - cx * this.scale;
      this.offY = h / 2 - cy * this.scale;
    }
    this.requestDraw();
  }

  private zoomAt(px: number, py: number, factor: number): void {
    if (!this.backing) return;
    // Wide clamp: far enough out to see the tile as a dot, far enough in to
    // count texels. Float precision is fine across this range.
    const min = this.fitScale / 256;
    const max = Math.max(4096, this.fitScale * 1024);
    const next = Math.min(max, Math.max(min, this.scale * factor));
    const k = next / this.scale;
    this.offX = px - (px - this.offX) * k;
    this.offY = py - (py - this.offY) * k;
    this.scale = next;
    this.requestDraw();
  }

  private readonly onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    // deltaMode 1 = lines (mouse wheels on some platforms); treat as ~16px.
    const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
    this.zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.exp(-dy * 0.0025));
  };

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 && ev.button !== 1) return;
    this.canvas.setPointerCapture(ev.pointerId);
    this.dragging = { id: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY, moved: 0 };
    // With a selection mode on, a left-drag is an area select; pan moves to
    // the middle button or Alt+drag. With no mode, left-drag pans as before.
    if (this.elements && ev.button === 0 && !ev.altKey) {
      const rect = this.canvas.getBoundingClientRect();
      this.marquee = {
        tool: this.elements.tool,
        pts: [{ x: ev.clientX - rect.left, y: ev.clientY - rect.top }],
        extend: ev.shiftKey,
      };
    } else {
      this.root.classList.add('dragging');
    }
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (!this.dragging || ev.pointerId !== this.dragging.id) {
      // Plain mouse move: element hover.
      if (this.elements) this.elements.onHover(this.pickElement(ev.clientX, ev.clientY));
      return;
    }
    this.dragging.moved += Math.abs(ev.clientX - this.dragging.lastX) + Math.abs(ev.clientY - this.dragging.lastY);
    if (this.marquee) {
      const rect = this.canvas.getBoundingClientRect();
      const pt = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      if (this.marquee.tool === 'lasso') this.marquee.pts.push(pt);
      else this.marquee.pts[1] = pt;
    } else {
      this.offX += ev.clientX - this.dragging.lastX;
      this.offY += ev.clientY - this.dragging.lastY;
    }
    this.dragging.lastX = ev.clientX;
    this.dragging.lastY = ev.clientY;
    this.requestDraw();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (!this.dragging || ev.pointerId !== this.dragging.id) return;
    const wasClick = this.dragging.moved < 5;
    this.canvas.releasePointerCapture(ev.pointerId);
    this.dragging = null;
    this.root.classList.remove('dragging');
    const marquee = this.marquee;
    this.marquee = null;
    if (wasClick && ev.button === 0 && this.elements) {
      // A stationary press is a pick, not an area.
      this.elements.onClick(this.pickElement(ev.clientX, ev.clientY), ev.shiftKey);
    } else if (marquee && this.elements && marquee.pts.length > 1) {
      this.finishArea(marquee);
    }
    this.requestDraw();
  };

  private readonly onPointerLeave = (): void => {
    if (this.elements) this.elements.onHover(null);
  };

  // ---- Drawing ----

  requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private css(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const b = this.backing;
    if (!b) {
      this.zoomLabel.textContent = '';
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = this.scale;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.offX, dpr * this.offY);
    // Past 1:1, show the texels as they are instead of a blurred upscale.
    ctx.imageSmoothingEnabled = s < 1;
    try {
      ctx.drawImage(b.source, 0, 0, b.width, b.height);
    } catch {
      // An image that is still decoding throws; the panel rebuild that fires
      // once loads settle repaints us.
    }

    // Tile border, 1 CSS px regardless of zoom.
    ctx.lineWidth = 1 / s;
    ctx.strokeStyle = this.css('--panel-border', '#3c3c3c');
    ctx.strokeRect(0, 0, b.width, b.height);

    if (this.showWire && this.geometry) {
      const wire = this.wireframe(this.geometry, b, this.flipped);
      if (wire) {
        ctx.lineWidth = 1 / s;
        ctx.strokeStyle = 'rgba(76, 195, 247, 0.85)';
        ctx.stroke(wire);
      }
    }
    this.drawElements(ctx);

    if (this.marquee && this.marquee.pts.length > 1) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = '#4cc3f7';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      const pts = this.marquee.pts;
      if (this.marquee.tool === 'box') {
        ctx.strokeRect(pts[0].x, pts[0].y, pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    const zoom = s / this.fitScale;
    this.zoomLabel.textContent = zoom >= 10 ? `${zoom.toFixed(0)}×` : `${zoom.toFixed(2)}×`;
  }

  /** Zoom/center onto the selected (else hovered) elements' UV bounds (F). */
  frameElements(): boolean {
    const ctx = this.elements;
    const b = this.backing;
    if (!ctx || !b) return false;
    const uv = ctx.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!uv) return false;
    const ids = ctx.selected.size ? ctx.selected : ctx.hovered !== null ? [ctx.hovered] : null;
    if (!ids) return false;
    const t = ctx.topo;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const p = { x: 0, y: 0 };
    const add = (i: number, du: number, dv: number): void => {
      this.texelOf(uv, i, du, dv, p);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    };
    for (const id of ids) {
      if (ctx.mode === 'face') {
        if (id < 0 || id >= t.triCount) continue;
        const a = t.tris[id * 3];
        const du = Math.floor(uv.getX(a));
        const dv = Math.floor(uv.getY(a));
        add(a, du, dv);
        add(t.tris[id * 3 + 1], du, dv);
        add(t.tris[id * 3 + 2], du, dv);
      } else if (ctx.mode === 'vertex') {
        for (const i of t.repVerts.get(id) ?? []) add(i, Math.floor(uv.getX(i)), Math.floor(uv.getY(i)));
      } else {
        const copies = t.edgeCopies.get(id);
        if (!copies) continue;
        for (let i = 0; i < copies.length; i += 2) {
          const du = Math.floor(uv.getX(copies[i]));
          const dv = Math.floor(uv.getY(copies[i]));
          add(copies[i], du, dv);
          add(copies[i + 1], du, dv);
        }
      }
    }
    if (minX > maxX) return false;
    // Pad, clamp to the zoom range, and center; a single vertex gets a sane
    // close-up rather than an infinite zoom.
    const w = Math.max(maxX - minX, b.width * 0.01);
    const h = Math.max(maxY - minY, b.height * 0.01);
    const target = Math.min(this.cssW / w, this.cssH / h) * 0.7;
    const min = this.fitScale / 256;
    const max = Math.max(4096, this.fitScale * 1024);
    this.scale = Math.min(max, Math.max(min, target));
    this.offX = this.cssW / 2 - ((minX + maxX) / 2) * this.scale;
    this.offY = this.cssH / 2 - ((minY + maxY) / 2) * this.scale;
    this.requestDraw();
    return true;
  }

  /** Cancel an in-progress box/lasso (Esc). True if one was active. */
  cancelArea(): boolean {
    if (!this.marquee) return false;
    this.marquee = null;
    this.requestDraw();
    return true;
  }

  private onDblClick(ev: MouseEvent): void {
    // Double-click selects the UV island under the cursor; with no mode (or on
    // empty space) it keeps its old meaning: re-fit the view.
    if (this.elements) {
      const id = this.pickElement(ev.clientX, ev.clientY);
      if (id !== null) {
        this.elements.onLinked(id, ev.shiftKey);
        return;
      }
    }
    this.resetView();
  }

  private finishArea(marquee: { tool: AreaTool; pts: Array<{ x: number; y: number }>; extend: boolean }): void {
    const ctx = this.elements;
    const b = this.backing;
    if (!ctx || !b) return;
    const uv = ctx.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!uv) return;
    // Region test in texel space (the transform is uniform, so a screen box
    // stays an axis-aligned texel box).
    const toTexel = (p: { x: number; y: number }): { x: number; y: number } => ({
      x: (p.x - this.offX) / this.scale,
      y: (p.y - this.offY) / this.scale,
    });
    const pts = marquee.pts.map(toTexel);
    let inside: (x: number, y: number) => boolean;
    if (marquee.tool === 'box') {
      const minX = Math.min(pts[0].x, pts[1].x);
      const maxX = Math.max(pts[0].x, pts[1].x);
      const minY = Math.min(pts[0].y, pts[1].y);
      const maxY = Math.max(pts[0].y, pts[1].y);
      inside = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
    } else {
      inside = (x, y) => pointInPolygon(x, y, pts);
    }
    const t = ctx.topo;
    const p = { x: 0, y: 0 };
    const insideVert = (i: number): boolean => {
      this.texelOf(uv, i, Math.floor(uv.getX(i)), Math.floor(uv.getY(i)), p);
      return inside(p.x, p.y);
    };
    const q = { x: 0, y: 0 };
    const r = { x: 0, y: 0 };
    const insideTri = (f: number): boolean => {
      const a = t.tris[f * 3];
      const c = t.tris[f * 3 + 1];
      const d = t.tris[f * 3 + 2];
      const du = Math.floor(uv.getX(a));
      const dv = Math.floor(uv.getY(a));
      this.texelOf(uv, a, du, dv, p);
      this.texelOf(uv, c, du, dv, q);
      this.texelOf(uv, d, du, dv, r);
      return inside((p.x + q.x + r.x) / 3, (p.y + q.y + r.y) / 3);
    };
    ctx.onArea(idsInRegion(t, ctx.mode, insideVert, insideTri), marquee.extend);
  }

  // ---- Element picking & highlights ----

  /** Texel coords of buffer vertex i, shifted into the tile of du/dv. */
  private texelOf(uv: BufferAttribute, i: number, du: number, dv: number, out: { x: number; y: number }): void {
    const b = this.backing!;
    out.x = (uv.getX(i) - du) * b.width;
    const fv = uv.getY(i) - dv;
    out.y = (this.flipped ? 1 - fv : fv) * b.height;
  }

  /** Element under a client-space point, using the same per-triangle tile
   *  shift as the wireframe so picking matches what is drawn. */
  private pickElement(clientX: number, clientY: number): number | null {
    const ctx = this.elements;
    const b = this.backing;
    if (!ctx || !b) return null;
    const uv = ctx.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!uv) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = (clientX - rect.left - this.offX) / this.scale;
    const py = (clientY - rect.top - this.offY) / this.scale;
    const tol = 8 / this.scale; // 8 CSS px, in texel units
    const tol2 = tol * tol;
    const t = ctx.topo;
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 0, y: 0 };
    let best: number | null = null;
    let bestD = tol2;
    for (let f = 0; f < t.triCount; f++) {
      const a = t.tris[f * 3];
      const c = t.tris[f * 3 + 1];
      const d = t.tris[f * 3 + 2];
      const du = Math.floor(uv.getX(a));
      const dv = Math.floor(uv.getY(a));
      this.texelOf(uv, a, du, dv, p0);
      this.texelOf(uv, c, du, dv, p1);
      this.texelOf(uv, d, du, dv, p2);
      // Cheap reject: bounding box grown by the tolerance.
      const minX = Math.min(p0.x, p1.x, p2.x) - tol;
      const maxX = Math.max(p0.x, p1.x, p2.x) + tol;
      if (px < minX || px > maxX) continue;
      const minY = Math.min(p0.y, p1.y, p2.y) - tol;
      const maxY = Math.max(p0.y, p1.y, p2.y) + tol;
      if (py < minY || py > maxY) continue;
      if (ctx.mode === 'face') {
        if (pointInTri(px, py, p0, p1, p2)) return f;
      } else if (ctx.mode === 'vertex') {
        const corners = [a, c, d];
        const pts = [p0, p1, p2];
        for (let i = 0; i < 3; i++) {
          const dx = pts[i].x - px;
          const dy = pts[i].y - py;
          const dd = dx * dx + dy * dy;
          if (dd < bestD) {
            bestD = dd;
            best = t.rep[corners[i]];
          }
        }
      } else {
        const corners = [a, c, d];
        const pts = [p0, p1, p2];
        for (let i = 0; i < 3; i++) {
          const q0 = pts[i];
          const q1 = pts[(i + 1) % 3];
          const dd = distToSegSq(px, py, q0, q1);
          if (dd < bestD) {
            bestD = dd;
            best = edgeKeyOf(t, corners[i], corners[(i + 1) % 3]);
          }
        }
      }
    }
    return best;
  }

  /** Faces/edges of one id set as a texel-space Path2D (zoom-independent). */
  private buildHighlightPath(ids: Iterable<number>): { path: Path2D; count: number } | null {
    const ctx = this.elements;
    if (!ctx) return null;
    const uv = ctx.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!uv) return null;
    const t = ctx.topo;
    const p = { x: 0, y: 0 };
    const q = { x: 0, y: 0 };
    const r = { x: 0, y: 0 };
    const path = new Path2D();
    let count = 0;
    for (const id of ids) {
      if (ctx.mode === 'face') {
        if (id < 0 || id >= t.triCount) continue;
        const a = t.tris[id * 3];
        const c = t.tris[id * 3 + 1];
        const d = t.tris[id * 3 + 2];
        const du = Math.floor(uv.getX(a));
        const dv = Math.floor(uv.getY(a));
        this.texelOf(uv, a, du, dv, p);
        this.texelOf(uv, c, du, dv, q);
        this.texelOf(uv, d, du, dv, r);
        path.moveTo(p.x, p.y);
        path.lineTo(q.x, q.y);
        path.lineTo(r.x, r.y);
        path.closePath();
        count++;
      } else if (ctx.mode === 'edge') {
        const copies = t.edgeCopies.get(id);
        if (!copies) continue;
        for (let i = 0; i < copies.length; i += 2) {
          const a = copies[i];
          const c = copies[i + 1];
          const du = Math.floor(uv.getX(a));
          const dv = Math.floor(uv.getY(a));
          this.texelOf(uv, a, du, dv, p);
          this.texelOf(uv, c, du, dv, q);
          path.moveTo(p.x, p.y);
          path.lineTo(q.x, q.y);
        }
        count++;
      }
    }
    return count ? { path, count } : null;
  }

  /** Selected/hovered highlights over the wireframe. Faces/edges come from the
   *  cached paths; vertices are few and zoom-dependent, so they draw direct. */
  private drawElements(ctx2d: CanvasRenderingContext2D): void {
    const ctx = this.elements;
    const b = this.backing;
    if (!ctx || !b) return;
    const s = this.scale;

    if (ctx.mode === 'vertex') {
      const uv = ctx.geometry.getAttribute('uv') as BufferAttribute | undefined;
      if (!uv) return;
      const t = ctx.topo;
      const p = { x: 0, y: 0 };
      const dots = (ids: Iterable<number>, color: string, vr: number): void => {
        ctx2d.fillStyle = color;
        ctx2d.beginPath();
        for (const id of ids) {
          for (const i of t.repVerts.get(id) ?? []) {
            this.texelOf(uv, i, Math.floor(uv.getX(i)), Math.floor(uv.getY(i)), p);
            ctx2d.moveTo(p.x + vr, p.y);
            ctx2d.arc(p.x, p.y, vr, 0, Math.PI * 2);
          }
        }
        ctx2d.fill();
      };
      if (ctx.selected.size) dots(ctx.selected, '#ff9d2e', 4 / s);
      if (ctx.hovered !== null && !ctx.selected.has(ctx.hovered)) dots([ctx.hovered], '#4cc3f7', 5 / s);
      return;
    }

    if (this.hlDirty) {
      this.hlDirty = false;
      const sel = ctx.selected.size ? this.buildHighlightPath(ctx.selected) : null;
      this.hlSel = sel?.path ?? null;
      this.hlSelCount = sel?.count ?? 0;
      const hov =
        ctx.hovered !== null && !ctx.selected.has(ctx.hovered)
          ? this.buildHighlightPath([ctx.hovered])
          : null;
      this.hlHov = hov?.path ?? null;
    }
    const paint = (path: Path2D, color: string, emph: boolean, count: number): void => {
      ctx2d.fillStyle = color;
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = (emph ? 2.5 : 1.8) / s;
      if (ctx.mode === 'face') {
        ctx2d.globalAlpha = emph ? 0.5 : 0.35;
        ctx2d.fill(path);
        ctx2d.globalAlpha = 1;
        // Outlining tens of thousands of triangles costs more than it shows.
        if (count <= 2000) ctx2d.stroke(path);
      } else {
        ctx2d.stroke(path);
      }
    };
    if (this.hlSel) paint(this.hlSel, '#ff9d2e', false, this.hlSelCount);
    if (this.hlHov) paint(this.hlHov, '#4cc3f7', true, 1);
  }

  /** Deduped-edge wireframe in texel space, cached per geometry/size/flip. */
  private wireframe(geom: BufferGeometry, b: UVBacking, flipped: boolean): Path2D | null {
    const key = `${geom.uuid}|${b.width}x${b.height}|${flipped ? 'f' : 'n'}`;
    if (this.wire && this.wire.key === key) return this.wire.path;
    const uv = geom.getAttribute('uv') as BufferAttribute | undefined;
    if (!uv) return null;

    // UVs may live outside [0, 1] and rely on wrapping at sample time (e.g.
    // DamagedHelmet's V spans [1, 2]). Like the modal overlay, translate each
    // triangle by the integer part of its first corner so it lands on the
    // visible tile; shifting per-triangle keeps seam-crossing triangles intact.
    const tx = (i: number, du: number): number => (uv.getX(i) - du) * b.width;
    const ty = (i: number, dv: number): number => {
      const fv = uv.getY(i) - dv;
      return (flipped ? 1 - fv : fv) * b.height;
    };

    const path = new Path2D();
    const seen = new Set<number>();
    const n = uv.count;
    const edge = (a: number, c: number, du: number, dv: number): void => {
      const lo = a < c ? a : c;
      const hi = a < c ? c : a;
      const id = lo * n + hi;
      if (seen.has(id)) return;
      seen.add(id);
      path.moveTo(tx(a, du), ty(a, dv));
      path.lineTo(tx(c, du), ty(c, dv));
    };
    const tri = (a: number, c: number, d: number): void => {
      const du = Math.floor(uv.getX(a));
      const dv = Math.floor(uv.getY(a));
      edge(a, c, du, dv); edge(c, d, du, dv); edge(d, a, du, dv);
    };
    const idx = geom.getIndex();
    if (idx) {
      for (let i = 0; i + 2 < idx.count; i += 3) tri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
    } else {
      for (let i = 0; i + 2 < n; i += 3) tri(i, i + 1, i + 2);
    }
    this.wire = { key, path };
    return path;
  }
}

function pointInTri(
  x: number,
  y: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  const s1 = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
  const s2 = (c.x - b.x) * (y - b.y) - (c.y - b.y) * (x - b.x);
  const s3 = (a.x - c.x) * (y - c.y) - (a.y - c.y) * (x - c.x);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

function distToSegSq(
  x: number,
  y: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx - x;
  const py = a.y + t * dy - y;
  return px * px + py * py;
}
