import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
  type LiveTarget,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import {
  registration,
  trusted,
} from "../provider/Layers/Pi/RpcProcess.owner.production.native.fixture.ts";
import { registerSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import { remoteShell } from "../ssh/sshOwnerProductionProviderLease.native.fixture.ts";
import { CodexAppServerManager } from "./codexAppServerManager.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";

// W2 T-prov live proof (U20): a real Codex app-server session through the Codex manager and the
// production owner, against a disposable Linux sshd with the real Codex CLI on
// the login PATH:
// BIGBUD_TEST_PROVIDER_LEASE_EXTERNAL_TARGET='{…}' \
// BIGBUD_TEST_PROVIDER_LEASE_EXPECT=ready bun run --cwd apps/server vitest run <this file>
const external = readExternalV2Target(process.env.BIGBUD_TEST_PROVIDER_LEASE_EXTERNAL_TARGET);
const enabled =
  external !== undefined &&
  process.env.BIGBUD_TEST_PROVIDER_LEASE_EXPECT === "ready" &&
  (process.platform === "darwin" || process.platform === "linux");

const input = (target: LiveTarget, thread: string, homePath?: string) => {
  const id = target.descriptor.targetId;
  return {
    threadId: ThreadId.makeUnsafe(thread),
    provider: "codex",
    providerRuntimeExecutionTargetId: id,
    workspaceExecutionTargetId: id,
    executionTargetId: id,
    cwd: target.cwd,
    binaryPath: "codex",
    runtimeMode: "full-access",
    sessionEpoch: 1,
    ...(homePath !== undefined ? { homePath } : {}),
  } satisfies CodexAppServerStartSessionInput;
};

it.skipIf(!enabled)(
  "runs a Codex app-server session through the manager and the production owner",
  async () => {
    const home = remoteShell(external!, 'mkdir -p "$HOME/.codex-alt"; printf %s "$HOME"').trim();
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const [target] = targets;
        await trusted(handle, target!);
        const unregister = registerSshOwnerProductionOwner(registration(handle, target!));
        const manager = new CodexAppServerManager();
        try {
          const session = await manager.startSession(
            input(target!, "thread-codex-live", `${home}/.codex-alt`),
          );
          expect(session.status).toBe("ready");
          expect(manager.hasSession(session.threadId)).toBe(true);
          // The custom CODEX_HOME took effect on the target.
          expect(remoteShell(external!, 'ls "$HOME/.codex-alt"').trim()).not.toBe("");
          manager.stopSession(session.threadId);
          await expect(
            manager.startSession(input(target!, "thread-codex-refused", "/etc")),
          ).rejects.toThrow(/Codex home/);
        } finally {
          manager.stopAll();
          unregister();
        }
      },
      { binding: {} },
    );
  },
  180_000,
);
