import type { Doc, Patch } from '../crdt/Doc.js';
import type { ObjId, Value } from '../crdt/ops.js';

/**
 * Incremental rendering layer.
 *
 * Instead of re-materializing the whole document after every change, each object gets a version
 * number that bumps only when a patch touches it. Views are *shallow*: a map's view contains child
 * object references (not their contents), so when a card's title changes, only that card's
 * subscribers re-render. Neither its column nor the board does.
 *
 * `view(id)` is memoized per (object, version), so repeated reads between changes are free.
 */
export type ShallowValue = string | number | boolean | null | { ref: ObjId };
export type MapView = { kind: 'map'; id: ObjId; version: number; fields: Record<string, ShallowValue>; conflicts: Record<string, number> };
export type ListView = { kind: 'list'; id: ObjId; version: number; items: Array<{ elem: string; value: ShallowValue }> };
export type View = MapView | ListView;

export class IncrementalStore {
  private versions = new Map<ObjId, number>();
  private cache = new Map<ObjId, View>();
  private listeners = new Map<ObjId, Set<() => void>>();
  readonly metrics = { materializations: 0, notifications: 0 };

  constructor(private readonly doc: Doc) {}

  /** Called by the replica with the patches from each applied change. */
  applyPatches(patches: Patch[]): void {
    const touched = new Set(patches.map((p) => p.obj));
    for (const id of touched) {
      this.versions.set(id, this.version(id) + 1);
      this.cache.delete(id);
    }
    for (const id of touched) {
      for (const fn of this.listeners.get(id) ?? []) {
        this.metrics.notifications++;
        fn();
      }
    }
  }

  version(id: ObjId): number {
    return this.versions.get(id) ?? 0;
  }

  subscribe(id: ObjId, fn: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  view(id: ObjId): View | null {
    const hit = this.cache.get(id);
    if (hit) return hit;
    if (!this.doc.has(id)) return null;
    this.metrics.materializations++;
    const version = this.version(id);
    let v: View;
    if (this.doc.kind(id) === 'list') {
      v = { kind: 'list', id, version, items: this.doc.elements(id).map(([elem, value]) => ({ elem, value: shallow(value) })) };
    } else {
      const fields: Record<string, ShallowValue> = {};
      const conflicts: Record<string, number> = {};
      for (const k of this.doc.keys(id)) {
        fields[k] = shallow(this.doc.get(id, k)!);
        const c = this.doc.conflicts(id, k).length;
        if (c > 1) conflicts[k] = c;
      }
      v = { kind: 'map', id, version, fields, conflicts };
    }
    this.cache.set(id, v);
    return v;
  }
}

function shallow(v: Value): ShallowValue {
  return v;
}
