import type { BufferGeometry, BufferAttribute } from 'three';

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
  private dragging: { id: number; lastX: number; lastY: number } | null = null;
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
    this.canvas.addEventListener('dblclick', () => this.resetView());
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
    this.dragging = { id: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY };
    this.root.classList.add('dragging');
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (!this.dragging || ev.pointerId !== this.dragging.id) return;
    this.offX += ev.clientX - this.dragging.lastX;
    this.offY += ev.clientY - this.dragging.lastY;
    this.dragging.lastX = ev.clientX;
    this.dragging.lastY = ev.clientY;
    this.requestDraw();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (!this.dragging || ev.pointerId !== this.dragging.id) return;
    this.canvas.releasePointerCapture(ev.pointerId);
    this.dragging = null;
    this.root.classList.remove('dragging');
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

    const zoom = s / this.fitScale;
    this.zoomLabel.textContent = zoom >= 10 ? `${zoom.toFixed(0)}×` : `${zoom.toFixed(2)}×`;
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
