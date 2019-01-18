import * as vc from '../clock/vector.js';
import type { VectorClock } from '../clock/vector.js';
import type { Change, ElemId, ObjId, Op, Primitive, Value } from './ops.js';
import { ROOT } from './ops.js';

/**
 * A JSON document CRDT that *relies on causal delivery* (provided by CausalBroadcast). Assuming
 * causality keeps every data type small and simple:
 *
 * - Map keys are multi-value registers. A write supersedes exactly the writes that causally precede
 *   it; concurrent writes coexist, one is shown deterministically (highest actor id), and the rest are
 *   exposed as conflicts instead of being silently lost.
 * - Counters (`inc`) commute, so concurrent increments add up.
 * - Lists are RGA (Replicated Growable Array): each element is inserted after a reference element;
 *   concurrent inserts at the same spot are ordered by a Lamport-style id. Removal leaves a tombstone.
 *
 * Every applied op emits a Patch naming the object it touched, which is what makes incremental
 * rendering possible (see incremental/Store.ts).
 */

interface RegEntry {
  opId: string;
  clock: VectorClock;
  actor: string;
  value: Value | undefined; // undefined = deleted
}

interface MapObj {
  kind: 'map';
  keys: Map<string, RegEntry[]>;
  counters: Map<string, number>;
}

interface ListElem {
  id: ElemId;
  stamp: [number, string]; // [lamport, actor] for ordering concurrent inserts
  value: Value;
  deleted: boolean;
}

interface ListObj {
  kind: 'list';
  elems: ListElem[];
  index: Map<ElemId, number>; // rebuilt lazily
  dirtyIndex: boolean;
}

type Obj = MapObj | ListObj;

export interface Patch {
  obj: ObjId;
  kind: 'map' | 'list';
  key?: string;
  index?: number;
  action: 'set' | 'delete' | 'insert' | 'remove' | 'create';
}

export interface ApplyContext {
  opIdBase: string; // "actor:seq"; the i-th op in a change gets id `${base}.${i}`
  actor: string;
  clock: VectorClock;
}

function stampGreater(a: [number, string], b: [number, string]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

export class Doc {
  private objects = new Map<ObjId, Obj>([[ROOT, { kind: 'map', keys: new Map(), counters: new Map() }]]);

  applyChange(change: Change, ctx: ApplyContext): Patch[] {
    const patches: Patch[] = [];
    change.ops.forEach((op, i) => {
      const p = this.applyOp(op, `${ctx.opIdBase}.${i}`, ctx);
      if (p) patches.push(p);
    });
    return patches;
  }

  private applyOp(op: Op, opId: string, ctx: ApplyContext): Patch | null {
    switch (op.t) {
      case 'makeMap':
        if (!this.objects.has(op.id)) this.objects.set(op.id, { kind: 'map', keys: new Map(), counters: new Map() });
        return { obj: op.id, kind: 'map', action: 'create' };
      case 'makeList':
        if (!this.objects.has(op.id)) this.objects.set(op.id, { kind: 'list', elems: [], index: new Map(), dirtyIndex: false });
        return { obj: op.id, kind: 'list', action: 'create' };
      case 'set':
      case 'del': {
        const m = this.map(op.obj);
        const existing = m.keys.get(op.key) ?? [];
        // Keep only concurrent entries; anything that happened-before this write is superseded.
        const survivors = existing.filter((e) => !vc.leq(e.clock, ctx.clock) || e.opId === opId);
        survivors.push({ opId, clock: ctx.clock, actor: ctx.actor, value: op.t === 'set' ? op.value : undefined });
        m.keys.set(op.key, survivors);
        return { obj: op.obj, kind: 'map', key: op.key, action: op.t === 'set' ? 'set' : 'delete' };
      }
      case 'inc': {
        const m = this.map(op.obj);
        m.counters.set(op.key, (m.counters.get(op.key) ?? 0) + op.by);
        return { obj: op.obj, kind: 'map', key: op.key, action: 'set' };
      }
      case 'ins': {
        const l = this.list(op.obj);
        const stamp: [number, string] = [vc.sum(ctx.clock), ctx.actor];
        let pos = op.after === null ? 0 : this.indexOf(l, op.after) + 1;
        if (op.after !== null && pos === 0) throw new Error(`reference element ${op.after} not found (causality violated?)`);
        // RGA: skip over elements inserted concurrently at the same spot with a greater stamp.
        while (pos < l.elems.length && stampGreater(l.elems[pos]!.stamp, stamp)) pos++;
        l.elems.splice(pos, 0, { id: opId, stamp, value: op.value, deleted: false });
        l.dirtyIndex = true;
        return { obj: op.obj, kind: 'list', index: this.visibleIndex(l, pos), action: 'insert' };
      }
      case 'rem': {
        const l = this.list(op.obj);
        const i = this.indexOf(l, op.elem);
        if (i < 0) throw new Error(`element ${op.elem} not found`);
        const el = l.elems[i]!;
        if (el.deleted) return null;
        const visible = this.visibleIndex(l, i);
        el.deleted = true;
        return { obj: op.obj, kind: 'list', index: visible, action: 'remove' };
      }
    }
  }

  private map(id: ObjId): MapObj {
    const o = this.objects.get(id);
    if (!o || o.kind !== 'map') throw new Error(`no map ${id}`);
    return o;
  }

  private list(id: ObjId): ListObj {
    const o = this.objects.get(id);
    if (!o || o.kind !== 'list') throw new Error(`no list ${id}`);
    return o;
  }

  private indexOf(l: ListObj, elem: ElemId): number {
    if (l.dirtyIndex) {
      l.index = new Map(l.elems.map((e, i) => [e.id, i]));
      l.dirtyIndex = false;
    }
    return l.index.get(elem) ?? -1;
  }

  private visibleIndex(l: ListObj, rawIndex: number): number {
    let n = 0;
    for (let i = 0; i < rawIndex; i++) if (!l.elems[i]!.deleted) n++;
    return n;
  }

  // ------------------------------------------------------------------ reading

  has(id: ObjId): boolean {
    return this.objects.has(id);
  }

  kind(id: ObjId): 'map' | 'list' | undefined {
    return this.objects.get(id)?.kind;
  }

  /** Winning value for a map key (deterministic among concurrent writes). */
  get(obj: ObjId, key: string): Value | undefined {
    const m = this.map(obj);
    if (m.counters.has(key)) return m.counters.get(key)!;
    const entries = m.keys.get(key);
    if (!entries || entries.length === 0) return undefined;
    const winner = entries.reduce((a, b) => (b.actor > a.actor || (b.actor === a.actor && b.opId > a.opId) ? b : a));
    return winner.value;
  }

  /** All concurrent values for a key when there is a conflict (length > 1). */
  conflicts(obj: ObjId, key: string): Value[] {
    return (this.map(obj).keys.get(key) ?? []).filter((e) => e.value !== undefined).map((e) => e.value!);
  }

  keys(obj: ObjId): string[] {
    const m = this.map(obj);
    const out = new Set<string>();
    for (const [k] of m.counters) out.add(k);
    for (const [k] of m.keys) if (this.get(obj, k) !== undefined) out.add(k);
    return [...out].sort();
  }

  /** Visible list elements as [elemId, value]. */
  elements(obj: ObjId): Array<[ElemId, Value]> {
    return this.list(obj).elems.filter((e) => !e.deleted).map((e) => [e.id, e.value]);
  }

  /** Element id at a visible index (for building insert/remove ops from user positions). */
  elemAt(obj: ObjId, index: number): ElemId | null {
    if (index < 0) return null;
    const els = this.elements(obj);
    return index < els.length ? els[index]![0] : null;
  }

  /** Deep JSON view (used by tests and for the "full re-render" baseline). */
  toJSON(id: ObjId = ROOT, counter?: { visits: number }): unknown {
    if (counter) counter.visits++;
    const o = this.objects.get(id)!;
    const resolve = (v: Value | undefined): unknown =>
      v !== null && typeof v === 'object' && 'ref' in v ? this.toJSON(v.ref, counter) : (v as Primitive | undefined);
    if (o.kind === 'list') return this.elements(id).map(([, v]) => resolve(v));
    const out: Record<string, unknown> = {};
    for (const k of this.keys(id)) out[k] = resolve(this.get(id, k));
    return out;
  }

  /** Serializable snapshot (used to bootstrap peers after log compaction). */
  snapshot(): unknown {
    const objs: unknown[] = [];
    for (const [id, o] of this.objects) {
      if (o.kind === 'map') objs.push({ id, kind: 'map', keys: [...o.keys], counters: [...o.counters] });
      else objs.push({ id, kind: 'list', elems: o.elems });
    }
    return objs;
  }

  static fromSnapshot(snapshot: unknown): Doc {
    const d = new Doc();
    d.objects.clear();
    for (const raw of snapshot as Array<Record<string, unknown>>) {
      if (raw.kind === 'map') {
        d.objects.set(raw.id as string, { kind: 'map', keys: new Map(raw.keys as Array<[string, RegEntry[]]>), counters: new Map(raw.counters as Array<[string, number]>) });
      } else {
        d.objects.set(raw.id as string, { kind: 'list', elems: raw.elems as ListElem[], index: new Map(), dirtyIndex: true });
      }
    }
    return d;
  }
}
