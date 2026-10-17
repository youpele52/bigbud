import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, opendir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { V2CodingFileResult } from "./Coding.files.ts";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";

/** Private app storage, never workspace tool paths. An intent is not permission to retry a write. */
export class V2CodingReceipts {
  private static readonly reservations = new Map<string, Promise<void>>();
  private constructor(private readonly directory: string) {}
  static async open(profile: string) {
    const directory = path.join(profile, "bigbud-coding-receipts");
    await mkdir(directory, { mode: 0o700, recursive: true });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw new Error("V2 coding receipts must be private.");
    if (process.platform === "win32") await inspectPrivateV2Profile(directory, { marker: false });
    return new V2CodingReceipts(await realpath(directory));
  }
  /** The application owns this profile; all in-process handles share one bounded admission queue. */
  private async reserve(key: string, fingerprint: string) {
    const prior = V2CodingReceipts.reservations.get(this.directory) ?? Promise.resolve();
    const pending = prior.then(() => this.reserveExclusive(key, fingerprint));
    const settled = pending.then(
      () => {},
      () => {},
    );
    V2CodingReceipts.reservations.set(this.directory, settled);
    try {
      return await pending;
    } finally {
      if (V2CodingReceipts.reservations.get(this.directory) === settled)
        V2CodingReceipts.reservations.delete(this.directory);
    }
  }
  private async reserveExclusive(key: string, fingerprint: string) {
    const replay = await this.find(key, fingerprint);
    if (replay) return replay;
    let count = 0;
    for await (const _entry of await opendir(this.directory)) {
      if (++count >= 4000)
        throw new Error("V2 coding durable receipt capacity reached; history retained.");
    }
    const filename = path.join(this.directory, createHash("sha256").update(key).digest("hex"));
    let handle;
    try {
      handle = await open(
        filename,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const result = await this.find(key, fingerprint);
      if (!result)
        throw new Error("V2 coding receipt disappeared; no automatic re-execution.", {
          cause: error,
        });
      return result;
    }
    try {
      await handle.writeFile(JSON.stringify({ fingerprint }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return undefined;
  }
  async run(key: string, fingerprint: string, operation: () => Promise<V2CodingFileResult>) {
    const replay = await this.reserve(key, fingerprint);
    if (replay) return replay;
    const filename = path.join(this.directory, createHash("sha256").update(key).digest("hex"));
    const result = await operation();
    const temporary = `${filename}.${randomUUID()}`;
    const completed = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await completed.writeFile(JSON.stringify({ fingerprint, result }));
      await completed.sync();
    } finally {
      await completed.close();
    }
    await rename(temporary, filename);
    const parent = await open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return result;
  }
  async find(key: string, fingerprint: string): Promise<V2CodingFileResult | undefined> {
    const filename = path.join(this.directory, createHash("sha256").update(key).digest("hex"));
    let existing;
    try {
      existing = await open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = await existing.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1_000_000)
        throw new Error("V2 coding receipt invalid.");
      const record = JSON.parse(await existing.readFile("utf8")) as {
        fingerprint: string;
        result?: V2CodingFileResult;
      };
      if (record.fingerprint !== fingerprint || !record.result)
        throw new Error(
          "V2 coding action outcome unconfirmed or changed; no automatic re-execution.",
        );
      return record.result;
    } finally {
      await existing.close();
    }
  }
}
