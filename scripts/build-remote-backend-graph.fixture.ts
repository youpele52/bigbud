import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Test-only helpers for private backend graph fixtures. Never used by production code. */
const cleanups: string[] = [];
export async function cleanupGraphFixtures() {
  await Promise.all(cleanups.splice(0).map((p) => rm(p, { recursive: true, force: true })));
}

export async function privateBase(prefix = "bb-graph-") {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(base);
  await chmod(base, 0o700);
  return base;
}

export function elf(machine: number, type = 2) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(type, 16);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

/** Write files (0600, or 0700 for `executable`) under fresh 0700 directories. */
export async function writeTree(
  root: string,
  files: Record<string, string | Buffer>,
  executable: ReadonlyArray<string> = [],
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), body, { mode: executable.includes(path) ? 0o700 : 0o600 });
  }
  async function lock(directory: string): Promise<void> {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await lock(join(directory, entry.name));
  }
  await lock(root);
  return root;
}

export async function signingKey(base: string) {
  const keys = generateKeyPairSync("ed25519");
  const keyFile = join(base, "key.pem");
  await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  return {
    keyFile,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** A fake Node distribution tarball with the official member layout. */
export async function nodeTarball(base: string, name = "node-v24.13.1-linux-arm64") {
  const source = join(base, "tarball-source");
  await writeTree(source, { [`${name}/bin/node`]: elf(183), [`${name}/LICENSE`]: "Node license" }, [
    `${name}/bin/node`,
  ]);
  const archive = join(base, `${name}.tar.xz`);
  const result = spawnSync("tar", ["-cJf", archive, "-C", source, name], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return archive;
}
