# CausalSync

**Causally Consistent State Synchronization and Incremental Rendering in Offline-Capable Collaborative Applications**: a TypeScript implementation of my MS thesis (The University of Texas at Austin, 2018).

> Portfolio reference implementation of the thesis system, rebuilt with current TypeScript, React 18 and Node.

## Abstract

Collaborative applications that work offline must reconcile edits made concurrently on many devices, over networks that drop, duplicate and reorder messages. Most practical CRDTs carry metadata to be correct under *any* delivery order. This work layers the system instead:

1. A **causal broadcast** layer guarantees that every replica applies an operation only after everything that happened before it, over an unreliable transport.
2. **CRDTs designed to assume causal delivery** become smaller and simpler: multi-value map registers, commutative counters, and an RGA sequence.
3. An **incremental rendering** layer turns each applied operation into object-level patches, so a UI re-renders only the components whose data changed.

On a kanban workload, incremental rendering touches **112× to 2,042× fewer objects** than re-materializing the document on every change, and the gap grows linearly with document size.

## Architecture

```
 React components ── useObject(id) ──▶ IncrementalStore  (per-object versions, memoized shallow views)
        │ user edit                         ▲ patches
        ▼                                   │
     Replica.change(ops) ──▶ CausalBroadcast ──▶ Doc (CRDT) ──▶ ReplicaStorage (IndexedDB / memory)
        │ envelope {actor, seq, clock}       ▲ causal delivery (buffer until ready, dedupe)
        ▼                                    │
     Transport: WebRTC data channels (unordered, unreliable) │ WebSocket relay fallback │ SimNetwork (tests)
                         anti-entropy: "sync {clock}" → peer replies with the log suffix you lack (or a snapshot)
```

| Layer | Module | Key idea |
|---|---|---|
| Clocks | [clock/vector.ts](src/clock/vector.ts) | compare / merge / meet (pointwise min gives the causally stable prefix) |
| Causal broadcast | [causal/CausalBroadcast.ts](src/causal/CausalBroadcast.ts) | deliver op from *a* when `clock[a] = local[a]+1` and all other entries ≤ local; buffer otherwise; drop duplicates; `missingFor(remoteClock)` drives anti-entropy; **causal-stability compaction** drops history every known replica has, with snapshot bootstrap for laggards |
| CRDT | [crdt/Doc.ts](src/crdt/Doc.ts) | **Map registers** where a write supersedes exactly what causally precedes it, so concurrent writes survive as visible conflicts (never silently lost); **counters**; **RGA lists** with Lamport stamps from the vector clock (concurrent inserts ordered deterministically, runs stay contiguous, removals are tombstones); snapshots |
| Incremental rendering | [incremental/Store.ts](src/incremental/Store.ts) | per-object versions bumped by patches; shallow views (children are references) memoized per version; subscriptions per object, wired to React with `useSyncExternalStore` ([demo/hooks.ts](demo/hooks.ts)) |
| Replica | [replica/Replica.ts](src/replica/Replica.ts) | persist-then-send, offline queueing, sync on reconnect, snapshot adoption only when it covers local state |
| Transports | [net/](src/net) | stateless relay (also WebRTC signaling); WebRTC data channels in **unordered, no-retransmit** mode, since causal broadcast tolerates reordering and anti-entropy repairs loss, which avoids head-of-line blocking; deterministic network simulator with drop, duplicate, delay and partitions |

## Results

```
$ npm run bench
columns  cards  edits  full-visits  incremental  ratio   full-ms  incr-ms
      5    100    500        56000          500    112x        43        3
     10    500    500       261000          500    522x       146        3
     20   2000    500      1021000          500   2042x       561        3
```

Full re-materialization costs O(document size) per edit; incremental costs O(objects touched), here exactly one per edit.

## Correctness evidence (tests)

- Causal delivery respects happens-before under 100 random arrival orders with duplicates
- **4 replicas converge** across 30 random seeds on a network with 20% loss, 10% duplication and reordering, with interleaved list inserts and removes, map writes and counters
- **Partition, then heal**: both sides keep working; concurrent offline edits to the same key are surfaced as conflicts on every replica
- Offline replica catch-up, including its own queued edits
- Compaction bounds the log; a late joiner bootstraps from a snapshot; a replica restarts from durable storage
- Real WebSocket relay session with a late joiner

## Run

```bash
npm install
npm test            # 16 tests
npm run typecheck
npm run bench
npm run relay       # ws://localhost:4444
npm run demo        # collaborative kanban (open in several tabs; try offline mode)
```
