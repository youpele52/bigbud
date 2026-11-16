import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLocalSupervisorServiceDirectory as directory,
  readLocalSupervisorServiceFile as read,
} from "./localSupervisorService.files.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/bb-sfile-"));
  roots.push(root);
  const path = join(root, "config");
  await fs.writeFile(path, "private", { mode: 0o600 });
  return { root, path };
}

describe("private account service file snapshots", () => {
  it("reads only bounded canonical owner600 single-link regular UTF8 files", async () => {
    const f = await fixture();
    expect(await read(f.path, 7)).toBe("private");
    await expect(read(f.path, 6)).rejects.toThrow("bounded");
    await fs.chmod(f.path, 0o644);
    await expect(read(f.path, 7)).rejects.toThrow("private");
    await fs.chmod(f.path, 0o600);
    await fs.link(f.path, `${f.path}.hard`);
    await expect(read(f.path, 7)).rejects.toThrow("single");
  });
  it("rejects linked, empty and malformed text without following or repairing it", async () => {
    const f = await fixture();
    await fs.symlink(f.path, `${f.path}.link`);
    await expect(read(`${f.path}.link`, 20)).rejects.toThrow("links");
    await fs.writeFile(f.path, new Uint8Array([255]));
    await expect(read(f.path, 20)).rejects.toThrow();
    await fs.writeFile(f.path, "");
    await expect(read(f.path, 20)).rejects.toThrow("bounded");
  });
  it("allows only explicit safe owned directory modes and never chmods existing data", async () => {
    const f = await fixture();
    await expect(directory(f.root)).resolves.toBeUndefined();
    await fs.chmod(f.root, 0o755);
    await expect(directory(f.root)).rejects.toThrow();
    await expect(directory(f.root, [0o700, 0o755])).resolves.toBeUndefined();
    await expect(directory(f.root, [0o777])).rejects.toThrow();
    expect((await fs.stat(f.root)).mode & 0o7777).toBe(0o755);
  });
});
