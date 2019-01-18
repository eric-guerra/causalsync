/** Document operations. Object ids and element ids are globally unique op ids ("actor:seq"). */
export type ObjId = string;
export type ElemId = string;
export type Primitive = string | number | boolean | null;
export type Value = Primitive | { ref: ObjId };

export type Op =
  | { t: 'makeMap'; id: ObjId }
  | { t: 'makeList'; id: ObjId }
  | { t: 'set'; obj: ObjId; key: string; value: Value }
  | { t: 'del'; obj: ObjId; key: string }
  | { t: 'inc'; obj: ObjId; key: string; by: number }
  | { t: 'ins'; obj: ObjId; after: ElemId | null; value: Value }
  | { t: 'rem'; obj: ObjId; elem: ElemId };

/** A batch of ops applied atomically (one user action = one causal operation). */
export interface Change {
  ops: Op[];
  message?: string;
}

export const ROOT: ObjId = 'root';
