import { memo } from 'react';
import { ROOT } from '../src/crdt/ops.js';
import type { Replica } from '../src/replica/Replica.js';
import { useObject } from './hooks.js';

type Props = { replica: Replica; id: string };

/** A card re-renders only when *its* map changes (title or votes), never when siblings change. */
const Card = memo(function Card({ replica, id }: Props) {
  const view = useObject(replica, id);
  if (!view || view.kind !== 'map') return null;
  const title = String(view.fields.title ?? '');
  return (
    <li className="card">
      <input value={title} onChange={(e) => replica.set(id, 'title', e.target.value)} />
      {view.conflicts.title ? <span title="Edited concurrently on another device" className="conflict">⚠</span> : null}
      <button onClick={() => replica.change([{ t: 'inc', obj: id, key: 'votes', by: 1 }])}>▲ {Number(view.fields.votes ?? 0)}</button>
    </li>
  );
});

const CardList = memo(function CardList({ replica, id }: Props) {
  const view = useObject(replica, id);
  if (!view || view.kind !== 'list') return null;
  return (
    <ul>
      {view.items.map((item) => (typeof item.value === 'object' && item.value ? <Card key={item.elem} replica={replica} id={item.value.ref} /> : null))}
    </ul>
  );
});

const Column = memo(function Column({ replica, id }: Props) {
  const view = useObject(replica, id);
  if (!view || view.kind !== 'map') return null;
  const cards = view.fields.cards;
  const addCard = () => {
    if (typeof cards !== 'object' || !cards) return;
    const card = replica.newId('card');
    replica.change([
      { t: 'makeMap', id: card },
      { t: 'set', obj: card, key: 'title', value: 'New card' },
      { t: 'ins', obj: cards.ref, after: null, value: { ref: card } },
    ]);
  };
  return (
    <section className="column">
      <h2>{String(view.fields.title ?? '')}</h2>
      {typeof cards === 'object' && cards ? <CardList replica={replica} id={cards.ref} /> : null}
      <button onClick={addCard}>+ Card</button>
    </section>
  );
});

export function Board({ replica }: { replica: Replica }) {
  const root = useObject(replica, ROOT);
  const cols = root && root.kind === 'map' ? root.fields.columns : undefined;
  const list = useObject(replica, typeof cols === 'object' && cols ? cols.ref : '__none__');
  if (!list || list.kind !== 'list') return <p>Empty board</p>;
  return (
    <div className="board">
      {list.items.map((item) => (typeof item.value === 'object' && item.value ? <Column key={item.elem} replica={replica} id={item.value.ref} /> : null))}
    </div>
  );
}
