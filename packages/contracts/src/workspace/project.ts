import { Schema } from "effect";
import { ExecutionTargetId, PositiveInt, TrimmedNonEmptyString } from "../core/baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_FILE_CONTENTS_MAX_LIMIT = 100;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PREVIEW_MAX_BYTES = 512 * 1024;

export const ProjectSearchEntriesInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectSearchFileContentsInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_FILE_CONTENTS_MAX_LIMIT)),
});
export type ProjectSearchFileContentsInput = typeof ProjectSearchFileContentsInput.Type;

export const ProjectFileContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  column: Schema.optional(PositiveInt),
  lineText: Schema.String,
});
export type ProjectFileContentMatch = typeof ProjectFileContentMatch.Type;

export const ProjectSearchFileContentsResult = Schema.Struct({
  matches: Schema.Array(ProjectFileContentMatch),
  truncated: Schema.Boolean,
});
export type ProjectSearchFileContentsResult = typeof ProjectSearchFileContentsResult.Type;

export class ProjectSearchFileContentsError extends Schema.TaggedErrorClass<ProjectSearchFileContentsError>()(
  "ProjectSearchFileContentsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectListDirectoryInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type ProjectListDirectoryInput = typeof ProjectListDirectoryInput.Type;

export const ProjectListDirectoryResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
});
export type ProjectListDirectoryResult = typeof ProjectListDirectoryResult.Type;

export class ProjectListDirectoryError extends Schema.TaggedErrorClass<ProjectListDirectoryError>()(
  "ProjectListDirectoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectDirectoryWatchInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type ProjectDirectoryWatchInput = typeof ProjectDirectoryWatchInput.Type;

export const ProjectDirectoryChangedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("directoryChanged"),
  relativePath: Schema.String,
});
export type ProjectDirectoryChangedEvent = typeof ProjectDirectoryChangedEvent.Type;

export const ProjectDirectoryWatchEvent = Schema.Union([ProjectDirectoryChangedEvent]);
export type ProjectDirectoryWatchEvent = typeof ProjectDirectoryWatchEvent.Type;

export class ProjectDirectoryWatchError extends Schema.TaggedErrorClass<ProjectDirectoryWatchError>()(
  "ProjectDirectoryWatchError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectReadFilePreviewInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  maxBytes: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_READ_FILE_PREVIEW_MAX_BYTES)),
  ),
});
export type ProjectReadFilePreviewInput = typeof ProjectReadFilePreviewInput.Type;

export const ProjectReadFilePreviewResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  sizeBytes: Schema.Number,
  truncated: Schema.Boolean,
});
export type ProjectReadFilePreviewResult = typeof ProjectReadFilePreviewResult.Type;

export class ProjectReadFilePreviewError extends Schema.TaggedErrorClass<ProjectReadFilePreviewError>()(
  "ProjectReadFilePreviewError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  executionTargetId: Schema.optional(ExecutionTargetId),
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
