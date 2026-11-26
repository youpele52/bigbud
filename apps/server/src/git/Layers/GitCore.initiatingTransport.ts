import { Schema, ServiceMap } from "effect";
import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { BoundedInitiatingGitTransport } from "./GitCore.initiatingPush.composition.ts";

/**
 * Owner-controlled initiating Git transport.
 *
 * The owner decides the SSH executable, arguments and environment. TypeScript supplies only
 * validated operands: workspace root, remote name, refspecs and the bound target generation.
 * No ambient `ssh`, `GIT_SSH_COMMAND` passthrough or HTTPS substitution is accepted.
 */

export type InitiatingGitVerb = "fetch" | "pull" | "push" | "checkoutPullRequest" | "gh";

export interface InitiatingFetchOperands {
  readonly cwd: string;
  readonly remoteName: string;
  readonly refspecs: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

export type InitiatingFetchOutcome = "fetched" | "upToDate";

/** The bigbud target that serves one push URL, as the trusted push producer records it. */
export interface InitiatingPushTarget {
  readonly executionTargetId: string;
  readonly targetGeneration: string;
  readonly endpoint: {
    readonly host: string;
    readonly user: string;
    readonly port: number;
    readonly repositoryPath: string;
  };
}

export interface InitiatingFetchBinding {
  readonly fetch: (
    operands: InitiatingFetchOperands,
    signal: AbortSignal,
  ) => Promise<InitiatingFetchOutcome>;
  /** U15 production push to a bigbud target; absent keeps such pushes refused. */
  readonly push?: {
    readonly select: (url: string) => Promise<InitiatingPushTarget | undefined>;
    readonly transport: BoundedInitiatingGitTransport;
  };
}

/** Injected only by the selected dev composition; absence keeps the verb refused. */
export class InitiatingFetchOwner extends ServiceMap.Service<
  InitiatingFetchOwner,
  InitiatingFetchBinding
>()("bigbud/git/InitiatingFetchOwner") {}

const AMBIENT_TRANSPORT_ENV = [
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_SSH_PLINK",
  "GIT_SSH_TORTISE",
] as const;
const MAX_REMOTE_NAME = 255;
const MAX_REFSPECS = 64;
const MAX_REFSPEC_BYTES = 1_024;

function isSafeRemoteName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_REMOTE_NAME &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/u.test(name) &&
    !name.split("/").some((part) => part === "." || part === "..")
  );
}

function isSafeRefspec(refspec: string): boolean {
  return (
    refspec.length > 0 &&
    Buffer.byteLength(refspec) <= MAX_REFSPEC_BYTES &&
    !refspec.includes("\0") &&
    !refspec.startsWith("-") &&
    refspec.split(":").every((part) => !part.includes(".."))
  );
}

export function validateFetchOperands(input: {
  readonly cwd: string;
  readonly remoteName: string;
  readonly refspecs: ReadonlyArray<string>;
  readonly timeoutMs: number;
}): InitiatingFetchOperands | undefined {
  if (
    !input.cwd.startsWith("/") ||
    input.cwd.includes("\0") ||
    !isSafeRemoteName(input.remoteName) ||
    input.refspecs.length > MAX_REFSPECS ||
    !input.refspecs.every(isSafeRefspec) ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0
  ) {
    return undefined;
  }
  return {
    cwd: input.cwd,
    remoteName: input.remoteName,
    refspecs: [...input.refspecs],
    timeoutMs: input.timeoutMs,
  };
}

/** Refuse any caller environment that could select a transport outside the owner. */
export function ambientTransportEnvironment(
  env: NodeJS.ProcessEnv | undefined,
): ReadonlyArray<string> {
  if (!env) return [];
  return AMBIENT_TRANSPORT_ENV.filter((name) => env[name] !== undefined);
}

const INITIATING_TRANSPORT_UNAVAILABLE_DETAIL =
  "This initiating Git verb has no owner-controlled transport in the selected SSH owner mode. No ambient transport was started.";

/** Typed refusal check: the owner path was required but no owner transport is bound. */
export function isInitiatingTransportUnavailable(error: unknown): boolean {
  return (
    Schema.is(GitCommandError)(error) &&
    error.operation.startsWith("GitCore.initiating.") &&
    error.detail === INITIATING_TRANSPORT_UNAVAILABLE_DETAIL
  );
}

export function initiatingTransportUnavailable(
  verb: InitiatingGitVerb,
  cwd: string,
): GitCommandError {
  return new GitCommandError({
    operation: `GitCore.initiating.${verb}`,
    command: "git",
    cwd,
    detail: INITIATING_TRANSPORT_UNAVAILABLE_DETAIL,
  });
}

export function ambientTransportDenied(cwd: string, names: ReadonlyArray<string>): GitCommandError {
  return new GitCommandError({
    operation: "GitCore.initiating.ambientTransport",
    command: "git",
    cwd,
    detail: `Refusing caller-selected transport environment: ${names.join(", ")}. No process was started.`,
  });
}

export interface ParsedSshRemote {
  readonly user: string;
  readonly host: string;
  readonly port: number;
  readonly repositoryPath: string;
}

/** Support only unambiguous explicit SSH URLs; never SCP aliases, helpers or HTTPS. */
export function parseSshRemoteUrl(url: string): ParsedSshRemote | undefined {
  const match =
    /^ssh:\/\/([a-zA-Z0-9_][a-zA-Z0-9_.-]*)@([a-zA-Z0-9][a-zA-Z0-9.-]*)(?::([1-9][0-9]{0,4}))?(\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)$/u.exec(
      url,
    );
  if (!match || match[0] !== url) return undefined;
  const [, user, host, portText, repositoryPath] = match;
  if (!user || !host || !repositoryPath) return undefined;
  if (repositoryPath.split("/").some((part) => part === "." || part === "..")) return undefined;
  const port = Number(portText ?? 22);
  return port <= 65_535 ? { user, host, port, repositoryPath } : undefined;
}

export function matchesSshTarget(
  remote: ParsedSshRemote,
  target: {
    readonly host: string;
    readonly user?: string | undefined;
    readonly port?: string | number | null | undefined;
  },
): boolean {
  return (
    target.user !== undefined &&
    remote.host === target.host &&
    remote.user === target.user &&
    remote.port === Number(target.port ?? 22)
  );
}

/** Copy only non-transport process settings; ambient SSH selection never crosses the boundary. */
export function sanitizedTransportEnvironment(
  env: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const allowed = [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "GH_CONFIG_DIR",
    "GH_HOST",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ] as const;
  const result: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const name of allowed) {
    const value = env[name];
    if (typeof value === "string") result[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) result[name] = value;
  return result;
}
