import type {
  ProjectDeleteEntryCapability,
  ProjectEntryActionCapability,
} from "@bigbud/contracts/workspace/projectEntryMutation";
import { FILE_EDIT_READ_ONLY_COPY } from "./fileEditEligibility";

export type NewEntryKind = "file" | "folder";

export interface DeleteEntryTarget {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
}

const MAX_ENTRY_NAME_LENGTH = 255;

/** A new entry name is one path segment: no separators, no `.`/`..`, no NUL, not too long. */
export function validateNewEntryName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "Enter a name.";
  if (name === "." || name === "..") return "That name isn't allowed.";
  if (/[/\\]/.test(name) || name.includes("\0")) return "A name can't contain / or \\.";
  if (name.length > MAX_ENTRY_NAME_LENGTH) return "That name is too long.";
  return null;
}

export function joinRelativeEntryPath(parentPath: string, name: string): string {
  return parentPath.length === 0 ? name : `${parentPath}/${name}`;
}

export function parentRelativePath(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index < 0 ? "" : relativePath.slice(0, index);
}

export function entryBaseName(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

/**
 * The folder a new entry goes into: the folder the user last opened when it and every ancestor
 * are still expanded (so the input is visible), else its deepest still-visible ancestor, else
 * the workspace root.
 */
export function resolveCreateTargetFolder(
  lastToggledFolder: string | null,
  expandedDirectories: Readonly<Record<string, boolean>>,
): string {
  if (!lastToggledFolder) return "";
  const segments = lastToggledFolder.split("/");
  let target = "";
  for (let index = 1; index <= segments.length; index++) {
    const candidate = segments.slice(0, index).join("/");
    if (!expandedDirectories[candidate]) break;
    target = candidate;
  }
  return target;
}

/** Why an action is unavailable, using the editor's read-only copy; null when allowed. */
export function entryActionDisabledReason(
  capability: ProjectEntryActionCapability | ProjectDeleteEntryCapability | null | undefined,
): string | null {
  if (!capability) return "Checking whether this location can be changed…";
  if (capability.allowed) return null;
  return FILE_EDIT_READ_ONLY_COPY[capability.reason ?? "unsupportedTarget"];
}

export interface DeleteConfirmationCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

export function deleteConfirmationCopy(input: {
  readonly target: DeleteEntryTarget;
  readonly permanent: boolean;
  readonly remote: boolean;
}): DeleteConfirmationCopy {
  const name = entryBaseName(input.target.relativePath);
  const folder = input.target.kind === "directory";
  const contents = folder ? `This deletes the folder ${name} and everything inside it. ` : "";
  const outcome = input.remote
    ? "This can't be undone."
    : input.permanent
      ? "The Trash isn't available here, so it is deleted permanently. This can't be undone."
      : `${folder ? "It moves" : "The file moves"} to the Trash.`;
  return {
    title: `Delete ${name}?`,
    description: `${contents}${outcome}`,
    confirmLabel: input.remote || input.permanent ? "Delete permanently" : "Move to Trash",
  };
}

/** Typed error flags from `ProjectEntryMutationError` / `ProjectWriteFileError`. */
export function createEntryErrorMessage(error: unknown, name: string): string {
  if (error && typeof error === "object" && "alreadyExists" in error && error.alreadyExists) {
    return `${name} already exists here. Choose another name.`;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message;
  return "It couldn't be created.";
}

/** Whether `path` is `deleted` or inside it (a deleted folder also removes its descendants). */
export function isSameOrDescendantPath(path: string, deleted: string): boolean {
  return path === deleted || path.startsWith(`${deleted}/`);
}
