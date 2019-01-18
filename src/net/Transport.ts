import type { VectorClock } from '../clock/vector.js';
import type { Envelope } from '../causal/CausalBroadcast.js';
import type { Change } from '../crdt/ops.js';

/** Messages exchanged between replicas. */
export type Message =
  | { type: 'op'; env: Envelope<Change> }
  /** Anti-entropy: "here is my clock; send me what I'm missing". Also acts as a stability ack. */
  | { type: 'sync'; clock: VectorClock }
  | { type: 'ops'; envs: Envelope<Change>[] }
  | { type: 'snapshot'; clock: VectorClock; doc: unknown };

/** Point-to-point or broadcast messaging. Implementations: SimNetwork (tests), WebSocket relay, WebRTC. */
export interface Transport {
  readonly id: string;
  send(to: string | '*', msg: Message): void;
  onMessage(handler: (from: string, msg: Message) => void): void;
  peers(): string[];
}
