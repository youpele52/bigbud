import { createHash } from "node:crypto";
import posixPath from "node:path/posix";

import { Effect } from "effect";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyProcess,
  type PtySpawnInput,
} from "../terminal/Services/PTY.ts";
import type { RemoteAgentPtyClient, RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import type { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

export interface RemoteAgentPtyResolver {
  readonly resolvePty: (executionTargetId: string) => Promise<RemoteAgentPtyClient>;
  readonly resolveWorkspace: (executionTargetId: string) => Promise<RemoteAgentWorkspaceClient>;
}

export interface PreparedRemoteAgentWorkspacePty {
  readonly client: RemoteAgentPtyClient;
  readonly workspaceHandle: string;
}

export function remoteAgentWorkspaceHandle(executionTargetId: string, root: string): string {
  return `workspace-${createHash("sha256")
    .update(`${executionTargetId}\0${root}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export async function prepareRemoteAgentWorkspacePty(
  input: {
    readonly executionTargetId: string;
    readonly workspaceRoot: string;
  },
  resolver: RemoteAgentPtyResolver,
): Promise<PreparedRemoteAgentWorkspacePty> {
  const workspace = await resolver.resolveWorkspace(input.executionTargetId);
  const workspaceHandle = remoteAgentWorkspaceHandle(input.executionTargetId, input.workspaceRoot);
  await workspace.openWorkspace(workspaceHandle, input.workspaceRoot);
  const client = await resolver.resolvePty(input.executionTargetId);
  return { client, workspaceHandle };
}

function resolveRemotePtyCwd(root: string, cwd: string | undefined): string {
  const normalizedRoot = posixPath.resolve(root);
  const resolved = cwd
    ? posixPath.isAbsolute(cwd)
      ? posixPath.resolve(cwd)
      : posixPath.resolve(normalizedRoot, cwd)
    : normalizedRoot;
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Remote PTY cwd escapes workspace root: ${cwd}`);
  }
  return resolved === normalizedRoot ? "" : posixPath.relative(normalizedRoot, resolved);
}

export async function createRemoteAgentWorkspacePty(
  input: {
    readonly executionTargetId: string;
    readonly workspaceRoot: string;
    readonly cwd?: string;
    readonly command: string;
    readonly args?: ReadonlyArray<string>;
    readonly cols: number;
    readonly rows: number;
    readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  },
  resolver: RemoteAgentPtyResolver,
): Promise<RemoteAgentPtyProcess> {
  const prepared = await prepareRemoteAgentWorkspacePty(input, resolver);
  return prepared.client.create({
    workspaceHandle: prepared.workspaceHandle,
    cwd: resolveRemotePtyCwd(input.workspaceRoot, input.cwd),
    shell: input.command,
    args: input.args ?? [],
    cols: input.cols,
    rows: input.rows,
    ...(input.environment ? { environment: input.environment } : {}),
  });
}

function terminalEnvironment(environment: NodeJS.ProcessEnv): ReadonlyArray<{
  readonly name: string;
  readonly value: string;
}> {
  return Object.entries(environment).flatMap(([name, value]) => {
    if (value === undefined) return [];
    if (!(name === "TERM" || name === "COLORTERM" || name === "LANG" || name.startsWith("LC_"))) {
      return [];
    }
    return [{ name, value }];
  });
}

async function spawnRemotePty(
  input: PtySpawnInput,
  resolver: RemoteAgentPtyResolver,
): Promise<PtyProcess> {
  const executionTargetId = input.executionTargetId;
  const root = input.remoteCwd;
  if (!executionTargetId || !root) {
    throw new PtySpawnError({
      adapter: "remote-agent-pty",
      message: "Remote PTY requires an execution target and remote workspace root.",
    });
  }
  return createRemoteAgentWorkspacePty(
    {
      executionTargetId,
      workspaceRoot: root,
      command: "/bin/sh",
      args: ["-lc", 'exec "${SHELL:-/bin/sh}" -l'],
      cols: input.cols,
      rows: input.rows,
      environment: terminalEnvironment(input.env),
    },
    resolver,
  );
}

export function makeRemoteAgentPtyAdapter(
  base: PtyAdapterShape,
  resolver: RemoteAgentPtyResolver,
): PtyAdapterShape {
  return {
    spawn: Effect.fn("remoteAgentPtyAdapter.spawn")(function* (input) {
      if (!input.executionTargetId || isLocalExecutionTarget(input.executionTargetId)) {
        return yield* base.spawn(input);
      }
      return yield* Effect.tryPromise({
        try: () => spawnRemotePty(input, resolver),
        catch: (cause) =>
          new PtySpawnError({
            adapter: "remote-agent-pty",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    }),
  };
}
