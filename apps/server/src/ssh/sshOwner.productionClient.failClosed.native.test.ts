import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it, vi } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import { makeProductionFixture } from "./sshOwnerProductionClient.fixture.ts";

// The first owner frame after the handshake is rejected as malformed, exactly as a
// decoder protocol error would be, so the session fails closed on the REAL owner.
const injected = vi.hoisted(() => ({ armed: false }));
vi.mock("./sshOwnerPickerProof.codec.decode.ts", async (original) => {
  const actual = await original<typeof import("./sshOwnerPickerProof.codec.decode.ts")>();
  return {
    ...actual,
    decodeOwnerFrame: (bytes: Uint8Array) => {
      if (injected.armed) {
        injected.armed = false;
        throw new Error("injected malformed frame");
      }
      return actual.decodeOwnerFrame(bytes);
    },
  };
});

const owner = fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url));
const ownersUnder = (root: string) => {
  try {
    return execFileSync("pgrep", ["-f", root], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it.skipIf(!existsSync(owner) || process.platform === "win32")(
  "reaps the real production owner when its session fails closed",
  async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const facts = resolveSshOwnerLaunchFacts({ stateDirectory: fixture.stateDirectory });
    const layer = makeSqlitePersistenceLive(join(fixture.root, "state.sqlite"), {
      worker: false,
    }).pipe(Layer.provide(NodeServices.layer));
    const result = await Effect.runPromise(
      Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
        Effect.gen(function* () {
          const handle = yield* startOrAttachSshOwnerProduction({
            artifact: fixture.artifact(owner),
            facts,
            sql,
          });
          const running = ownersUnder(fixture.root);
          injected.armed = true;
          const error = yield* Effect.promise(() =>
            handle
              .target(fixture.profile.target!)
              .inspectTrust()
              .then(
                () => undefined,
                (cause: unknown) => cause,
              ),
          );
          const failed = handle.state();
          // Exactly the live fixtures' shape: a rejected run, then ensuring(shutdown).
          const rejected = yield* Effect.promise(() => Promise.reject(error)).pipe(
            Effect.ensuring(handle.shutdown()),
            Effect.exit,
          );
          return { running, error, failed, rejected: rejected._tag };
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(result.running).not.toBe("");
    expect(result.error).toBeDefined();
    expect(result.error).toMatchObject({ code: "protocolError" });
    expect(result.failed).toBe("dead");
    expect(result.rejected).toBe("Failure");
    expect(ownersUnder(fixture.root)).toBe("");
  },
  60_000,
);

it.skipIf(!existsSync(owner) || process.platform === "win32")(
  "a failed-closed desktop-dev owner retires through its launcher-lifetime socket",
  async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const facts = resolveSshOwnerLaunchFacts({ stateDirectory: fixture.stateDirectory });
    const layer = makeSqlitePersistenceLive(join(fixture.root, "state.sqlite"), {
      worker: false,
    }).pipe(Layer.provide(NodeServices.layer));
    // An interrupted run: the session fails closed and nothing calls shutdown.
    // Failing closed releases FD 3, so the owner retires on its own.
    const running = await Effect.runPromise(
      Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
        Effect.gen(function* () {
          const handle = yield* startOrAttachSshOwnerProduction({
            artifact: fixture.artifact(owner),
            facts,
            sql,
          });
          const before = ownersUnder(fixture.root);
          injected.armed = true;
          yield* Effect.promise(() =>
            handle
              .target(fixture.profile.target!)
              .inspectTrust()
              .catch(() => undefined),
          );
          return before;
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(running).not.toBe("");
    const deadline = Date.now() + 5_000;
    while (ownersUnder(fixture.root) !== "" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ownersUnder(fixture.root)).toBe("");
  },
  60_000,
);
