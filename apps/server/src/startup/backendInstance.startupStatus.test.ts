import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const writeStartupStatus = vi.hoisted(() => vi.fn());
vi.mock("./startupStatus.ts", () => ({ writeStartupStatus }));

import { StateDirLockLive } from "./backendInstance.ts";
import { ServerConfig } from "./config.ts";

let baseDir: string;
let lockPath: string;
beforeEach(async () => {
  writeStartupStatus.mockReset();
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-lock-status-"));
  await fs.mkdir(path.join(baseDir, "userdata"));
  lockPath = path.join(baseDir, "userdata/backend.lock");
});
afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

function buildLockLayer() {
  return Effect.runPromiseExit(
    Effect.scoped(
      Layer.build(
        StateDirLockLive.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}

it.each([
  ["live owner", os.hostname(), "state_directory_in_use"],
  [
    "legacy owner from a different hostname",
    "old-host.invalid",
    "state_directory_owner_unverified",
  ],
])(
  "reports %s before the server layer can bind, without changing its lock",
  async (_label, hostname, reason) => {
    const raw = JSON.stringify({
      format: "bigbud.backend-lock.v1",
      pid: process.pid,
      startedAt: null,
      port: 3773,
      hostname,
      acquiredAt: "2026-10-15T00:00:00.000Z",
      nonce: "existing-owner",
    });
    await fs.writeFile(lockPath, raw);
    expect(Exit.isFailure(await buildLockLayer())).toBe(true);
    expect(writeStartupStatus).toHaveBeenCalledExactlyOnceWith("error", reason);
    expect(await fs.readFile(lockPath, "utf8")).toBe(raw);
  },
);

it("reports unverifiable unreadable ownership without removing the lock", async () => {
  await fs.writeFile(lockPath, "{");
  expect(Exit.isFailure(await buildLockLayer())).toBe(true);
  expect(writeStartupStatus).toHaveBeenCalledExactlyOnceWith(
    "error",
    "state_directory_owner_unverified",
  );
  expect(await fs.readFile(lockPath, "utf8")).toBe("{");
});

it("does not report a permanent ownership failure for ordinary filesystem errors", async () => {
  await fs.rm(path.join(baseDir, "userdata"), { recursive: true });
  await fs.writeFile(path.join(baseDir, "userdata"), "not a directory");
  expect(Exit.isFailure(await buildLockLayer())).toBe(true);
  expect(writeStartupStatus).not.toHaveBeenCalled();
});

it("starts and releases a fresh lock without a failure status", async () => {
  expect(Exit.isSuccess(await buildLockLayer())).toBe(true);
  expect(writeStartupStatus).not.toHaveBeenCalled();
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});
