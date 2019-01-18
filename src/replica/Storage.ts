import type { VectorClock } from '../clock/vector.js';
import type { Envelope } from '../causal/CausalBroadcast.js';
import type { Change } from '../crdt/ops.js';

/**
 * Durable storage for offline operation: an append-only op log plus an occasional snapshot.
 * Browser builds back this with IndexedDB; tests use the memory implementation.
 */
export interface ReplicaStorage {
  append(env: Envelope<Change>): Promise<void>;
  loadLog(): Promise<Envelope<Change>[]>;
  saveSnapshot(snapshot: { clock: VectorClock; doc: unknown }): Promise<void>;
  loadSnapshot(): Promise<{ clock: VectorClock; doc: unknown } | null>;
  truncateLog(upTo: VectorClock): Promise<void>;
}

export class MemoryStorage implements ReplicaStorage {
  log: Envelope<Change>[] = [];
  snapshot: { clock: VectorClock; doc: unknown } | null = null;

  async append(env: Envelope<Change>): Promise<void> {
    this.log.push(structuredClone(env));
  }

  async loadLog(): Promise<Envelope<Change>[]> {
    return structuredClone(this.log);
  }

  async saveSnapshot(s: { clock: VectorClock; doc: unknown }): Promise<void> {
    this.snapshot = structuredClone(s);
  }

  async loadSnapshot(): Promise<{ clock: VectorClock; doc: unknown } | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async truncateLog(upTo: VectorClock): Promise<void> {
    this.log = this.log.filter((e) => e.seq > (upTo[e.actor] ?? 0));
  }
}
