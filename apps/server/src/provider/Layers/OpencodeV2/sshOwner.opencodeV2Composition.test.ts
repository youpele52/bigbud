import { afterEach, describe, expect, it, vi } from "vitest";

import type { SshOwnerTargetDescriptor } from "../../../ssh/sshOwnerProductionClient.launch.ts";
import {
  makeProductionV2OwnerSource,
  resolveV2OwnerServiceBinding,
  startSelectedV2OwnerProcess,
} from "./ServerManager.ownerV2.selected.ts";
import type { V2ProcessConfig } from "./ServerManager.types.ts";
import {
  cleanupFixtures,
  config,
  ownerClient,
  refusal,
  sourceFor,
  targetFixture,
  track,
  type TargetFixture,
} from "./sshOwner.opencodeV2Composition.fixture.ts";

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnSpy,
}));

afterEach(async () => {
  await cleanupFixtures();
  spawnSpy.mockClear();
});

describe("selected OpenCode v2 SSH owner binding", () => {
  it("binds only a trusted absolute profile path", () => {
    expect(resolveV2OwnerServiceBinding("/opt/opencode/opencode")).toEqual({
      kind: "bound",
      binaryPath: "/opt/opencode/opencode",
    });
    expect(resolveV2OwnerServiceBinding(undefined)).toEqual({
      kind: "refused",
      reason: "no-binding",
    });
    expect(resolveV2OwnerServiceBinding(undefined, "no-binding")).toEqual({
      kind: "refused",
      reason: "no-binding",
    });
    expect(resolveV2OwnerServiceBinding("opencode")).toEqual({
      kind: "refused",
      reason: "non-absolute-path",
    });
    expect(resolveV2OwnerServiceBinding(" /opt/opencode/opencode")).toEqual({
      kind: "refused",
      reason: "non-absolute-path",
    });
    expect(resolveV2OwnerServiceBinding("/opt/opencode\0")).toEqual({
      kind: "refused",
      reason: "non-absolute-path",
    });
    expect(resolveV2OwnerServiceBinding("/opt/../opencode")).toEqual({
      kind: "refused",
      reason: "non-absolute-path",
    });
    expect(resolveV2OwnerServiceBinding(undefined, "settings-unreadable")).toEqual({
      kind: "refused",
      reason: "settings-unreadable",
    });
    expect(resolveV2OwnerServiceBinding(undefined, "non-absolute-path")).toEqual({
      kind: "refused",
      reason: "non-absolute-path",
    });
  });
});

describe("selected OpenCode v2 SSH owner composition", () => {
  it("constructs the owner session and hands the SDK the owner endpoint and credential", async () => {
    const fixture = await targetFixture("/opt/remote/opencode");
    const source = sourceFor({ "ssh:fixture": fixture }, fixture.remoteBinary);
    const process = track(
      await startSelectedV2OwnerProcess(config(), source, { platform: "linux" }),
    );
    expect((await process.client.server.info()).version).toBe("2.1.4");
    expect(process.isRunning()).toBe(true);
    // The owner selected this listener and credential; the SDK used both.
    expect(fixture.scopes).toEqual([
      { threadId: "ssh:fixture", sessionEpoch: 0, cwd: "/srv/ssh_fixture", transport: "v2" },
    ]);
    expect(fixture.calls[0]).toBe("open v2 ssh:fixture /srv/ssh_fixture");
    expect(fixture.requests[0]).toBe(
      `/api/info Basic ${Buffer.from(`opencode:${fixture.password}`).toString("base64")}`,
    );
    // The host-side setting can never substitute for the owner binding.
    expect(spawnSpy).not.toHaveBeenCalled();
    await process.close();
    expect(fixture.calls).toContain("close");
  });

  it("keeps each target's lease and listener independent through the composition", async () => {
    const first = await targetFixture("/opt/remote/opencode");
    const second = await targetFixture("/opt/remote/opencode");
    const source = sourceFor({ "ssh:one": first, "ssh:two": second }, first.remoteBinary);
    const one = track(
      await startSelectedV2OwnerProcess(config("ssh:one"), source, { platform: "linux" }),
    );
    const two = track(
      await startSelectedV2OwnerProcess(config("ssh:two"), source, { platform: "linux" }),
    );
    expect(first.port).not.toBe(second.port);
    expect((await one.client.server.info()).version).toBe("2.1.4");
    expect((await two.client.server.info()).version).toBe("2.1.4");
    await one.close();
    expect(first.calls).toContain("close");
    expect(second.calls).not.toContain("close");
    // The first teardown cannot retire the second target's listener.
    expect((await two.client.server.info()).version).toBe("2.1.4");
    expect(two.isRunning()).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("binds two production handle targets with independent owner leases", async () => {
    const first = await targetFixture("/opt/remote/opencode");
    const second = await targetFixture("/opt/remote/opencode");
    const fixtures: Record<string, TargetFixture> = {
      "ssh:one": first,
      "ssh:two": second,
    };
    const handle = {
      ownerEpoch: new Uint8Array(32).fill(9),
      opencodeV2Service: { binaryPath: first.remoteBinary },
      target(descriptor: { readonly targetId: string }) {
        const fixture = fixtures[descriptor.targetId]!;
        return {
          targetId: descriptor.targetId,
          generation: new Uint8Array(32).fill(7),
          ...ownerClient(fixture.port, fixture.password, fixture.calls, fixture.scopes),
        };
      },
    } as unknown as Parameters<typeof makeProductionV2OwnerSource>[0];
    const descriptors: Record<string, SshOwnerTargetDescriptor> = {
      "ssh:one": {
        targetId: "ssh:one",
        kind: "structured",
        host: "127.0.0.1",
        port: 22,
        user: "tester",
        identityFile: "/srv/id",
        knownHostsFile: "/srv/known_hosts",
      },
      "ssh:two": {
        targetId: "ssh:two",
        kind: "structured",
        host: "127.0.0.1",
        port: 22,
        user: "tester",
        identityFile: "/srv/id",
        knownHostsFile: "/srv/known_hosts",
      },
    };
    const source = makeProductionV2OwnerSource(handle, async (targetId) => {
      const descriptor = descriptors[targetId];
      if (!descriptor) throw new Error(`no descriptor for ${targetId}`);
      return descriptor;
    });
    const one = track(
      await startSelectedV2OwnerProcess(config("ssh:one"), source, { platform: "linux" }),
    );
    const two = track(
      await startSelectedV2OwnerProcess(config("ssh:two"), source, { platform: "linux" }),
    );
    expect((await one.client.server.info()).version).toBe("2.1.4");
    expect((await two.client.server.info()).version).toBe("2.1.4");
    await one.close();
    expect(first.calls).toContain("close");
    expect(second.calls).not.toContain("close");
    expect(two.isRunning()).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("refuses a shared local service instead of borrowing it for an owner target", async () => {
    const reason = await refusal(
      startSelectedV2OwnerProcess(
        {
          runtimeTargetId: "ssh:fixture",
          sharedService: {
            registrationFile: "/tmp/fixture.json",
            generation: "fixture",
            storageIdentity: "fixture",
          },
        } satisfies V2ProcessConfig,
        undefined,
        { platform: "linux" },
      ),
    );
    expect(reason).toBe("owner-unavailable");
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
