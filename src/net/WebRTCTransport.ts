import type { Message, Transport } from './Transport.js';
import type { WebSocketTransport } from './WebSocketTransport.js';

/**
 * Peer-to-peer transport over WebRTC data channels, using the relay only for signaling.
 * Messages to a peer go over its data channel when open and fall back to the relay otherwise,
 * so a failed ICE negotiation degrades to relay mode instead of breaking sync.
 *
 * Data channels are created unordered and with maxRetransmits: 0. Causal broadcast tolerates
 * reordering and anti-entropy repairs loss, so we skip SCTP's head-of-line blocking.
 */
export class WebRTCTransport implements Transport {
  private channels = new Map<string, RTCDataChannel>();
  private conns = new Map<string, RTCPeerConnection>();
  private handler: (from: string, msg: Message) => void = () => {};

  constructor(private readonly relay: WebSocketTransport, private readonly iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]) {
    relay.onMessage((from, msg) => this.handler(from, msg));
    relay.onSignal = (from, signal) => void this.onSignal(from, signal as SignalMsg);
  }

  get id(): string {
    return this.relay.id;
  }

  /** The peer with the lexically smaller id initiates, so exactly one side sends the offer. */
  async connectTo(peer: string): Promise<void> {
    if (this.conns.has(peer) || this.id > peer) return;
    const pc = this.peerConnection(peer);
    this.attach(peer, pc.createDataChannel('causalsync', { ordered: false, maxRetransmits: 0 }));
    await pc.setLocalDescription(await pc.createOffer());
    this.relay.signal(peer, { sdp: pc.localDescription });
  }

  private peerConnection(peer: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc.onicecandidate = (e) => { if (e.candidate) this.relay.signal(peer, { candidate: e.candidate }); };
    pc.ondatachannel = (e) => this.attach(peer, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.channels.delete(peer);
        this.conns.delete(peer);
      }
    };
    this.conns.set(peer, pc);
    return pc;
  }

  private attach(peer: string, channel: RTCDataChannel): void {
    channel.onopen = () => this.channels.set(peer, channel);
    channel.onclose = () => this.channels.delete(peer);
    channel.onmessage = (e) => this.handler(peer, JSON.parse(String(e.data)) as Message);
  }

  private async onSignal(from: string, signal: SignalMsg): Promise<void> {
    const pc = this.conns.get(from) ?? this.peerConnection(from);
    if (signal.sdp) {
      await pc.setRemoteDescription(signal.sdp);
      if (signal.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        this.relay.signal(from, { sdp: pc.localDescription });
      }
    } else if (signal.candidate) {
      await pc.addIceCandidate(signal.candidate).catch(() => {});
    }
  }

  send(to: string | '*', msg: Message): void {
    const targets = to === '*' ? this.peers() : [to];
    const data = JSON.stringify(msg);
    for (const peer of targets) {
      const ch = this.channels.get(peer);
      if (ch?.readyState === 'open' && data.length < 64_000) ch.send(data);
      else this.relay.send(peer, msg);
    }
  }

  onMessage(handler: (from: string, msg: Message) => void): void {
    this.handler = handler;
  }

  peers(): string[] {
    return this.relay.peers();
  }

  directPeers(): string[] {
    return [...this.channels.keys()];
  }
}

interface SignalMsg {
  sdp?: RTCSessionDescriptionInit & { type: RTCSdpType };
  candidate?: RTCIceCandidateInit;
}
