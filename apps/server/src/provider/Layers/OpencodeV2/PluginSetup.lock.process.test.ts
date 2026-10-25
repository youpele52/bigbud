import { fork, spawn } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { mkdir, readFile, lstat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";

async function deadOwnedPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  return child.pid!;
}
function reader(input: object) {
  const child = fork(
    fileURLToPath(new URL("./PluginSetup.lock.process.fixture.mjs", import.meta.url)),
    [],
    {
      execArgv: ["--experimental-transform-types"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const events: Array<{ state: string; role?: string }> = [],
    waiters: Array<() => void> = [];
  child.stderr?.resume();
  child.on("message", (event) => {
    events.push(event as (typeof events)[number]);
    for (const wake of waiters.splice(0)) wake();
  });
  child.send(input);
  const wait = async (states: string[]) => {
    const limit = Date.now() + 15000;
    while (!events.some((event) => states.includes(event.state))) {
      if (child.exitCode !== null || Date.now() >= limit)
        throw new Error("Owned Node lock barrier did not settle.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return events.find((event) => states.includes(event.state))!;
  };
  return {
    child,
    events,
    wait,
    close: async () => {
      if (child.connected) {
        child.send("resume", () => {});
        child.send("release", () => {});
      }
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

it.each(["publisher", "record", "default"] as const)(
  "two actual Node %s writers cannot reclaim an exited owner over a successor",
  async (purpose) => {
    const app = await makeV2ThreadPluginFixture();
    let a: ReturnType<typeof reader> | undefined, b: ReturnType<typeof reader> | undefined;
    try {
      const namespace = path.join(app.artifact.root, "barrier-record"),
        key = "owned";
      const root =
        purpose === "record"
          ? JSON.stringify([namespace, key])
          : purpose === "default"
            ? app.artifact.root
            : app.root;
      const directory =
        purpose === "record"
          ? path.join(
              app.artifact.root,
              "record-locks",
              createHash("sha256").update(root).digest("hex"),
            )
          : path.join(
              app.artifact.root,
              purpose === "default" ? "implementation-locks" : "owned-publication-lock",
            );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = path.join(directory, ".bigbud-thread-tools-managed.lock"),
        pid = await deadOwnedPid(),
        nonce = "a".repeat(32);
      const original = JSON.stringify({
        root,
        issuer: app.artifact.issuer,
        pid,
        nonce,
        signature: sign(
          null,
          Buffer.from(
            JSON.stringify([
              "bigbud.thread.install.lock.v1",
              root,
              app.artifact.issuer,
              pid,
              nonce,
            ]),
          ),
          app.artifact.privateKey,
        ).toString("base64url"),
      });
      await writeFile(filename, original, { mode: 0o600 });
      const config = { directory, filename, root, artifact: app.artifact, purpose };
      a = reader({ ...config, role: "A" });
      const observation = await a.wait(["last-inode-observed", "blocked"]);
      // Explicit fixture-owned handoff outside the reclamation branch. In production no such
      // deletion is automatic: a dead lock stays blocked pending independently safe remediation.
      expect(await readFile(filename, "utf8")).toBe(original);
      await unlink(filename);
      b = reader({ ...config, role: "B" });
      await b.wait(["successor-held"]);
      const successor = { bytes: await readFile(filename), identity: await lstat(filename) };
      if (observation.state === "last-inode-observed") a.child.send("resume");
      await a.wait(["blocked", "complete"]);
      expect(a.events.filter((event) => event.state === "writer-entered")).toHaveLength(0);
      expect(b.events.filter((event) => event.state === "writer-entered")).toHaveLength(1);
      expect(await readFile(filename)).toEqual(successor.bytes);
      expect((await lstat(filename)).ino).toBe(successor.identity.ino);
    } finally {
      await a?.close();
      await b?.close();
      await app.close();
    }
  },
  30000,
);
