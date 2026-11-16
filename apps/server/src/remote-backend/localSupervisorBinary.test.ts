import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { verifyManagedLocalSupervisor } from "./localSupervisorBinary.ts";

let root: string;
let runtime: RemoteAgentRuntime;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp("/tmp/bb-lsb-"));
  const bytes = Buffer.from("fixture supervisor bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const statePath = join(root, "runtimes/g1");
  const binaryRoot = join(root, "bin/1.0.0", sha256);
  await fs.mkdir(statePath, { recursive: true, mode: 0o700 });
  await fs.mkdir(binaryRoot, { recursive: true, mode: 0o700 });
  runtime = {
    generation: "g1",
    version: "1.0.0",
    sha256,
    buildDigest: "fixture",
    targetTriple: "aarch64-unknown-linux-gnu",
    origin: "managed",
    statePath,
    binaryPath: join(binaryRoot, "bigbud-remote-agent"),
    socketPath: join(statePath, "supervisor.sock"),
    logPath: join(statePath, "supervisor.log"),
  };
  await fs.writeFile(runtime.binaryPath, bytes, { mode: 0o700 });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")("installed local supervisor verification", () => {
  it("verifies exact pinned bytes without executing the binary", async () => {
    await expect(verifyManagedLocalSupervisor(runtime)).resolves.toBeUndefined();
    expect(await fs.readFile(runtime.binaryPath, "utf8")).toBe("fixture supervisor bytes");
  });

  it("refuses changed bytes and unsafe executable permissions", async () => {
    await fs.writeFile(runtime.binaryPath, "different bytes");
    await expect(verifyManagedLocalSupervisor(runtime)).rejects.toThrow("pinned artifact");
    await fs.chmod(runtime.binaryPath, 0o755);
    await expect(verifyManagedLocalSupervisor(runtime)).rejects.toThrow("unsafe ownership");
  });

  it("refuses public or symlinked runtime directories", async () => {
    await fs.chmod(runtime.statePath, 0o755);
    await expect(verifyManagedLocalSupervisor(runtime)).rejects.toThrow("private directories");
    await fs.chmod(runtime.statePath, 0o700);
    await fs.rename(runtime.statePath, `${runtime.statePath}-real`);
    await fs.symlink(`${runtime.statePath}-real`, runtime.statePath);
    await expect(verifyManagedLocalSupervisor(runtime)).rejects.toThrow("private directories");
  });

  it("refuses binary symlinks and FIFOs without waiting for a writer", async () => {
    await fs.rename(runtime.binaryPath, `${runtime.binaryPath}-real`);
    await fs.symlink(`${runtime.binaryPath}-real`, runtime.binaryPath);
    await expect(verifyManagedLocalSupervisor(runtime)).rejects.toThrow();
    await fs.unlink(runtime.binaryPath);
    execFileSync("mkfifo", ["-m", "700", runtime.binaryPath]);
    await expect(verifyManagedLocalSupervisor(runtime)).rejects.toThrow("unsafe ownership");
  });

  it("refuses external descriptors before touching their filesystem paths", async () => {
    await expect(
      verifyManagedLocalSupervisor({
        ...runtime,
        origin: "legacy-external",
        binaryPath: "/nonexistent/never-open",
      }),
    ).rejects.toThrow("managed local supervisor");
  });
});
