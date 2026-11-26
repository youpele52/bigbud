import { createConnection } from "node:net";
import { expect, it, vi } from "vitest";

import type { ProofOpencodeState } from "../../../ssh/sshOwnerPickerProof.codec.opencode.ts";
import { OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
import { startSelectedV2OwnerProcess } from "./ServerManager.ownerV2.selected.ts";
import { withNativeOpencodeV2Owner } from "./ServerManager.sshOwner.native.fixture.ts";

// Linux, non-root, with target/debug/bigbud-ssh-owner built and the pinned Linux
// OpenCode v2 CLI (@opencode/cli-linux-<arch>@2.1.4):
// BIGBUD_TEST_OPENCODE_V2_OWNER_BINARY=/absolute/opencode bwrap --unshare-net --die-with-parent \
//   --bind / / -- bun run --cwd apps/server vitest run \
//   src/provider/Layers/OpencodeV2/ServerManager.sshOwner.native.test.ts
const executable = process.env.BIGBUD_TEST_OPENCODE_V2_OWNER_BINARY;

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

it.skipIf(process.platform !== "linux" || !executable).each(["close", "disconnect"] as const)(
  "serves real OpenCode v2 through the owner-selected SSH lane and tears it down on %s",
  async (end) => {
    await withNativeOpencodeV2Owner(executable!, async (native) => {
      const { owner, readCommandStarts } = native;
      const baseline = await readCommandStarts();
      const states: ProofOpencodeState[] = [];
      const session = await native.source.target(native.config.runtimeTargetId);
      const lane = session!.lane!;
      const recorded = {
        ...session!,
        lane: {
          ...lane,
          client: {
            ...lane.client,
            async openOpencodeV2(...args: Parameters<typeof lane.client.openOpencodeV2>) {
              const state = await lane.client.openOpencodeV2(...args);
              states.push(state);
              return state;
            },
            async opencodeV2Status(...args: Parameters<typeof lane.client.opencodeV2Status>) {
              const state = await lane.client.opencodeV2Status(...args);
              states.push(state);
              return state;
            },
          },
        },
      };
      const process = await startSelectedV2OwnerProcess(
        native.config,
        { target: async () => recorded },
        {},
      );
      const ready = states.find((state) => state.phase === "ready");
      if (ready?.phase !== "ready") throw new Error("The owner never reported a ready lease.");
      const { localPort, password } = ready;
      expect(password).toMatch(/^[0-9a-f]{64}$/);
      expect(process.isRunning()).toBe(true);
      expect(await readCommandStarts()).toBe(baseline + 1);

      // The SDK client already verified /api/info at the pinned version; check
      // again directly, and confirm the listener refuses a missing credential.
      const url = `http://127.0.0.1:${localPort}/api/info`;
      const unauthenticated = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      expect(unauthenticated.status).toBe(401);
      const info = await fetch(url, {
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(2_000),
      });
      expect(info.status).toBe(200);
      expect(await info.json()).toMatchObject({ version: OPENCODE_V2_CLIENT_VERSION });

      const onDeath = vi.fn();
      process.onDeath(onDeath);
      if (end === "close") {
        await process.close();
      } else {
        await owner.disconnect();
        await expect.poll(() => onDeath.mock.calls.length, { timeout: 5_000 }).toBe(1);
      }
      expect(process.isRunning()).toBe(false);
      // Probe TCP directly: an aborted SDK client alone does not prove teardown.
      await expect(connectToListener(localPort)).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(await readCommandStarts()).toBe(baseline + 1);
    });
  },
  90_000,
);
