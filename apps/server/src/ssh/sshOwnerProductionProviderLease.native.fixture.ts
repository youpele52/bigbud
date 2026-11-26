import { execFileSync } from "node:child_process";

import type { ExternalV2Target } from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";

/**
 * W2 T-prov live helpers: a direct `ssh` to the disposable external target (test setup and
 * observation only, never a product path) and local process observation for the owner-crash
 * proof.
 *
 * @module sshOwnerProductionProviderLease.native.fixture
 */

export function remoteShell(target: ExternalV2Target, script: string): string {
  return execFileSync(
    "/usr/bin/ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `UserKnownHostsFile=${target.knownHostsFile}`,
      "-o",
      "StrictHostKeyChecking=yes",
      "-i",
      target.identityFile,
      "-p",
      String(target.port),
      `${target.user}@${target.host}`,
      script,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
}

/** Local processes whose command line contains `needle` (excluding this query). */
export function localProcesses(needle: string): ReadonlyArray<{ pid: number; ppid: number }> {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(needle) && !line.includes("/bin/ps"))
    .map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number);
      return { pid: pid!, ppid: ppid! };
    });
}

export async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}
