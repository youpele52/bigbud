import { runProcess } from "../../utils/processRunner";
import {
  initiatingTransportUnavailable,
  sanitizedTransportEnvironment,
  validateFetchOperands,
  type InitiatingFetchBinding,
  type InitiatingFetchOperands,
} from "./GitCore.initiatingTransport.ts";
import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import {
  classifyRemoteUrl,
  endpointMatchesTarget,
  nonInteractiveSshCommand,
  type RemoteRoute,
  type SshTargetEndpoint,
} from "./GitCore.fetchRoute.match.ts";
import { resolveSshEndpoint, type ResolvedSshEndpoint } from "./GitCore.remoteEndpoint.ts";

/**
 * Selected-mode fetch routing (U7, U14, U15).
 *
 * - HTTP(S), file and local-path remotes run as ordinary local Git; Git itself refuses any
 *   other protocol even if config rewrites the URL.
 * - SSH remotes whose host is NOT a bigbud SSH execution target (github.com, GitLab, ...) run
 *   as ordinary fenced local Git with the user's own `~/.ssh` setup (U14). The owner is not
 *   involved. The fence: sanitized environment (no server-selected SSH command or Git config
 *   injection), Git restricted to the ssh protocol, a bounded deadline and non-interactive SSH.
 * - SSH remotes whose host IS a bigbud SSH target go through the owner binding (U15), or are
 *   refused typed when none is bound. Unknown target sets fail closed to the owner path.
 * - Anything else (git://, ext::, transport helpers) is refused.
 *
 * @module GitCore.fetchRoute
 */

const LOCAL_PROTOCOLS = "http:https:file";
const SSH_PROTOCOLS = "ssh";
/** Used only when the user's own Git config selects no SSH command. */
const NON_INTERACTIVE_SSH = "ssh -o BatchMode=yes";

export interface FetchRouteDependencies {
  readonly resolveRemoteUrl: (cwd: string, remoteName: string) => Promise<string>;
  readonly readGitConfig: (cwd: string, key: string) => Promise<string | undefined>;
  readonly runGit: (
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ) => Promise<{ readonly code: number; readonly stderr: string }>;
  readonly resolveEndpoint: typeof resolveSshEndpoint;
}

export const defaultFetchRouteDependencies: FetchRouteDependencies = {
  resolveRemoteUrl: (cwd, remoteName) =>
    runProcess("git", ["-C", cwd, "remote", "get-url", remoteName], {
      env: sanitizedTransportEnvironment(process.env),
      timeoutMs: 5_000,
    }).then((result) => result.stdout.trim()),
  readGitConfig: (cwd, key) =>
    runProcess("git", ["-C", cwd, "config", "--get", key], {
      env: sanitizedTransportEnvironment(process.env),
      timeoutMs: 5_000,
      allowNonZeroExit: true,
    }).then((result) => (result.code === 0 ? result.stdout.trim() || undefined : undefined)),
  runGit: (args, options) =>
    runProcess("git", args, { ...options, allowNonZeroExit: true }).then((result) => ({
      code: result.code ?? -1,
      stderr: result.stderr,
    })),
  resolveEndpoint: (spec) => resolveSshEndpoint(spec),
};

/**
 * Every spelling the remote dials, through `~/.ssh/config`; `undefined` when the config cannot
 * be evaluated (U17), which callers treat like an unknown target set: the owner path, never the
 * U14 fence.
 */
export async function routeEndpoint(
  route: Extract<RemoteRoute, { kind: "ssh" }>,
  resolve: FetchRouteDependencies["resolveEndpoint"] = defaultFetchRouteDependencies.resolveEndpoint,
): Promise<ResolvedSshEndpoint | undefined> {
  const resolved = await resolve(route).catch(() => "refused" as const);
  return resolved === "refused" ? undefined : resolved;
}

function fetchFailure(cwd: string, detail: string, cause?: unknown): GitCommandError {
  return new GitCommandError({
    operation: "GitCore.initiating.fetch",
    command: "git fetch",
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export interface RouteFetchInput {
  readonly operands: InitiatingFetchOperands;
  /** The owner binding, when composed. */
  readonly owner: InitiatingFetchBinding | undefined;
  /**
   * Every bigbud SSH execution target, or `undefined` when the set cannot be read. An unknown
   * set never lets an SSH remote run as ordinary Git.
   */
  readonly targets: () => Promise<ReadonlyArray<SshTargetEndpoint> | undefined>;
}

/**
 * The environment (and `-c` options) for ordinary local Git on a non-owner route: HTTP(S)/file
 * under `GIT_ALLOW_PROTOCOL`, or the U14 fence for an SSH host that is not a bigbud target.
 */
export async function ordinaryGitTransport(
  kind: "local" | "ssh",
  cwd: string,
  deps: Pick<FetchRouteDependencies, "readGitConfig">,
): Promise<{ readonly configArgs: ReadonlyArray<string>; readonly env: Record<string, string> }> {
  if (kind === "local") {
    return {
      configArgs: [],
      env: sanitizedTransportEnvironment(process.env, { GIT_ALLOW_PROTOCOL: LOCAL_PROTOCOLS }),
    };
  }
  // U14 third-party host: the user's own SSH config and agent; nothing selected by bigbud's
  // process environment. BatchMode is always requested; a user command is kept and extended
  // only when that is unambiguous (`nonInteractiveSshCommand`).
  const userCommand = await deps.readGitConfig(cwd, "core.sshCommand");
  const command = userCommand ? nonInteractiveSshCommand(userCommand) : NON_INTERACTIVE_SSH;
  const agent = process.env.SSH_AUTH_SOCK;
  return {
    configArgs: command ? ["-c", `core.sshCommand=${command}`] : [],
    env: sanitizedTransportEnvironment(process.env, {
      GIT_ALLOW_PROTOCOL: SSH_PROTOCOLS,
      ...(agent ? { SSH_AUTH_SOCK: agent } : {}),
    }),
  };
}

/** Route one selected-mode fetch; never starts an ambient transport for a bigbud target. */
export async function routeSelectedFetch(
  input: RouteFetchInput,
  signal: AbortSignal,
  dependencies: Partial<FetchRouteDependencies> = {},
): Promise<"fetched"> {
  const deps = { ...defaultFetchRouteDependencies, ...dependencies };
  const operands = validateFetchOperands(input.operands);
  if (!operands) throw initiatingTransportUnavailable("fetch", input.operands.cwd);
  if (signal.aborted) throw new Error("fetch aborted before dispatch");
  let url: string;
  try {
    url = await deps.resolveRemoteUrl(operands.cwd, operands.remoteName);
  } catch (cause) {
    throw fetchFailure(operands.cwd, "Could not resolve the selected remote URL.", cause);
  }
  const route = classifyRemoteUrl(url);
  if (route.kind === "unsupported") throw initiatingTransportUnavailable("fetch", operands.cwd);
  if (route.kind === "ssh") {
    const targets = await input.targets().catch(() => undefined);
    const endpoint = await routeEndpoint(route, deps.resolveEndpoint);
    if (
      !targets ||
      !endpoint ||
      targets.some((target) => endpointMatchesTarget(endpoint, target))
    ) {
      if (!input.owner) throw initiatingTransportUnavailable("fetch", operands.cwd);
      await input.owner.fetch(operands, signal);
      return "fetched";
    }
  }
  const args = [
    "fetch",
    "--no-tags",
    "--quiet",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    operands.remoteName,
    ...operands.refspecs,
  ];
  const { configArgs, env } = await ordinaryGitTransport(route.kind, operands.cwd, deps);
  args.unshift(...configArgs);
  const result = await deps.runGit(args, {
    cwd: operands.cwd,
    env,
    timeoutMs: Math.min(operands.timeoutMs, 30_000),
    signal,
  });
  if (result.code !== 0) {
    throw fetchFailure(operands.cwd, result.stderr.trim() || "Git fetch failed.");
  }
  return "fetched";
}
