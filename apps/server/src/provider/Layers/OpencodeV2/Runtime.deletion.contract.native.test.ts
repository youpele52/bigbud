import { expect, it } from "vitest";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;

it.skipIf(!binary)(
  "exact native removal recursively deletes parentID children but retains forks and independently created bigbud children",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    fixture.state.textOnlyDelegated = true;
    const manager = new OpencodeV2ServerManager({
      maxProcesses: 1,
      maxOwners: 25,
      maxQueuedEvents: 128,
      maxEventBytes: 2_000_000,
      consumerTimeoutMs: 15000,
    });
    try {
      const lease = await manager.acquire({
        binaryPath: binary!,
        profileRoot: fixture.profile,
        runtimeTargetId: "local",
      });
      try {
        const client = lease.process.client;
        const input = {
          directory: fixture.workspace,
          model: { providerID: "bigbud-v2-fixture", id: "synthetic-model" },
          permissions: [{ action: "*", resource: "*", effect: "deny" as const }],
        };
        const parent = await client.session.create({
          ...input,
          title: "Disposable removal parent",
        });
        await client.session.prompt({
          sessionID: parent.id,
          text: "Disposable retained history delegated_thread_provenance",
        });
        await expect
          .poll(async () => (await client.message.list({ sessionID: parent.id })).data.length, {
            timeout: 15000,
          })
          .toBeGreaterThan(0);
        await expect
          .poll(async () => (await client.session.active())[parent.id], { timeout: 15000 })
          .toBeFalsy();
        const fork = await client.session.fork({ sessionID: parent.id });
        const nested = await client.session.create({
          ...input,
          parentID: parent.id,
          title: "Recursive native child",
        });
        const independent = await client.session.create({
          ...input,
          title: "Independent bigbud child",
        });
        expect(fork.parentID).toBeFalsy();
        expect(nested.parentID).toBe(parent.id);
        expect(independent.parentID).toBeFalsy();
        await client.session.remove({ sessionID: parent.id });
        await expect(client.session.get({ sessionID: parent.id })).rejects.toThrow();
        await expect(client.session.get({ sessionID: nested.id })).rejects.toThrow();
        expect((await client.session.get({ sessionID: fork.id })).id).toBe(fork.id);
        expect((await client.session.get({ sessionID: independent.id })).id).toBe(independent.id);
        // No app stop/archive/shutdown path uses this API; this test only deletes its own disposable sessions.
      } finally {
        await lease.release();
      }
    } finally {
      await manager.close();
      await fixture.close();
    }
  },
  60000,
);
