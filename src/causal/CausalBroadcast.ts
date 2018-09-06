import * as vc from '../clock/vector.js';
import type { VectorClock } from '../clock/vector.js';

/** An operation stamped with its sender and the sender's clock *after* the operation. */
export interface Envelope<P> {
  actor: string;
  seq: number;
  clock: VectorClock;
  payload: P;
}

export interface BroadcastStats {
  delivered: number;
  duplicates: number;
  buffered: number;
  maxBuffered: number;
}

/**
 * Causal broadcast over an unreliable transport.
 *
 * Operations may arrive duplicated, reordered or not at all. An operation from `a` is delivered only
 * once everything that happened-before it has been delivered:
 *     env.clock[a] === local[a] + 1   and   env.clock[k] <= local[k] for every other k
 * Anything else waits in a buffer. Missing operations are recovered by anti-entropy: peers exchange
 * clocks and send each other the log suffix the other lacks (`missingFor`).
 *
 * The log can be compacted once operations are *causally stable* (every known replica has them).
 */
export class CausalBroadcast<P> {
  private clock: VectorClock = {};
  private log: Envelope<P>[] = [];
  private logBase: VectorClock = {}; // clock covered by compacted (dropped) log entries
  private buffer = new Map<string, Envelope<P>>();
  private peerClocks = new Map<string, VectorClock>();
  readonly stats: BroadcastStats = { delivered: 0, duplicates: 0, buffered: 0, maxBuffered: 0 };

  constructor(
    readonly actor: string,
    private readonly deliver: (env: Envelope<P>) => void,
  ) {}

  /** Creates and locally delivers a new operation; returns the envelope to send. */
  broadcast(payload: P): Envelope<P> {
    const seq = vc.get(this.clock, this.actor) + 1;
    this.clock = { ...this.clock, [this.actor]: seq };
    const env: Envelope<P> = { actor: this.actor, seq, clock: { ...this.clock }, payload };
    this.log.push(env);
    this.stats.delivered++;
    this.deliver(env);
    return env;
  }

  /** Accepts an operation from the network. Returns the envelopes delivered as a result (possibly several). */
  receive(env: Envelope<P>): Envelope<P>[] {
    const key = `${env.actor}:${env.seq}`;
    if (env.seq <= vc.get(this.clock, env.actor) || this.buffer.has(key)) {
      this.stats.duplicates++;
      return [];
    }
    this.buffer.set(key, env);
    this.stats.maxBuffered = Math.max(this.stats.maxBuffered, this.buffer.size);
    return this.drain();
  }

  private ready(env: Envelope<P>): boolean {
    if (env.clock[env.actor] !== vc.get(this.clock, env.actor) + 1) return false;
    for (const [k, v] of Object.entries(env.clock)) {
      if (k !== env.actor && v > vc.get(this.clock, k)) return false;
    }
    return true;
  }

  private drain(): Envelope<P>[] {
    const delivered: Envelope<P>[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (const [key, env] of this.buffer) {
        if (!this.ready(env)) continue;
        this.buffer.delete(key);
        this.clock = vc.merge(this.clock, { [env.actor]: env.seq });
        this.log.push(env);
        this.stats.delivered++;
        this.deliver(env);
        delivered.push(env);
        progress = true;
      }
    }
    this.stats.buffered = this.buffer.size;
    return delivered;
  }

  get version(): VectorClock {
    return { ...this.clock };
  }

  /** Log suffix a peer with clock `remote` is missing, in causal (delivery) order. */
  missingFor(remote: VectorClock): Envelope<P>[] | 'needs-snapshot' {
    // If we've compacted away operations the peer still needs, it must bootstrap from a snapshot.
    for (const [k, v] of Object.entries(this.logBase)) if (vc.get(remote, k) < v) return 'needs-snapshot';
    return this.log.filter((e) => e.seq > vc.get(remote, e.actor));
  }

  /** Record what a peer has seen (from sync/ack messages) for stability tracking. */
  observePeer(peer: string, clock: VectorClock): void {
    this.peerClocks.set(peer, vc.merge(this.peerClocks.get(peer) ?? {}, clock));
  }

  forgetPeer(peer: string): void {
    this.peerClocks.delete(peer);
  }

  /** Operations every known replica (including us) has seen. */
  stableClock(): VectorClock {
    return vc.meet([this.clock, ...this.peerClocks.values()]);
  }

  /** Drops causally stable log entries; returns how many were removed. */
  compact(): number {
    const stable = this.stableClock();
    const before = this.log.length;
    this.log = this.log.filter((e) => e.seq > vc.get(stable, e.actor));
    this.logBase = vc.merge(this.logBase, stable);
    return before - this.log.length;
  }

  /** Restores state from a snapshot taken at `clock` (operations up to it are already reflected). */
  resetTo(clock: VectorClock): void {
    this.clock = { ...clock };
    this.logBase = { ...clock };
    this.log = [];
    for (const [key, env] of this.buffer) if (env.seq <= vc.get(clock, env.actor)) this.buffer.delete(key);
    this.drain();
  }

  get logSize(): number {
    return this.log.length;
  }

  get pending(): number {
    return this.buffer.size;
  }
}
