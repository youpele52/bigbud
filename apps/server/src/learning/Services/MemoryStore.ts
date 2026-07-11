import { ProjectId, TrimmedNonEmptyString } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

export const MemoryScope = Schema.Literals(["user", "global", "project"]);
export type MemoryScope = typeof MemoryScope.Type;

export const MemoryDocument = Schema.Struct({
  scope: MemoryScope,
  projectId: Schema.NullOr(ProjectId),
  content: Schema.String,
  updatedAt: Schema.String,
});
export type MemoryDocument = typeof MemoryDocument.Type;

export const WriteMemoryDocumentInput = Schema.Struct({
  scope: MemoryScope,
  projectId: Schema.NullOr(ProjectId),
  content: Schema.String,
  expectedContent: Schema.optional(Schema.String),
});
export type WriteMemoryDocumentInput = typeof WriteMemoryDocumentInput.Type;

export class MemoryConflictError extends Schema.TaggedErrorClass<MemoryConflictError>()(
  "MemoryConflictError",
  { scope: MemoryScope, projectId: Schema.NullOr(ProjectId) },
) {}

export class MemoryStoreError extends Schema.TaggedErrorClass<MemoryStoreError>()(
  "MemoryStoreError",
  {
    operation: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface MemoryStoreShape {
  readonly read: (input: {
    readonly scope: MemoryScope;
    readonly projectId: ProjectId | null;
  }) => Effect.Effect<MemoryDocument, MemoryStoreError>;
  readonly write: (
    input: WriteMemoryDocumentInput,
  ) => Effect.Effect<MemoryDocument, MemoryStoreError | MemoryConflictError>;
}

export class MemoryStore extends ServiceMap.Service<MemoryStore, MemoryStoreShape>()(
  "t3/learning/Services/MemoryStore",
) {}
