import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../src/crdt/ops.js';
import { startRelay } from '../src/net/relay-server.js';
import { WebSocketTransport } from '../src/net/WebSocketTransport.js';
import { Replica } from '../src/replica/Replica.js';

let relay: Awaited<ReturnType<typeof startRelay>>;

beforeAll(async () => {
  relay = await startRelay(0);
});

afterAll(async () => {
  await relay.close();
});

async function until(fn: () => boolean, label: string) {
  const deadline = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('replicas over the WebSocket relay', () => {
  it('sync through a stateless relay, including a late joiner', async () => {
    const url = `ws://localhost:${relay.port}`;
    const ta = new WebSocketTransport('alice', url, 'room1');
    const tb = new WebSocketTransport('bob', url, 'room1');
    const a = new Replica('alice', ta);
    const b = new Replica('bob', tb);
    ta.onConnect = () => a.sync();
    tb.onConnect = () => b.sync();
    await ta.connect();
    await tb.connect();

    a.set(ROOT, 'title', 'Hello');
    b.set(ROOT, 'count', 1);
    await until(() => b.doc.get(ROOT, 'title') === 'Hello' && a.doc.get(ROOT, 'count') === 1, 'exchange');

    const tc = new WebSocketTransport('carol', url, 'room1');
    const c = new Replica('carol', tc);
    tc.onConnect = () => c.sync();
    await tc.connect();
    await until(() => JSON.stringify(c.json()) === JSON.stringify(a.json()), 'late joiner catch-up');
    expect(c.json()).toEqual({ count: 1, title: 'Hello' });
    [ta, tb, tc].forEach((t) => t.close());
  });
});
