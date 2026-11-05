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
