import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import path from "node:path";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";
import {
  prepareThreadOrchestrationSessionAuth,
  resolveThreadOrchestrationHttpConfig,
} from "../../../orchestration-tools/threadOrchestrationBridge.shared.ts";
import {
  deleteThreadOrchestrationToolAuth,
  renewThreadOrchestrationToolAuth,
} from "../../../orchestration-tools/ThreadOrchestrationToolAuth.ts";

/** Local-only shared preparation never initializes a private profile, MCP server, or remote workspace. */
export function makeV2SharedTargetPreparation(
  options: V2IsolatedRuntimeOptions,
  stateDir: string,
  port: number,
): NonNullable<V2IsolatedRuntimeOptions["prepareSession"]> {
  return async (input, signal, disableTools) => {
    if (
      !input.threadId ||
      Buffer.byteLength(`${input.threadId}.json`) > 255 ||
      path.basename(input.threadId) !== input.threadId ||
      // oxlint-disable-next-line no-control-regex -- NUL is rejected deliberately in app auth file components
      /[\\\0]/.test(input.threadId) ||
      [".", ".."].includes(input.threadId)
    )
      throw new Error(
        "V2 retained canonical thread id is not a safe app auth component; no native history acquisition.",
      );
    const context = resolveProviderExecutionContext({
      ...input,
      defaultProviderRuntimeExecutionTargetId: "local",
      useLegacyExecutionTargetForProviderRuntime: false,
    });
    if (
      context.providerRuntimeTarget.executionTargetId !== "local" ||
      context.workspaceTarget.executionTargetId !== "local"
    )
      throw new Error(
        "Shared OpenCode v2 supports local native Locations only; no private/SSH fallback.",
      );
    if (!context.workspaceTarget.cwd) throw new Error("V2 selected native Location is required.");
    signal.throwIfAborted();
    await options.authorizeExecution?.();
    signal.throwIfAborted();
    // Canonical credentials are deliberately provisioned after successful native preflight by Runtime.sessions.
    return {
      options,
      input,
      resources: {
        cleanup: async () => {},
        ...(!disableTools
          ? {
              activateCanonicalTools: () =>
                prepareV2SharedCanonicalResources(stateDir, input.threadId, port),
            }
          : {}),
      },
    };
  };
}

/** Canonical HTTP auth is app-internal; native enrollment receives a different per-owner callback token. */
export async function prepareV2SharedCanonicalResources(
  stateDir: string,
  threadId: string,
  port: number,
) {
  const { token } = await prepareThreadOrchestrationSessionAuth({ stateDir, threadId });
  return {
    orchestration: resolveThreadOrchestrationHttpConfig(
      { stateDir, threadId, host: "127.0.0.1", port, providerSessionId: `opencodeV2:${threadId}` },
      token,
    ),
    cleanup: () => deleteThreadOrchestrationToolAuth({ stateDir, threadId, token }),
    renewCanonicalAuth: () => renewThreadOrchestrationToolAuth({ stateDir, threadId, token }),
  };
}
