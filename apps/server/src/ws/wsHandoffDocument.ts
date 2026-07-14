import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Data, Effect } from "effect";

const HANDOFF_TMP_DIR = path.join(homedir(), ".bigbud", "skills", "handoff", "tmp");
export const HANDOFF_DOCUMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_SCOPE = "handoff-document";

class HandoffDocumentCleanupError extends Data.TaggedError("HandoffDocumentCleanupError")<{
  readonly cause: unknown;
}> {}

function logCleanupWarning(message: string, context: Record<string, unknown>) {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function slugifyHandoffTitle(value: string | undefined): string {
  const base = (value ?? "handoff")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base.length > 0 ? base : "handoff";
}

export async function writeHandoffDocumentFile(input: {
  readonly title?: string | undefined;
  readonly content: string;
}): Promise<string> {
  await mkdir(HANDOFF_TMP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const suffix = crypto.randomUUID().slice(0, 8);
  const fileName = `${stamp}-${slugifyHandoffTitle(input.title)}-${suffix}.md`;
  const filePath = path.join(HANDOFF_TMP_DIR, fileName);
  await writeFile(filePath, `${input.content.trim()}\n`, "utf8");
  return filePath;
}

export const cleanupHandoffDocumentFiles = Effect.fn("cleanupHandoffDocumentFiles")(
  function* (options?: {
    readonly directory?: string;
    readonly maxAgeMs?: number;
    readonly now?: Date;
  }) {
    const directory = options?.directory ?? HANDOFF_TMP_DIR;
    const maxAgeMs = options?.maxAgeMs ?? HANDOFF_DOCUMENT_RETENTION_MS;
    const nowMs = options?.now?.getTime() ?? Date.now();
    const directoryEntries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => new HandoffDocumentCleanupError({ cause }),
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (entries) => ({ ok: true as const, entries }),
      }),
    );

    if (!directoryEntries.ok) {
      if (!isMissingDirectoryError(directoryEntries.error.cause)) {
        yield* logCleanupWarning("failed to read handoff directory for cleanup", {
          directory,
          error: directoryEntries.error.cause,
        });
      }
      return;
    }

    for (const entry of directoryEntries.entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
        continue;
      }

      const entryPath = path.join(directory, entry.name);
      const entryStat = yield* Effect.tryPromise({
        try: () => stat(entryPath),
        catch: (cause) => new HandoffDocumentCleanupError({ cause }),
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (fileStat) => ({ ok: true as const, fileStat }),
        }),
      );
      if (!entryStat.ok) {
        yield* logCleanupWarning("failed to stat handoff document during cleanup", {
          entryPath,
          error: entryStat.error.cause,
        });
        continue;
      }
      if (!entryStat.fileStat.isFile() || nowMs - entryStat.fileStat.mtimeMs <= maxAgeMs) {
        continue;
      }

      const removal = yield* Effect.tryPromise({
        try: () => rm(entryPath, { force: true }),
        catch: (cause) => new HandoffDocumentCleanupError({ cause }),
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: () => ({ ok: true as const }),
        }),
      );
      if (!removal.ok) {
        yield* logCleanupWarning("failed to remove expired handoff document", {
          entryPath,
          error: removal.error.cause,
        });
      }
    }
  },
);
