import { createHash, randomBytes, sign, verify } from "node:crypto";
import { captureV2OperationAuthority, type V2OperationAuthority } from "./Client.guard.ts";
import { constants } from "node:fs";
import { open, rename, unlink, link } from "node:fs/promises";
import path from "node:path";
import {
  ensureV2ThreadPrivateChild,
  readV2ThreadPrivateFile,
  writeV2ThreadPrivateFile,
  v2ThreadPrivateDirectory,
  listV2ThreadPrivateDirectory,
} from "./Orchestration.storage.ts";
import { lockV2ThreadRecord } from "./Orchestration.records.lock.ts";
import { publishV2WindowsRecord } from "./Orchestration.records.windows.ts";

interface SignedRecord {
  readonly revision: string;
  readonly value: unknown;
  readonly signature: string;
}
const bytes = (record: Pick<SignedRecord, "revision" | "value">) =>
  Buffer.from(JSON.stringify(["bigbud.thread.record.v1", record.revision, record.value]));

/** Signed private app records are evidence, never repaired from native guesses. */
export class V2ThreadRecords {
  private static readonly locks = new Map<string, Promise<unknown>>();
  private constructor(
    readonly directory: string,
    private readonly privateKey: string,
    private readonly publicKey: string,
  ) {}

  static async open(
    root: string,
    name:
      | "enrollments"
      | "receipts"
      | "installations"
      | "retirements"
      | "implementations"
      | "native-family-publications"
      | "recovery"
      | "instances",
    privateKey: string,
    publicKey: string,
  ) {
    return new V2ThreadRecords(await ensureV2ThreadPrivateChild(root, name), privateKey, publicKey);
  }

  private filename(key: string) {
    return path.join(this.directory, createHash("sha256").update(key).digest("hex"));
  }

  /** Same issuer/private namespace, never a new signer or native storage authority. */
  sibling(
    name: "retirements" | "implementations" | "recovery" | "enrollments" | "receipts" | "instances",
  ) {
    return V2ThreadRecords.open(
      path.dirname(this.directory),
      name,
      this.privateKey,
      this.publicKey,
    );
  }

  async read(key: string): Promise<SignedRecord | undefined> {
    return this.readFilename(this.filename(key));
  }

  /** Bounded signed evidence scan; used to avoid native reload/upgrades while enrollment leases live. */
  async entries(): Promise<ReadonlyArray<SignedRecord>> {
    return (await this.inventory()).map((entry) => entry.signed);
  }

  /** Include the durable filename so maintenance evidence cannot be transplanted to another key. */
  async inventory(): Promise<ReadonlyArray<{ name: string; signed: SignedRecord }>> {
    return this.scanInventory(0);
  }

  private async scanInventory(
    attempt: number,
  ): Promise<ReadonlyArray<{ name: string; signed: SignedRecord }>> {
    await v2ThreadPrivateDirectory(this.directory);
    const names = await listV2ThreadPrivateDirectory(this.directory);
    if (names.length > 4096) throw new Error("V2 thread-tools signed inventory exceeds its bound.");
    const partial = names.filter((name) => !/^[a-f0-9]{64}$/.test(name));
    if (partial.length && attempt < 3) {
      const writers = partial.map((name) =>
        /^[a-f0-9]{64}\.[a-f0-9]{32}$/.test(name)
          ? V2ThreadRecords.locks.get(path.join(this.directory, name.slice(0, 64)))
          : undefined,
      );
      // Join only known live writers, then re-read every entry. Never skip staging evidence:
      // abandoned, foreign-process, or forged files still fail the strict scan below.
      if (writers.every((writer) => writer !== undefined)) {
        await Promise.all(writers);
        return this.scanInventory(attempt + 1);
      }
    }
    const records: { name: string; signed: SignedRecord }[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name))
        throw new Error(
          "V2 thread-tools signed inventory has partial/unknown entries; evidence retained.",
        );
      const value = await this.readFilename(path.join(this.directory, name));
      if (!value) throw new Error("V2 thread-tools signed inventory changed during scan.");
      records.push({ name, signed: value });
    }
    return records;
  }

  private async readFilename(filename: string): Promise<SignedRecord | undefined> {
    let content: string;
    try {
      content = await readV2ThreadPrivateFile(filename);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    const record = JSON.parse(content) as SignedRecord;
    if (
      !record ||
      Object.keys(record).toSorted().join() !== "revision,signature,value" ||
      typeof record.revision !== "string" ||
      !/^[a-f0-9]{32}$/.test(record.revision) ||
      typeof record.signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(record.signature) ||
      !verify(null, bytes(record), this.publicKey, Buffer.from(record.signature, "base64url"))
    )
      throw new Error("V2 thread-tools signed record rejected; evidence retained.");
    return record;
  }

  /** Conditional replacement cannot let old cleanup overwrite a successor record instance. */
  async replace(
    key: string,
    expected: string | undefined,
    value: unknown,
    extra?: V2OperationAuthority,
  ): Promise<string> {
    const authority = captureV2OperationAuthority(extra);
    authority.assertCurrent();
    const filename = this.filename(key);
    if (V2ThreadRecords.locks.has(filename)) throw new Error("V2 thread-tools record update busy.");
    const operation = this.replaceExclusive(key, expected, value, authority);
    V2ThreadRecords.locks.set(filename, operation);
    try {
      return await operation;
    } finally {
      if (V2ThreadRecords.locks.get(filename) === operation) V2ThreadRecords.locks.delete(filename);
    }
  }

  private async replaceExclusive(
    key: string,
    expected: string | undefined,
    value: unknown,
    authority: V2OperationAuthority,
  ) {
    const unlock = await lockV2ThreadRecord(
      this.directory,
      key,
      this.privateKey,
      this.publicKey,
      authority,
    );
    try {
      return await this.replaceLocked(key, expected, value, authority);
    } finally {
      await unlock();
    }
  }

  private async replaceLocked(
    key: string,
    expected: string | undefined,
    value: unknown,
    authority: V2OperationAuthority,
  ) {
    const before = await this.read(key);
    authority.assertCurrent();
    if (before?.revision !== expected)
      throw new Error("V2 thread-tools record successor preserved.");
    const record = { revision: randomBytes(16).toString("hex"), value };
    const content = JSON.stringify({
      ...record,
      signature: sign(null, bytes(record), this.privateKey).toString("base64url"),
    });
    if (Buffer.byteLength(content) > 131072)
      throw new Error("V2 thread-tools record bound exceeded.");
    const filename = this.filename(key);
    if (process.platform === "win32") {
      await publishV2WindowsRecord(filename, before, content, authority);
      if ((await this.read(key))?.revision !== record.revision)
        throw new Error("V2 thread-tools record publication changed.");
      return record.revision;
    }
    if (!before && path.basename(this.directory) === "recovery") {
      const temporary = `${filename}.${record.revision}`;
      await writeV2ThreadPrivateFile(temporary, content, authority);
      try {
        authority.assertCurrent();
        // Exclusive link publishes fully fsynced bytes without replacing a concurrent creator.
        await link(temporary, filename);
      } finally {
        await unlink(temporary);
      }
    } else if (!before) await writeV2ThreadPrivateFile(filename, content, authority);
    else {
      const temporary = `${filename}.${record.revision}`;
      await writeV2ThreadPrivateFile(temporary, content, authority);
      try {
        await v2ThreadPrivateDirectory(this.directory);
        if ((await this.read(key))?.revision !== expected)
          throw new Error("V2 thread-tools record changed during update.");
        authority.assertCurrent();
        await rename(temporary, filename);
      } finally {
        // An expired normal operation retains its private staging evidence. Exact owned
        // lock release and directory durability below finish already-issued work separately.
        let cleanupAllowed = true;
        try {
          authority.assertCurrent();
        } catch {
          cleanupAllowed = false;
        }
        if (cleanupAllowed)
          await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
      }
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
    if ((await this.read(key))?.revision !== record.revision)
      throw new Error("V2 thread-tools record publication changed.");
    return record.revision;
  }
}
