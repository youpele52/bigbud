import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { checkMuseProviderStatus, initialMuseSnapshot } from "./Provider.ts";
import type { MuseHostFactory, MuseTransport } from "./Client.ts";

const failingFactory: MuseHostFactory = async () => {
  throw new Error("spawn muse ENOENT not found");
};

const qualifiedFactory: MuseHostFactory = async () => {
  let counter = 0;
  const transport: MuseTransport = {
    initializeResult: {
      grantedCapabilities: ["sessionMcp"],
      sessionDurability: "durable",
      serverVersion: "1.4.14",
    },
    mintCommandId: () => `cmd-${++counter}`,
    command: async () => ({}),
    request: async (method) => {
      if (method === "model/list")
        return {
          providerId: "meta",
          models: [
            {
              modelId: "muse-spark-1.3",
              displayLabel: "muse-spark-1.3",
              providerId: "meta",
              isDefault: false,
              isActive: false,
              description: null,
              variants: ["low", "high"],
              defaultReasoningEffort: "high",
            },
          ],
        };
      if (method === "account/read") return { state: "accountLogin", credentialRequired: true };
      if (method === "permissionProfile/list")
        return {
          profiles: [
            { profileId: ":ask-me", label: "Ask me", available: true, reviewerAuthority: "human" },
          ],
        };
      return {};
    },
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    close: async () => undefined,
  };
  return transport;
};

describe("Muse provider snapshot", () => {
  it.each(["spawn", "discovery"])(
    "redacts %s failures before forwarding provider status",
    async (phase) => {
      const failure = new Error("Bearer private123\ntoken=hidden account@example.test");
      const factory: MuseHostFactory =
        phase === "spawn"
          ? async () => {
              throw failure;
            }
          : qualifiedFactory;
      const snapshot = await Effect.runPromise(
        checkMuseProviderStatus(
          { enabled: true, binaryPath: "muse" },
          factory,
          "darwin",
          async () => {
            throw failure;
          },
        ),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).not.toMatch(/private123|hidden|account@example|\n/);
      expect(snapshot.message).toContain("[redacted]");
    },
  );
  it("does not turn a discovery result into a defect when close throws synchronously", async () => {
    const factory: MuseHostFactory = async (options) => ({
      ...(await qualifiedFactory(options)),
      close: () => {
        throw new Error("cleanup failed");
      },
    });
    const snapshot = await Effect.runPromise(
      checkMuseProviderStatus({ enabled: true, binaryPath: "muse" }, factory, "darwin"),
    );
    expect(snapshot.status).toBe("ready");
  });
  it("is disabled by default and spawns nothing", async () => {
    let spawned = false;
    const snapshot = await Effect.runPromise(
      checkMuseProviderStatus({ enabled: false, binaryPath: "muse" }, async () => {
        spawned = true;
        throw new Error("must not spawn");
      }),
    );
    expect(snapshot.status).toBe("disabled");
    expect(snapshot.enabled).toBe(false);
    expect(spawned).toBe(false);
    expect(snapshot.supportsAttachments).toBe(false);
    expect(snapshot.supportedRuntimeModes).toEqual(["auto-accept-edits"]);
  });

  it("reports a missing CLI as user action required", async () => {
    const snapshot = await Effect.runPromise(
      checkMuseProviderStatus({ enabled: true, binaryPath: "muse" }, failingFactory),
    );
    expect(snapshot.installed).toBe(false);
    expect(snapshot.status).toBe("error");
    expect(snapshot.failure?.reason).toBe("command-not-found");
    expect(snapshot.message).toContain("sign in");
  });

  it("becomes ready on qualified macOS when enabled and signed in with browser login", async () => {
    const snapshot = await Effect.runPromise(
      checkMuseProviderStatus({ enabled: true, binaryPath: "muse" }, qualifiedFactory, "darwin"),
    );
    expect(snapshot.status).toBe("ready");
    expect(snapshot.auth.status).toBe("authenticated");
    expect(snapshot.auth.type).toBe("accountLogin");
    expect(snapshot.models.map((m) => m.slug)).toEqual(["muse-spark-1.3"]);
    expect(snapshot.supportedRuntimeModes).toEqual(["auto-accept-edits"]);
  });

  it.each(["darwin", "win32", "linux"] as const)(
    "reports an empty native catalog as unavailable on %s and recovers on refresh",
    async (platform) => {
      let empty = true;
      let closed = 0;
      let commands = 0;
      const factory: MuseHostFactory = async (options) => {
        const transport = await qualifiedFactory(options);
        return {
          ...transport,
          command: async () => {
            commands++;
            throw new Error("Discovery must not mutate native sessions");
          },
          request: async (method, params) => {
            if (method === "model/list") {
              expect(params).toEqual({});
              if (empty)
                return {
                  providerId: "meta",
                  profileId: "tbh",
                  source: "bundledCatalog",
                  models: [],
                };
            }
            return transport.request(method, params);
          },
          close: async () => {
            closed++;
          },
        };
      };
      const check = () =>
        Effect.runPromise(
          checkMuseProviderStatus({ enabled: true, binaryPath: "muse" }, factory, platform),
        );
      const unavailable = await check();
      expect(unavailable.status).toBe("warning");
      expect(unavailable.installed).toBe(true);
      expect(unavailable.version).toBe("1.4.14");
      expect(unavailable.auth.type).toBe("accountLogin");
      expect(unavailable.models).toEqual([]);
      expect(unavailable.modelDiscovery?.status).toBe("unavailable");
      expect(unavailable.message).toContain("empty model catalog");
      expect(unavailable.message).toContain("native `muse` CLI");
      expect(unavailable.supportsAttachments).toBe(false);
      expect(unavailable.supportsLocalRuntimeRemoteWorkspace).toBe(false);
      empty = false;
      const ready = await check();
      expect(ready.status).toBe("ready");
      expect(ready.modelDiscovery?.status).toBe("live");
      expect(ready.message).toBeUndefined();
      expect(ready.models.map((model) => model.slug)).toEqual(["muse-spark-1.3"]);
      expect(closed).toBe(2);
      expect(commands).toBe(0);
    },
  );

  it.each([
    ["loggedOut", "not signed in"],
    ["envKey", "API key"],
  ])("preserves %s remediation when the catalog is also empty", async (state, message) => {
    const factory: MuseHostFactory = async (options) => {
      const transport = await qualifiedFactory(options);
      return {
        ...transport,
        request: async (method, params) => {
          if (method === "model/list") return { providerId: "meta", models: [] };
          if (method === "account/read") return { state, credentialRequired: true };
          return transport.request(method, params);
        },
      };
    };
    const snapshot = await Effect.runPromise(
      checkMuseProviderStatus({ enabled: true, binaryPath: "muse" }, factory, "darwin"),
    );
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain(message);
    expect(snapshot.modelDiscovery?.status).toBe("unavailable");
    expect(snapshot.models).toEqual([]);
  });

  it("does not report ready when the native lane is logged out", async () => {
    const loggedOutFactory: MuseHostFactory = async () => {
      const transport = await qualifiedFactory({ binaryPath: "muse", cwd: process.cwd() });
      return {
        ...transport,
        request: async (method: string) =>
          method === "account/read"
            ? { state: "loggedOut", credentialRequired: true }
            : transport.request(method),
      };
    };
    const snapshot = await Effect.runPromise(
      checkMuseProviderStatus({ enabled: true, binaryPath: "muse" }, loggedOutFactory, "darwin"),
    );
    expect(snapshot.status).toBe("warning");
    expect(snapshot.auth.status).toBe("unauthenticated");
    expect(snapshot.message).toContain("not signed in");
  });

  it("is ready on Windows and Linux when enabled and signed in", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const snapshot = await Effect.runPromise(
        checkMuseProviderStatus({ enabled: true, binaryPath: "muse" }, qualifiedFactory, platform),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.message).toBeUndefined();
    }
  });

  it("stays unavailable on an unknown platform", async () => {
    const snapshot = await Effect.runPromise(
      checkMuseProviderStatus(
        { enabled: true, binaryPath: "muse" },
        qualifiedFactory,
        "freebsd" as NodeJS.Platform,
      ),
    );
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain("freebsd");
  });

  it("initial snapshot carries the fail-closed declarations", () => {
    const snapshot = initialMuseSnapshot({ enabled: true, binaryPath: "muse" });
    expect(snapshot.provider).toBe("muse");
    expect(snapshot.supportsAttachments).toBe(false);
    expect(snapshot.supportsLocalRuntimeRemoteWorkspace).toBe(false);
    expect(snapshot.turnControl?.continuation).toBe(false);
    expect(snapshot.turnControl?.interruptTarget).toBe("exact-turn");
  });
});
