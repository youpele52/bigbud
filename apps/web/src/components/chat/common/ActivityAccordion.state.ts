import type { SyntheticEvent } from "react";

/** Persisted open state of every timeline accordion, keyed by `activityAccordionId`. */
export type ActivityAccordionOpenById = Readonly<Record<string, boolean>>;
export type SetActivityAccordionOpen = (id: string, open: boolean) => void;

/** Namespaces keep ids unique when different row kinds share a timeline row id. */
export type ActivityAccordionKind = "question" | "work" | "work-entry" | "thinking" | "subagents";

/** Controlled `<details>` props for an `ActivityAccordion`. */
export interface ActivityAccordionControl {
  readonly open: boolean;
  readonly onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => void;
}

export function activityAccordionId(kind: ActivityAccordionKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

/** Every accordion starts collapsed until the user opens it. */
export function resolveActivityAccordionOpen(
  openById: ActivityAccordionOpenById | undefined,
  id: string,
): boolean {
  return openById?.[id] ?? false;
}

/**
 * Persist native `<details>` toggles outside the row, so a virtualized row that unmounts and
 * remounts keeps its state. Only a toggle that disagrees with the rendered state is stored:
 * `toggle` also fires when React applies `open` itself, which must not store anything.
 */
export function controlledActivityAccordionProps(input: {
  readonly id: string;
  readonly openById: ActivityAccordionOpenById;
  readonly onSetOpen: SetActivityAccordionOpen;
}): ActivityAccordionControl {
  const open = resolveActivityAccordionOpen(input.openById, input.id);
  return {
    open,
    onToggle: (event) => {
      const next = event.currentTarget.open;
      if (next !== open) input.onSetOpen(input.id, next);
    },
  };
}
