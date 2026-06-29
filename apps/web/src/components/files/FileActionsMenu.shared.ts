import type { ContextMenuItem } from "@bigbud/contracts";

export type SharedFileActionId =
  | "select-all"
  | "open-externally"
  | "copy-relative-path"
  | "copy-path";

interface CreateSharedFileActionItemsInput {
  readonly canSelectAll: boolean;
  readonly canOpenExternally: boolean;
  readonly canCopyRelativePath: boolean;
  readonly canCopyPath: boolean;
}

export function createSharedFileActionItems(
  input: CreateSharedFileActionItemsInput,
): ReadonlyArray<ContextMenuItem<SharedFileActionId>> {
  return [
    ...(input.canSelectAll ? [{ id: "select-all" as const, label: "Select All" }] : []),
    ...(input.canOpenExternally
      ? [{ id: "open-externally" as const, label: "Open externally" }]
      : []),
    ...(input.canCopyRelativePath
      ? [{ id: "copy-relative-path" as const, label: "Copy relative path" }]
      : []),
    ...(input.canCopyPath ? [{ id: "copy-path" as const, label: "Copy path" }] : []),
  ];
}
