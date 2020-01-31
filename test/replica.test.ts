import { describe, expect, it } from 'vitest';
import * as vc from '../src/clock/vector.js';
import { ROOT } from '../src/crdt/ops.js';
import { SimNetwork } from '../src/net/SimNetwork.js';
import { Replica } from '../src/replica/Replica.js';
import { MemoryStorage } from '../src/replica/Storage.js';
import { runBench } from '../bench/render-bench.js';

function cluster(n: number, seed: number, net = { dropRate: 0.2, duplicateRate: 0.1, maxDelay: 6 }) {
  const sim = new SimNetwork({ seed, ...net });
  const replicas = Array.from({ length: n }, (_, i) => new Replica(`r${i}`, sim.join(`r${i}`)));
  const settle = () => {
    // Anti-entropy rounds until quiescent: real deployments run these on a timer and on reconnect.
    for (let round = 0; round < 50; round++) {
      replicas.forEach((r) => r.sync());
      sim.run();
      const v = replicas[0]!.version;
      if (replicas.every((r) => vc.compare(r.version, v) === 'equal' && r.stats.pending === 0)) return;
    }
    throw new Error('did not converge');
  };
  return { sim, replicas, settle };
}

describe('replicas over a lossy, reordering network', () => {
  it('converge to identical documents (randomized, 30 seeds)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { sim, replicas, settle } = cluster(4, seed);
      const list = 'shared-list';
      replicas[0]!.change([{ t: 'makeList', id: list }, { t: 'set', obj: ROOT, key: 'items', value: { ref: list } }]);
      settle();
      for (let i = 0; i < 60; i++) {
        const r = replicas[Math.floor(sim.rand() * replicas.length)]!;
        const len = r.doc.elements(list).length;
        const roll = sim.rand();
        if (roll < 0.5 || len === 0) r.insertAt(list, Math.floor(sim.rand() * (len + 1)), `${r.id}-${i}`);
        else if (roll < 0.7) r.removeAt(list, Math.floor(sim.rand() * len));
        else if (roll < 0.85) r.set(ROOT, `k${i % 3}`, `${r.id}-${i}`);
        else r.change([{ t: 'inc', obj: ROOT, key: 'count', by: 1 }]);
        if (sim.rand() < 0.3) sim.step(); // let some traffic through mid-stream
      }
      settle();
      const json = JSON.stringify(replicas[0]!.json());
      for (const r of replicas) expect(JSON.stringify(r.json()), `seed ${seed}`).toBe(json);
    }
  });

  it('partitioned replicas keep working and reconcile after healing', () => {
    const { sim, replicas, settle } = cluster(3, 7, { dropRate: 0, duplicateRate: 0, maxDelay: 2 });
    const [a, b, c] = replicas as [Replica, Replica, Replica];
    a.set(ROOT, 'title', 'Plan');
    settle();

    sim.partition(['r0', 'r1'], ['r2']);
    a.set(ROOT, 'owner', 'ana');
    c.set(ROOT, 'due', 'friday');
    c.set(ROOT, 'title', 'Plan v2 (offline)');
    a.set(ROOT, 'title', 'Plan v2');
    sim.run();
    expect(b.doc.get(ROOT, 'owner')).toBe('ana');
    expect(b.doc.get(ROOT, 'due')).toBeUndefined();

    sim.heal();
    settle();
    for (const r of replicas) {
      expect(r.json()).toEqual(a.json());
      expect(r.doc.conflicts(ROOT, 'title').sort(), 'concurrent offline edits are surfaced, not lost').toEqual(['Plan v2', 'Plan v2 (offline)']);
    }
  });

  it('a replica that was offline catches up via anti-entropy, including its own queued edits', () => {
    const { replicas, settle } = cluster(2, 3, { dropRate: 0, duplicateRate: 0, maxDelay: 2 });
    const [a, b] = replicas as [Replica, Replica];
    b.goOffline();
    for (let i = 0; i < 5; i++) a.set(ROOT, `a${i}`, i);
    for (let i = 0; i < 3; i++) b.set(ROOT, `b${i}`, i);
    b.goOnline();
    settle();
    expect(a.json()).toEqual(b.json());
    expect(Object.keys(a.json() as object)).toHaveLength(8);
  });

  it('compaction keeps logs bounded and new peers bootstrap from a snapshot', async () => {
    const sim = new SimNetwork({ seed: 5, dropRate: 0, duplicateRate: 0, maxDelay: 1 });
    const storage = new MemoryStorage();
    const a = new Replica('a', sim.join('a'), storage);
    const b = new Replica('b', sim.join('b'));
    for (let i = 0; i < 50; i++) a.set(ROOT, `k${i % 5}`, i);
    sim.run();
    b.sync();
    sim.run();
    expect(await a.compact()).toBe(50);
    expect(a.stats.log).toBe(0);
    expect(storage.snapshot).not.toBeNull();

    const late = new Replica('late', sim.join('late'));
    late.sync();
    sim.run();
    expect(late.json()).toEqual(a.json());

    // Restart from durable storage.
    a.set(ROOT, 'after', 'compaction');
    const restarted = new Replica('a', null, storage);
    await restarted.load();
    expect(restarted.json()).toEqual(a.json());
  });
});

describe('incremental rendering (thesis experiment)', () => {
  it('touches far fewer objects than full re-materialization', () => {
    const r = runBench(10, 30, 200, 3);
    expect(r.cards).toBe(300);
    // Each edit touches one object; a full re-render visits ~1 + 10 cols + 10 lists + 300 cards + 1 list.
    expect(r.incrementalMaterializations).toBeLessThanOrEqual(r.edits);
    expect(r.ratio).toBeGreaterThan(100);
  });
});
