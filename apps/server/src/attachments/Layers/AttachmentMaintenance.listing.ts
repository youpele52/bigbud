/**
 * The attachments root listing a tick works from: every name, the managed files in name order
 * and the files grouped by attachment ID.
 *
 * Listing, parsing and sorting a large root on the event loop is not bounded by the tick budget,
 * so the result is reused while the root directory is unchanged. Adding, removing or renaming
 * an entry changes the directory's mtime (or ctime), so a reused listing is never missing a
 * name a fresh `readdir` would return, except within the filesystem's timestamp granularity:
 * a listing taken within 2 seconds of the directory's last change is never reused. Every step
 * still `lstat`s each file before acting on it.
 *
 * @module AttachmentMaintenance.listing
 */
import * as nodeFs from "node:fs/promises";

import { managedAttachmentIdFromFileName } from "../attachmentMaintenance.layout.ts";
import { compareNames, lstatIfPresent } from "./AttachmentMaintenance.fs.ts";
import type { ManagedAttachmentFile } from "./AttachmentMaintenance.holds.ts";

/** Coarsest directory timestamp granularity in use (FAT keeps 2 seconds). */
const RACY_LISTING_NS = 2_000_000_000n;

export interface AttachmentRootListing {
  readonly names: ReadonlyArray<string>;
  readonly files: ReadonlyArray<ManagedAttachmentFile>;
  readonly filesById: ReadonlyMap<string, ReadonlyArray<string>>;
}

export function listManagedAttachmentFiles(
  names: ReadonlyArray<string>,
): Array<ManagedAttachmentFile> {
  return names
    .flatMap((fileName) => {
      const attachmentId = managedAttachmentIdFromFileName(fileName);
      return attachmentId ? [{ attachmentId, fileName }] : [];
    })
    .toSorted((left, right) => compareNames(left.fileName, right.fileName));
}

function groupById(files: ReadonlyArray<ManagedAttachmentFile>) {
  const byId = new Map<string, Array<string>>();
  for (const file of files) {
    const names = byId.get(file.attachmentId);
    if (names) names.push(file.fileName);
    else byId.set(file.attachmentId, [file.fileName]);
  }
  return byId;
}

interface CachedListing {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly listing: AttachmentRootListing;
}

/** Reads the root through a cache owned by one maintenance instance. */
export function makeAttachmentRootLister() {
  let cached: CachedListing | null = null;
  let reads = 0;
  const read = async (root: string): Promise<"missing" | "invalid" | AttachmentRootListing> => {
    const stats = await lstatIfPresent(root);
    if (!stats) return "missing";
    if (!stats.isDirectory() || stats.isSymbolicLink()) return "invalid";
    if (
      cached !== null &&
      cached.dev === stats.dev &&
      cached.ino === stats.ino &&
      cached.mtimeNs === stats.mtimeNs &&
      cached.ctimeNs === stats.ctimeNs
    ) {
      return cached.listing;
    }
    const listedAtNs = BigInt(Date.now()) * 1_000_000n;
    let names: Array<string>;
    try {
      names = await nodeFs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "missing";
      throw error;
    }
    reads += 1;
    const files = listManagedAttachmentFiles(names);
    const listing = { names, files, filesById: groupById(files) };
    const changedAtNs = stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs;
    cached =
      listedAtNs - changedAtNs >= RACY_LISTING_NS
        ? {
            dev: stats.dev,
            ino: stats.ino,
            mtimeNs: stats.mtimeNs,
            ctimeNs: stats.ctimeNs,
            listing,
          }
        : null;
    return listing;
  };
  return { read, readCount: () => reads };
}
