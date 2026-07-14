// Blender-style animation timeline / dope sheet (visualization only, no editing).
//
// Renders a bottom-docked panel with:
//  - a transport header (clip picker, frame stepping, play/pause, FPS, speed, loop)
//  - a canvas dope sheet: frame ruler, playhead, and per-node keyframe rows
//    grouped exactly like Blender's dope sheet (summary row -> node -> channels)
//
// The component never mutates keyframes; all interactions are read-only views
// onto the clip (scrubbing, zooming, expanding rows).

import * as THREE from 'three';
import type { AssetEntry } from './viewer';

export interface TimelineClip {
  entry: AssetEntry;
  /** Index into entry.asset.animations. */
  index: number;
  label: string;
  clip: THREE.AnimationClip;
}

/** Everything the timeline needs from the outside world. The host (main.ts)
 *  owns the Viewer; the timeline only asks it to seek/play — it never drives
 *  the mixer directly, so play state stays in one place. */
export interface TimelineHost {
  /** Current time of the active action in seconds. */
  getTime(): number;
  isPlaying(): boolean;
  /** Seek the active action (activating one first if needed). */
  seekSeconds(t: number): void;
  togglePlay(): void;
  setSpeed(speed: number): void;
  setLoop(loop: boolean): void;
  /** User picked a different clip in the timeline's dropdown. */
  selectClip(index: number): void;
}

interface ChannelRow {
  label: string;
  /** Unique keyframe times in seconds, sorted ascending. */
  times: number[];
}

interface TrackGroup {
  name: string;
  channels: ChannelRow[];
  /** Aggregated unique key times across all channels. */
  times: number[];
  expanded: boolean;
}

interface FlatRow {
  kind: 'summary' | 'group' | 'channel';
  label: string;
  times: number[];
  group?: TrackGroup;
}

// Layout constants (CSS pixels).
const LABEL_W = 180;
const RULER_H = 22;
const ROW_H = 18;
const LEFT_PAD = 12; // gap between the label column and frame 0 at default zoom

const COMMON_RATES = [12, 15, 24, 25, 30, 48, 50, 60, 90, 120];

/** Guess the sampling rate of a clip from the spacing of its keyframes.
 *  Baked exports (FBX/GLTF) key every frame, so the modal key delta is the
 *  frame time. Falls back to 24 fps (Blender's default) when keys are too
 *  sparse to tell. */
export function detectFps(clip: THREE.AnimationClip): number {
  const counts = new Map<number, number>();
  for (const track of clip.tracks) {
    const t = track.times;
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      if (d <= 1e-6) continue;
      // Bucket at 0.1 ms so float noise from export roundtrips collapses.
      const key = Math.round(d * 10000);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let modal = 0;
  let best = 0;
  for (const [key, n] of counts) {
    if (n > best) { best = n; modal = key / 10000; }
  }
  if (modal <= 0) return 24;
  const rate = 1 / modal;
  for (const c of COMMON_RATES) {
    if (Math.abs(rate - c) / c < 0.03) return c;
  }
  if (rate < 6 || rate > 240) return 24;
  return Math.round(rate);
}

const CHANNEL_LABELS: Record<string, string> = {
  position: 'Position',
  quaternion: 'Rotation',
  rotation: 'Rotation (Euler)',
  scale: 'Scale',
  morphTargetInfluences: 'Morph',
  opacity: 'Opacity',
  color: 'Color',
};

/** Group a clip's tracks by target node, Blender-dope-sheet style. */
function buildGroups(clip: THREE.AnimationClip): TrackGroup[] {
  const byNode = new Map<string, TrackGroup>();
  for (const track of clip.tracks) {
    let nodeName = '';
    let propertyName = track.name;
    let propertyIndex: string | undefined;
    try {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      nodeName = parsed.nodeName ?? '';
      propertyName = parsed.propertyName ?? track.name;
      propertyIndex = parsed.propertyIndex;
    } catch {
      // Keep the raw track name as the channel label.
    }
    const groupName = nodeName || '(scene)';
    let group = byNode.get(groupName);
    if (!group) {
      group = { name: groupName, channels: [], times: [], expanded: false };
      byNode.set(groupName, group);
    }
    let label = CHANNEL_LABELS[propertyName] ?? propertyName;
    if (propertyIndex !== undefined) label += ` · ${propertyIndex}`;
    const times = dedupeSorted(track.times);
    group.channels.push({ label, times });
  }
  for (const group of byNode.values()) {
    group.times = mergeTimes(group.channels.map((c) => c.times));
  }
  return Array.from(byNode.values());
}

function dedupeSorted(times: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (out.length === 0 || t - out[out.length - 1] > 1e-6) out.push(t);
  }
  return out;
}

function mergeTimes(lists: number[][]): number[] {
  const all: number[] = [];
  for (const l of lists) all.push(...l);
  all.sort((a, b) => a - b);
  return dedupeSorted(all);
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

export class TimelinePanel {
  private readonly host: TimelineHost;

  private readonly root = $('timeline');
  private readonly body = $('tlBody');
  private readonly canvas = $<HTMLCanvasElement>('tlCanvas');
  private readonly clipSelect = $<HTMLSelectElement>('tlClipSelect');
  private readonly playBtn = $<HTMLButtonElement>('tlPlay');
  private readonly frameInput = $<HTMLInputElement>('tlFrameInput');
  private readonly frameTotal = $('tlFrameTotal');
  private readonly timeLabel = $('tlTimeLabel');
  private readonly fpsSelect = $<HTMLSelectElement>('tlFps');
  private readonly speedSelect = $<HTMLSelectElement>('tlSpeed');
  private readonly loopBtn = $<HTMLButtonElement>('tlLoop');
  private readonly collapseBtn = $<HTMLButtonElement>('tlCollapse');

  private clips: TimelineClip[] = [];
  private activeIdx = -1;
  private groups: TrackGroup[] = [];
  private flatRows: FlatRow[] = [];
  private fps = 24;
  private fpsAuto = 24;
  private totalFrames = 1;
  private duration = 0;

  // View state.
  private pxPerFrame = 6;
  private scrollX = -LEFT_PAD; // horizontal offset in px (frame 0 sits at LABEL_W - scrollX)
  private scrollY = 0;
  private scrubbing = false;
  private looping = true;

  private width = 0;
  private height = 0;
  private drawQueued = false;
  /** True while the last fitView() ran against a zero/hidden panel width; the
   *  next real resize re-fits so the clip fills the visible track area. */
  private needsFit = true;

  constructor(host: TimelineHost) {
    this.host = host;

    new ResizeObserver(() => {
      this.resizeCanvas();
      if (this.needsFit && this.width > LABEL_W + 60) {
        this.fitView();
      }
      this.requestDraw();
    }).observe(this.body);

    this.installHeader();
    this.installCanvasInput();
    this.installKeyboard();
  }

  // ---- Public API (called by main.ts) ----

  setClips(clips: TimelineClip[], activeIdx: number): void {
    this.clips = clips;
    this.clipSelect.innerHTML = '';
    for (let i = 0; i < clips.length; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = clips[i].label;
      opt.title = clips[i].label;
      this.clipSelect.appendChild(opt);
    }
    this.root.classList.toggle('hidden', clips.length === 0);
    if (clips.length === 0) {
      this.activeIdx = -1;
      this.groups = [];
      this.flatRows = [];
      return;
    }
    this.setActiveClip(Math.max(0, Math.min(activeIdx, clips.length - 1)));
  }

  /** Point the dope sheet at a clip (does not touch playback). */
  setActiveClip(idx: number): void {
    if (idx < 0 || idx >= this.clips.length) return;
    this.activeIdx = idx;
    this.clipSelect.value = String(idx);
    const clip = this.clips[idx].clip;
    this.duration = clip.duration;
    this.fpsAuto = detectFps(clip);
    this.fps = this.fpsAuto;
    this.refreshFpsOptions();
    this.groups = buildGroups(clip);
    this.rebuildRows();
    this.recomputeFrameCount();
    this.fitView();
    this.requestDraw();
  }

  setPlaying(playing: boolean): void {
    this.playBtn.textContent = playing ? '❚❚' : '▶';
    this.playBtn.title = playing ? 'Pause (Space)' : 'Play (Space)';
  }

  setSpeedDisplay(speed: number): void {
    // Snap to the closest preset for display; the actual speed is whatever
    // the sidebar slider says.
    let best = 0;
    let bestDiff = Infinity;
    for (const opt of Array.from(this.speedSelect.options)) {
      const v = Number(opt.value);
      const diff = Math.abs(v - speed);
      if (diff < bestDiff) { bestDiff = diff; best = v; }
    }
    this.speedSelect.value = String(best);
  }

  get currentFps(): number {
    return this.fps;
  }

  /** Index of the clip the dope sheet is showing, -1 when empty. */
  get activeClipIndex(): number {
    return this.activeIdx;
  }

  hasClips(): boolean {
    return this.clips.length > 0;
  }

  /** Redraw the playhead/frame readout from the host's current time. */
  refresh(): void {
    this.updateFrameReadout();
    this.requestDraw();
  }

  // ---- Header ----

  private installHeader(): void {
    this.clipSelect.addEventListener('change', () => {
      const idx = Number(this.clipSelect.value);
      if (Number.isFinite(idx)) this.host.selectClip(idx);
    });

    this.playBtn.addEventListener('click', () => this.host.togglePlay());
    $('tlToStart').addEventListener('click', () => this.seekFrame(0));
    $('tlToEnd').addEventListener('click', () => this.seekFrame(this.totalFrames));
    $('tlPrevFrame').addEventListener('click', () => this.stepFrame(-1));
    $('tlNextFrame').addEventListener('click', () => this.stepFrame(1));
    $('tlPrevKey').addEventListener('click', () => this.jumpToKey(-1));
    $('tlNextKey').addEventListener('click', () => this.jumpToKey(1));

    this.frameInput.addEventListener('change', () => {
      const f = Number(this.frameInput.value);
      if (Number.isFinite(f)) this.seekFrame(Math.round(f));
    });

    this.fpsSelect.addEventListener('change', () => {
      const v = Number(this.fpsSelect.value);
      if (!Number.isFinite(v) || v <= 0) return;
      this.fps = v;
      this.recomputeFrameCount();
      this.fitView();
      this.refresh();
    });

    this.speedSelect.addEventListener('change', () => {
      const s = Number(this.speedSelect.value);
      if (Number.isFinite(s) && s > 0) this.host.setSpeed(s);
    });

    this.loopBtn.addEventListener('click', () => {
      this.looping = !this.looping;
      this.loopBtn.classList.toggle('active', this.looping);
      this.host.setLoop(this.looping);
    });

    this.collapseBtn.addEventListener('click', () => {
      const collapsed = this.root.classList.toggle('collapsed');
      this.collapseBtn.textContent = collapsed ? '▴' : '▾';
      this.collapseBtn.title = collapsed ? 'Expand timeline' : 'Collapse timeline';
      if (!collapsed) this.requestDraw();
    });
  }

  private refreshFpsOptions(): void {
    this.fpsSelect.innerHTML = '';
    const rates = COMMON_RATES.includes(this.fpsAuto)
      ? COMMON_RATES
      : [...COMMON_RATES, this.fpsAuto].sort((a, b) => a - b);
    for (const r of rates) {
      const opt = document.createElement('option');
      opt.value = String(r);
      opt.textContent = r === this.fpsAuto ? `${r} (auto)` : String(r);
      this.fpsSelect.appendChild(opt);
    }
    this.fpsSelect.value = String(this.fps);
  }

  private recomputeFrameCount(): void {
    this.totalFrames = Math.max(1, Math.round(this.duration * this.fps));
    this.frameTotal.textContent = `/ ${this.totalFrames}`;
    this.frameInput.max = String(this.totalFrames);
  }

  private updateFrameReadout(): void {
    const t = this.host.getTime();
    if (document.activeElement !== this.frameInput) {
      this.frameInput.value = String(Math.round(t * this.fps));
    }
    this.timeLabel.textContent = `${t.toFixed(2)}s`;
  }

  // ---- Playback helpers ----

  private seekFrame(frame: number): void {
    if (this.activeIdx < 0) return;
    const f = Math.max(0, Math.min(frame, this.totalFrames));
    this.host.seekSeconds(Math.min(f / this.fps, this.duration));
    this.refresh();
  }

  private stepFrame(delta: number): void {
    const f = Math.round(this.host.getTime() * this.fps) + delta;
    this.seekFrame(f);
  }

  /** Jump to the next (+1) / previous (-1) keyframe in the summary row,
   *  mirroring Blender's Up/Down arrow behavior. */
  private jumpToKey(dir: 1 | -1): void {
    const summary = this.flatRows[0];
    if (!summary || summary.times.length === 0) return;
    const t = this.host.getTime();
    const eps = 1e-4;
    let target: number | undefined;
    if (dir > 0) {
      target = summary.times.find((k) => k > t + eps);
    } else {
      for (let i = summary.times.length - 1; i >= 0; i--) {
        if (summary.times[i] < t - eps) { target = summary.times[i]; break; }
      }
    }
    if (target === undefined) return;
    this.host.seekSeconds(Math.min(target, this.duration));
    this.refresh();
  }

  // ---- Rows ----

  private rebuildRows(): void {
    const rows: FlatRow[] = [];
    const clipName = this.clips[this.activeIdx]?.clip.name || 'Summary';
    rows.push({
      kind: 'summary',
      label: clipName,
      times: mergeTimes(this.groups.map((g) => g.times)),
    });
    for (const group of this.groups) {
      rows.push({ kind: 'group', label: group.name, times: group.times, group });
      if (group.expanded) {
        for (const ch of group.channels) {
          rows.push({ kind: 'channel', label: ch.label, times: ch.times });
        }
      }
    }
    this.flatRows = rows;
    this.clampScroll();
  }

  // ---- View transforms ----

  private frameToX(frame: number): number {
    return LABEL_W + frame * this.pxPerFrame - this.scrollX;
  }

  private xToFrame(x: number): number {
    return (x - LABEL_W + this.scrollX) / this.pxPerFrame;
  }

  private fitView(): void {
    this.needsFit = this.width <= LABEL_W + 60;
    const avail = Math.max(50, this.width - LABEL_W - LEFT_PAD * 2);
    this.pxPerFrame = Math.max(0.02, Math.min(40, avail / this.totalFrames));
    this.scrollX = -LEFT_PAD;
    this.scrollY = 0;
  }

  private clampScroll(): void {
    const contentH = this.flatRows.length * ROW_H;
    const viewH = Math.max(0, this.height - RULER_H);
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, contentH - viewH)));
    const contentW = this.totalFrames * this.pxPerFrame;
    this.scrollX = Math.max(-LEFT_PAD * 2, Math.min(this.scrollX, contentW - 40));
  }

  // ---- Input ----

  private installCanvasInput(): void {
    this.canvas.addEventListener('pointerdown', (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      if (x <= LABEL_W && y > RULER_H) {
        // Label column: toggle group expansion.
        const idx = Math.floor((y - RULER_H + this.scrollY) / ROW_H);
        const row = this.flatRows[idx];
        if (row?.group) {
          row.group.expanded = !row.group.expanded;
          this.rebuildRows();
          this.requestDraw();
        }
        return;
      }
      if (x > LABEL_W) {
        this.scrubbing = true;
        this.canvas.setPointerCapture(ev.pointerId);
        this.scrubTo(x);
      }
    });

    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this.scrubbing) return;
      const rect = this.canvas.getBoundingClientRect();
      this.scrubTo(ev.clientX - rect.left);
    });

    const endScrub = (ev: PointerEvent): void => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      try { this.canvas.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    };
    this.canvas.addEventListener('pointerup', endScrub);
    this.canvas.addEventListener('pointercancel', endScrub);

    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        if (ev.ctrlKey || ev.metaKey) {
          // Zoom around the cursor.
          const rect = this.canvas.getBoundingClientRect();
          const x = Math.max(LABEL_W, ev.clientX - rect.left);
          const frameAt = this.xToFrame(x);
          const factor = Math.exp(-ev.deltaY * 0.0022);
          this.pxPerFrame = Math.max(0.02, Math.min(60, this.pxPerFrame * factor));
          this.scrollX = frameAt * this.pxPerFrame - (x - LABEL_W);
        } else if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
          this.scrollX += ev.deltaX !== 0 ? ev.deltaX : ev.deltaY;
        } else {
          this.scrollY += ev.deltaY;
        }
        this.clampScroll();
        this.requestDraw();
      },
      { passive: false },
    );
  }

  /** Scrub the playhead to canvas-x, snapping to whole frames like Blender. */
  private scrubTo(x: number): void {
    const frame = Math.round(this.xToFrame(x));
    this.seekFrame(frame);
  }

  private installKeyboard(): void {
    document.addEventListener('keydown', (ev) => {
      if (!this.hasClips()) return;
      const target = ev.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      switch (ev.code) {
        case 'Space':
          ev.preventDefault();
          this.host.togglePlay();
          break;
        case 'ArrowLeft':
          ev.preventDefault();
          if (ev.shiftKey) this.seekFrame(0);
          else this.stepFrame(-1);
          break;
        case 'ArrowRight':
          ev.preventDefault();
          if (ev.shiftKey) this.seekFrame(this.totalFrames);
          else this.stepFrame(1);
          break;
        case 'ArrowUp':
          ev.preventDefault();
          this.jumpToKey(1);
          break;
        case 'ArrowDown':
          ev.preventDefault();
          this.jumpToKey(-1);
          break;
      }
    });
  }

  // ---- Drawing ----

  private resizeCanvas(): void {
    const rect = this.body.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.clampScroll();
  }

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
    if (this.root.classList.contains('hidden') || this.root.classList.contains('collapsed')) return;
    if (this.activeIdx < 0) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = this.width;
    const H = this.height;
    const bg = this.css('--bg', '#1e1e1e');
    const panelBg = this.css('--panel-bg', '#252526');
    const border = this.css('--panel-border', '#3c3c3c');
    const fg = this.css('--fg', '#d4d4d4');
    const muted = this.css('--muted', '#9d9d9d');
    const accent = this.css('--accent', '#3794ff');

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // -- Track area (right of the label column, below the ruler) --
    const x0 = this.frameToX(0);
    const x1 = this.frameToX(this.totalFrames);

    // Out-of-range shading, Blender-style: area outside [0, end] is darker.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    if (x0 > LABEL_W) ctx.fillRect(LABEL_W, RULER_H, Math.min(x0, W) - LABEL_W, H - RULER_H);
    if (x1 < W) ctx.fillRect(Math.max(x1, LABEL_W), RULER_H, W - Math.max(x1, LABEL_W), H - RULER_H);

    // Frame grid ticks.
    const step = this.pickTickStep();
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, 0, W - LABEL_W, H);
    ctx.clip();

    ctx.strokeStyle = 'rgba(128, 128, 128, 0.14)';
    ctx.lineWidth = 1;
    const firstTick = Math.floor(this.xToFrame(LABEL_W) / step) * step;
    const lastTick = Math.ceil(this.xToFrame(W) / step) * step;
    for (let f = firstTick; f <= lastTick; f += step) {
      const x = Math.round(this.frameToX(f)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // -- Rows --
    const firstRow = Math.max(0, Math.floor(this.scrollY / ROW_H));
    const lastRow = Math.min(this.flatRows.length - 1, Math.ceil((this.scrollY + H - RULER_H) / ROW_H));
    for (let i = firstRow; i <= lastRow; i++) {
      const row = this.flatRows[i];
      const y = RULER_H + i * ROW_H - this.scrollY;
      if (row.kind !== 'channel') {
        ctx.fillStyle = row.kind === 'summary' ? 'rgba(96, 160, 96, 0.10)' : 'rgba(128, 128, 128, 0.07)';
        ctx.fillRect(LABEL_W, y, W - LABEL_W, ROW_H);
      }
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.10)';
      ctx.beginPath();
      ctx.moveTo(LABEL_W, y + ROW_H + 0.5);
      ctx.lineTo(W, y + ROW_H + 0.5);
      ctx.stroke();

      this.drawKeys(ctx, row, y);
    }

    // -- Playhead --
    const time = this.host.getTime();
    const playheadX = this.frameToX(time * this.fps);
    if (playheadX >= LABEL_W - 1) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, RULER_H);
      ctx.lineTo(playheadX, H);
      ctx.stroke();
    }
    ctx.restore();

    // -- Ruler --
    ctx.fillStyle = panelBg;
    ctx.fillRect(LABEL_W, 0, W - LABEL_W, RULER_H);
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(LABEL_W, RULER_H + 0.5);
    ctx.lineTo(W, RULER_H + 0.5);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, 0, W - LABEL_W, RULER_H);
    ctx.clip();
    ctx.font = '10px var(--vscode-font-family, sans-serif)';
    ctx.fillStyle = muted;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let f = firstTick; f <= lastTick; f += step) {
      const x = this.frameToX(f);
      ctx.fillRect(x, RULER_H - 5, 1, 5);
      ctx.fillText(String(f), x + 3, RULER_H / 2);
    }

    // Current-frame chip on the playhead (Blender's blue tag).
    if (playheadX >= LABEL_W - 30) {
      const label = String(Math.round(time * this.fps));
      const tw = ctx.measureText(label).width;
      const chipW = tw + 10;
      ctx.fillStyle = accent;
      roundRect(ctx, playheadX - chipW / 2, 3, chipW, RULER_H - 7, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(label, playheadX, RULER_H / 2 - 1);
    }
    ctx.restore();

    // -- Label column --
    ctx.fillStyle = panelBg;
    ctx.fillRect(0, 0, LABEL_W, H);
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(LABEL_W + 0.5, 0);
    ctx.lineTo(LABEL_W + 0.5, H);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, LABEL_W, H - RULER_H);
    ctx.clip();
    ctx.font = '11px var(--vscode-font-family, sans-serif)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = firstRow; i <= lastRow; i++) {
      const row = this.flatRows[i];
      const y = RULER_H + i * ROW_H - this.scrollY;
      const cy = y + ROW_H / 2;
      let tx = 8;
      if (row.kind === 'group') {
        ctx.fillStyle = muted;
        ctx.fillText(row.group?.expanded ? '▾' : '▸', tx, cy);
        tx += 12;
        ctx.fillStyle = fg;
      } else if (row.kind === 'channel') {
        tx += 22;
        ctx.fillStyle = muted;
      } else {
        ctx.fillStyle = fg;
        ctx.font = 'bold 11px var(--vscode-font-family, sans-serif)';
      }
      ctx.fillText(truncate(ctx, row.label, LABEL_W - tx - 6), tx, cy);
      if (row.kind === 'summary') ctx.font = '11px var(--vscode-font-family, sans-serif)';
    }
    ctx.restore();

    // Ruler corner above the label column.
    ctx.fillStyle = panelBg;
    ctx.fillRect(0, 0, LABEL_W, RULER_H);
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(LABEL_W, RULER_H + 0.5);
    ctx.moveTo(LABEL_W + 0.5, 0);
    ctx.lineTo(LABEL_W + 0.5, RULER_H);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.font = '10px var(--vscode-font-family, sans-serif)';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${this.fps} fps`, 8, RULER_H / 2);
  }

  private drawKeys(ctx: CanvasRenderingContext2D, row: FlatRow, y: number): void {
    const cy = y + ROW_H / 2;
    const size = row.kind === 'channel' ? 3.2 : 4;
    const minFrame = this.xToFrame(LABEL_W) - 1;
    const maxFrame = this.xToFrame(this.width) + 1;
    const minT = minFrame / this.fps;
    const maxT = maxFrame / this.fps;

    ctx.fillStyle = row.kind === 'channel' ? '#b9b9b9' : '#e6e6e6';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineWidth = 1;

    // Binary search the first visible key so huge baked clips stay cheap.
    let lo = 0;
    let hi = row.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (row.times[mid] < minT) lo = mid + 1;
      else hi = mid;
    }

    let lastX = -Infinity;
    for (let i = lo; i < row.times.length; i++) {
      const t = row.times[i];
      if (t > maxT) break;
      const x = this.frameToX(t * this.fps);
      // Skip keys that would land on the same pixel — a baked 60fps clip zoomed
      // out would otherwise draw thousands of overlapping diamonds.
      if (x - lastX < 1.5) continue;
      lastX = x;
      ctx.beginPath();
      ctx.moveTo(x, cy - size);
      ctx.lineTo(x + size, cy);
      ctx.lineTo(x, cy + size);
      ctx.lineTo(x - size, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  private pickTickStep(): number {
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    for (const s of steps) {
      if (s * this.pxPerFrame >= 55) return s;
    }
    return steps[steps.length - 1];
  }
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
