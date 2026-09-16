export function shouldHandleMobileComposerEnter(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}): boolean {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}
