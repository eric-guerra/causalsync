import { describe, expect, it } from 'vitest';
import * as vc from '../src/clock/vector.js';
import { CausalBroadcast, type Envelope } from '../src/causal/CausalBroadcast.js';

describe('vector clocks', () => {
  it('compares and merges', () => {
    expect(vc.compare({ a: 1 }, { a: 2 })).toBe('before');
    expect(vc.compare({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe('concurrent');
    expect(vc.compare({}, {})).toBe('equal');
    expect(vc.merge({ a: 3 }, { a: 1, b: 2 })).toEqual({ a: 3, b: 2 });
    expect(vc.meet([{ a: 3, b: 1 }, { a: 1, b: 5 }])).toEqual({ a: 1, b: 1 });
  });
});

describe('causal broadcast', () => {
  function shuffle<T>(arr: T[], seed: number): T[] {
    const a = arr.slice();
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  it('delivers in an order consistent with happens-before, whatever the arrival order', () => {
    for (let seed = 1; seed <= 100; seed++) {
      // Three writers with interleaved causality: b reads a before writing, c reads both.
      const a = new CausalBroadcast<string>('a', () => {});
      const b = new CausalBroadcast<string>('b', () => {});
      const c = new CausalBroadcast<string>('c', () => {});
      const all: Envelope<string>[] = [];
      const a1 = a.broadcast('a1'); all.push(a1);
      b.receive(a1);
      const b1 = b.broadcast('b1'); all.push(b1);
      c.receive(a1); c.receive(b1);
      const c1 = c.broadcast('c1'); all.push(c1);
      const a2 = a.broadcast('a2'); all.push(a2); // concurrent with b1 and c1

      const order: string[] = [];
      const d = new CausalBroadcast<string>('d', (e) => order.push(e.payload));
      const arrivals = shuffle([...all, ...all.slice(0, 2)], seed); // with duplicates
      for (const env of arrivals) d.receive(structuredClone(env));

      expect(order.sort()).toEqual(['a1', 'a2', 'b1', 'c1']);
      const delivered: string[] = [];
      const d2 = new CausalBroadcast<string>('d2', (e) => delivered.push(e.payload));
      for (const env of shuffle(all, seed)) d2.receive(structuredClone(env));
      expect(delivered.indexOf('a1')).toBeLessThan(delivered.indexOf('b1'));
      expect(delivered.indexOf('b1')).toBeLessThan(delivered.indexOf('c1'));
      expect(delivered.indexOf('a1')).toBeLessThan(delivered.indexOf('a2'));
      expect(d.stats.duplicates).toBe(2);
    }
  });

  it('buffers until dependencies arrive and reports what a peer is missing', () => {
    const a = new CausalBroadcast<number>('a', () => {});
    const e1 = a.broadcast(1);
    const e2 = a.broadcast(2);
    const got: number[] = [];
    const b = new CausalBroadcast<number>('b', (e) => got.push(e.payload));
    expect(b.receive(e2)).toEqual([]);
    expect(b.pending).toBe(1);
    expect(b.receive(e1).map((e) => e.payload)).toEqual([1, 2]);
    expect(a.missingFor({ a: 1 })).toEqual([e2]);
    expect(a.missingFor(a.version)).toEqual([]);
  });

  it('compacts causally stable history and asks laggards for snapshots', () => {
    const a = new CausalBroadcast<number>('a', () => {});
    for (let i = 0; i < 10; i++) a.broadcast(i);
    a.observePeer('b', { a: 6 });
    expect(a.stableClock()).toEqual({ a: 6 });
    expect(a.compact()).toBe(6);
    expect(a.logSize).toBe(4);
    expect(a.missingFor({ a: 8 })).toHaveLength(2);
    expect(a.missingFor({ a: 2 })).toBe('needs-snapshot');
  });
});
