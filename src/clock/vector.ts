/** Vector clocks: { replicaId: number of operations from that replica that have been seen }. */
export type VectorClock = Record<string, number>;

export type Order = 'equal' | 'before' | 'after' | 'concurrent';

export function get(vc: VectorClock, id: string): number {
  return vc[id] ?? 0;
}

export function merge(a: VectorClock, b: VectorClock): VectorClock {
  const out: VectorClock = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

export function leq(a: VectorClock, b: VectorClock): boolean {
  for (const [k, v] of Object.entries(a)) if (v > get(b, k)) return false;
  return true;
}

export function compare(a: VectorClock, b: VectorClock): Order {
  const ab = leq(a, b);
  const ba = leq(b, a);
  if (ab && ba) return 'equal';
  if (ab) return 'before';
  if (ba) return 'after';
  return 'concurrent';
}

/** Pointwise minimum: the prefix of history every clock in `clocks` has seen (causal stability). */
export function meet(clocks: VectorClock[]): VectorClock {
  if (clocks.length === 0) return {};
  const keys = new Set(clocks.flatMap((c) => Object.keys(c)));
  const out: VectorClock = {};
  for (const k of keys) out[k] = Math.min(...clocks.map((c) => get(c, k)));
  return out;
}

/** Scalar summary that strictly increases along causal chains (used as a Lamport timestamp). */
export function sum(vc: VectorClock): number {
  let s = 0;
  for (const v of Object.values(vc)) s += v;
  return s;
}
