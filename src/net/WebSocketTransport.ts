import type { Message, Transport } from './Transport.js';

/**
 * Transport over the relay server. Works in browsers and in Node 22+ (global WebSocket).
 * Reconnects with backoff; on (re)connect it fires `onConnect` so the replica can run anti-entropy.
 */
export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private handler: (from: string, msg: Message) => void = () => {};
  private known = new Set<string>();
  private attempt = 0;
  private closed = false;
  onConnect: () => void = () => {};
  onSignal: (from: string, signal: unknown) => void = () => {};

  constructor(readonly id: string, private readonly url: string, private readonly room: string) {}

  connect(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${this.url}?room=${encodeURIComponent(this.room)}&peer=${encodeURIComponent(this.id)}`);
      this.ws = ws;
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.peers) {
          frame.peers.forEach((p: string) => this.known.add(p));
          this.attempt = 0;
          this.onConnect();
          resolve();
        } else if (frame.joined) {
          this.known.add(frame.joined);
        } else if (frame.left) {
          this.known.delete(frame.left);
        } else if (frame.payload?.signal !== undefined) {
          this.onSignal(frame.from, frame.payload.signal);
        } else if (frame.payload) {
          this.handler(frame.from, frame.payload as Message);
        }
      };
      ws.onclose = () => {
        if (this.closed) return;
        const delay = Math.min(10_000, 200 * 2 ** this.attempt++);
        setTimeout(() => void this.connect(), delay);
      };
    });
  }

  send(to: string | '*', msg: Message): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return; // replica's anti-entropy recovers anything dropped
    this.ws.send(JSON.stringify(to === '*' ? { payload: msg } : { to, payload: msg }));
  }

  signal(to: string, signal: unknown): void {
    this.ws?.send(JSON.stringify({ to, payload: { signal } }));
  }

  onMessage(handler: (from: string, msg: Message) => void): void {
    this.handler = handler;
  }

  peers(): string[] {
    return [...this.known];
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
