import { createRoot } from 'react-dom/client';
import { ROOT } from '../src/crdt/ops.js';
import { WebRTCTransport } from '../src/net/WebRTCTransport.js';
import { WebSocketTransport } from '../src/net/WebSocketTransport.js';
import { IdbStorage } from '../src/replica/IdbStorage.js';
import { Replica } from '../src/replica/Replica.js';
import { Board } from './Board.js';

/**
 * Demo: a collaborative kanban board. Open it in several tabs or devices; toggle airplane mode and
 * keep editing; changes reconcile on reconnect. Peers talk over WebRTC when possible, via the relay otherwise.
 */
const room = new URLSearchParams(location.search).get('room') ?? 'demo';
const id = sessionStorage.getItem('causalsync.id') ?? crypto.randomUUID().slice(0, 8);
sessionStorage.setItem('causalsync.id', id);

const relay = new WebSocketTransport(id, `ws://${location.hostname}:4444`, room);
const transport = new WebRTCTransport(relay);
const replica = new Replica(id, transport, new IdbStorage(`causalsync-${room}`));

relay.onConnect = () => {
  replica.sync();
  relay.peers().forEach((p) => void transport.connectTo(p));
};

/** Seeds a fresh board only if no peer supplied one (avoids two tabs seeding concurrently). */
function seedIfEmpty(): void {
  if (!replica.doc.get(ROOT, 'columns')) {
    const cols = replica.newId('list');
    replica.change([{ t: 'makeList', id: cols }, { t: 'set', obj: ROOT, key: 'columns', value: { ref: cols } }]);
    for (const title of ['To do', 'Doing', 'Done']) {
      const col = replica.newId('col');
      const cards = replica.newId('cards');
      replica.change([{ t: 'makeMap', id: col }, { t: 'set', obj: col, key: 'title', value: title }, { t: 'makeList', id: cards }, { t: 'set', obj: col, key: 'cards', value: { ref: cards } }]);
      replica.insertAt(cols, replica.doc.elements(cols).length, { ref: col });
    }
  }
}

async function start(): Promise<void> {
  await replica.load();
  // Don't block startup on the network: offline-first means the board opens with or without a relay.
  await Promise.race([relay.connect(), new Promise((r) => setTimeout(r, 2000))]);
  setTimeout(seedIfEmpty, 1500); // give anti-entropy a moment to pull an existing board first
  setInterval(() => replica.sync(), 5000); // periodic anti-entropy repairs anything lost in transit
  window.addEventListener('online', () => replica.goOnline());
  window.addEventListener('offline', () => replica.goOffline());

  createRoot(document.getElementById('root')!).render(<Board replica={replica} />);
}

void start();
