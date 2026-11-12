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
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { remoteAgentLegacyTerminalLaunch } from "./remoteAgentTerminalLaunch.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";

export interface RemoteAgentPtyResolver {
  readonly restoreOrCreate?: (input: PtySpawnInput) => Promise<PtyProcess | undefined>;
  readonly resolveProfileBinding?: (
    target: string,
  ) => Promise<RemoteAgentRuntimeBinding | undefined>;
  readonly resolvePty: (executionTargetId: string) => Promise<RemoteAgentPtyClient>;
  readonly resolveWorkspace: (
    executionTargetId: string,
    connection: RemoteAgentConnection,
  ) => Promise<RemoteAgentWorkspaceClient>;
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
  const client = await resolver.resolvePty(input.executionTargetId);
  const workspace = await resolver.resolveWorkspace(input.executionTargetId, client.connection);
  const workspaceHandle = remoteAgentWorkspaceHandle(input.executionTargetId, input.workspaceRoot);
  await workspace.openWorkspace(workspaceHandle, input.workspaceRoot);
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

async function spawnRemotePty(
  input: PtySpawnInput,
  resolver: RemoteAgentPtyResolver,
): Promise<PtyProcess> {
  if (resolver.restoreOrCreate && input.ownerKey) {
    const owned = await resolver.restoreOrCreate(input);
    if (owned) return owned;
  }
  if (input.shellLaunch)
    throw new Error(
      "Explicit remote profiles require durable terminal ownership; no PTY was created.",
    );
  const executionTargetId = input.executionTargetId;
  const root = input.remoteCwd;
  if (!executionTargetId || !root) {
    throw new PtySpawnError({
      adapter: "remote-agent-pty",
      message: "Remote PTY requires an execution target and remote workspace root.",
    });
  }
  const launch = remoteAgentLegacyTerminalLaunch(input.env);
  const process = await createRemoteAgentWorkspacePty(
    {
      executionTargetId,
      workspaceRoot: root,
      command: launch.shell,
      args: launch.args,
      cols: input.cols,
      rows: input.rows,
      environment: launch.environment,
    },
    resolver,
  );
  return Object.assign(process, { pidDomain: "remote" as const });
}

export function makeRemoteAgentPtyAdapter(
  base: PtyAdapterShape,
  resolver: RemoteAgentPtyResolver,
  shouldUseRemote: (executionTargetId: string | undefined) => boolean = (executionTargetId) =>
    !isLocalExecutionTarget(executionTargetId),
): PtyAdapterShape {
  return {
    spawn: Effect.fn("remoteAgentPtyAdapter.spawn")(function* (input) {
      if (
        !input.executionTargetId ||
        isLocalExecutionTarget(input.executionTargetId) ||
        !shouldUseRemote(input.executionTargetId)
      ) {
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
