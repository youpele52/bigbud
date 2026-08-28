import type { ProviderKind, ThreadId } from "@bigbud/contracts";
import { Duration, Effect } from "effect";

import { registerOpencodeMcpBridge } from "../../../orchestration-tools/orchestrationMcpBridge.session.ts";
import {
  composeBridgeCleanups,
  disconnectOpencodeOrchestrationMcpBridge,
} from "../../../orchestration-tools/orchestrationMcpBridge.session.ts";
import { ProviderAdapterProcessError } from "../../Errors.ts";
import type { OpencodeServerHandle } from "../../Services/Opencode/ServerManager.ts";
import type { OpencodeRemoteWorkspaceBridge } from "./OpencodeRemoteWorkspaceBridge.ts";
import { toMessage } from "./Adapter.stream.ts";

const REMOTE_MCP_REGISTRATION_TIMEOUT = Duration.millis(5_500);

export function makeOpencodeBridgeCleanup(input: {
  readonly serverHandle: OpencodeServerHandle;
  readonly serverDirectory: string | undefined;
  readonly orchestrationServerName: string;
  readonly remoteWorkspaceServerName: string | undefined;
  readonly cleanup: () => Promise<void>;
}): () => Promise<void> {
  return composeBridgeCleanups(async () => {
    try {
      for (const serverName of [input.orchestrationServerName, input.remoteWorkspaceServerName]) {
        if (!serverName) continue;
        await disconnectOpencodeOrchestrationMcpBridge({
          client: input.serverHandle.client,
          ...(input.serverDirectory ? { directory: input.serverDirectory } : {}),
          serverName,
        });
      }
    } catch {
      // Best effort: bridge cleanup below removes bigbud auth and files.
    }
  }, input.cleanup);
}

export const registerOpencodeRemoteWorkspaceMcp = Effect.fn("registerOpencodeRemoteWorkspaceMcp")(
  function* (input: {
    readonly provider: Extract<ProviderKind, "opencode" | "kilocode">;
    readonly threadId: ThreadId;
    readonly serverHandle: OpencodeServerHandle;
    readonly serverDirectory: string | undefined;
    readonly bridge: OpencodeRemoteWorkspaceBridge;
    readonly cleanup: () => Promise<void>;
  }) {
    yield* Effect.tryPromise({
      try: () =>
        registerOpencodeMcpBridge({
          client: input.serverHandle.client,
          ...(input.serverDirectory ? { directory: input.serverDirectory } : {}),
          bridge: {
            serverName: input.bridge.serverName,
            serverPath: input.bridge.serverPath,
            bridgeDir: input.bridge.cwd,
          },
          label: "remote workspace",
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: input.provider,
          threadId: input.threadId,
          detail: toMessage(
            cause,
            `Failed to register ${input.provider} remote workspace MCP bridge.`,
          ),
          cause,
        }),
    }).pipe(
      Effect.timeout(REMOTE_MCP_REGISTRATION_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: input.provider,
            threadId: input.threadId,
            detail: `Timed out registering ${input.provider} remote workspace MCP bridge.`,
            cause,
          }),
        ),
      ),
      Effect.tapError(() =>
        Effect.sync(() => {
          input.serverHandle.release();
          void input.cleanup().catch(() => undefined);
        }),
      ),
    );
  },
);
