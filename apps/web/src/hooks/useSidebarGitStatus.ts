import { useMemo } from "react";
import { type ThreadId } from "@bigbud/contracts";
import { useQueries } from "@tanstack/react-query";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { type ThreadPr } from "../components/sidebar/SidebarThreadRow";

interface ThreadGitTarget {
  threadId: ThreadId;
  branch: string | null;
  cwd: string | null;
  executionTargetId?: string | undefined;
}

/** Derives open PR info for each thread based on git status queries. */
export function useSidebarGitStatus(threadGitTargets: ThreadGitTarget[]): Map<ThreadId, ThreadPr> {
  const threadGitStatusTargets = useMemo(
    () => [
      ...new Map(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .filter((target): target is ThreadGitTarget & { cwd: string } => target.cwd !== null)
          .map((target) => [`${target.executionTargetId ?? "local"}\u0000${target.cwd}`, target]),
      ).values(),
    ],
    [threadGitTargets],
  );

  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusTargets.map((target) => ({
      ...gitStatusQueryOptions(target.cwd, target.executionTargetId),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });

  return useMemo(() => {
    const statusByCwd = new Map<
      string,
      ReturnType<typeof gitStatusQueryOptions>["queryFn"] extends (
        ...args: unknown[]
      ) => Promise<infer R>
        ? R
        : never
    >();
    for (let index = 0; index < threadGitStatusTargets.length; index += 1) {
      const target = threadGitStatusTargets[index];
      if (!target) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(
          `${target.executionTargetId ?? "local"}\u0000${target.cwd}`,
          status as never,
        );
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd
        ? (statusByCwd.get(`${target.executionTargetId ?? "local"}\u0000${target.cwd}`) as
            | { branch: string | null; pr: ThreadPr }
            | undefined)
        : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusQueries, threadGitStatusTargets, threadGitTargets]);
}
