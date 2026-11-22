import { describe, expect, it } from "vitest";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { remoteAgentKeptTerminalHosts } from "./remoteAgentKeptTerminalHosts.ts";
import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";

const ON = { BIGBUD_TERMINAL_HOST: "1" } as NodeJS.ProcessEnv;

const owner = (key: string, fields: Partial<RemoteAgentOwner>) =>
  ({ ownerKey: `terminal:${key}`, state: "may-have-been-sent", ...fields }) as RemoteAgentOwner;

/** Owners per target, served in pages of `pageSize`. */
function store(byTarget: Record<string, RemoteAgentOwner[]>, pageSize = 100) {
  const reads: string[] = [];
  const owners = {
    knownTargets: async () => Object.keys(byTarget),
    listTerminalOwners: async (target: string, after = "") => {
      reads.push(target);
      const all = byTarget[target] ?? [];
      const start = after ? all.findIndex((entry) => entry.ownerKey === after) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      return {
        owners: page,
        nextCursor: start + pageSize < all.length ? page.at(-1)!.ownerKey : "",
      };
    },
  } as unknown as RemoteAgentOwnerStore;
  return { owners, reads };
}

const connection = (lifecycle = true) =>
  ({
    supportsCapability: (name: string) => lifecycle && name === "terminal.lifecycle",
    request: async () => ({}),
    onFrame: () => () => undefined,
  }) as unknown as RemoteAgentConnection;

describe("remoteAgentKeptTerminalHosts", () => {
  it("reads nothing with the terminal host off", async () => {
    const { owners, reads } = store({ "ssh:a": [owner("a", {})] });
    const hosts = await remoteAgentKeptTerminalHosts({
      environment: {},
      owners: () => owners,
      isRemoteTarget: () => true,
      liveConnection: () => connection(),
    });
    expect(hosts).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("returns one host per target with a live managed owner, found past the first page", async () => {
    const ended = Array.from({ length: 5 }, (_, i) => owner(`b${i}`, { state: "terminal" }));
    const { owners } = store(
      {
        "ssh:kept": [...ended, owner("kept", {})],
        "ssh:ended": ended,
        "ssh:unmanaged": [owner("u", { hostFeatures: { screen: false, lifecycle: false } })],
      },
      2,
    );
    const live = new Map([
      ["ssh:kept", connection()],
      ["ssh:ended", connection()],
      ["ssh:unmanaged", connection()],
    ]);
    const hosts = await remoteAgentKeptTerminalHosts({
      environment: ON,
      owners: () => owners,
      isRemoteTarget: () => true,
      liveConnection: (target) => live.get(target) ?? null,
    });
    expect(hosts).toHaveLength(1);
    const key = hosts[0]!.connectionKey();
    // The control follows the live connection: a reconnect gets a new key, none has no key.
    live.set("ssh:kept", connection());
    expect(hosts[0]!.connectionKey()).not.toBe(key);
    live.delete("ssh:kept");
    expect(() => hosts[0]!.connectionKey()).toThrow();
    // An agent before 1.9 has no host to address either.
    live.set("ssh:kept", connection(false));
    expect(() => hosts[0]!.connectionKey()).toThrow();
  });

  it("skips non-remote targets and treats an unreadable owner table as no hosts", async () => {
    const { owners } = store({ local: [owner("l", {})] });
    expect(
      await remoteAgentKeptTerminalHosts({
        environment: ON,
        owners: () => owners,
        isRemoteTarget: () => false,
        liveConnection: () => connection(),
      }),
    ).toEqual([]);
    expect(
      await remoteAgentKeptTerminalHosts({
        environment: ON,
        owners: () => {
          throw new Error("not initialized");
        },
      }),
    ).toEqual([]);
  });
});
