import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import type { SshOwnerProfile } from "./sshOwnerProductionArtifact.ts";
import { makeProductionFixture } from "./sshOwnerProductionClient.fixture.ts";

/**
 * Decision (b): a non-surviving owner (`desktop-dev`) is tied to its launcher through the
 * FD 3 lifetime socket. Killing the launcher with SIGKILL (no shutdown, no cleanup code)
 * retires the owner within a bound; a surviving owner (`desktop-packaged`) is unchanged
 * and outlives its launcher until it is reattached or reaped.
 */
const owner = fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url));
const launcher = fileURLToPath(
  new URL("./sshOwner.productionClient.launcherLifetime.launcher.ts", import.meta.url),
);
const RETIRE_BOUND_MS = 5_000;

const ownersUnder = (root: string) => {
  try {
    return execFileSync("pgrep", ["-f", "--", `--state-dir ${root}/`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function launchAndKill(kind: SshOwnerProfile) {
  const fixture = await makeProductionFixture();
  cleanup.push(fixture.dispose);
  // Bun runs the TypeScript launcher directly (the checkout's extensionless imports).
  const child = spawn("bun", ["run", launcher, fixture.root, owner, kind], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`launcher exited early (${code})`)));
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) resolve();
    });
  });
  const before = ownersUnder(fixture.root);
  child.removeAllListeners("exit");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  const killedAt = Date.now();
  while (ownersUnder(fixture.root) !== "" && Date.now() - killedAt < RETIRE_BOUND_MS)
    await new Promise((resolve) => setTimeout(resolve, 25));
  return { before, after: ownersUnder(fixture.root), retiredMs: Date.now() - killedAt, fixture };
}

it.skipIf(!existsSync(owner) || process.platform === "win32")(
  "killing the launcher retires a desktop-dev owner within the bound",
  async () => {
    const result = await launchAndKill("desktop-dev");
    console.log(`launcher-lifetime desktop-dev retired ms=${result.retiredMs}`);
    expect(result.before).not.toBe("");
    expect(result.after).toBe("");
    expect(result.retiredMs).toBeLessThan(RETIRE_BOUND_MS);
  },
  60_000,
);

it.skipIf(!existsSync(owner) || process.platform === "win32")(
  "a desktop-packaged owner still survives its launcher, and fixture disposal reaps it",
  async () => {
    const result = await launchAndKill("desktop-packaged");
    expect(result.before).not.toBe("");
    expect(result.after).toBe(result.before);
    await result.fixture.dispose();
    expect(ownersUnder(result.fixture.root)).toBe("");
  },
  60_000,
);
