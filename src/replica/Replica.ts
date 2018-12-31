import { CausalBroadcast } from '../causal/CausalBroadcast.js';
import type { Envelope } from '../causal/CausalBroadcast.js';
import { Doc } from '../crdt/Doc.js';
import type { Change, ElemId, ObjId, Op, Value } from '../crdt/ops.js';
import { ROOT } from '../crdt/ops.js';
import { IncrementalStore } from '../incremental/Store.js';
import type { Message, Transport } from '../net/Transport.js';
import type { ReplicaStorage } from './Storage.js';

/**
 * A replica ties the layers together:
 *
 *   user change → CausalBroadcast.broadcast → Doc.applyChange → IncrementalStore patches → UI
 *                      │                                      ▲
 *                      └── transport.send('op') ──▶ peers ─────┘ (via receive → causal delivery)
 *
 * Operations are persisted before they're sent, so a replica can go offline, keep editing, reload,
 * and reconcile later through anti-entropy (`sync`).
 */
export class Replica {
  doc = new Doc();
  store = new IncrementalStore(this.doc);
  private broadcast: CausalBroadcast<Change>;
  private idSeq = 0;
  online = true;

  constructor(
    readonly id: string,
    private readonly transport: Transport | null,
    private readonly storage: ReplicaStorage | null = null,
  ) {
    this.broadcast = this.newBroadcast();
    transport?.onMessage((from, msg) => this.onMessage(from, msg));
  }

  private newBroadcast(): CausalBroadcast<Change> {
    return new CausalBroadcast<Change>(this.id, (env) => this.applyEnvelope(env));
  }

  private applyEnvelope(env: Envelope<Change>): void {
    const patches = this.doc.applyChange(env.payload, { opIdBase: `${env.actor}:${env.seq}`, actor: env.actor, clock: env.clock });
    this.store.applyPatches(patches);
  }

  /** Restores persisted state (snapshot + log) after a restart. */
  async load(): Promise<void> {
    if (!this.storage) return;
    const snap = await this.storage.loadSnapshot();
    if (snap) {
      this.doc = Doc.fromSnapshot(snap.doc);
      this.store = new IncrementalStore(this.doc);
      this.broadcast = this.newBroadcast();
      this.broadcast.resetTo(snap.clock);
    }
    for (const env of await this.storage.loadLog()) this.broadcast.receive(env);
  }

  // ------------------------------------------------------------------ local changes

  /** Applies a batch of ops as one causal operation and propagates it. */
  change(ops: Op[], message?: string): Envelope<Change> {
    const env = this.broadcast.broadcast({ ops, message });
    void this.storage?.append(env);
    if (this.online) this.transport?.send('*', { type: 'op', env });
    return env;
  }

  /** Fresh id for a new object. Ids embed the replica id so they never collide. */
  newId(prefix = 'o'): ObjId {
    return `${prefix}:${this.id}:${++this.idSeq}:${Date.now().toString(36)}`;
  }

  set(obj: ObjId, key: string, value: Value): void {
    this.change([{ t: 'set', obj, key, value }]);
  }

  insertAt(list: ObjId, index: number, value: Value): void {
    this.change([{ t: 'ins', obj: list, after: index === 0 ? null : this.doc.elemAt(list, index - 1), value }]);
  }

  removeAt(list: ObjId, index: number): void {
    const elem = this.doc.elemAt(list, index);
    if (elem) this.change([{ t: 'rem', obj: list, elem }]);
  }

  /** Moves a list item: remove + insert in one causal operation. */
  move(list: ObjId, from: number, to: number): void {
    const els = this.doc.elements(list);
    const item = els[from];
    if (!item) return;
    const without = els.filter((_, i) => i !== from);
    const after: ElemId | null = to === 0 ? null : without[to - 1]?.[0] ?? null;
    this.change([{ t: 'rem', obj: list, elem: item[0] }, { t: 'ins', obj: list, after, value: item[1] }]);
  }

  // ------------------------------------------------------------------ networking

  private onMessage(from: string, msg: Message): void {
    if (!this.online) return;
    switch (msg.type) {
      case 'op':
        this.receive(msg.env);
        break;
      case 'ops':
        msg.envs.forEach((e) => this.receive(e));
        break;
      case 'sync': {
        this.broadcast.observePeer(from, msg.clock);
        const missing = this.broadcast.missingFor(msg.clock);
        if (missing === 'needs-snapshot') {
          this.transport?.send(from, { type: 'snapshot', clock: this.broadcast.version, doc: this.doc.snapshot() });
        } else if (missing.length) {
          this.transport?.send(from, { type: 'ops', envs: missing });
        }
        break;
      }
      case 'snapshot':
        this.adoptSnapshot(msg.clock, msg.doc);
        break;
    }
  }

  private receive(env: Envelope<Change>): void {
    const delivered = this.broadcast.receive(env);
    for (const d of delivered) void this.storage?.append(d);
  }

  /** Only adopt a snapshot that strictly covers what we have (we never lose local, unsent work). */
  private adoptSnapshot(clock: Record<string, number>, docSnapshot: unknown): void {
    const ours = this.broadcast.version;
    if (!Object.entries(ours).every(([k, v]) => v <= (clock[k] ?? 0))) return;
    this.doc = Doc.fromSnapshot(docSnapshot);
    this.store = new IncrementalStore(this.doc);
    this.broadcast = this.newBroadcast();
    this.broadcast.resetTo(clock);
    void this.storage?.saveSnapshot({ clock, doc: docSnapshot });
  }

  /** Anti-entropy round: announce our clock to every peer (they reply with what we lack). */
  sync(): void {
    if (this.online) this.transport?.send('*', { type: 'sync', clock: this.broadcast.version });
  }

  goOffline(): void {
    this.online = false;
  }

  goOnline(): void {
    this.online = true;
    this.sync();
  }

  /** Drops causally stable history and snapshots it. */
  async compact(): Promise<number> {
    const removed = this.broadcast.compact();
    if (this.storage && removed > 0) {
      await this.storage.saveSnapshot({ clock: this.broadcast.version, doc: this.doc.snapshot() });
      await this.storage.truncateLog(this.broadcast.stableClock());
    }
    return removed;
  }

  get version() {
    return this.broadcast.version;
  }

  get stats() {
    return { ...this.broadcast.stats, log: this.broadcast.logSize, pending: this.broadcast.pending };
  }

  json(): unknown {
    return this.doc.toJSON(ROOT);
  }
}
