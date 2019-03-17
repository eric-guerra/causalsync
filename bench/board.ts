import { ROOT } from '../src/crdt/ops.js';
import type { Op } from '../src/crdt/ops.js';
import type { Replica } from '../src/replica/Replica.js';

/** Builds a kanban board: root.columns → [column{title, cards → [card{title, votes}]}]. */
export function buildBoard(r: Replica, columns: number, cardsPerColumn: number): { columnIds: string[]; cardIds: string[][] } {
  const cols = r.newId('list');
  r.change([{ t: 'makeList', id: cols }, { t: 'set', obj: ROOT, key: 'columns', value: { ref: cols } }]);
  const columnIds: string[] = [];
  const cardIds: string[][] = [];
  for (let c = 0; c < columns; c++) {
    const col = r.newId('col');
    const cards = r.newId('cards');
    const ids: string[] = [];
    const ops: Op[] = [
      { t: 'makeMap', id: col },
      { t: 'set', obj: col, key: 'title', value: `Column ${c}` },
      { t: 'makeList', id: cards },
      { t: 'set', obj: col, key: 'cards', value: { ref: cards } },
    ];
    for (let k = 0; k < cardsPerColumn; k++) {
      const card = r.newId('card');
      ids.push(card);
      ops.push({ t: 'makeMap', id: card }, { t: 'set', obj: card, key: 'title', value: `Card ${c}.${k}` });
    }
    r.change(ops);
    // Insert in order; each insert references the previous element, so order is preserved.
    ids.forEach((card, k) => r.insertAt(cards, k, { ref: card }));
    r.insertAt(cols, c, { ref: col });
    columnIds.push(col);
    cardIds.push(ids);
  }
  return { columnIds, cardIds };
}
