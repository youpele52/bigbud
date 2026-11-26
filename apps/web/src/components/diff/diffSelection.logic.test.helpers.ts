export function mockElement(input: {
  readonly attributes?: Record<string, string>;
  readonly dataset?: Record<string, string>;
  readonly parent?: Node | null;
  readonly localName?: string;
  readonly parentElement?: HTMLElement | null;
  readonly textContent?: string;
}): HTMLElement {
  return {
    localName: input.localName ?? "div",
    getAttribute: (name: string) => input.attributes?.[name] ?? null,
    hasAttribute: (name: string) => input.attributes?.[name] !== undefined,
    dataset: input.dataset ?? {},
    parentNode: input.parent ?? null,
    parentElement: input.parentElement ?? (input.parent as HTMLElement | null) ?? null,
    textContent: input.textContent ?? null,
  } as unknown as HTMLElement;
}
