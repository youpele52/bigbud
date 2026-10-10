import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  copyFile,
  chmod,
  realpath,
  readFile,
  writeFile,
  rm,
  link,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderV2LegacyCodingPlugin } from "./Coding.plugin.legacy.ts";
import { renderV2CodingPlugin } from "./Coding.plugin.ts";
import { renderV2PreviousCodingPlugin } from "./Coding.plugin.previous.ts";
import { v2SshBootstrapProgram } from "./ServerManager.ssh.ts";
import { closeOwnedChild } from "./ServerManager.child.ts";

it.skipIf(process.platform === "win32")(
  "fixed SSH bootstrap upgrades only exact legacy/current residue atomically, rejects marker mutation and inode aliases",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-plugin-upgrade-"))),
      profile = path.join(root, "profile"),
      directory = path.join(profile, "config", "opencode", "plugins"),
      filename = path.join(directory, "bigbud-coding-owned.js"),
      binary = path.join(root, "fixture.mjs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyFile(fileURLToPath(new URL("./ServerManager.fixture.mjs", import.meta.url)), binary);
    await chmod(binary, 0o700);
    await writeFile(
      path.join(profile, ".bigbud-opencode-v2-development"),
      "bigbud-opencode-v2-disposable-v1\n",
      { mode: 0o600 },
    );
    const priorUrl = "http://127.0.0.1:12345/invoke",
      url = "http://127.0.0.1:12346/invoke",
      priorToken = "1".repeat(64),
      token = "2".repeat(64),
      prior = renderV2LegacyCodingPlugin(priorUrl, priorToken),
      source = renderV2CodingPlugin(url, token),
      program = await v2SshBootstrapProgram();
    try {
      for (const template of [
        prior,
        renderV2CodingPlugin(priorUrl, priorToken),
        renderV2PreviousCodingPlugin(priorUrl, priorToken),
        renderV2PreviousCodingPlugin(priorUrl, priorToken) + "\n// impostor",
        prior + "\n// impostor",
        "hardlink",
        "symlink",
      ]) {
        const alias = path.join(root, "alias");
        if (template === "hardlink" || template === "symlink") {
          await writeFile(alias, prior, { mode: 0o600 });
          if (template === "hardlink") await link(alias, filename);
          else await symlink(alias, filename);
        } else await writeFile(filename, template, { mode: 0o600 });
        const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.resume();
        try {
          const exit = once(child, "exit");
          child.stdin.write(
            JSON.stringify({
              binaryPath: binary,
              profileRoot: profile,
              password: "a".repeat(43),
              pluginSource: source,
              previousPluginSource: renderV2LegacyCodingPlugin(url, token),
              previousNativePluginSource: renderV2PreviousCodingPlugin(url, token),
            }) + "\n",
          );
          if (
            [
              prior,
              renderV2CodingPlugin(priorUrl, priorToken),
              renderV2PreviousCodingPlugin(priorUrl, priorToken),
            ].includes(template)
          ) {
            await expect.poll(() => output.includes('"url"'), { timeout: 10000 }).toBe(true);
            expect(await readFile(filename, "utf8")).toBe(source);
            await closeOwnedChild(child);
          } else {
            expect((await exit)[0]).toBe(1);
            expect(output).not.toContain('"url"');
          }
        } finally {
          await closeOwnedChild(child);
          await unlink(filename).catch(() => {});
          await unlink(alias).catch(() => {});
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
