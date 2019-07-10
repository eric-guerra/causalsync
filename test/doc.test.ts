import { describe, expect, it } from 'vitest';
import { Doc } from '../src/crdt/Doc.js';
import { ROOT } from '../src/crdt/ops.js';
import type { Change } from '../src/crdt/ops.js';
import { IncrementalStore } from '../src/incremental/Store.js';

function apply(doc: Doc, actor: string, seq: number, clock: Record<string, number>, change: Change) {
  return doc.applyChange(change, { opIdBase: `${actor}:${seq}`, actor, clock });
}

describe('map registers', () => {
  it('a causally later write supersedes; concurrent writes are kept as a visible conflict', () => {
    const d = new Doc();
    apply(d, 'a', 1, { a: 1 }, { ops: [{ t: 'set', obj: ROOT, key: 'title', value: 'v1' }] });
    apply(d, 'b', 1, { a: 1, b: 1 }, { ops: [{ t: 'set', obj: ROOT, key: 'title', value: 'v2' }] });
    expect(d.get(ROOT, 'title')).toBe('v2');
    expect(d.conflicts(ROOT, 'title')).toEqual(['v2']);

    // Concurrent: neither saw the other.
    apply(d, 'c', 1, { a: 1, b: 1, c: 1 }, { ops: [{ t: 'set', obj: ROOT, key: 'title', value: 'from c' }] });
    apply(d, 'a', 2, { a: 2, b: 1 }, { ops: [{ t: 'set', obj: ROOT, key: 'title', value: 'from a' }] });
    expect(d.conflicts(ROOT, 'title').sort()).toEqual(['from a', 'from c']);
    expect(d.get(ROOT, 'title'), 'deterministic winner: highest actor id').toBe('from c');

    // A later write that saw both resolves the conflict.
    apply(d, 'a', 3, { a: 3, b: 1, c: 1 }, { ops: [{ t: 'set', obj: ROOT, key: 'title', value: 'merged' }] });
    expect(d.conflicts(ROOT, 'title')).toEqual(['merged']);
  });

  it('deletes and counters', () => {
    const d = new Doc();
    apply(d, 'a', 1, { a: 1 }, { ops: [{ t: 'set', obj: ROOT, key: 'x', value: 1 }, { t: 'inc', obj: ROOT, key: 'votes', by: 2 }] });
    apply(d, 'b', 1, { a: 1, b: 1 }, { ops: [{ t: 'del', obj: ROOT, key: 'x' }] });
    apply(d, 'c', 1, { a: 1, c: 1 }, { ops: [{ t: 'inc', obj: ROOT, key: 'votes', by: 3 }] });
    expect(d.toJSON()).toEqual({ votes: 5 });
  });
});

describe('RGA lists', () => {
  it('orders concurrent inserts at the same position identically on every replica', () => {
    const changes: Array<[string, number, Record<string, number>, Change]> = [
      ['a', 1, { a: 1 }, { ops: [{ t: 'makeList', id: 'L' }, { t: 'ins', obj: 'L', after: null, value: 'x' }] }],
      ['b', 1, { a: 1, b: 1 }, { ops: [{ t: 'ins', obj: 'L', after: 'a:1.1', value: 'from-b' }] }],
      ['c', 1, { a: 1, c: 1 }, { ops: [{ t: 'ins', obj: 'L', after: 'a:1.1', value: 'from-c' }] }],
      ['b', 2, { a: 1, b: 2 }, { ops: [{ t: 'ins', obj: 'L', after: 'b:1.0', value: 'b-next' }] }],
    ];
    const orders = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 1, 3, 2]].map((perm) => {
      const d = new Doc();
      for (const i of perm) apply(d, ...changes[i]!);
      return d.elements('L').map(([, v]) => v);
    });
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
    expect(orders[0]![0]).toBe('x');
    expect(orders[0]!.indexOf('b-next'), "b's own run stays contiguous").toBe(orders[0]!.indexOf('from-b') + 1);
  });

  it('removal tombstones keep positions stable for later inserts', () => {
    const d = new Doc();
    apply(d, 'a', 1, { a: 1 }, { ops: [{ t: 'makeList', id: 'L' }, { t: 'ins', obj: 'L', after: null, value: 1 }] });
    apply(d, 'a', 2, { a: 2 }, { ops: [{ t: 'rem', obj: 'L', elem: 'a:1.1' }] });
    apply(d, 'b', 1, { a: 1, b: 1 }, { ops: [{ t: 'ins', obj: 'L', after: 'a:1.1', value: 2 }] }); // concurrent with the removal
    expect(d.elements('L').map(([, v]) => v)).toEqual([2]);
  });

  it('snapshots round-trip', () => {
    const d = new Doc();
    apply(d, 'a', 1, { a: 1 }, { ops: [{ t: 'makeList', id: 'L' }, { t: 'set', obj: ROOT, key: 'l', value: { ref: 'L' } }, { t: 'ins', obj: 'L', after: null, value: 'q' }] });
    const copy = Doc.fromSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    expect(copy.toJSON()).toEqual({ l: ['q'] });
    apply(copy, 'b', 1, { a: 1, b: 1 }, { ops: [{ t: 'ins', obj: 'L', after: 'a:1.2', value: 'r' }] });
    expect(copy.toJSON()).toEqual({ l: ['q', 'r'] });
  });
});

describe('incremental store', () => {
  it('only re-materializes and notifies the objects a change touched', () => {
    const d = new Doc();
    const store = new IncrementalStore(d);
    store.applyPatches(apply(d, 'a', 1, { a: 1 }, { ops: [
      { t: 'makeMap', id: 'card1' }, { t: 'makeMap', id: 'card2' },
      { t: 'set', obj: 'card1', key: 'title', value: 'one' }, { t: 'set', obj: 'card2', key: 'title', value: 'two' },
    ] }));
    let card1 = 0, card2 = 0;
    store.subscribe('card1', () => card1++);
    store.subscribe('card2', () => card2++);
    const v1 = store.view('card1');
    expect(store.view('card1'), 'memoized between changes').toBe(v1);

    store.applyPatches(apply(d, 'a', 2, { a: 2 }, { ops: [{ t: 'set', obj: 'card2', key: 'title', value: 'TWO' }] }));
    expect([card1, card2]).toEqual([0, 1]);
    expect(store.view('card1'), 'untouched object keeps its cached view').toBe(v1);
    expect(store.view('card2')).toMatchObject({ kind: 'map', fields: { title: 'TWO' }, version: 2 });
  });
});
