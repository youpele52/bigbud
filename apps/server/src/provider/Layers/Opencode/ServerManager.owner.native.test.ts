import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { createConnection } from "node:net";
import { expect, it, vi } from "vitest";

import { withNativeOpencodeOwner } from "./ServerManager.owner.native.fixture.ts";
import { SYNTHETIC_OPENCODE_HEALTH_VERSION } from "./ServerManager.owner.native.service.ts";
import {
  startOwnedOpencodeServer,
  type OpencodeOwnerStart,
  type OwnedOpencodeServerInput,
} from "./ServerManager.owner.ts";

// Linux, non-root, with target/debug/bigbud-ssh-owner built and a real Linux v1 binary:
// BIGBUD_TEST_OPENCODE_V1_BINARY=/absolute/opencode bwrap --unshare-net --die-with-parent --bind / / \
//   -- bun run --cwd apps/server vitest run src/provider/Layers/Opencode/ServerManager.owner.native.test.ts
// Alternatively set BIGBUD_TEST_OPENCODE_V1_SYNTHETIC=1 for native transport only.
const executable =
  process.env.BIGBUD_TEST_OPENCODE_V1_BINARY ||
  (process.env.BIGBUD_TEST_OPENCODE_V1_SYNTHETIC === "1" ? "synthetic" : undefined);
const serviceLabel = executable === "synthetic" ? "synthetic ELF" : "real OpenCode v1";

vi.mock("./ServerManager.child.ts", () => {
  throw new Error("The native OpenCode proof must not load the alternate child launcher.");
});

function connectToListener(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1_000, () => socket.destroy(new Error("Listener probe timed out.")));
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
  });
}

it.skipIf(process.platform !== "linux" || !executable).each(["cancel", "disconnect"] as const)(
  `uses the pinned native lease (${serviceLabel}) and tears down its exact listener on %s`,
  async (end) => {
    await withNativeOpencodeOwner(executable!, async (picker, input, readCommandStarts) => {
      const boundOwner = picker.opencodeOwner;
      if (!boundOwner) throw new Error("The native picker did not expose the bound OpenCode port.");
      const baseline = await readCommandStarts();
      if (end === "cancel") {
        const otherTarget = {
          ...input.providerRuntimeTarget,
          executionTargetId: "ssh:host=127.0.0.1&port=22223&transport=direct-ssh",
        };
        for (const wrong of [
          { threadId: ThreadId.makeUnsafe("other-thread") },
          { sessionEpoch: input.sessionEpoch + 1 },
          { workspaceTarget: { ...input.workspaceTarget, cwd: "/wrong-directory" } },
          { binaryPath: `${input.binaryPath}-other` },
          {
            providerRuntimeTarget: otherTarget,
            workspaceTarget: { ...otherTarget, cwd: input.workspaceTarget.cwd },
          },
        ] satisfies Partial<OwnedOpencodeServerInput>[]) {
          await expect(
            startOwnedOpencodeServer({ ...input, ...wrong, owner: boundOwner }),
          ).rejects.toMatchObject({ code: "operationDenied" });
        }
        expect(await readCommandStarts()).toBe(baseline);
      }

      const starts: OpencodeOwnerStart[] = [];
      const server = await startOwnedOpencodeServer({
        ...input,
        owner: {
          startProvider(request) {
            const started = boundOwner.startProvider(request);
            starts.push(started);
            return started;
          },
        },
      });
      expect(starts).toHaveLength(1);
      const { localPort } = await starts[0]!.ready;
      expect(server.lease).toEqual(starts[0]!.lease);
      expect(localPort).not.toBe(4096);
      expect(server.url).toBe(`http://127.0.0.1:${localPort}`);
      const health = await server.client.global.health({ signal: AbortSignal.timeout(2_000) });
      expect(health.response?.status).toBe(200);
      expect(health.data).toMatchObject({
        healthy: true,
        version:
          executable === "synthetic"
            ? SYNTHETIC_OPENCODE_HEALTH_VERSION
            : expect.stringMatching(/^v?1\./),
      });
      expect(await readCommandStarts()).toBe(baseline + 1);

      const onUnexpectedDeath = vi.fn();
      server.onUnexpectedDeath?.(onUnexpectedDeath);
      if (end === "cancel") {
        await server.close();
        expect(onUnexpectedDeath).not.toHaveBeenCalled();
      } else {
        await picker.disconnect();
        await expect.poll(() => onUnexpectedDeath.mock.calls.length, { timeout: 2_000 }).toBe(1);
        await expect(
          startOwnedOpencodeServer({ ...input, owner: boundOwner }),
        ).rejects.toMatchObject({
          code: "targetDisconnected",
        });
      }
      expect(server.isRunning?.()).toBe(false);
      // Probe TCP directly: an aborted SDK client alone does not prove native teardown.
      await expect(connectToListener(localPort)).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(await readCommandStarts()).toBe(baseline + 1);
    });
  },
  60_000,
);

it.skipIf(process.platform !== "linux" || process.env.BIGBUD_TEST_OPENCODE_V1_SYNTHETIC !== "1")(
  "cancels a real SSH launch before readiness and waits for confirmed teardown",
  async () => {
    await withNativeOpencodeOwner("synthetic-stalled", async (picker, input, readCommandStarts) => {
      const owner = picker.opencodeOwner;
      if (!owner) throw new Error("Missing OpenCode proof owner");
      const baseline = await readCommandStarts();
      const cancellation = new AbortController();
      let reservation: OpencodeOwnerStart | undefined;
      const started = startOwnedOpencodeServer({
        ...input,
        owner: {
          startProvider(request) {
            reservation = owner.startProvider(request);
            return reservation;
          },
        },
        signal: cancellation.signal,
      });
      void started.catch(() => undefined);
      await expect.poll(readCommandStarts, { timeout: 3_000 }).toBe(baseline + 1);
      cancellation.abort();
      // An unconfirmed teardown would surface as a separate aggregate cleanup error.
      await expect(started).rejects.toThrow(/^OpenCode SSH owner readiness cancelled\.$/);
      if (!reservation) throw new Error("Missing OpenCode reservation");
      await expect(reservation.ready).rejects.toMatchObject({ code: "transportLost" });
      await expect(reservation.cancel()).resolves.toBeUndefined();
      expect(await readCommandStarts()).toBe(baseline + 1);
    });
  },
  60_000,
);
