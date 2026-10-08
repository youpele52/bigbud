import { createHash } from "node:crypto";
import { mkdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import { createRemoteWorkspaceBridge } from "../../../remote-workspace-bridge/remoteWorkspaceBridge.ts";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";
import { V2RemoteFiles, type V2WorkspaceClientResolver } from "./Remote.files.ts";
import { prepareV2RemoteMedia } from "./Remote.media.ts";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";
import { prepareV2Orchestration } from "./Execution.orchestration.ts";

/** Application routing owns target preparation; no synthetic authorization supplied by callers. */
export function makeV2TargetPreparation(
  options: V2IsolatedRuntimeOptions,
  stateDir: string,
  resolveWorkspace?: V2WorkspaceClientResolver,
  httpPort?: number,
): NonNullable<V2IsolatedRuntimeOptions["prepareSession"]> {
  return async (input, signal, disableTools) => {
    const context = resolveProviderExecutionContext({
      ...input,
      defaultProviderRuntimeExecutionTargetId: "local",
      useLegacyExecutionTargetForProviderRuntime: false,
    });
    const runtimeTarget = context.providerRuntimeTarget.executionTargetId;
    const workspaceTarget = context.workspaceTarget.executionTargetId;
    if (runtimeTarget !== "local" && runtimeTarget !== workspaceTarget)
      throw new Error(
        "V2 SSH runtime must use its own remote workspace target; no mixed-host path guessing.",
      );
    if (!context.workspaceTarget.cwd) throw new Error("V2 workspace root is required.");
    signal.throwIfAborted();
    await options.authorizeExecution?.();
    signal.throwIfAborted();
    const prepareTools = () =>
      !disableTools && httpPort
        ? prepareV2Orchestration(stateDir, input.threadId, httpPort)
        : Promise.resolve(undefined);
    if (workspaceTarget === "local") {
      const orchestration = await prepareTools();
      let cleanup: Promise<void> | undefined;
      return {
        options,
        input,
        resources: {
          ...(orchestration ? { orchestration: orchestration.httpConfig } : {}),
          cleanup: () => (cleanup ??= orchestration?.cleanup() ?? Promise.resolve()),
        },
      };
    }
    const remote = await V2RemoteFiles.open(
      workspaceTarget,
      context.workspaceTarget.cwd,
      input.threadId,
      resolveWorkspace,
    );
    let bridge: Awaited<ReturnType<typeof createRemoteWorkspaceBridge>> | undefined;
    let orchestration: Awaited<ReturnType<typeof prepareV2Orchestration>> | undefined;
    try {
      orchestration = await prepareTools();
      if (runtimeTarget === "local") {
        const hash = createHash("sha256")
          .update(JSON.stringify([input.threadId, workspaceTarget, remote.root]))
          .digest("hex");
        const parent = path.join(stateDir, "opencode-v2-workspaces");
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const canonical = await realpath(parent);
        const info = await lstat(canonical);
        if (process.platform === "win32")
          await inspectPrivateV2Profile(canonical, { marker: false });
        else if (info.mode & 0o077)
          throw new Error("V2 synthetic workspace parent must be private.");
        bridge = await createRemoteWorkspaceBridge({
          workspaceTarget: context.workspaceTarget,
          prefix: "bigbud-v2-remote-",
          directory: path.join(canonical, hash),
          retainDirectory: true,
        });
      }
      signal.throwIfAborted();
      const cwd = bridge ? await realpath(bridge.cwd) : remote.root;
      let cleanup: Promise<void> | undefined;
      const resources = {
        ...(orchestration ? { orchestration: orchestration.httpConfig } : {}),
        codingFiles: remote,
        media: (turn: Parameters<typeof prepareV2RemoteMedia>[0]) =>
          prepareV2RemoteMedia(turn, remote, options.attachmentsDir),
        cleanup: () => {
          remote.close();
          return (cleanup ??= Promise.all([bridge?.cleanup(), orchestration?.cleanup()]).then(
            () => {},
          ));
        },
      };
      return {
        input: {
          ...input,
          cwd,
          providerRuntimeExecutionTargetId: runtimeTarget,
          workspaceExecutionTargetId: workspaceTarget,
        },
        options: {
          ...options,
          config: {
            ...options.config,
            runtimeTargetId: runtimeTarget,
            ...(runtimeTarget !== "local" ? { workspaceRoot: remote.root } : {}),
          },
          enableLocalTools: !disableTools,
          remoteSessionConformance: {
            providerRuntimeTargetId: runtimeTarget,
            workspaceTargetId: workspaceTarget,
            profileRoot: options.config.profileRoot,
            syntheticDirectory: cwd,
          },
        },
        resources,
      };
    } catch (error) {
      remote.close();
      await bridge?.cleanup();
      await orchestration?.cleanup();
      throw error;
    }
  };
}
