import { createHash } from "node:crypto";

import { Effect } from "effect";

import type { RemoteWorkspaceExecutions } from "../remote-workspace-bridge/remoteWorkspaceExecutions.ts";
import { makeProductionTypedSshToolCapability } from "../tool-transport/toolTransport.ssh.owner.production.ts";
import { resolveToolTransportTarget, runToolCommand } from "../tool-transport/toolTransport.ts";
import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import { withProductionWorkspaceOwner } from "./wsSshOwnerProduction.workspace.ts";
import { ThreadToolRequestError } from "./http.threadTools.schema.ts";
import {
  decodeRemoteWorkspaceTool,
  runLegacyRemoteWorkspaceTool,
  runOwnedRemoteWorkspaceTool,
  type LegacyToolRun,
} from "./http.threadTools.remoteWorkspaceTool.ts";

const LEGACY_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * One typed bridge tool on the authorized target and root. `mode` is decided by
 * the caller: `owner` (production activation) uses the owner's typed verbs,
 * `legacy` the fixed scripts, and `refused` (the dev fixture without typed tool
 * authority) refuses before anything is dispatched.
 */
export const dispatchRemoteWorkspaceTool = Effect.fn("dispatchRemoteWorkspaceTool")(
  function* (input: {
    readonly mode: "owner" | "legacy" | "refused";
    readonly remoteTool: unknown;
    readonly callerThreadId: string;
    readonly invocationId: string;
    readonly targetId: string;
    readonly workspaceRoot: string;
    readonly timeoutMs: number;
    readonly executionOwner?: RemoteWorkspaceExecutions | undefined;
    readonly generation?: number | undefined;
  }) {
    const tool = yield* Effect.try({
      try: () => decodeRemoteWorkspaceTool(input.remoteTool),
      catch: (cause) =>
        new ThreadToolRequestError({
          status: 400,
          message: cause instanceof Error ? cause.message : "Invalid remote workspace tool.",
        }),
    });
    if (input.mode === "refused")
      return yield* new ThreadToolRequestError({
        status: 409,
        message:
          "Typed remote workspace tools are not composed for the development SSH fixture. Nothing was dispatched.",
      });
    const legacy =
      (signal?: AbortSignal): LegacyToolRun =>
      (command, args, options) =>
        runToolCommand({
          ...(signal ? { signal } : {}),
          invocationId: createHash("sha256")
            .update(JSON.stringify([input.callerThreadId, input.invocationId]))
            .digest("hex"),
          target: resolveToolTransportTarget({
            location: "remote",
            executionTargetId: input.targetId,
            cwd: input.workspaceRoot,
          }),
          command,
          args,
          ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
          allowNonZeroExit: options?.allowNonZeroExit === true,
          timeoutMs: input.timeoutMs,
          maxBufferBytes: LEGACY_OUTPUT_BYTES,
          outputMode: "truncate",
        });
    const run = (signal?: AbortSignal) =>
      input.mode === "owner"
        ? runOwnedRemoteWorkspaceTool(
            makeProductionTypedSshToolCapability(input.targetId, input.workspaceRoot),
            tool,
            signal,
            // Typed glob: one bounded owner index of the root.
            (indexSignal) =>
              withProductionWorkspaceOwner(
                readSshOwnerProductionOwner,
                input.targetId,
                (owner) =>
                  owner.indexProofWorkspace({
                    executionTargetId: input.targetId,
                    workspaceRoot: input.workspaceRoot,
                  }),
                indexSignal,
              ),
          )
        : runLegacyRemoteWorkspaceTool(legacy(signal), tool);
    const owner = input.executionOwner;
    const result = yield* Effect.tryPromise({
      try: (signal) => {
        if (!owner) return run(signal);
        if (input.generation !== undefined) owner.assertGeneration(input.generation);
        return owner.run(input.invocationId, run, signal);
      },
      catch: (cause) =>
        new ThreadToolRequestError({
          status: 502,
          message: cause instanceof Error ? cause.message : "Remote workspace tool failed.",
        }),
    });
    return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false, tool: result };
  },
);
