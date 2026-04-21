/**
 * Pull-request discovery and completion toast helpers for GitManager.
 *
 * Accepts service instances as parameters to remain decoupled from the
 * Effect service layer.
 *
 * @module GitManager.prLookup
 */
import { Effect, Result } from "effect";

import type { GitRunStackedActionResult } from "@bigbud/contracts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitHubCliShape } from "../Services/GitHubCli.ts";
import {
  gitManagerError,
  matchesBranchHeadContext,
  toPullRequestInfo,
} from "./GitManager.prUtils.ts";
import {
  decodeGitHubPullRequestListJson,
  formatGitHubJsonDecodeError,
} from "../githubPullRequests.ts";
import { summarizeGitActionResult } from "./GitManager.commitUtils.ts";
import type { BranchHeadContext, PullRequestInfo } from "./GitManager.types.ts";
import type { makeBranchContext } from "./GitManager.branchContext.ts";

export function makePrLookup(
  gitCore: GitCoreShape,
  gitHubCli: GitHubCliShape,
  branchContext: ReturnType<typeof makeBranchContext>,
) {
  const { resolveBranchHeadContext } = branchContext;

  const findOpenPr = Effect.fn("findOpenPr")(function* (
    cwd: string,
    headContext: Pick<
      BranchHeadContext,
      | "headBranch"
      | "headSelectors"
      | "headRepositoryNameWithOwner"
      | "headRepositoryOwnerLogin"
      | "isCrossRepository"
    >,
  ) {
    for (const headSelector of headContext.headSelectors) {
      const pullRequests = yield* gitHubCli.listOpenPullRequests({
        cwd,
        headSelector,
        limit: 1,
      });
      const normalizedPullRequests = pullRequests.map(toPullRequestInfo);

      const firstPullRequest = normalizedPullRequests.find((pullRequest) =>
        matchesBranchHeadContext(pullRequest, headContext),
      );
      if (firstPullRequest) {
        return {
          number: firstPullRequest.number,
          title: firstPullRequest.title,
          url: firstPullRequest.url,
          baseRefName: firstPullRequest.baseRefName,
          headRefName: firstPullRequest.headRefName,
          state: "open",
          updatedAt: null,
        } satisfies PullRequestInfo;
      }
    }

    return null;
  });

  const findLatestPr = Effect.fn("findLatestPr")(function* (
    cwd: string,
    details: { branch: string; upstreamRef: string | null },
  ) {
    const headContext = yield* resolveBranchHeadContext(cwd, details);
    const parsedByNumber = new Map<number, PullRequestInfo>();

    for (const headSelector of headContext.headSelectors) {
      const stdout = yield* gitHubCli
        .execute({
          cwd,
          args: [
            "pr",
            "list",
            "--head",
            headSelector,
            "--state",
            "all",
            "--limit",
            "20",
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        })
        .pipe(Effect.map((result) => result.stdout));

      const raw = stdout.trim();
      if (raw.length === 0) {
        continue;
      }

      const pullRequests = yield* Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
        Effect.flatMap((decoded) => {
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              gitManagerError(
                "findLatestPr",
                `GitHub CLI returned invalid PR list JSON: ${formatGitHubJsonDecodeError(decoded.failure)}`,
                decoded.failure,
              ),
            );
          }
          return Effect.succeed(decoded.success);
        }),
      );

      for (const pr of pullRequests) {
        if (!matchesBranchHeadContext(pr, headContext)) {
          continue;
        }
        parsedByNumber.set(pr.number, pr);
      }
    }

    const parsed = Array.from(parsedByNumber.values()).toSorted((a, b) => {
      const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return right - left;
    });

    const latestOpenPr = parsed.find((pr) => pr.state === "open");
    if (latestOpenPr) {
      return latestOpenPr;
    }
    return parsed[0] ?? null;
  });

  const buildCompletionToast = Effect.fn("buildCompletionToast")(function* (
    cwd: string,
    result: Pick<GitRunStackedActionResult, "action" | "branch" | "commit" | "push" | "pr">,
  ) {
    const summary = summarizeGitActionResult(result);
    let latestOpenPr: PullRequestInfo | null = null;
    let currentBranchIsDefault = false;
    let finalBranchContext: {
      branch: string;
      upstreamRef: string | null;
      hasUpstream: boolean;
    } | null = null;

    if (result.action !== "commit") {
      const finalStatus = yield* gitCore.statusDetails(cwd);
      if (finalStatus.branch) {
        finalBranchContext = {
          branch: finalStatus.branch,
          upstreamRef: finalStatus.upstreamRef,
          hasUpstream: finalStatus.hasUpstream,
        };
        currentBranchIsDefault = finalStatus.isDefaultBranch;
      }
    }

    const explicitResultPr =
      (result.pr.status === "created" || result.pr.status === "opened_existing") && result.pr.url
        ? {
            url: result.pr.url,
            state: "open" as const,
          }
        : null;
    const shouldLookupExistingOpenPr =
      (result.action === "commit_push" || result.action === "push") &&
      result.push.status === "pushed" &&
      result.branch.status !== "created" &&
      !currentBranchIsDefault &&
      explicitResultPr === null &&
      finalBranchContext?.hasUpstream === true;

    if (shouldLookupExistingOpenPr && finalBranchContext) {
      latestOpenPr = yield* resolveBranchHeadContext(cwd, {
        branch: finalBranchContext.branch,
        upstreamRef: finalBranchContext.upstreamRef,
      }).pipe(
        Effect.flatMap((headContext) => findOpenPr(cwd, headContext)),
        Effect.catch(() => Effect.succeed(null)),
      );
    }

    const openPr = latestOpenPr ?? explicitResultPr;

    const cta =
      result.action === "commit" && result.commit.status === "created"
        ? {
            kind: "run_action" as const,
            label: "Push",
            action: { kind: "push" as const },
          }
        : (result.action === "push" ||
              result.action === "create_pr" ||
              result.action === "commit_push" ||
              result.action === "commit_push_pr") &&
            openPr?.url &&
            (!currentBranchIsDefault ||
              result.pr.status === "created" ||
              result.pr.status === "opened_existing")
          ? {
              kind: "open_pr" as const,
              label: "View PR",
              url: openPr.url,
            }
          : (result.action === "push" || result.action === "commit_push") &&
              result.push.status === "pushed" &&
              !currentBranchIsDefault
            ? {
                kind: "run_action" as const,
                label: "Create PR",
                action: { kind: "create_pr" as const },
              }
            : {
                kind: "none" as const,
              };

    return {
      ...summary,
      cta,
    };
  });

  return {
    findOpenPr,
    findLatestPr,
    buildCompletionToast,
  };
}
