import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, chmod, realpath, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { closeOwnedChild } from "./ServerManager.child.ts";
import { v2SshBootstrapInvocation, v2SshBootstrapProgram } from "./ServerManager.ssh.ts";

for (const unsafe of ["root", "config"] as const)
  it.skipIf(process.platform === "win32")(
    `protected bootstrap rejects writable ${unsafe} before version/plugin execution`,
    async () => {
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "v2-bootstrap-permissions-")),
      );
      const config = path.join(root, "config");
      const launched = path.join(root, "launched");
      const binaryPath = path.join(root, "never-launch.mjs");
      await mkdir(config, { mode: 0o700 });
      await writeFile(
        path.join(root, ".bigbud-opencode-v2-development"),
        "bigbud-opencode-v2-disposable-v1\n",
        { mode: 0o600 },
      );
      await writeFile(
        binaryPath,
        `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(launched)}, 'unsafe launch');console.log('2.0.19');`,
        { mode: 0o700 },
      );
      await chmod(unsafe === "root" ? root : config, 0o770);
      // Execute the exact concatenated protected SSH program locally, without contacting a host/key.
      const invocation = await v2SshBootstrapInvocation(
        "ssh:host=synthetic.invalid&user=fixture&auth=ssh-key",
      );
      expect(invocation.args.join(" ")).not.toContain("a".repeat(43));
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", await v2SshBootstrapProgram()],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdout.resume();
      child.stderr.resume();
      try {
        const exit = once(child, "exit");
        child.stdin.write(
          JSON.stringify({ binaryPath, profileRoot: root, password: "a".repeat(43) }) + "\n",
        );
        const [code] = await exit;
        expect(code).toBe(1);
        await expect(readFile(launched)).rejects.toThrow();
      } finally {
        await closeOwnedChild(child);
        await chmod(root, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
    10000,
  );
