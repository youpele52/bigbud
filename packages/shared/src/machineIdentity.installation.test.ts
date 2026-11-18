import { spawn } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installationIdPath, readOrCreateInstallationId } from "./machineIdentity.installation";

let base: string;
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-install-")));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function mode(target: string): number {
  return fs.lstatSync(target).mode & 0o777;
}

function expectRefused(pattern: RegExp) {
  const result = readOrCreateInstallationId(base);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(pattern);
}

const helper = fileURLToPath(new URL("./machineIdentity.installation.ts", import.meta.url));

/** A separate process, as a backend restart or a concurrent backend would be. */
function readInChild(dir: string): Promise<string> {
  const script = `import { readOrCreateInstallationId } from ${JSON.stringify(helper)}; console.log(JSON.stringify(readOrCreateInstallationId(${JSON.stringify(dir)})));`;
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("error", reject);
    child.once("exit", () => {
      const parsed = JSON.parse(out.trim()) as { ok: boolean; id?: string };
      if (parsed.ok && parsed.id) resolve(parsed.id);
      else reject(new Error(out));
    });
  });
}

describe.skipIf(process.platform === "win32")("readOrCreateInstallationId", () => {
  it("mints 256 random bits once, privately, and leaves no temp file", () => {
    const first = readOrCreateInstallationId(base);
    expect(first.ok && first.id).toMatch(/^[0-9a-f]{64}$/);
    const file = installationIdPath(base);
    expect(mode(path.dirname(file))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe(`${first.ok && first.id}\n`);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["installation-v1"]);
    expect(readOrCreateInstallationId(base)).toEqual(first);
  });

  it("is stable across processes and converges when several create it at once", async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => readInChild(base)));
    expect(new Set(ids).size).toBe(1);
    expect(readOrCreateInstallationId(base)).toEqual({ ok: true, id: ids[0] });
    expect(await readInChild(base)).toBe(ids[0]);
    expect(fs.readdirSync(path.dirname(installationIdPath(base)))).toEqual(["installation-v1"]);
  });

  it.each([
    ["truncated", "abc\n"],
    ["uppercase", `${"A".repeat(64)}\n`],
    ["no newline", "a".repeat(64)],
    ["trailing data", `${"a".repeat(64)}\nextra`],
    ["empty", ""],
  ])("refuses a corrupt file (%s) and never replaces it", (_name, content) => {
    const file = installationIdPath(base);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
    expectRefused(/is corrupt/);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });

  it("refuses a symlinked file without following it", () => {
    const file = installationIdPath(base);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const target = path.join(base, "elsewhere");
    fs.writeFileSync(target, `${"b".repeat(64)}\n`, { mode: 0o600 });
    fs.symlinkSync(target, file);
    expectRefused(/symlink/);
    fs.rmSync(file);
    fs.symlinkSync(path.join(base, "dangling"), file);
    expectRefused(/symlink/);
    expect(fs.existsSync(path.join(base, "dangling"))).toBe(false);
  });

  it("refuses a symlinked identity directory", () => {
    const real = path.join(base, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, path.dirname(installationIdPath(base)));
    expectRefused(/not a real directory/);
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it("refuses group- or world-accessible modes", () => {
    const first = readOrCreateInstallationId(base);
    expect(first.ok).toBe(true);
    const file = installationIdPath(base);
    fs.chmodSync(file, 0o644);
    expectRefused(/mode 0600/);
    fs.chmodSync(file, 0o600);
    fs.chmodSync(path.dirname(file), 0o755);
    expectRefused(/mode 0700/);
  });

  it.skipIf(process.getuid?.() === 0)("refuses an unreadable file instead of minting one", () => {
    const first = readOrCreateInstallationId(base);
    const file = installationIdPath(base);
    fs.chmodSync(file, 0o000);
    expectRefused(/unreadable/);
    fs.chmodSync(file, 0o600);
    expect(readOrCreateInstallationId(base)).toEqual(first);
  });
});
