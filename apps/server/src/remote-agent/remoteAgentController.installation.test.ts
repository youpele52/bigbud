import { spawn } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveLocalHostIdentity } from "@bigbud/shared/machineIdentity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { processStartToken } from "../utils/processStartToken.ts";

// A host without a platform machine id (a container): only the installation fallback remains.
const host = vi.hoisted(() => ({ baseDir: "", hostname: "container-1" }));
vi.mock("../utils/machineIdentity.ts", () => ({
  localHostIdentity: () =>
    resolveLocalHostIdentity({
      machine: () => null,
      baseDir: host.baseDir,
      hostname: () => host.hostname,
    }),
}));

const homes: string[] = [];
function home(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-ctl-")));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh module instance stands in for a backend start. */
async function startBackend(baseDir: string, hostname = "container-1") {
  host.baseDir = baseDir;
  host.hostname = hostname;
  vi.resetModules();
  return import("./remoteAgentController.ts");
}

/** An earlier controller that was `kill -9`ed: its process is gone. */
async function deadEarlierController(
  backend: Awaited<ReturnType<typeof startBackend>>,
): Promise<{ id: string; pid: number; startedAt: string }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const pid = child.pid!;
  const startedAt = processStartToken(pid)!;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  const id = backend
    .currentRemoteAgentController()
    .id.replace(/:[0-9]+:[^:]+$/, `:${pid}:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);
  return { id, pid, startedAt };
}

const scopeOf = (id: string) => id.split(":")[1];

describe.skipIf(process.platform === "win32")("controller scope without a machine id", () => {
  it("recognises a dead earlier controller with the same installation id after a restart", async () => {
    const dir = home();
    const earlier = await startBackend(dir);
    expect(earlier.remoteAgentControllerScopeIssue()).toBeUndefined();
    const dead = await deadEarlierController(earlier);

    const restarted = await startBackend(dir);
    expect(scopeOf(restarted.currentRemoteAgentController().id)).toBe(scopeOf(dead.id));
    expect(scopeOf(dead.id)).toMatch(/^[a-f0-9]{64}$/);
    expect(await restarted.isRemoteAgentControllerAlive(dead)).toBe(false);
  });

  it.each([
    ["another installation", () => home(), "container-1"],
    ["another host sharing the home", undefined, "container-2"],
  ])("still fails closed for %s", async (_name, otherHome, otherHost) => {
    const dir = home();
    const dead = await deadEarlierController(await startBackend(dir));
    const other = await startBackend(otherHome?.() ?? dir, otherHost);
    expect(scopeOf(other.currentRemoteAgentController().id)).not.toBe(scopeOf(dead.id));
    expect(await other.isRemoteAgentControllerAlive(dead)).toBe(true);
  });

  it("refuses a corrupt installation id with a clear reason instead of minting one", async () => {
    const dir = home();
    const file = path.join(dir, "identity", "installation-v1");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "corrupt\n", { mode: 0o600 });
    const backend = await startBackend(dir);
    expect(backend.currentRemoteAgentController().id).toMatch(/^controller-v2:unknown:/);
    expect(backend.remoteAgentControllerScopeIssue()).toContain(`${file} is corrupt`);
    expect(fs.readFileSync(file, "utf8")).toBe("corrupt\n");
  });
});
