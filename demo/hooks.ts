import { useSyncExternalStore } from 'react';
import type { ObjId } from '../src/crdt/ops.js';
import type { View } from '../src/incremental/Store.js';
import type { Replica } from '../src/replica/Replica.js';

/**
 * Subscribes a component to exactly one CRDT object. React re-renders the component only when that
 * object's version changes: this is the incremental rendering contract, wired to React 18's
 * external-store API (tearing-free under concurrent rendering).
 */
export function useObject(replica: Replica, id: ObjId): View | null {
  return useSyncExternalStore(
    (onChange) => replica.store.subscribe(id, onChange),
    () => replica.store.view(id),
  );
}
