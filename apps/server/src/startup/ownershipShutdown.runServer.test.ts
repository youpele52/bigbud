import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it, vi } from "vitest";
import {
  ownershipIdentity,
  requestOwnershipControl,
} from "@bigbud/shared/backendOwnership.control";
import { readOwnershipLock } from "@bigbud/shared/backendOwnership.record";

const wiring = vi.hoisted(() => ({
  launch: vi.fn(),
  pipes: undefined as undefined | { input: PassThrough; output: PassThrough },
}));
// Replace the heavyweight application only, retaining runServer's actual shutdown wrapper.
vi.mock("effect", async (original) => {
  const actual = await original<typeof import("effect")>();
  return { ...actual, Layer: { ...actual.Layer, launch: wiring.launch } };
});
vi.mock("./ownershipHandoff", async (original) => {
  const actual = await original<typeof import("./ownershipHandoff")>();
  return {
    ...actual,
    createOwnershipHandoff: (directory: string, shutdown: () => void) =>
      actual.createOwnershipHandoff(directory, shutdown, wiring.pipes),
  };
});
import { StateDirLockLive } from "./backendInstance";
import { ServerConfig } from "./config";

it.skipIf(process.platform === "win32")(
  "runServer provides shutdown to the real lock layer and awaits application finalizers before unlocking",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bigbud-runserver-handoff-"));
    const input = new PassThrough(),
      output = new PassThrough();
    wiring.pipes = { input, output };
    output.on("data", (chunk) => {
      const { operation } = JSON.parse(String(chunk));
      input.write(`${JSON.stringify({ operation, quiesced: true })}\n`);
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let finalizerHeldLock = false;
    let stateDir = "";
    wiring.launch.mockReturnValue(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        stateDir = yield* Effect.promise(() => realpath(config.stateDir));
        yield* Layer.build(StateDirLockLive).pipe(
          Effect.provideService(ServerConfig, { ...config, desktopOwnershipHandoff: true }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            finalizerHeldLock =
              (await readOwnershipLock(path.join(stateDir, "backend.lock"))) !== undefined;
          }),
        );
        ready();
        return yield* Effect.never;
      }).pipe(Effect.scoped),
    );
    const abort = new AbortController();
    let running: Promise<void> | undefined;
    try {
      const { runServer, makeServerLayer } = await import("../server");
      expect(wiring.launch).toHaveBeenCalledWith(makeServerLayer);
      running = Effect.runPromise(
        runServer.pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), directory).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
        { signal: abort.signal },
      );
      await Promise.race([started, running]);
      const record = await readOwnershipLock(path.join(stateDir, "backend.lock"));
      expect(record?.control).toBeDefined();
      if (!record?.control)
        throw new Error("production wrapper did not provide ownership shutdown");
      const identity = ownershipIdentity(record, stateDir);
      expect(
        await requestOwnershipControl(record.control, {
          version: 1,
          action: "prepare",
          operation: "a".repeat(32),
          identity,
        }),
      ).toBe("prepared");
      await requestOwnershipControl(record.control, {
        version: 1,
        action: "commit",
        operation: "b".repeat(32),
        identity,
      }).catch(() => undefined);
      await running;
      expect(finalizerHeldLock).toBe(true);
      expect(await readOwnershipLock(path.join(stateDir, "backend.lock"))).toBeUndefined();
    } finally {
      abort.abort();
      await running?.catch(() => undefined);
      input.destroy();
      output.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
