import type { Message, Transport } from './Transport.js';

/**
 * Deterministic network simulator for property tests. Every message is a scheduled event; the
 * scheduler can reorder, delay, duplicate and drop messages, and partition the network, all driven by a
 * seeded PRNG so failures are reproducible from the seed.
 */
export interface NetConfig {
  seed: number;
  dropRate: number;
  duplicateRate: number;
  maxDelay: number; // in scheduler ticks
}

interface InFlight {
  at: number;
  seq: number;
  from: string;
  to: string;
  msg: Message;
}

export class SimNetwork {
  private time = 0;
  private seq = 0;
  private queue: InFlight[] = [];
  private nodes = new Map<string, (from: string, msg: Message) => void>();
  private partitions: Array<Set<string>> | null = null;
  private random: () => number;
  readonly stats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0 };

  constructor(readonly config: NetConfig) {
    let s = config.seed >>> 0 || 1;
    this.random = () => {
      // xorshift32
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) % 1_000_000) / 1_000_000;
    };
  }

  join(id: string): Transport {
    const net = this;
    let handler: (from: string, msg: Message) => void = () => {};
    this.nodes.set(id, (from, msg) => handler(from, msg));
    return {
      id,
      send(to, msg) {
        const targets = to === '*' ? [...net.nodes.keys()].filter((n) => n !== id) : [to];
        for (const t of targets) net.enqueue(id, t, msg);
      },
      onMessage(h) {
        handler = h;
      },
      peers() {
        return [...net.nodes.keys()].filter((n) => n !== id && net.connected(id, n));
      },
    };
  }

  private connected(a: string, b: string): boolean {
    if (!this.partitions) return true;
    return this.partitions.some((p) => p.has(a) && p.has(b));
  }

  private enqueue(from: string, to: string, msg: Message): void {
    this.stats.sent++;
    if (!this.connected(from, to) || this.random() < this.config.dropRate) {
      this.stats.dropped++;
      return;
    }
    // Deep-copy so receivers never share objects with senders (like a real wire).
    const copy = JSON.parse(JSON.stringify(msg)) as Message;
    const copies = this.random() < this.config.duplicateRate ? 2 : 1;
    if (copies === 2) this.stats.duplicated++;
    for (let i = 0; i < copies; i++) {
      this.queue.push({ at: this.time + 1 + Math.floor(this.random() * this.config.maxDelay), seq: this.seq++, from, to, msg: copy });
    }
  }

  partition(...groups: string[][]): void {
    this.partitions = groups.map((g) => new Set(g));
  }

  heal(): void {
    this.partitions = null;
  }

  /** Delivers everything due at the next tick. Returns false when nothing is in flight. */
  step(): boolean {
    if (this.queue.length === 0) return false;
    this.time++;
    const due = this.queue.filter((m) => m.at <= this.time).sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.queue = this.queue.filter((m) => m.at > this.time);
    for (const m of due) {
      this.stats.delivered++;
      this.nodes.get(m.to)?.(m.from, m.msg);
    }
    return true;
  }

  run(maxTicks = 10_000): void {
    for (let i = 0; i < maxTicks && this.step(); i++);
  }

  get inFlight(): number {
    return this.queue.length;
  }

  rand(): number {
    return this.random();
  }
}
