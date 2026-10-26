import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import path from "node:path";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";
import { prepareV2SharedCanonicalResources } from "./Application.targets.auth.ts";
import { prepareV2SharedRemoteTarget } from "./Application.targets.remote.ts";

/** Shared preparation keeps the provider local and binds remote files through bigbud tools. */
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
    if (context.providerRuntimeTarget.executionTargetId !== "local")
      throw new Error(
        "Shared OpenCode v2 requires a local provider runtime; remote files use bigbud workspace tools.",
      );
    if (!context.workspaceTarget.cwd) throw new Error("V2 selected native Location is required.");
    signal.throwIfAborted();
    await options.authorizeExecution?.();
    signal.throwIfAborted();
    if (context.workspaceTarget.executionTargetId !== "local")
      return prepareV2SharedRemoteTarget(
        options,
        input,
        context.workspaceTarget,
        stateDir,
        port,
        signal,
        disableTools,
      );
    // Canonical credentials are deliberately provisioned after successful native preflight by Runtime.sessions.
    return {
      options,
      input,
      resources: {
        cleanup: async () => {},
        ...(!disableTools
          ? {
              activateCanonicalTools: () =>
                prepareV2SharedCanonicalResources(stateDir, input.threadId, port, {
                  executionTargetId: context.workspaceTarget.executionTargetId,
                  cwd: context.workspaceTarget.cwd!,
                }),
            }
          : {}),
      },
    };
  };
}
