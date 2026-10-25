import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";

vi.mock("./ownershipHandoff", () => ({
  createOwnershipHandoff: async () => {
    throw new Error("control endpoint unavailable");
  },
}));
import { StateDirLockLive } from "./backendInstance";
import { ServerConfig } from "./config";
import { OwnershipShutdown } from "./ownershipShutdown";

it("keeps ordinary startup working without advertising an unavailable recovery endpoint", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "bigbud-recovery-unavailable-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        yield* Layer.build(StateDirLockLive).pipe(
          Effect.provideService(ServerConfig, { ...config, desktopOwnershipHandoff: true }),
          Effect.provideService(OwnershipShutdown, { request: () => {} }),
        );
        const record = yield* Effect.promise(() =>
          readFile(path.join(base, "userdata/backend.lock"), "utf8"),
        );
        expect(JSON.parse(record)).not.toHaveProperty("control");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), base).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
