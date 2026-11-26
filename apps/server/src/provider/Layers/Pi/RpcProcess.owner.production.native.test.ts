import { createInterface } from "node:readline";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it } from "vitest";

import {
  acquireOwnedCodexAppServer,
  probeOwnedCodexVersion,
  type CodexOwnerRuntime,
} from "../../../codex/codexAppServerManager.process.remote.owner.ts";
import { makeProductionCodexSshOwner } from "../../../codex/codexAppServerManager.process.remote.production.ts";
import {
  readExternalV2Target,
  withProductionV2Owner,
  type LiveTarget,
} from "../OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { startPi, trusted } from "./RpcProcess.owner.production.native.fixture.ts";

// W2 T-prov live proof: a PRODUCTION (target-free) owner on this host against a disposable
// Linux sshd whose account has the real Pi and Codex CLIs on its login PATH (or neither):
// BIGBUD_TEST_PROVIDER_LEASE_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":…,"remoteBinary":"/unused"}'
// BIGBUD_TEST_PROVIDER_LEASE_EXPECT=ready|unavailable
//   bun run --cwd apps/server vitest run <this file>
const external = readExternalV2Target(process.env.BIGBUD_TEST_PROVIDER_LEASE_EXTERNAL_TARGET);
const expectation = process.env.BIGBUD_TEST_PROVIDER_LEASE_EXPECT;
const enabled =
  external !== undefined && (process.platform === "darwin" || process.platform === "linux");

const codexRuntime = (target: LiveTarget): CodexOwnerRuntime => ({
  provider: "codex",
  threadId: ThreadId.makeUnsafe("thread-codex"),
  sessionEpoch: 1,
  executionTargetId: target.descriptor.targetId,
  cwd: target.cwd,
  binaryPath: "codex",
});

it.skipIf(!enabled || expectation !== "ready")(
  "runs two Pi RPC sessions and a Codex app-server through the production owner",
  async () => {
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const [target] = targets;
        const bound = await trusted(handle, target!);
        // Two concurrent Pi sessions (two threads) on one target, each its own lease.
        const sessions = await Promise.all([
          startPi(handle, target!, "thread-pi-1"),
          startPi(handle, target!, "thread-pi-2"),
        ]);
        for (const session of sessions) {
          const state = await session.request({ type: "get_state" }, 20_000);
          expect(state.success).toBe(true);
          expect(session.isAlive()).toBe(true);
        }
        await Promise.all(sessions.map((session) => session.stop()));
        for (const session of sessions) expect(session.isAlive()).toBe(false);

        const codex = makeProductionCodexSshOwner(bound, target!.descriptor.targetId);
        const probe = await probeOwnedCodexVersion(codex, codexRuntime(target!));
        expect(probe.status).toBe(0);
        expect(probe.stdout).toMatch(/^codex-cli \d+\.\d+\.\d+/);
        const version = probe.stdout.trim().replace("codex-cli ", "");
        const server = await acquireOwnedCodexAppServer(codex, codexRuntime(target!), version);
        const lines = createInterface({ input: server.stdout });
        const reply = new Promise<string>((resolve) => lines.once("line", resolve));
        server.stdin.write(
          `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "bigbud-tprov", version: "0" } } })}\n`,
        );
        // An early exit fails fast instead of waiting for a reply line.
        const ended = server.exit.then((exit) => {
          throw new Error(`Codex app-server exited early: ${JSON.stringify(exit)}`);
        });
        const line = await Promise.race([reply, ended]);
        const initialized = JSON.parse(line) as { id: number; result?: unknown };
        expect(initialized.id).toBe(1);
        expect(initialized.result).toBeDefined();
        await server.cancel();
        void ended.catch(() => undefined);
        lines.close();
      },
      { binding: {} },
    );
  },
  180_000,
);

it.skipIf(!enabled || expectation !== "unavailable")(
  "refuses Pi and Codex with a typed reason when neither is discoverable",
  async () => {
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const [target] = targets;
        const bound = await trusted(handle, target!);
        await expect(startPi(handle, target!, "thread-pi-1")).rejects.toMatchObject({
          code: "providerExecutableUnavailable",
        });
        const codex = makeProductionCodexSshOwner(bound, target!.descriptor.targetId);
        await expect(probeOwnedCodexVersion(codex, codexRuntime(target!))).rejects.toMatchObject({
          code: "providerExecutableUnavailable",
        });
        // No probe succeeded, so no lease open is armed on this target.
        await expect(
          bound.openProviderLease(new Uint8Array(32).fill(1), {
            provider: "codex",
            threadId: "thread-codex",
            sessionEpoch: 1,
            cwd: target!.cwd,
          }),
        ).rejects.toMatchObject({ code: "operationDenied" });
      },
      { binding: {} },
    );
  },
  180_000,
);
