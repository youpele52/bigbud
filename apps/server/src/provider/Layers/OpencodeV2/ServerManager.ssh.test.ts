import { spawn } from "node:child_process";
import { mkdtemp, chmod, copyFile, realpath, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { makeOwnedClient } from "./Client.ts";
import { closeOwnedChild } from "./ServerManager.child.ts";
import { v2SshBootstrapInvocation } from "./ServerManager.ssh.ts";

it("keeps secret payload out of SSH argv and requires strict host-key checking", async () => {
  const invocation = await v2SshBootstrapInvocation(
    "ssh:host=synthetic.invalid&user=fixture&auth=ssh-key",
  );
  expect(invocation.args).toContain("StrictHostKeyChecking=yes");
  expect(invocation.args.join(" ")).not.toContain("disposable-secret");
  expect(invocation.args.at(-1)).toContain("node");
  // Invocation construction only: this test never connects to a host or reads an SSH key.
});

it.skipIf(process.platform === "win32")(
  "runs the fixed protected bootstrap locally against a disposable child fixture",
  async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "bigbud-v2-stdin-bootstrap-")),
    );
    const binaryPath = path.join(root, "opencode-fixture.mjs");
    await copyFile(
      fileURLToPath(new URL("./ServerManager.fixture.mjs", import.meta.url)),
      binaryPath,
    );
    await chmod(binaryPath, 0o700);
    await writeFile(
      path.join(root, ".bigbud-opencode-v2-development"),
      "bigbud-opencode-v2-disposable-v1\n",
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./ServerManager.ssh.bootstrap.mjs", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stderr.resume();
    const password = "a".repeat(43);
    try {
      const ready = new Promise<{ url: string; pid: number }>((resolve, reject) => {
        let output = "";
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Bootstrap exited before readiness.")));
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          const end = output.indexOf("\n");
          if (end >= 0) resolve(JSON.parse(output.slice(0, end)));
        });
      });
      child.stdin.write(JSON.stringify({ binaryPath, profileRoot: root, password }) + "\n");
      const endpoint = await ready;
      const client = makeOwnedClient({ endpoint: endpoint.url, password });
      const info = await client.server.info();
      expect(info.pid).toBe(endpoint.pid);
      expect(info.version).toBe("2.0.19");
      expect(endpoint.url).not.toContain(password);
      await closeOwnedChild(child);
      expect(await readFile(path.join(root, "synthetic-history"), "utf8")).toBe("retained");
    } finally {
      await closeOwnedChild(child);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
