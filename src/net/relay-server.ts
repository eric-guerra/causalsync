import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * A deliberately dumb relay: it forwards messages between peers in a room and carries WebRTC
 * signaling. It holds no document state at all. Correctness lives entirely in the replicas
 * (causal broadcast + CRDTs), so the relay can restart, reorder or drop without harming
 * consistency, and peers can switch to direct WebRTC channels and stop using it.
 *
 * Frames:  { to?: peerId, payload }   →   delivered as { from: peerId, payload }
 *          on join, the newcomer receives { peers: [...] } and others get { joined: id }
 */
export function startRelay(port = 0): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('causalsync relay');
  });
  const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });
  const rooms = new Map<string, Map<string, WebSocket>>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const room = url.searchParams.get('room') ?? '';
    const peer = url.searchParams.get('peer') ?? '';
    if (!/^[\w-]{1,64}$/.test(room) || !/^[\w-]{1,64}$/.test(peer)) {
      ws.close(1008, 'room and peer are required');
      return;
    }
    let members = rooms.get(room);
    if (!members) rooms.set(room, (members = new Map()));
    members.get(peer)?.close(4000, 'replaced by a newer connection');
    ws.send(JSON.stringify({ peers: [...members.keys()] }));
    for (const other of members.values()) other.send(JSON.stringify({ joined: peer }));
    members.set(peer, ws);

    ws.on('message', (data) => {
      let frame: { to?: string; payload: unknown };
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      const out = JSON.stringify({ from: peer, payload: frame.payload });
      if (frame.to) members!.get(frame.to)?.send(out);
      else for (const [id, other] of members!) if (id !== peer && other.readyState === WebSocket.OPEN) other.send(out);
    });

    ws.on('close', () => {
      if (members!.get(peer) !== ws) return;
      members!.delete(peer);
      for (const other of members!.values()) other.send(JSON.stringify({ left: peer }));
      if (members!.size === 0) rooms.delete(room);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('relay-server.ts')) {
  startRelay(Number(process.env.PORT) || 4444).then(({ port }) => console.log(`relay on ws://localhost:${port}`));
}
