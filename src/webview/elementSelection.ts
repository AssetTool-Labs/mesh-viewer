import type * as THREE from 'three';
import { allIds, linkedIds, topologyOf, type ElementMode, type Topology } from './elementTopology';

/**
 * One selection, two views: the UV canvas and the 3D viewport both render this
 * state and both mutate it, so hover and selection stay mirrored for free.
 * Ids are mode-dependent (triangle index / canonical vertex / canonical edge
 * key — see elementTopology). Session-local; cleared on mode or mesh changes.
 */
class ElementSelection {
  mode: ElementMode = 'off';
  mesh: THREE.Mesh | null = null;
  topo: Topology | null = null;
  readonly selected = new Set<number>();
  hovered: number | null = null;
  /** Bumped on every change to the selection *set* (never on hover), so the
   *  views can cache their selection renderings across hover churn. */
  version = 0;

  private readonly listeners: Array<() => void> = [];

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  setMode(mode: ElementMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.selected.clear();
    this.hovered = null;
    this.version++;
    this.notify();
  }

  /** Selection follows one mesh at a time; switching meshes starts fresh. */
  setMesh(mesh: THREE.Mesh | null): void {
    if (this.mesh === mesh) return;
    this.mesh = mesh;
    this.topo = mesh ? topologyOf(mesh.geometry as THREE.BufferGeometry) : null;
    this.selected.clear();
    this.hovered = null;
    this.version++;
    this.notify();
  }

  click(id: number | null, extend: boolean): void {
    if (id === null) {
      if (!extend && this.selected.size) {
        this.selected.clear();
        this.version++;
        this.notify();
      }
      return;
    }
    if (extend) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else {
      this.selected.clear();
      this.selected.add(id);
    }
    this.version++;
    this.notify();
  }

  hover(id: number | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.notify();
  }

  /** Area-select result: replace or union into the selection. */
  applyArea(ids: Iterable<number>, extend: boolean): void {
    if (!extend) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.version++;
    this.notify();
  }

  /** `A`: everything when nothing is selected, otherwise back to nothing. */
  selectAllToggle(): void {
    if (this.mode === 'off' || !this.topo) return;
    if (this.selected.size) {
      this.selected.clear();
    } else {
      for (const id of allIds(this.topo, this.mode)) this.selected.add(id);
    }
    this.version++;
    this.notify();
  }

  /** Double-click: the connected patch around `seed` — the UV island when
   *  initiated from the UV view, the 3D component from the viewport. */
  selectLinked(seed: number, space: 'uv' | '3d', extend: boolean): void {
    if (this.mode === 'off' || !this.topo) return;
    const labels = space === 'uv' ? this.topo.islandOfTri : this.topo.componentOfTri;
    this.applyArea(linkedIds(this.topo, this.mode, seed, labels), extend);
  }

  clear(): void {
    if (!this.selected.size && this.hovered === null) return;
    this.selected.clear();
    this.hovered = null;
    this.version++;
    this.notify();
  }
}

export const elementSelection = new ElementSelection();
export type { ElementMode };
