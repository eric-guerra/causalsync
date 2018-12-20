import type { VectorClock } from '../clock/vector.js';
import type { Envelope } from '../causal/CausalBroadcast.js';
import type { Change } from '../crdt/ops.js';
import type { ReplicaStorage } from './Storage.js';

/** Browser persistence: op log in one object store (key "actor:seq"), snapshot in another. */
export class IdbStorage implements ReplicaStorage {
  private db: Promise<IDBDatabase>;

  constructor(name = 'causalsync') {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('log');
        req.result.createObjectStore('snapshot');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  async append(env: Envelope<Change>): Promise<void> {
    await this.run('log', 'readwrite', (s) => s.put(env, `${env.actor}:${String(env.seq).padStart(12, '0')}`));
  }

  async loadLog(): Promise<Envelope<Change>[]> {
    return ((await this.run('log', 'readonly', (s) => s.getAll())) as Envelope<Change>[] | undefined) ?? [];
  }

  async saveSnapshot(snapshot: { clock: VectorClock; doc: unknown }): Promise<void> {
    await this.run('snapshot', 'readwrite', (s) => s.put(snapshot, 'latest'));
  }

  async loadSnapshot(): Promise<{ clock: VectorClock; doc: unknown } | null> {
    return ((await this.run('snapshot', 'readonly', (s) => s.get('latest'))) as { clock: VectorClock; doc: unknown } | undefined) ?? null;
  }

  async truncateLog(upTo: VectorClock): Promise<void> {
    const all = await this.loadLog();
    await this.run('log', 'readwrite', (s) => {
      for (const e of all) if (e.seq <= (upTo[e.actor] ?? 0)) s.delete(`${e.actor}:${String(e.seq).padStart(12, '0')}`);
    });
  }
}
