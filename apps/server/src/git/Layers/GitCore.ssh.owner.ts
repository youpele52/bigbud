import { posix } from "node:path";
import { Effect } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";

import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./GitCoreExecutor.ts";
import {
  DIRECT_WORKSPACE_GIT_MUTATION_LIMITS,
  DirectWorkspaceGitOutcomeUnknown,
  selectMutation,
  selectPathRead,
  type DirectWorkspaceGitMutationOwner,
  type DirectWorkspaceGitPathReadOwner,
} from "./GitCore.ssh.owner.mutation.ts";
import { selectDiffRead, type DirectWorkspaceGitDiffReadOwner } from "./GitCore.ssh.owner.reads.ts";
import {
  selectTemplate,
  type DirectWorkspaceGitTemplateOwner,
} from "./GitCore.ssh.owner.templates.ts";
import {
  selectHistoryRead,
  type DirectWorkspaceGitHistoryOwner,
} from "./GitCore.ssh.owner.history.ts";

export type {
  DirectWorkspaceGitTemplateOwner,
  DirectWorkspaceGitTemplateRequest,
} from "./GitCore.ssh.owner.templates.ts";
export type {
  DirectWorkspaceGitHistoryOwner,
  DirectWorkspaceGitHistoryRequest,
} from "./GitCore.ssh.owner.history.ts";
export type {
  DirectWorkspaceGitDiffReadAction,
  DirectWorkspaceGitDiffReadOwner,
  DirectWorkspaceGitDiffReadRequest,
} from "./GitCore.ssh.owner.reads.ts";
export type {
  DirectWorkspaceGitMutationAction,
  DirectWorkspaceGitMutationOwner,
  DirectWorkspaceGitMutationRequest,
  DirectWorkspaceGitPathReadOwner,
  DirectWorkspaceGitPathReadRequest,
} from "./GitCore.ssh.owner.mutation.ts";
export {
  DIRECT_WORKSPACE_GIT_MUTATION_LIMITS,
  DirectWorkspaceGitOutcomeUnknown,
} from "./GitCore.ssh.owner.mutation.ts";

const STATUS_READ_RECIPES = {
  statusPorcelainV2: { suffix: "status", args: ["status", "--porcelain=2", "--branch", "-uall"] },
  unstagedNumstat: { suffix: "unstagedNumstat", args: ["diff", "--numstat"] },
  stagedNumstat: { suffix: "stagedNumstat", args: ["diff", "--cached", "--numstat"] },
  originDefaultRef: { suffix: "defaultRef", args: ["symbolic-ref", "refs/remotes/origin/HEAD"] },
} as const;

/** Exact read recipes used by the discard UI, separate from status-details composition. */
const DISCARD_READ_RECIPES = {
  statusPorcelainV2Nul: {
    operation: "GitCore.discardChanges.status",
    args: ["status", "--porcelain=2", "-z", "-uall"],
  },
  showToplevel: {
    operation: "GitCore.discardChanges.topLevel",
    args: ["rev-parse", "--show-toplevel"],
  },
} as const;

export type DirectWorkspaceGitAction =
  | "statusPorcelainV2"
  | "isInsideWorkTree"
  | keyof typeof DISCARD_READ_RECIPES;
export type DirectWorkspaceGitMetadataAction =
  | Exclude<keyof typeof STATUS_READ_RECIPES, "statusPorcelainV2">
  | "originRemoteUrl";
type WorkspaceReadAction = DirectWorkspaceGitAction | DirectWorkspaceGitMetadataAction;

const defaultReadLimits = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
} as const;

export const DIRECT_WORKSPACE_GIT_LIMITS = {
  statusPorcelainV2: defaultReadLimits,
  unstagedNumstat: defaultReadLimits,
  stagedNumstat: defaultReadLimits,
  originDefaultRef: defaultReadLimits,
  originRemoteUrl: defaultReadLimits,
  statusPorcelainV2Nul: defaultReadLimits,
  showToplevel: defaultReadLimits,
  isInsideWorkTree: { timeoutMs: 5_000, maxOutputBytes: 4_096 },
} as const satisfies Record<WorkspaceReadAction, { timeoutMs: number; maxOutputBytes: number }>;

export interface DirectWorkspaceGitRequest<
  A extends WorkspaceReadAction = DirectWorkspaceGitAction,
> {
  readonly action: A;
  readonly executionTargetId: string;
  readonly cwd: string;
}

export interface DirectWorkspaceGitOwner {
  /**
   * Bind each action, target, and cwd to the authorized workspace and target generation before
   * dispatch; matching an operation label is not authorization. Select the fixed recipe and
   * limits by action. Read only local workspace state: configurations that can spawn helpers or
   * fetch missing objects must be refused unless the owner can prevent those effects without
   * changing the result. Return ordinary Git exits (including nonzero); reject on denial, timeout,
   * transport failure, or overflow of either stream. This is not initiating-side Git transport.
   */
  readonly execute: (
    request: DirectWorkspaceGitRequest,
    signal: AbortSignal,
  ) => Promise<ExecuteGitResult>;
  /** Optional extension with the same admission and failure contract. */
  readonly statusMetadata?: {
    readonly execute: (
      request: DirectWorkspaceGitRequest<DirectWorkspaceGitMetadataAction>,
      signal: AbortSignal,
    ) => Promise<ExecuteGitResult>;
  };
  /** Optional fixed-recipe mutations; the selected dev layer supplies the owner-backed one. */
  readonly mutation?: DirectWorkspaceGitMutationOwner;
  /** Optional fixed single-path read used for bounded untracked line counts. */
  readonly pathRead?: DirectWorkspaceGitPathReadOwner;
  /** Optional fixed diff-panel and branch-list reads (C06, B). */
  readonly diffRead?: DirectWorkspaceGitDiffReadOwner;
  /** Optional History panel reads (B). */
  readonly history?: DirectWorkspaceGitHistoryOwner;
  /** Optional branch, checkout, commit, worktree and range recipes (B). */
  readonly template?: DirectWorkspaceGitTemplateOwner;
}

function exactArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((arg, index) => arg === actual[index]);
}

function selectAction(input: ExecuteGitInput): WorkspaceReadAction | undefined {
  if (
    input.allowNonZeroExit !== true ||
    input.env !== undefined ||
    input.stdin !== undefined ||
    input.progress !== undefined ||
    input.operationId !== undefined ||
    input.truncateOutputAtMaxBytes !== undefined
  ) {
    return undefined;
  }

  if (input.timeoutMs === undefined && input.maxOutputBytes === undefined) {
    for (const action of Object.keys(STATUS_READ_RECIPES) as Array<
      keyof typeof STATUS_READ_RECIPES
    >) {
      const { suffix, args } = STATUS_READ_RECIPES[action];
      if (
        (input.operation === `GitCore.statusDetails.${suffix}` ||
          input.operation === `GitCore.statusDetailsLocal.${suffix}`) &&
        exactArgs(input.args, args)
      ) {
        return action;
      }
    }
    if (
      input.operation === "GitCore.originRemoteExists" &&
      exactArgs(input.args, ["remote", "get-url", "origin"])
    ) {
      return "originRemoteUrl";
    }
    for (const action of Object.keys(DISCARD_READ_RECIPES) as Array<
      keyof typeof DISCARD_READ_RECIPES
    >) {
      const { operation, args } = DISCARD_READ_RECIPES[action];
      if (input.operation === operation && exactArgs(input.args, args)) {
        return action;
      }
    }
  }

  if (
    input.operation === "GitCore.isInsideWorkTree" &&
    exactArgs(input.args, ["rev-parse", "--is-inside-work-tree"]) &&
    input.timeoutMs === DIRECT_WORKSPACE_GIT_LIMITS.isInsideWorkTree.timeoutMs &&
    input.maxOutputBytes === DIRECT_WORKSPACE_GIT_LIMITS.isInsideWorkTree.maxOutputBytes
  ) {
    return "isInsideWorkTree";
  }

  return undefined;
}

export function executeOwnedWorkspaceGit(
  owner: DirectWorkspaceGitOwner,
  input: ExecuteGitInput,
  executionTargetId: string,
): Effect.Effect<ExecuteGitResult, GitCommandError> {
  const { operation, cwd } = input;
  const fail = (detail: string, cause?: unknown) =>
    new GitCommandError({
      operation,
      command: "direct workspace Git",
      cwd,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target || target.transport === "agent" || !posix.isAbsolute(cwd) || cwd.includes("\0")) {
    return Effect.fail(
      fail("A direct SSH target and an absolute workspace directory are required."),
    );
  }

  const action = selectAction(input);
  const mutation = action === undefined ? selectMutation(input) : undefined;
  const pathRead =
    action === undefined && mutation === undefined ? selectPathRead(input) : undefined;
  const diffRead =
    action === undefined && mutation === undefined && pathRead === undefined
      ? selectDiffRead(input)
      : undefined;
  const diffReadOwner = owner.diffRead;
  const history =
    action === undefined && mutation === undefined && pathRead === undefined && !diffRead
      ? selectHistoryRead(input)
      : undefined;
  const historyOwner = owner.history;
  const template =
    action === undefined &&
    mutation === undefined &&
    pathRead === undefined &&
    !diffRead &&
    history === undefined
      ? selectTemplate(input)
      : undefined;
  const templateOwner = owner.template;
  const statusMetadata = owner.statusMetadata;
  const mutationOwner = owner.mutation;
  const pathReadOwner = owner.pathRead;
  let execute: (signal: AbortSignal) => Promise<ExecuteGitResult>;
  if (action === "statusPorcelainV2" || action === "isInsideWorkTree") {
    execute = (signal) => owner.execute({ action, executionTargetId, cwd }, signal);
  } else if (action === "statusPorcelainV2Nul" || action === "showToplevel") {
    execute = (signal) => owner.execute({ action, executionTargetId, cwd }, signal);
  } else if (action !== undefined && statusMetadata !== undefined) {
    execute = (signal) => statusMetadata.execute({ action, executionTargetId, cwd }, signal);
  } else if (pathRead !== undefined && pathReadOwner !== undefined) {
    execute = (signal) =>
      pathReadOwner.execute(
        {
          action: "untrackedNumstat",
          executionTargetId,
          cwd,
          path: pathRead.path,
        },
        signal,
      );
  } else if (template !== undefined && templateOwner !== undefined) {
    execute = (signal) =>
      templateOwner.execute(
        { action: template.action, operands: template.operands, executionTargetId, cwd },
        signal,
      );
  } else if (history !== undefined && historyOwner !== undefined) {
    execute = (signal) => historyOwner.execute({ ...history, executionTargetId, cwd }, signal);
  } else if (diffRead !== undefined && diffReadOwner !== undefined) {
    execute = (signal) =>
      diffReadOwner.execute(
        { action: diffRead.action, executionTargetId, cwd, paths: diffRead.paths },
        signal,
      );
  } else if (mutation !== undefined && mutationOwner !== undefined) {
    execute = (signal) =>
      mutationOwner.execute(
        {
          action: mutation.action,
          executionTargetId,
          cwd,
          paths: mutation.paths,
          ...(mutation.operationId !== undefined ? { operationId: mutation.operationId } : {}),
        },
        signal,
      );
  } else {
    return Effect.fail(
      fail(
        mutation !== undefined || pathRead !== undefined
          ? "This Git mutation is not supported by the direct workspace Git owner."
          : "This Git request is not supported by the direct workspace Git owner.",
      ),
    );
  }

  return Effect.tryPromise({
    try: execute,
    // Do not let owner/transport errors look like Git's ordinary repository discovery failures.
    catch: (cause) =>
      cause instanceof DirectWorkspaceGitOutcomeUnknown
        ? fail((cause as Error).message, cause)
        : fail("The direct workspace Git owner could not complete the request.", cause),
  }).pipe(
    Effect.flatMap((result) => {
      // Only the per-file commit diff reports a cut instead of failing (typed "too large").
      const capped =
        (history?.action === "commitFileDiff" || template?.capped === true) &&
        !result.stderrTruncated;
      if (!capped && (result.stdoutTruncated || result.stderrTruncated)) {
        return Effect.fail(fail("The direct workspace Git owner exceeded the output limit."));
      }
      if (!Number.isInteger(result.code) || result.code < 0 || result.code >= 255) {
        return Effect.fail(
          fail("The direct workspace Git owner did not return an ordinary Git exit."),
        );
      }
      return Effect.succeed(result);
    }),
  );
}
