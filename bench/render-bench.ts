/**
 * Thesis experiment: cost of keeping a UI in sync with a shared document.
 *
 * Baseline ("full"): after each remote change, re-materialize the whole document (what a naive
 * `setState(doc.toJSON())` does). Incremental: components subscribe to the objects they render,
 * and only views whose object was touched are re-materialized.
 *
 * Workload: a board with C columns × K cards; random edits (retitle a card 70%, vote 20%, rename a
 * column 10%) arrive from a peer.
 */
import { ROOT } from '../src/crdt/ops.js';
import { Replica } from '../src/replica/Replica.js';
import { SimNetwork } from '../src/net/SimNetwork.js';
import { buildBoard } from './board.js';

export interface BenchResult {
  columns: number;
  cards: number;
  edits: number;
  fullVisits: number;
  incrementalMaterializations: number;
  ratio: number;
  fullMs: number;
  incrementalMs: number;
}

export function runBench(columns: number, cardsPerColumn: number, edits: number, seed = 1): BenchResult {
  const net = new SimNetwork({ seed, dropRate: 0, duplicateRate: 0, maxDelay: 1 });
  const author = new Replica('author', net.join('author'));
  const viewer = new Replica('viewer', net.join('viewer'));
  const { columnIds, cardIds } = buildBoard(author, columns, cardsPerColumn);
  net.run();

  // Mount "components": one subscription per object on screen, each re-reading its own view.
  const objects = [ROOT, ...columnIds, ...cardIds.flat()];
  for (const id of objects) viewer.store.view(id);
  const subs = objects.map((id) => viewer.store.subscribe(id, () => viewer.store.view(id)));
  const before = viewer.store.metrics.materializations;

  let fullVisits = 0;
  let fullMs = 0;
  let incrementalMs = 0;
  for (let i = 0; i < edits; i++) {
    const roll = net.rand();
    const c = Math.floor(net.rand() * columns);
    const k = Math.floor(net.rand() * cardsPerColumn);
    if (roll < 0.7) author.set(cardIds[c]![k]!, 'title', `Edited ${i}`);
    else if (roll < 0.9) author.change([{ t: 'inc', obj: cardIds[c]![k]!, key: 'votes', by: 1 }]);
    else author.set(columnIds[c]!, 'title', `Column ${c} (${i})`);

    const t0 = performance.now();
    net.run(); // incremental path runs inside delivery via subscriptions
    incrementalMs += performance.now() - t0;

    const t1 = performance.now();
    const counter = { visits: 0 };
    viewer.doc.toJSON(ROOT, counter); // baseline: full re-materialization
    fullMs += performance.now() - t1;
    fullVisits += counter.visits;
  }
  subs.forEach((off) => off());
  const incrementalMaterializations = viewer.store.metrics.materializations - before;
  return {
    columns, cards: columns * cardsPerColumn, edits, fullVisits, incrementalMaterializations,
    ratio: Math.round((fullVisits / Math.max(1, incrementalMaterializations)) * 10) / 10,
    fullMs: Math.round(fullMs), incrementalMs: Math.round(incrementalMs),
  };
}

if (process.argv[1] && process.argv[1].endsWith('render-bench.ts')) {
  console.log('columns  cards  edits  full-visits  incremental  ratio   full-ms  incr-ms');
  for (const [c, k] of [[5, 20], [10, 50], [20, 100]] as const) {
    const r = runBench(c, k, 500);
    console.log(`${String(r.columns).padStart(7)}${String(r.cards).padStart(7)}${String(r.edits).padStart(7)}${String(r.fullVisits).padStart(13)}${String(r.incrementalMaterializations).padStart(13)}${String(r.ratio + 'x').padStart(8)}${String(r.fullMs).padStart(10)}${String(r.incrementalMs).padStart(9)}`);
  }
}
