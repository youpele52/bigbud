import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { isSafeRelativePath } from "./GitCore.ssh.owner.mutation.ts";
import {
  COMMIT_FILE_DIFF_ARGS,
  COMMIT_NUMSTAT_ARGS,
  COMMIT_SUMMARY_FORMAT,
  LITERAL_PATHSPEC,
} from "./GitHistory.commit.ts";
import { COMMIT_LOG_FORMAT } from "./GitHistory.parse.ts";

/**
 * History panel reads on a direct SSH target (B): each exact product argv maps to one owner
 * recipe plus validated operands (commit, upstream ref, page, per-file cap). The owner compiles
 * its own argv; nothing here is forwarded as arguments.
 *
 * @module GitCore.ssh.owner.history
 */
export type DirectWorkspaceGitHistoryAction =
  | "commitLog"
  | "upstreamRef"
  | "unpushedShas"
  | "commitSummary"
  | "commitNumstat"
  | "commitFileDiff";

export interface DirectWorkspaceGitHistoryOperands {
  readonly action: DirectWorkspaceGitHistoryAction;
  readonly paths: string[];
  readonly revision?: string;
  readonly limit?: number;
  readonly skip?: number;
  readonly maxOutputBytes?: number;
}

export interface DirectWorkspaceGitHistoryRequest extends DirectWorkspaceGitHistoryOperands {
  readonly executionTargetId: string;
  readonly cwd: string;
}

export interface DirectWorkspaceGitHistoryOwner {
  /** Same contract as the other reads; `commitFileDiff` may return `stdoutTruncated`. */
  readonly execute: (
    request: DirectWorkspaceGitHistoryRequest,
    signal: AbortSignal,
  ) => Promise<ExecuteGitResult>;
}

const COMMIT = /^[0-9a-f]{4,64}$/u;
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/u;
const MAX_LOG_LIMIT = 101;
const MAX_FILE_DIFF_BYTES = 1_000_000;

function isRefName(value: string): boolean {
  return (
    REF.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function same(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return expected.every((arg, index) => actual[index] === arg);
}

function plainRead(input: ExecuteGitInput): boolean {
  return (
    input.allowNonZeroExit === true &&
    input.env === undefined &&
    input.stdin === undefined &&
    input.progress === undefined &&
    input.operationId === undefined &&
    input.timeoutMs === undefined
  );
}

function selectFileDiff(input: ExecuteGitInput): DirectWorkspaceGitHistoryOperands | undefined {
  const cap = input.maxOutputBytes;
  if (
    input.truncateOutputAtMaxBytes !== true ||
    cap === undefined ||
    !Number.isInteger(cap) ||
    cap < 1 ||
    cap > MAX_FILE_DIFF_BYTES ||
    !same(input.args, COMMIT_FILE_DIFF_ARGS)
  ) {
    return undefined;
  }
  const [commit, separator, ...specs] = input.args.slice(COMMIT_FILE_DIFF_ARGS.length);
  if (!commit || !COMMIT.test(commit) || separator !== "--") return undefined;
  if (specs.length < 1 || specs.length > 2) return undefined;
  const paths = specs.map((spec) =>
    spec.startsWith(LITERAL_PATHSPEC) ? spec.slice(LITERAL_PATHSPEC.length) : "",
  );
  if (!paths.every(isSafeRelativePath)) return undefined;
  return { action: "commitFileDiff", paths, revision: commit, maxOutputBytes: cap };
}

/** Match one exact History panel read; anything else is not owner-supported. */
export function selectHistoryRead(
  input: ExecuteGitInput,
): DirectWorkspaceGitHistoryOperands | undefined {
  if (!plainRead(input)) return undefined;
  if (input.operation === "GitCore.getCommitFileDiff") return selectFileDiff(input);
  if (input.maxOutputBytes !== undefined || input.truncateOutputAtMaxBytes !== undefined) {
    return undefined;
  }
  const args = input.args;
  switch (input.operation) {
    case "GitCore.listCommits": {
      const [log, max, ...rest] = args;
      const limit = Number(/^--max-count=([1-9]\d{0,2})$/u.exec(max ?? "")?.[1]);
      const skipArg = rest.length === 2 ? rest[0] : undefined;
      const skip =
        skipArg === undefined ? 0 : Number(/^--skip=([1-9]\d{0,6})$/u.exec(skipArg)?.[1]);
      if (
        log !== "log" ||
        rest.at(-1) !== COMMIT_LOG_FORMAT ||
        rest.length > 2 ||
        !(limit >= 1 && limit <= MAX_LOG_LIMIT) ||
        !(skip >= 0 && skip <= 1_000_000)
      ) {
        return undefined;
      }
      return { action: "commitLog", paths: [], limit, ...(skip > 0 ? { skip } : {}) };
    }
    case "GitCore.listCommits.upstreamRef":
      return args.length === 4 &&
        same(args, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        ? { action: "upstreamRef", paths: [] }
        : undefined;
    case "GitCore.listCommits.unpushed": {
      const ref = args[1]?.endsWith("..HEAD") ? args[1].slice(0, -"..HEAD".length) : "";
      return args.length === 2 && args[0] === "rev-list" && isRefName(ref)
        ? { action: "unpushedShas", paths: [], revision: ref }
        : undefined;
    }
    case "GitCore.getCommitDetails.summary":
      return args.length === 4 &&
        same(args, ["show", "-s", COMMIT_SUMMARY_FORMAT]) &&
        COMMIT.test(args[3]!)
        ? { action: "commitSummary", paths: [], revision: args[3]! }
        : undefined;
    case "GitCore.getCommitDetails.numstat": {
      const commit = args[COMMIT_NUMSTAT_ARGS.length];
      return args.length === COMMIT_NUMSTAT_ARGS.length + 2 &&
        same(args, COMMIT_NUMSTAT_ARGS) &&
        commit !== undefined &&
        COMMIT.test(commit) &&
        args.at(-1) === "--"
        ? { action: "commitNumstat", paths: [], revision: commit }
        : undefined;
    }
    default:
      return undefined;
  }
}
