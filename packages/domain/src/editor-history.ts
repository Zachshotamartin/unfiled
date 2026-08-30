import { deepFreeze } from "./canonical.js";

export type EditorHistory<T> = Readonly<{
  canRedo: boolean;
  canUndo: boolean;
  future: readonly T[];
  limit: number;
  past: readonly T[];
  present: T;
}>;

function history<T>(
  past: readonly T[],
  present: T,
  future: readonly T[],
  limit: number
): EditorHistory<T> {
  return deepFreeze({
    canRedo: future.length > 0,
    canUndo: past.length > 0,
    future: [...future],
    limit,
    past: [...past],
    present
  });
}

export function createEditorHistory<T>(present: T, limit = 100): EditorHistory<T> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Editor history limit must be positive");
  return history([], present, [], limit);
}

export function pushEditorState<T>(state: EditorHistory<T>, present: T): EditorHistory<T> {
  if (Object.is(state.present, present)) return state;
  return history([...state.past, state.present].slice(-state.limit), present, [], state.limit);
}

export function undoEditorState<T>(state: EditorHistory<T>): EditorHistory<T> {
  const present = state.past.at(-1);
  if (present === undefined) return state;
  return history(state.past.slice(0, -1), present, [state.present, ...state.future], state.limit);
}

export function redoEditorState<T>(state: EditorHistory<T>): EditorHistory<T> {
  const [present, ...future] = state.future;
  if (present === undefined) return state;
  return history([...state.past, state.present].slice(-state.limit), present, future, state.limit);
}
