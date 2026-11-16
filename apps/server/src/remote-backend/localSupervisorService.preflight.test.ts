import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOwnershipLock } from "@bigbud/shared/backendOwnership.record";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import { acquireStateDirLock } from "../startup/stateDirLock.ts";

const wiring = vi.hoisted(() => ({
  events: [] as string[],
  config: undefined as ServerConfigShape | undefined,
  sql: { fixture: "sql" },
  owners: { fixture: "owners" },
  identityFails: false,
  close: async () => {},
}));

// Real lock and authority publication; synthetic machine ID makes this fixture portable.
vi.mock("./identity.service.ts", async (original) => {
  const actual = await original<typeof import("./identity.service.ts")>();
  const { BackendInstance } = await import("../startup/backendInstance.ts");
  const { loadRemoteBackendIdentity } = await import("./authority.ts");
  return {
    ...actual,
    makeRemoteBackendIdentityLive: (options: { requireExisting?: boolean } = {}) =>
      Layer.effect(
        actual.RemoteBackendIdentityService,
        Effect.gen(function* () {
          const owner = yield* BackendInstance;
          wiring.events.push("identity");
          if (wiring.identityFails)
            return yield* Effect.fail(new Error("fixture identity rejected"));
          return yield* Effect.promise(() =>
            loadRemoteBackendIdentity(
              { ...owner, machineId: "machine-v1:preflight-fixture" },
              options,
            ),
          );
        }),
      ),
  };
});
// Hold the persistence finalizer to test ordering without opening provider/runtime services.
vi.mock("../persistence/Layers/Sqlite.ts", () => ({
  makeSqlitePersistenceLive: () =>
    Layer.mergeAll(
      Layer.succeed(SqlClient.SqlClient, wiring.sql as never),
      Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.promise(async () => {
            expect(
              await readOwnershipLock(join(wiring.config!.stateDir, "backend.lock")),
            ).toBeDefined();
            wiring.events.push("database-open");
          }),
          () =>
            Effect.promise(async () => {
              wiring.events.push("database-close");
              await wiring.close();
              expect(
                await readOwnershipLock(join(wiring.config!.stateDir, "backend.lock")),
              ).toBeDefined();
            }),
        ),
      ),
    ),
}));
vi.mock("../persistence/Layers/RemoteExecutionTargetDisconnects.ts", () => ({
  withRemoteExecutionTargetDisconnects: (layer: Layer.Layer<SqlClient.SqlClient>) => layer,
}));
vi.mock("../persistence/Layers/RemoteAgentRuntimeBindings.ts", async () => {
  const { RemoteAgentRuntimeOwners } =
    await import("../persistence/Layers/RemoteAgentRuntimeBindings.service.ts");
  return {
    RemoteAgentRuntimeOwnersLive: Layer.effect(
      RemoteAgentRuntimeOwners,
      Effect.as(Effect.service(SqlClient.SqlClient), wiring.owners as never),
    ),
  };
});
vi.mock("../startup/config.remote.ts", async (original) => {
  const actual = await original<typeof import("../startup/config.remote.ts")>();
  return {
    ...actual,
    assertRemoteServerProfile: (config: ServerConfigShape) =>
      actual.assertRemoteServerProfile(config, "linux"),
  };
});
import { runLocalSupervisorServicePreflight } from "./localSupervisorService.preflight.ts";

let directory: string;
let config: ServerConfigShape;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "bb-preflight-")));
  const base = await Effect.runPromise(
    Effect.service(ServerConfig).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), directory).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  await chmod(base.stateDir, 0o700);
  config = {
    ...base,
    mode: "remote",
    authToken: "fixture-only-token",
    devUrl: undefined,
    host: "127.0.0.1",
    noBrowser: true,
    autoBootstrapProjectFromCwd: false,
  };
  wiring.config = config;
  wiring.events = [];
  wiring.identityFails = false;
  wiring.close = async () => {};
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const lock = () => readOwnershipLock(join(config.stateDir, "backend.lock"));

describe("finite remote service preflight ownership", () => {
  it("holds the real backend lock through persistence teardown and releases it before another startup", async () => {
    let closing!: () => void;
    const closingStarted = new Promise<void>((resolve) => {
      closing = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    wiring.close = async () => {
      closing();
      await gate;
    };
    const running = Effect.runPromise(
      runLocalSupervisorServicePreflight({
        config,
        operation: async (context) => {
          expect(context.sql).toBe(wiring.sql);
          expect(context.owners).toBe(wiring.owners);
          expect((await lock())?.nonce).toBe(context.owner.nonce);
          expect(context.identity.authority.authorityId).toMatch(/^[a-f0-9]{32}$/);
          wiring.events.push("operation");
          return "adopted-fixture";
        },
      }),
    );
    void running.catch(() => undefined);
    try {
      await Promise.race([closingStarted, running]);
      expect(await lock()).toBeDefined();
      await expect(
        acquireStateDirLock({ stateDir: config.stateDir, port: config.port }),
      ).rejects.toThrow();
    } finally {
      release();
    }
    expect(await running).toBe("adopted-fixture");
    expect(wiring.events).toEqual(["identity", "database-open", "operation", "database-close"]);
    expect(await lock()).toBeUndefined();
    const next = await acquireStateDirLock({ stateDir: config.stateDir, port: config.port });
    await next.release();
  });

  it("closes resources and ownership when the finite operation fails", async () => {
    await expect(
      Effect.runPromise(
        runLocalSupervisorServicePreflight({
          config,
          operation: async () => {
            throw new Error("fixture operation failed");
          },
        }),
      ),
    ).rejects.toThrow("preflight did not complete");
    expect(wiring.events).toEqual(["identity", "database-open", "database-close"]);
    expect(await lock()).toBeUndefined();
  });

  it("retains SQL and the lock until an interrupted operation Promise actually settles", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let childSignal: AbortSignal | undefined;
    const running = Effect.runPromise(
      runLocalSupervisorServicePreflight({
        config,
        operation: async (_context, signal) => {
          childSignal = signal;
          wiring.events.push("operation-start");
          started();
          await gate; // Deliberately ignores cancellation until its bounded continuation settles.
          expect(await lock()).toBeDefined();
          wiring.events.push("operation-settled");
        },
      }),
      { signal: controller.signal },
    );
    void running.catch(() => undefined);
    try {
      await Promise.race([ready, running]);
      controller.abort();
      await vi.waitFor(() => expect(childSignal?.aborted).toBe(true));
      expect(wiring.events).not.toContain("database-close");
      expect(await lock()).toBeDefined();
      await expect(
        acquireStateDirLock({ stateDir: config.stateDir, port: config.port }),
      ).rejects.toThrow();
    } finally {
      release();
    }
    await expect(running).rejects.toBeDefined();
    expect(wiring.events).toEqual([
      "identity",
      "database-open",
      "operation-start",
      "operation-settled",
      "database-close",
    ]);
    expect(await lock()).toBeUndefined();
  });

  it("refuses a missing service identity without generating a replacement or opening persistence", async () => {
    await expect(
      Effect.runPromise(
        runLocalSupervisorServicePreflight({
          config,
          requireExistingIdentity: true,
          operation: async () => {
            throw new Error("must not run");
          },
        }),
      ),
    ).rejects.toThrow();
    expect(wiring.events).toEqual(["identity"]);
    await expect(readFile(join(config.stateDir, "remote-authority.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readOwnershipLock(join(config.stateDir, "backend.lock"))).toBeUndefined();
  });

  it("validates the service identity pin before building persistence", async () => {
    await expect(
      Effect.runPromise(
        runLocalSupervisorServicePreflight({
          config,
          validateIdentity: () => {
            throw new Error("reserved installation mismatch");
          },
          operation: async () => {
            throw new Error("must not run");
          },
        }),
      ),
    ).rejects.toThrow("identity does not match its reserved installation");
    expect(wiring.events).toEqual(["identity"]);
    expect(await readOwnershipLock(join(config.stateDir, "backend.lock"))).toBeUndefined();
  });

  it("does not build persistence after identity refusal", async () => {
    wiring.identityFails = true;
    await expect(
      Effect.runPromise(
        runLocalSupervisorServicePreflight({
          config,
          operation: async () => {
            throw new Error("must not run");
          },
        }),
      ),
    ).rejects.toThrow("identity rejected");
    expect(wiring.events).toEqual(["identity"]);
    expect(await lock()).toBeUndefined();
  });

  it.each(["mode", "database"] as const)(
    "rejects invalid %s before acquiring any resource",
    async (field) => {
      const invalid =
        field === "mode"
          ? { ...config, mode: "web" as const }
          : { ...config, dbPath: join(directory, "other-authority.sqlite") };
      await expect(
        Effect.runPromise(
          runLocalSupervisorServicePreflight({
            config: invalid,
            operation: async () => "must not run",
          }),
        ),
      ).rejects.toThrow("Invalid remote service preflight");
      expect(wiring.events).toEqual([]);
      expect(await lock()).toBeUndefined();
    },
  );
});
