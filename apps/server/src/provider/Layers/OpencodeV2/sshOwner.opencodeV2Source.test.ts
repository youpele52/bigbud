import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevSshOwnerRuntime } from "../../../ssh/sshOwnerDevRuntime.ts";
import type { SshOwnerProductionRegistration } from "../../../ssh/sshOwnerProductionRegistry.ts";
import type { SshOwnerTargetDescriptor } from "../../../ssh/sshOwnerProductionClient.launch.ts";
import { resolveSelectedV2OwnerSource } from "./ServerManager.ownerV2.source.ts";
import { startSelectedV2OwnerProcess } from "./ServerManager.ownerV2.selected.ts";
import {
  cleanupFixtures,
  config,
  ownerClient,
  refusal,
  targetFixture,
  track,
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

const descriptor: SshOwnerTargetDescriptor = {
  targetId: "ssh:fixture",
  kind: "structured",
  host: "127.0.0.1",
  port: 22,
  user: "tester",
  identityFile: "/srv/id",
  knownHostsFile: "/srv/known_hosts",
};

async function production(opencodeV2: boolean, calls: string[]) {
  const fixture = await targetFixture("/opt/remote/opencode");
  const client = ownerClient(fixture.port, fixture.password, calls, []);
  const registration = {
    handle: {
      ownerEpoch: new Uint8Array(32).fill(1),
      state: () => "open" as const,
      ...(opencodeV2 ? { opencodeV2Service: { binaryPath: "/opt/remote/opencode" } } : {}),
      target: (next: SshOwnerTargetDescriptor) => {
        calls.push(`bind ${next.targetId}`);
        return { ...client, generation: new Uint8Array(32).fill(2) };
      },
    },
    descriptorFor: async (targetId: string) => {
      if (targetId !== descriptor.targetId) throw new Error(`no descriptor for ${targetId}`);
      return descriptor;
    },
  } as unknown as SshOwnerProductionRegistration;
  return registration;
}

const resolve = (options: Parameters<typeof resolveSelectedV2OwnerSource>[0]) =>
  Effect.runPromise(resolveSelectedV2OwnerSource(options));

describe("OpenCode v2 owner source resolution", () => {
  it("uses the selected dev owner session when the dev runtime is present", async () => {
    const reads: string[] = [];
    const session = {
      targetId: "ssh:fixture",
      picker: {
        withOwner: async <A>(targetId: string, operation: (client: object) => Promise<A>) => {
          reads.push(targetId);
          return operation({ opencodeV2Service: { binaryPath: "/opt/remote/opencode" } });
        },
      },
    };
    const source = await Effect.runPromise(
      resolveSelectedV2OwnerSource({
        activation: true,
        production: () => {
          throw new Error("production must not be consulted when dev is selected");
        },
      }).pipe(Effect.provideService(DevSshOwnerRuntime, { session } as never)),
    );
    const target = await source?.target("ssh:fixture");
    expect(reads).toEqual(["ssh:fixture"]);
    expect(target?.serviceBinding).toBe("/opt/remote/opencode");
  });

  it("uses the registered production owner when activation is on", async () => {
    const calls: string[] = [];
    const registration = await production(true, calls);
    const source = await resolve({ activation: true, production: () => registration });
    const process = track(
      await startSelectedV2OwnerProcess(config(), source, { platform: "linux" }),
    );
    expect((await process.client.server.info()).version).toBe("2.1.4");
    expect(calls[0]).toBe("bind ssh:fixture");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("stays inert with activation off even when a production owner is registered", async () => {
    const calls: string[] = [];
    const registration = await production(true, calls);
    const source = await resolve({ activation: false, production: () => registration });
    expect(source).toBeUndefined();
    expect(
      await refusal(startSelectedV2OwnerProcess(config(), source, { platform: "linux" })),
    ).toBe("owner-unavailable");
    expect(calls).toEqual([]);
  });

  it("refuses as owner-unavailable, not no-binding, when no owner is open", async () => {
    const source = await resolve({ activation: true, production: () => undefined });
    expect(
      await refusal(startSelectedV2OwnerProcess(config(), source, { platform: "linux" })),
    ).toBe("owner-unavailable");
  });

  it("refuses an open production owner launched without a v2 binding as no-binding", async () => {
    const calls: string[] = [];
    const registration = await production(false, calls);
    const source = await resolve({ activation: true, production: () => registration });
    expect(
      await refusal(startSelectedV2OwnerProcess(config(), source, { platform: "linux" })),
    ).toBe("no-binding");
    expect(calls).toEqual([]);
  });
});
