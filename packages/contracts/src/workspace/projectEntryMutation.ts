import { Schema } from "effect";

import { ExecutionTargetId, TrimmedNonEmptyString } from "../core/baseSchemas";
import { FilesystemPath } from "./filesystemPath";
import { ProjectFileEditReadOnlyReason, ProjectWriteFileDisposition } from "./project";

const PROJECT_ENTRY_PATH_MAX_LENGTH = 512;
const ProjectEntryOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const ProjectEntryRelativePath = FilesystemPath.check(
  Schema.isMaxLength(PROJECT_ENTRY_PATH_MAX_LENGTH),
);

/** Whether one Files action (create file, create folder or delete) is allowed for a workspace. */
export const ProjectEntryActionCapability = Schema.Struct({
  allowed: Schema.Boolean,
  reason: Schema.optional(ProjectFileEditReadOnlyReason),
});
export type ProjectEntryActionCapability = typeof ProjectEntryActionCapability.Type;

export const ProjectDeleteEntryCapability = Schema.Struct({
  allowed: Schema.Boolean,
  reason: Schema.optional(ProjectFileEditReadOnlyReason),
  /** True when deleted items cannot be recovered (no system Trash, or a remote host). */
  permanent: Schema.Boolean,
});
export type ProjectDeleteEntryCapability = typeof ProjectDeleteEntryCapability.Type;

export const ProjectEntryActionsInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  cwd: FilesystemPath,
});
export type ProjectEntryActionsInput = typeof ProjectEntryActionsInput.Type;

/** Server-reported Files create/delete support for the composed workspace backend. */
export const ProjectEntryActions = Schema.Struct({
  createFile: ProjectEntryActionCapability,
  createFolder: ProjectEntryActionCapability,
  delete: ProjectDeleteEntryCapability,
});
export type ProjectEntryActions = typeof ProjectEntryActions.Type;

export const ProjectCreateDirectoryInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  /** Stable caller identity; an ambiguous create must not be replayed under a new identity. */
  operationId: Schema.optional(ProjectEntryOperationId),
  cwd: FilesystemPath,
  /** The folder to create; its parent must already exist. */
  relativePath: ProjectEntryRelativePath,
});
export type ProjectCreateDirectoryInput = typeof ProjectCreateDirectoryInput.Type;

export const ProjectCreateDirectoryResult = Schema.Struct({
  relativePath: FilesystemPath,
});
export type ProjectCreateDirectoryResult = typeof ProjectCreateDirectoryResult.Type;

export const ProjectEntryKindExpectation = Schema.Literals(["file", "directory"]);
export type ProjectEntryKindExpectation = typeof ProjectEntryKindExpectation.Type;

export const ProjectDeleteEntryInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  operationId: Schema.optional(ProjectEntryOperationId),
  cwd: FilesystemPath,
  relativePath: ProjectEntryRelativePath,
  /** The kind the user confirmed; a different real entry is refused (a symlink is removed). */
  expectedKind: ProjectEntryKindExpectation,
});
export type ProjectDeleteEntryInput = typeof ProjectDeleteEntryInput.Type;

/** `trashed`: moved to the system Trash; `deleted`: removed permanently. */
export const ProjectDeleteEntryDisposition = Schema.Literals(["trashed", "deleted"]);
export type ProjectDeleteEntryDisposition = typeof ProjectDeleteEntryDisposition.Type;

export const ProjectDeleteEntryResult = Schema.Struct({
  relativePath: FilesystemPath,
  disposition: ProjectDeleteEntryDisposition,
});
export type ProjectDeleteEntryResult = typeof ProjectDeleteEntryResult.Type;

export class ProjectEntryMutationError extends Schema.TaggedErrorClass<ProjectEntryMutationError>()(
  "ProjectEntryMutationError",
  {
    message: TrimmedNonEmptyString,
    /** A create found an entry with that name and left it untouched. */
    alreadyExists: Schema.optional(Schema.Boolean),
    /** The entry to delete no longer exists. */
    notFound: Schema.optional(Schema.Boolean),
    mutationDisposition: Schema.optional(ProjectWriteFileDisposition),
    cause: Schema.optional(Schema.Defect),
  },
) {}
