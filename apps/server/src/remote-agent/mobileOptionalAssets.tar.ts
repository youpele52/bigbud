import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  MOBILE_ASSET_MAX_CONTENT_BYTES,
  MOBILE_ASSET_MAX_ENTRIES,
  MOBILE_ASSET_MAX_PAX_BYTES,
  MOBILE_ASSET_MAX_DIRECTORY_DEPTH,
  claimMobileAssetPath,
  validateMobileAssetPath,
} from "@bigbud/shared/mobileOptionalAssets.policy";

export interface MobileAssetTarWriter {
  readonly directory: (path: string) => Promise<void>;
  readonly file: (path: string) => Promise<FileHandle>;
  readonly completedFile: (path: string, info: Stats) => void;
}

function text(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((byte) => byte !== 0))
    throw new Error("Malformed tar string padding.");
  return bytes.subarray(0, end >= 0 ? end : bytes.length).toString("ascii");
}
function octal(bytes: Buffer): number {
  const value = bytes.toString("ascii").replaceAll("\0", " ").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Malformed tar numeric field.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error("Tar number exceeds safe range.");
  return parsed;
}
function paxPath(bytes: Buffer): string {
  if (bytes.some((byte) => byte > 127)) throw new Error("Non-ASCII PAX header.");
  const space = bytes.indexOf(32);
  const length = bytes.subarray(0, space).toString("ascii");
  if (
    space < 1 ||
    !/^[1-9][0-9]*$/.test(length) ||
    Number(length) !== bytes.length ||
    bytes.at(-1) !== 10 ||
    bytes.toString("ascii", space + 1, space + 6) !== "path="
  ) {
    throw new Error("Unsupported or malformed local PAX header.");
  }
  return bytes.toString("ascii", space + 6, bytes.length - 1);
}

/** A streaming subset matching the deterministic producer: files, directories, local PAX path. */
export class MobileAssetTarParser {
  readonly #header = Buffer.alloc(512);
  readonly #paths = new Set<string>();
  readonly #directories = new Set<string>();
  readonly #folded = new Set<string>();
  #headerOffset = 0;
  #remaining = 0;
  #padding = 0;
  #file: FileHandle | null = null;
  #fileSize = 0;
  #fileIdentity = "";
  #pax: Buffer | null = null;
  #paxOffset = 0;
  #pendingPath: string | null = null;
  #zeroBlocks = 0;
  #contentBytes = 0;
  #headers = 0;
  #fileOffset = 0;
  #credentialTail = Buffer.alloc(0);
  #currentPath = "";

  constructor(readonly writer: MobileAssetTarWriter) {}

  async consume(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#remaining > 0) {
        const count = Math.min(this.#remaining, chunk.length - offset);
        const part = chunk.subarray(offset, offset + count);
        if (this.#pax) {
          part.copy(this.#pax, this.#paxOffset);
          this.#paxOffset += count;
        } else if (this.#file) {
          const inspected = Buffer.concat([this.#credentialTail, part]);
          if (
            inspected.includes(Buffer.from("-----BEGIN ")) ||
            inspected.includes(Buffer.from("PRIVATE KEY-----"))
          ) {
            throw new Error("Private key material in mobile assets.");
          }
          this.#credentialTail = Buffer.from(
            inspected.subarray(Math.max(0, inspected.length - 32)),
          );
          let written = 0;
          while (written < part.length) {
            const result = await this.#file.write(
              part,
              written,
              part.length - written,
              this.#fileOffset,
            );
            if (!result.bytesWritten) throw new Error("Asset write made no progress.");
            written += result.bytesWritten;
            this.#fileOffset += result.bytesWritten;
          }
        }
        this.#remaining -= count;
        offset += count;
        if (this.#remaining === 0) await this.#endPayload();
      } else if (this.#padding > 0) {
        const count = Math.min(this.#padding, chunk.length - offset);
        if (chunk.subarray(offset, offset + count).some((byte) => byte !== 0))
          throw new Error("Nonzero tar payload padding.");
        this.#padding -= count;
        offset += count;
      } else {
        const count = Math.min(512 - this.#headerOffset, chunk.length - offset);
        chunk.copy(this.#header, this.#headerOffset, offset, offset + count);
        this.#headerOffset += count;
        offset += count;
        if (this.#headerOffset === 512) {
          this.#headerOffset = 0;
          await this.#startHeader();
        }
      }
    }
  }

  async #endPayload(): Promise<void> {
    if (this.#pax) {
      this.#pendingPath = paxPath(this.#pax);
      this.#pax = null;
    }
    if (this.#file) {
      const info = await this.#file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== this.#fileSize ||
        `${info.dev}:${info.ino}` !== this.#fileIdentity ||
        (info.mode & 0o077) !== 0
      ) {
        throw new Error("Asset destination changed during extraction.");
      }
      await this.#file.close();
      this.#file = null;
      this.writer.completedFile(this.#currentPath, info);
    }
  }

  async #startHeader(): Promise<void> {
    const bytes = this.#header;
    if (bytes.every((byte) => byte === 0)) {
      if (this.#pendingPath !== null) throw new Error("Dangling local PAX header.");
      this.#zeroBlocks += 1;
      return;
    }
    if (
      this.#zeroBlocks > 0 ||
      ++this.#headers > MOBILE_ASSET_MAX_ENTRIES * 2 ||
      bytes.some((byte) => byte > 127)
    ) {
      throw new Error("Trailing members or tar header budget exceeded.");
    }
    const checksum = bytes.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (
      octal(bytes.subarray(148, 156)) !== checksum ||
      text(bytes.subarray(257, 263)) !== "ustar" ||
      bytes.toString("ascii", 263, 265) !== "00" ||
      text(bytes.subarray(157, 257)) ||
      text(bytes.subarray(265, 297)) ||
      text(bytes.subarray(297, 329)) ||
      octal(bytes.subarray(108, 116)) !== 0 ||
      octal(bytes.subarray(116, 124)) !== 0 ||
      bytes.subarray(329, 345).some((byte) => byte !== 0 && byte !== 48) ||
      octal(bytes.subarray(136, 148)) !== 0 ||
      bytes.subarray(500).some((byte) => byte !== 0)
    ) {
      throw new Error("Malformed or unsupported tar header.");
    }
    const size = octal(bytes.subarray(124, 136));
    const type = bytes[156];
    const name = text(bytes.subarray(0, 100));
    const prefix = text(bytes.subarray(345, 500));
    if (type === 120) {
      if (
        this.#pendingPath !== null ||
        name !== "././@PaxHeader" ||
        prefix ||
        size < 1 ||
        size > MOBILE_ASSET_MAX_PAX_BYTES ||
        octal(bytes.subarray(100, 108)) !== 0
      )
        throw new Error("Unsupported local PAX header.");
      this.#pax = Buffer.alloc(size);
      this.#paxOffset = 0;
    } else {
      if (type !== 0 && type !== 48 && type !== 53)
        throw new Error("Links or special tar members forbidden.");
      const directory = type === 53;
      const rawPath = prefix ? `${prefix}/${name}` : name;
      // PAX fallback names are truncated by tar; validate syntax without treating a truncated
      // file extension as the effective path. Only the fully validated effective path is used.
      const fallback = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      if (
        fallback.split("/").length > MOBILE_ASSET_MAX_DIRECTORY_DEPTH + 1 ||
        fallback.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
      )
        throw new Error("Unsafe tar fallback path.");
      const path = validateMobileAssetPath(this.#pendingPath ?? rawPath, directory);
      this.#pendingPath = null;
      if (this.#paths.size >= MOBILE_ASSET_MAX_ENTRIES)
        throw new Error("Excessive mobile asset entries.");
      claimMobileAssetPath(path, directory, this.#folded);
      if (
        (directory && size !== 0) ||
        octal(bytes.subarray(100, 108)) !== (directory ? 0o755 : 0o644)
      ) {
        throw new Error("Unsupported mobile asset mode or directory payload.");
      }
      const parents = path.split("/");
      parents.pop();
      while (parents.length) {
        if (!this.#directories.has(parents.join("/")))
          throw new Error("Missing directory or file ancestor in tar.");
        parents.pop();
      }
      this.#paths.add(path);
      if (directory) {
        await this.writer.directory(path);
        this.#directories.add(path);
      } else {
        this.#contentBytes += size;
        if (this.#contentBytes > MOBILE_ASSET_MAX_CONTENT_BYTES)
          throw new Error("Mobile asset content budget exceeded.");
        this.#file = await this.writer.file(path);
        this.#currentPath = path;
        this.#fileOffset = 0;
        const info = await this.#file.stat();
        this.#fileIdentity = `${info.dev}:${info.ino}`;
        this.#fileSize = size;
        this.#credentialTail = Buffer.alloc(0);
      }
    }
    this.#remaining = size;
    this.#padding = (512 - (size % 512)) % 512;
    if (size === 0) await this.#endPayload();
  }

  finish(): void {
    if (
      this.#remaining ||
      this.#padding ||
      this.#headerOffset ||
      this.#pendingPath !== null ||
      this.#zeroBlocks < 2 ||
      !this.#paths.has("index.html") ||
      this.#directories.has("index.html")
    ) {
      throw new Error("Incomplete mobile assets archive or missing index.html.");
    }
  }
  async close(): Promise<void> {
    await this.#file?.close();
    this.#file = null;
  }
}
