import { promises as fs } from "node:fs";
import path from "node:path";

import { assertPrivateOwnership } from "../../remote-backend/privatePermission.ts";
import { randomPasteBaseName } from "./Manager.pasteStaging.names.ts";

export const LOCAL_PASTE_TTL_MS = 24 * 60 * 60 * 1000;
export const LOCAL_PASTE_TOTAL_BYTES = 512 * 1024 * 1024;

export interface PasteUploadSink {
  readonly write: (chunk: Uint8Array) => Promise<void>;
  /** Finalizes the upload and resolves to the staged file's absolute path. */
  readonly commit: () => Promise<string>;
  readonly abort: () => Promise<void>;
}

/**
 * Owner-private staging on the server host: a 0700 folder of 0600 files with random names.
 * Partial uploads are written beside their final name and renamed only after verification.
 */
export class LocalPasteStore {
  private resolvedRoot: string | null = null;

  constructor(
    private readonly root: string,
    private readonly limits = { ttlMs: LOCAL_PASTE_TTL_MS, totalBytes: LOCAL_PASTE_TOTAL_BYTES },
  ) {}

  /** Creates (or tightens) the private folder and resolves its real absolute path. */
  async ensureRoot(): Promise<string> {
    if (this.resolvedRoot) return this.resolvedRoot;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const link = await fs.lstat(this.root);
    if (link.isSymbolicLink() || !link.isDirectory())
      throw new Error("The terminal paste folder is not a private directory.");
    if (process.platform !== "win32") {
      await fs.chmod(this.root, 0o700);
      assertPrivateOwnership(await fs.stat(this.root, { bigint: true }), {
        kind: "directory",
        path: this.root,
        allowedModes: [0o700],
        message: "The terminal paste folder is not owned by this account.",
      });
    }
    this.resolvedRoot = await fs.realpath(this.root);
    return this.resolvedRoot;
  }

  async begin(extension: string, byteLength: number): Promise<PasteUploadSink> {
    const root = await this.ensureRoot();
    await this.enforceTotal(byteLength);
    const finalPath = path.join(root, `${randomPasteBaseName()}.${extension}`);
    const partialPath = `${finalPath}.partial`;
    const handle = await fs.open(partialPath, "wx", 0o600);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    };
    return {
      write: async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset);
          offset += bytesWritten;
        }
      },
      commit: async () => {
        await handle.sync();
        await close();
        // `link` refuses an existing name, so a staged file is never replaced.
        await fs.link(partialPath, finalPath);
        await fs.unlink(partialPath);
        return finalPath;
      },
      abort: async () => {
        await close().catch(() => undefined);
        await fs.rm(partialPath, { force: true });
      },
    };
  }

  /** Removes staged files; paths outside the private folder are ignored. */
  async remove(paths: ReadonlyArray<string>): Promise<void> {
    const root = this.resolvedRoot;
    if (!root) return;
    await Promise.all(
      paths
        .filter((file) => path.dirname(file) === root)
        .map((file) => fs.rm(file, { force: true })),
    );
  }

  /** Startup/periodic safety net: TTL first, then the oldest files over the total cap. */
  async sweep(now = Date.now()): Promise<number> {
    const entries = await this.list();
    let removed = 0;
    for (const entry of entries) {
      if (now - entry.mtimeMs <= this.limits.ttlMs) continue;
      await fs.rm(entry.path, { force: true });
      removed++;
    }
    return removed + (await this.enforceTotal(0));
  }

  private async enforceTotal(incoming: number): Promise<number> {
    const all = await this.list();
    let total = all.reduce((sum, entry) => sum + entry.size, 0) + incoming;
    // In-progress uploads are never evicted; only the TTL sweep removes abandoned ones.
    const entries = all
      .filter((entry) => !entry.path.endsWith(".partial"))
      .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
    let removed = 0;
    for (const entry of entries) {
      if (total <= this.limits.totalBytes) break;
      await fs.rm(entry.path, { force: true });
      total -= entry.size;
      removed++;
    }
    return removed;
  }

  private async list() {
    const root = await this.ensureRoot();
    const names = await fs.readdir(root);
    const entries = await Promise.all(
      names
        .filter((name) => name.startsWith("paste-"))
        .map(async (name) => {
          const file = path.join(root, name);
          const stat = await fs.lstat(file).catch(() => null);
          return stat?.isFile() ? { path: file, size: stat.size, mtimeMs: stat.mtimeMs } : null;
        }),
    );
    return entries.filter((entry) => entry !== null);
  }
}
