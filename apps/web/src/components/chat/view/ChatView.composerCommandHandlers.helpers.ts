import { type TerminalContextDraft } from "../../../lib/terminalContext";

export function extendReplacementRangeForTrailingSpace(
  text: string,
  rangeEnd: number,
  replacement: string,
): number {
  if (!replacement.endsWith(" ")) return rangeEnd;
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
}

export function syncTerminalContextsByIds(
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
}

export function terminalContextIdListsEqual(
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean {
  return (
    contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index])
  );
}
