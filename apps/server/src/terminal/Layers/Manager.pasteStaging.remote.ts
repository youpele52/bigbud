import * as Effect from "effect/Effect";
import { TerminalPasteStageError } from "@bigbud/contracts/workspace/terminal.paste.ts";
import { REMOTE_AGENT_PASTE_STAGING_CAPABILITY } from "../../remote-agent/remoteAgentProtocol.pasteStaging.ts";
import {
  beginRemoteAgentPasteUpload,
  discardRemoteAgentPasteScope,
  RemoteAgentPasteStagingError,
} from "../../remote-agent/remoteAgentPasteStaging.ts";
import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import type { PtyAdapterShape } from "../Services/PTY.ts";
import { resolveOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve.ts";
import { isAbsolutePastePath } from "./Manager.pasteStaging.names.ts";
import type {
  PasteClipboardOutcome,
  RemotePasteAgent,
  RemotePasteAgentResolver,
} from "./Manager.pasteStaging.target.ts";

const AGENT_ERRORS: Record<string, TerminalPasteStageError["code"]> = {
  TOO_LARGE: "tooLarge",
  DIGEST_MISMATCH: "integrity",
  INCOMPLETE: "integrity",
};

function stageError(cause: unknown, host: string): TerminalPasteStageError {
  if (cause instanceof RemoteAgentPasteStagingError)
    return new TerminalPasteStageError({
      code: AGENT_ERRORS[cause.code] ?? "storageFailed",
      detail: `${host} could not stage the file: ${cause.message}`,
    });
  return new TerminalPasteStageError({
    code: "storageFailed",
    detail: `${host} could not stage the file: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
}

const rethrow = <A>(host: string, run: () => Promise<A>) =>
  run().catch((cause: unknown) => {
    throw stageError(cause, host);
  });

function clipboardOutcome(value: string): PasteClipboardOutcome {
  return value === "set" || value === "unavailable" ? value : "skipped";
}

/** Upload and discard through one connected agent; the path is whatever the agent resolved. */
export function makeRemotePasteAgent(
  connection: RemoteAgentConnection,
  host: string,
): RemotePasteAgent {
  return {
    begin: (input) =>
      rethrow(host, async () => {
        const upload = await beginRemoteAgentPasteUpload(connection, {
          scope: input.scope,
          extension: input.kind.extension,
          imageMimeType: input.kind.imageMimeType,
          totalBytes: input.byteLength,
        });
        return {
          write: (chunk) => rethrow(host, () => upload.write(chunk)),
          commit: (sha256) =>
            rethrow(host, async () => {
              const committed = await upload.commit(sha256);
              if (!isAbsolutePastePath(committed.path))
                throw new RemoteAgentPasteStagingError("IO", "the agent returned a relative path");
              return { path: committed.path, clipboard: clipboardOutcome(committed.clipboard) };
            }),
          abort: () => upload.abort(),
        };
      }),
    discard: async (scope) => {
      await discardRemoteAgentPasteScope(connection, scope);
    },
  };
}

/**
 * Only agent-owned remote terminals can stage: SSH-only terminals have no agent, and agents
 * without the capability must be updated (never a silent drop).
 */
export function makeRemotePasteAgentResolver(
  adapter: Pick<PtyAdapterShape, "ownedRuntimeForTarget"> | undefined,
): RemotePasteAgentResolver {
  return (executionTargetId) =>
    Effect.gen(function* () {
      const host = parseSshExecutionTarget(executionTargetId)?.host ?? executionTargetId;
      const runtime = resolveOwnedPtyRuntime(adapter, executionTargetId);
      if (!runtime)
        return yield* new TerminalPasteStageError({
          code: "remoteAgentRequired",
          detail: `Pasting files into terminals on ${host} needs the bigbud remote agent. Connect ${host} with the remote agent, then paste again.`,
        });
      const connection = yield* Effect.tryPromise({
        try: () => runtime.pool.get(runtime.targetId),
        catch: () =>
          new TerminalPasteStageError({
            code: "unavailable",
            detail: `The remote agent on ${host} is not reachable. Reconnect, then paste again.`,
          }),
      });
      if (!connection.supportsCapability(REMOTE_AGENT_PASTE_STAGING_CAPABILITY))
        return yield* new TerminalPasteStageError({
          code: "agentUpdateRequired",
          detail: `The remote agent on ${host} needs updating before it can receive pasted files. Update it, then paste again.`,
        });
      return makeRemotePasteAgent(connection, host);
    });
}
