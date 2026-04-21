import { Cause, Exit, Result, Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@bigbud/contracts";
import { formatSchemaError } from "@bigbud/shared/schemaJson";

export interface NormalizedGitHubPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: string | null;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

const GitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

type RawPullRequest = Schema.Schema.Type<typeof GitHubPullRequestSchema>;

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubPullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const normalizedState = input.state?.trim().toUpperCase();
  if (
    (typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0) ||
    normalizedState === "MERGED"
  ) {
    return "merged";
  }
  if (normalizedState === "CLOSED") {
    return "closed";
  }
  return "open";
}

function normalizeGitHubPullRequestRecord(raw: RawPullRequest): NormalizedGitHubPullRequestRecord {
  const headRepositoryNameWithOwner = trimOptionalString(raw.headRepository?.nameWithOwner);
  const headRepositoryOwnerLogin =
    trimOptionalString(raw.headRepositoryOwner?.login) ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizeGitHubPullRequestState(raw),
    updatedAt:
      typeof raw.updatedAt === "string" && raw.updatedAt.trim().length > 0 ? raw.updatedAt : null,
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

const decodePullRequestListFromJson = Schema.decodeExit(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const decodePullRequestEntry = Schema.decodeUnknownExit(GitHubPullRequestSchema);
const decodePullRequestFromJson = Schema.decodeExit(Schema.fromJsonString(GitHubPullRequestSchema));

export const formatGitHubJsonDecodeError = formatSchemaError;

export function decodeGitHubPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const listResult = decodePullRequestListFromJson(raw);
  if (Exit.isFailure(listResult)) {
    return Result.fail(listResult.cause);
  }
  const pullRequests: NormalizedGitHubPullRequestRecord[] = [];
  for (const entry of listResult.value) {
    const decoded = decodePullRequestEntry(entry);
    if (Exit.isFailure(decoded)) {
      continue;
    }
    pullRequests.push(normalizeGitHubPullRequestRecord(decoded.value));
  }
  return Result.succeed(pullRequests);
}

export function decodeGitHubPullRequestJson(
  raw: string,
): Result.Result<NormalizedGitHubPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodePullRequestFromJson(raw);
  if (Exit.isFailure(result)) {
    return Result.fail(result.cause);
  }
  return Result.succeed(normalizeGitHubPullRequestRecord(result.value));
}
