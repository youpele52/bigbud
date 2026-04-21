import { useMemo } from "react";
import { type ThreadId } from "@bigbud/contracts";
import { useQueries } from "@tanstack/react-query";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { type ThreadPr } from "../components/sidebar/SidebarThreadRow";

interface ThreadGitTarget {
  threadId: ThreadId;
  branch: string | null;
  cwd: string | null;
}

/** Derives open PR info for each thread based on git status queries. */
export function useSidebarGitStatus(threadGitTargets: ThreadGitTarget[]): Map<ThreadId, ThreadPr> {
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );

  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
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
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status as never);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd
        ? (statusByCwd.get(target.cwd) as { branch: string | null; pr: ThreadPr } | undefined)
        : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);
}
