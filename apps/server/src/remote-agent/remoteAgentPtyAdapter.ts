import { createHash } from "node:crypto";

import { Effect } from "effect";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyProcess,
  type PtySpawnInput,
} from "../terminal/Services/PTY.ts";
import type { RemoteAgentPtyClient } from "./remoteAgentPtyClient.ts";
import type { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

export interface RemoteAgentPtyResolver {
  readonly resolvePty: (executionTargetId: string) => Promise<RemoteAgentPtyClient>;
  readonly resolveWorkspace: (executionTargetId: string) => Promise<RemoteAgentWorkspaceClient>;
}

function workspaceHandle(executionTargetId: string, root: string): string {
  return `workspace-${createHash("sha256")
    .update(`${executionTargetId}\0${root}`)
    .digest("hex")
    .slice(0, 32)}`;
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
  const workspace = await resolver.resolveWorkspace(executionTargetId);
  const handle = workspaceHandle(executionTargetId, root);
  await workspace.openWorkspace(handle, root);
  const client = await resolver.resolvePty(executionTargetId);
  return client.create({
    workspaceHandle: handle,
    cwd: "",
    shell: "/bin/sh",
    args: ["-lc", 'exec "${SHELL:-/bin/sh}" -l'],
    cols: input.cols,
    rows: input.rows,
    environment: terminalEnvironment(input.env),
  });
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
