import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { assertLocalSupervisorServiceDirectory } from "./localSupervisorService.files.ts";
export async function syncServiceDirectory(path: string) {
  const directory = await fs.open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function createServiceNamespace(root: string, checkpoint: () => Promise<void>) {
  const parent = dirname(root);
  await checkpoint();
  try {
    await fs.mkdir(parent, { mode: 0o700 });
    await syncServiceDirectory(dirname(parent));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  await assertLocalSupervisorServiceDirectory(parent);
  await checkpoint();
  await fs.mkdir(root, { mode: 0o700 });
  await syncServiceDirectory(parent);
}
/** Complete file is linked atomically without replacement. Any ambiguous publication is preserved. */
export async function publishServiceFile(
  path: string,
  raw: string,
  checkpoint: () => Promise<void>,
) {
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024)
    throw new Error("Service publication exceeds the bounded file policy.");
  const parent = dirname(path);
  await assertLocalSupervisorServiceDirectory(parent);
  await checkpoint();
  const before = await fs.lstat(parent, { bigint: true });
  const temporary = join(parent, `.setup-${randomUUID()}.tmp`);
  const file = await fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(raw);
    await file.sync();
    const owned = await file.stat({ bigint: true });
    const named = await fs.lstat(temporary, { bigint: true });
    if (!named.isFile() || named.dev !== owned.dev || named.ino !== owned.ino || named.nlink !== 1n)
      throw new Error("Service publication temporary changed; preserve it.");
    await checkpoint();
    const current = await fs.lstat(parent, { bigint: true });
    if (current.dev !== before.dev || current.ino !== before.ino)
      throw new Error("Service publication directory changed; preserve it.");
    await fs.link(temporary, path);
    const published = await fs.lstat(path, { bigint: true });
    const original = await fs.lstat(temporary, { bigint: true });
    if (
      published.dev !== owned.dev ||
      published.ino !== owned.ino ||
      original.dev !== owned.dev ||
      original.ino !== owned.ino
    )
      throw new Error("Service publication identity changed; preserve both names.");
    await fs.unlink(temporary);
    await syncServiceDirectory(parent);
  } finally {
    await file.close();
  }
}
