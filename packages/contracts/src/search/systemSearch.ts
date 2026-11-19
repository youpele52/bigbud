import { Schema } from "effect";

import {
  ExecutionTargetId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";

/** Longest query, in characters; the agent engine enforces the same limit. */
export const SYSTEM_SEARCH_MAX_QUERY_CHARS = 512;
/** Rows sent to the client per query, across every tier (plan §4). */
export const SYSTEM_SEARCH_MAX_ROWS = 200;

/**
 * Tiers served by `search.query`, named like the palette tiers (plan §1): T2 current project
 * files, T4 other projects' files, T5 this computer, T6 remote areas outside projects. T1 and T3
 * stay on their existing RPCs.
 */
export const SystemSearchTier = Schema.Literals([
  "currentProject",
  "otherProjectFiles",
  "thisComputer",
  "remoteOutsideProjects",
] as const);
export type SystemSearchTier = typeof SystemSearchTier.Type;

export const SystemSearchQueryInput = Schema.Struct({
  /** Client generation label echoed in every update; lets the client drop late updates. */
  queryId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(SYSTEM_SEARCH_MAX_QUERY_CHARS)),
  currentProjectId: Schema.optional(ProjectId),
  currentThreadId: Schema.optional(ThreadId),
  tiers: Schema.Array(SystemSearchTier),
});
export type SystemSearchQueryInput = typeof SystemSearchQueryInput.Type;

export const SystemSearchHit = Schema.Struct({
  /** Stable row identity `tier:source:target:path[:line[:column]]`. */
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["name", "content"] as const),
  executionTargetId: ExecutionTargetId,
  /** Absolute folder the path is relative to (project root, remote folder, or a T5 parent). */
  root: TrimmedNonEmptyString,
  /** `/`-separated path relative to `root`. */
  path: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  /** Project title or folder label shown beside the row. */
  label: Schema.optional(Schema.String),
  isDirectory: Schema.optional(Schema.Boolean),
  sizeBytes: Schema.optional(NonNegativeInt),
  modifiedUnixMs: Schema.optional(NonNegativeInt),
  line: Schema.optional(NonNegativeInt),
  column: Schema.optional(NonNegativeInt),
  excerpt: Schema.optional(Schema.String),
});
export type SystemSearchHit = typeof SystemSearchHit.Type;

/**
 * Why a source is partial or unavailable. The palette shows a notice for each:
 * `not-connected` (the remote is not connected; the server never dials just to search),
 * `agent-update-available` (old remote agent: names only), `use-managed-agent` (SSH-only host),
 * `agent-unavailable`, `busy`, `error`, and the "this computer" states (`disabled`,
 * `file-access-none`, `unsupported`, `policy`, `index-unavailable`).
 */
export const SystemSearchReason = Schema.Literals([
  "not-connected",
  "agent-update-available",
  "use-managed-agent",
  "agent-unavailable",
  "busy",
  "error",
  "disabled",
  "file-access-none",
  "unsupported",
  "policy",
  "index-unavailable",
] as const);
export type SystemSearchReason = typeof SystemSearchReason.Type;

export const SystemSearchSourceState = Schema.Literals([
  "searching",
  "partial",
  "done",
  "unavailable",
] as const);
export type SystemSearchSourceState = typeof SystemSearchSourceState.Type;

/** One streamed update. `items` only carries rows new since the previous update for the source. */
export const SystemSearchTierUpdate = Schema.Struct({
  queryId: TrimmedNonEmptyString,
  tier: SystemSearchTier,
  /** `local`, an execution target, or `spotlight`; one source per tier answers in order. */
  sourceId: TrimmedNonEmptyString,
  items: Schema.Array(SystemSearchHit),
  state: SystemSearchSourceState,
  reason: Schema.optional(SystemSearchReason),
  truncated: Schema.Boolean,
});
export type SystemSearchTierUpdate = typeof SystemSearchTierUpdate.Type;

export class SystemSearchError extends Schema.TaggedErrorClass<SystemSearchError>()(
  "SystemSearchError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
