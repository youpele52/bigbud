import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { runProcess } from "../../utils/processRunner";
import type { GitHubCliOwnerTransportShape } from "./GitHubCli.owner.ts";
import {
  ambientTransportDenied,
  ambientTransportEnvironment,
  initiatingTransportUnavailable,
  matchesSshTarget,
  parseSshRemoteUrl,
  sanitizedTransportEnvironment,
  type InitiatingFetchBinding,
  type InitiatingFetchOperands,
} from "./GitCore.initiatingTransport.ts";

const SHIM_SOURCE = `const { connect } = require("node:net");
const socket = connect(process.env.BIGBUD_GIT_STREAM_SOCKET);
socket.on("error", () => process.exit(1));
socket.on("end", () => process.stdin.pause());
process.stdin.pipe(socket);
socket.pipe(process.stdout);
`;
const STREAM_CLOSE_TIMEOUT_MS = 2_000;

export interface OwnerGitStreamLease {
  readonly pipes: {
    readonly stdin: Writable;
    readonly stdout: Readable;
    readonly stderr: Readable;
  };
  readonly exit: Promise<unknown>;
  readonly close: (request: {
    readonly mode: "graceful" | "terminate";
    readonly timeoutMs: number;
  }) => Promise<void>;
}

export interface OwnerGitStreamClient {
  readonly openGitUpload: (
    input: { readonly executionTargetId: string; readonly repositoryPath: string },
    signal: AbortSignal,
  ) => Promise<OwnerGitStreamLease>;
}

/** A launched owner session scoped to one target; no legacy SSH path is reachable here. */
export interface OwnerGitStreamSession {
  readonly targetId: string;
  readonly withClient: <A>(
    operation: (client: OwnerGitStreamClient) => Promise<A>,
    signal: AbortSignal,
  ) => Promise<A>;
}

export interface OwnerGitStream {
  /** Owner-provided transport environment; the shim is the only SSH executable Git may use. */
  readonly env: Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * Open a private owner-controlled SSH stream for local Git or `gh`. The owner supplies the
 * upload-pack lease; local processes can only reach it through the generated shim socket.
 */
export async function openOwnerGitStream(
  session: OwnerGitStreamSession,
  repositoryPath: string,
  signal: AbortSignal,
): Promise<OwnerGitStream> {
  signal.throwIfAborted();
  const lease = await session.withClient((client) => {
    const open = (client as { readonly openGitUpload?: unknown }).openGitUpload;
    if (typeof open !== "function") {
      throw new Error("The selected owner does not expose an owner-controlled Git stream.");
    }
    return (open as OwnerGitStreamClient["openGitUpload"]).call(
      client,
      { executionTargetId: session.targetId, repositoryPath },
      signal,
    );
  }, signal);
  const directory = await mkdtemp(join(tmpdir(), "bbgs-"));
  const socketPath = join(directory, "s.sock");
  const shimPath = join(directory, "shim.cjs");
  const server = createServer({ allowHalfOpen: true });
  const sockets = new Set<Socket>();
  let connections = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => lease.pipes.stdin.destroy(error));
    // One shim connection per Git transport. Extra dials are refused, not silently bridged.
    if (++connections !== 1) {
      socket.destroy();
      return;
    }
    socket.pipe(lease.pipes.stdin);
    lease.pipes.stdout.pipe(socket);
  });
  const cleanup = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(shimPath, SHIM_SOURCE, { mode: 0o600 });
    await listen(server, socketPath);
    signal.throwIfAborted();
  } catch (cause) {
    await cleanup().catch(() => undefined);
    await lease
      .close({ mode: "terminate", timeoutMs: STREAM_CLOSE_TIMEOUT_MS })
      .catch(() => undefined);
    throw cause;
  }
  // Drain diagnostics so a chatty remote cannot stall the stream; they are not product output.
  lease.pipes.stderr.resume();
  return {
    env: {
      GIT_SSH_COMMAND: `${quote(process.execPath)} ${quote(shimPath)}`,
      GIT_SSH_VARIANT: "ssh",
      BIGBUD_GIT_STREAM_SOCKET: socketPath,
    },
    async close() {
      await cleanup().catch(() => undefined);
      await lease
        .close({ mode: "terminate", timeoutMs: STREAM_CLOSE_TIMEOUT_MS })
        .catch(() => undefined);
    },
  };
}

export interface SelectedStreamDependencies {
  readonly session: OwnerGitStreamSession | undefined;
  readonly resolveRemoteUrl: (cwd: string, remoteName: string) => Promise<string>;
  readonly runGit: (
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ) => Promise<{ readonly code: number; readonly stderr: string }>;
}

function defaultResolveRemoteUrl(cwd: string, remoteName: string): Promise<string> {
  return runProcess("git", ["-C", cwd, "remote", "get-url", remoteName], {
    env: sanitizedTransportEnvironment(process.env),
    timeoutMs: 5_000,
  }).then((result) => result.stdout.trim());
}

function defaultRunGit(
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  },
): Promise<{ code: number; stderr: string }> {
  return runProcess("git", args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    allowNonZeroExit: true,
  }).then((result) => ({ code: result.code ?? -1, stderr: result.stderr }));
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

function validatedRepository(
  operands: InitiatingFetchOperands,
  targetId: string,
  url: string,
): string | undefined {
  const remote = parseSshRemoteUrl(url);
  const target = parseSshExecutionTarget(targetId);
  if (!remote || !target || target.transport === "agent" || !matchesSshTarget(remote, target)) {
    return undefined;
  }
  return remote.repositoryPath;
}

/** Product fetch binding: owner stream for the exact validated remote. */
export function makeSelectedInitiatingFetchBinding(
  dependencies: Partial<SelectedStreamDependencies> = {},
): InitiatingFetchBinding {
  const session = dependencies.session;
  const resolveRemoteUrl = dependencies.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const runGit = dependencies.runGit ?? defaultRunGit;
  return {
    async fetch(operands, signal) {
      if (!session) throw initiatingTransportUnavailable("fetch", operands.cwd);
      let url: string;
      try {
        url = await resolveRemoteUrl(operands.cwd, operands.remoteName);
      } catch (cause) {
        throw fetchFailure(operands.cwd, "Could not resolve the selected remote URL.", cause);
      }
      const repositoryPath = validatedRepository(operands, session.targetId, url);
      if (!repositoryPath) throw initiatingTransportUnavailable("fetch", operands.cwd);
      const stream = await openOwnerGitStream(session, repositoryPath, signal);
      try {
        const result = await runGit(
          [
            "fetch",
            "--no-tags",
            "--quiet",
            "--no-write-fetch-head",
            "--no-auto-maintenance",
            operands.remoteName,
            ...operands.refspecs,
          ],
          {
            cwd: operands.cwd,
            env: { ...sanitizedTransportEnvironment(process.env), ...stream.env },
            timeoutMs: Math.min(operands.timeoutMs, 30_000),
            signal,
          },
        );
        if (result.code !== 0) {
          throw fetchFailure(operands.cwd, result.stderr.trim() || "Git fetch failed.");
        }
        return "fetched";
      } finally {
        await stream.close();
      }
    },
  };
}

/** Product `gh` owner transport: SSH-delegating verbs run under the owner shim. */
export function makeSelectedGitHubCliOwnerTransport(
  dependencies: Partial<SelectedStreamDependencies> = {},
): GitHubCliOwnerTransportShape {
  const session = dependencies.session;
  const resolveRemoteUrl = dependencies.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  return {
    async execute(input, signal) {
      const sshTraffic = input.args[0] === "pr" && input.args[1] === "checkout";
      if (!sshTraffic) {
        const result = await runProcess("gh", input.args, {
          cwd: input.cwd,
          env: sanitizedTransportEnvironment(process.env),
          timeoutMs: input.timeoutMs,
          signal,
          allowNonZeroExit: true,
        });
        return { stdout: result.stdout, stderr: result.stderr, code: result.code ?? -1 };
      }
      if (!session) throw initiatingTransportUnavailable("checkoutPullRequest", input.cwd);
      const ambient = ambientTransportEnvironment(process.env);
      if (ambient.length > 0) throw ambientTransportDenied(input.cwd, ambient);
      const url = await resolveRemoteUrl(input.cwd, "origin");
      const repositoryPath = validatedRepository(
        { cwd: input.cwd, remoteName: "origin", refspecs: [], timeoutMs: input.timeoutMs },
        session.targetId,
        url,
      );
      if (!repositoryPath) throw initiatingTransportUnavailable("checkoutPullRequest", input.cwd);
      const stream = await openOwnerGitStream(session, repositoryPath, signal);
      try {
        const result = await runProcess("gh", input.args, {
          cwd: input.cwd,
          env: { ...sanitizedTransportEnvironment(process.env), ...stream.env },
          timeoutMs: input.timeoutMs,
          signal,
          allowNonZeroExit: true,
        });
        return { stdout: result.stdout, stderr: result.stderr, code: result.code ?? -1 };
      } finally {
        await stream.close();
      }
    },
  };
}
