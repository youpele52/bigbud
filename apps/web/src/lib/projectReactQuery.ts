import {
  resolveExecutionTargetId,
  type ExecutionTargetId,
  type ProjectSearchFileContentsResult,
  type ProjectSearchEntriesResult,
} from "@bigbud/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../rpc/nativeApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (
    cwd: string | null,
    query: string,
    limit: number,
    executionTargetId?: ExecutionTargetId | null | undefined,
  ) =>
    [
      "projects",
      "search-entries",
      resolveExecutionTargetId(executionTargetId),
      cwd,
      query,
      limit,
    ] as const,
  searchFileContents: (
    cwd: string | null,
    query: string,
    limit: number,
    executionTargetId?: ExecutionTargetId | null | undefined,
  ) =>
    [
      "projects",
      "search-file-contents",
      resolveExecutionTargetId(executionTargetId),
      cwd,
      query,
      limit,
    ] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_FILE_CONTENTS_LIMIT = 40;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};
const EMPTY_SEARCH_FILE_CONTENTS_RESULT: ProjectSearchFileContentsResult = {
  matches: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(
      input.cwd,
      input.query,
      limit,
      input.executionTargetId,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

export function projectSearchFileContentsQueryOptions(input: {
  cwd: string | null;
  executionTargetId?: ExecutionTargetId | null | undefined;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_FILE_CONTENTS_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchFileContents(
      input.cwd,
      input.query,
      limit,
      input.executionTargetId,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace file content search is unavailable.");
      }
      return api.projects.searchFileContents({
        cwd: input.cwd,
        ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_FILE_CONTENTS_RESULT,
  });
}
