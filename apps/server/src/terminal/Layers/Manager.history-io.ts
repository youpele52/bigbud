import path from "node:path";

import { DEFAULT_TERMINAL_ID } from "@bigbud/contracts";
import { Effect, FileSystem } from "effect";

import { TerminalHistoryError } from "../Services/Manager";
import { capHistory } from "./Manager.history";
import { legacySafeThreadId, toSafeTerminalId, toSafeThreadId } from "./Manager.shell";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function historyPath(logsDir: string, threadId: string, terminalId: string): string {
  const threadPart = toSafeThreadId(threadId);
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return path.join(logsDir, `${threadPart}.log`);
  }
  return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
}

export function legacyHistoryPath(logsDir: string, threadId: string): string {
  return path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);
}

const readHistoryEffect = Effect.fn("terminal.readHistory")(function* (
  logsDir: string,
  historyLineLimit: number,
  threadId: string,
  terminalId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const nextPath = historyPath(logsDir, threadId, terminalId);
  const toError = (operation: "read" | "truncate" | "migrate") => (cause: unknown) =>
    new TerminalHistoryError({ operation, threadId, terminalId, cause });

  if (yield* fileSystem.exists(nextPath).pipe(Effect.mapError(toError("read")))) {
    const raw = yield* fileSystem.readFileString(nextPath).pipe(Effect.mapError(toError("read")));
    const capped = capHistory(raw, historyLineLimit);
    if (capped !== raw) {
      yield* fileSystem
        .writeFileString(nextPath, capped)
        .pipe(Effect.mapError(toError("truncate")));
    }
    return capped;
  }

  if (terminalId !== DEFAULT_TERMINAL_ID) {
    return "";
  }

  const legacyPath = legacyHistoryPath(logsDir, threadId);
  if (!(yield* fileSystem.exists(legacyPath).pipe(Effect.mapError(toError("migrate"))))) {
    return "";
  }

  const raw = yield* fileSystem
    .readFileString(legacyPath)
    .pipe(Effect.mapError(toError("migrate")));
  const capped = capHistory(raw, historyLineLimit);
  yield* fileSystem.writeFileString(nextPath, capped).pipe(Effect.mapError(toError("migrate")));
  yield* fileSystem.remove(legacyPath, { force: true }).pipe(
    Effect.catch((cleanupError) =>
      Effect.logWarning("failed to remove legacy terminal history", {
        threadId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }),
    ),
  );
  return capped;
});

const deleteHistoryEffect = Effect.fn("terminal.deleteHistory")(function* (
  logsDir: string,
  threadId: string,
  terminalId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(historyPath(logsDir, threadId, terminalId), { force: true }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
  if (terminalId === DEFAULT_TERMINAL_ID) {
    yield* fileSystem.remove(legacyHistoryPath(logsDir, threadId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }
});

/** The pane a history file name belongs to for this thread, or undefined when it is not one. */
function historyFileTerminalId(name: string, threadId: string): string | undefined {
  const threadPart = toSafeThreadId(threadId);
  if (name === `${threadPart}.log` || name === `${legacySafeThreadId(threadId)}.log`) {
    return DEFAULT_TERMINAL_ID;
  }
  if (!name.startsWith(`${threadPart}_`) || !name.endsWith(".log")) return undefined;
  const encoded = name.slice(threadPart.length + 1, -".log".length);
  const terminalId = Buffer.from(encoded, "base64url").toString("utf8");
  // Only exact encodings name a pane; anything else is not this thread's history.
  return encoded.length > 0 && toSafeTerminalId(terminalId) === encoded ? terminalId : undefined;
}

const deleteAllHistoryForThreadEffect = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
  logsDir: string,
  threadId: string,
  retainedTerminalIds: ReadonlySet<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const threadPrefix = `${toSafeThreadId(threadId)}_`;
  const entries = yield* fileSystem
    .readDirectory(logsDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
  yield* Effect.forEach(
    entries.filter((name) => {
      const terminalId = historyFileTerminalId(name, threadId);
      // A pane that still has an owner record or a host PTY keeps its history (N8): its file
      // is how the thread keeps recognising that pane.
      if (terminalId !== undefined) return !retainedTerminalIds.has(terminalId);
      return name.startsWith(threadPrefix);
    }),
    (name) =>
      fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal histories for thread", {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    { discard: true },
  );
});

const listHistoryTerminalIdsEffect = Effect.fn("terminal.listHistoryTerminalIds")(function* (
  logsDir: string,
  threadId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem.readDirectory(logsDir, { recursive: false }).pipe(
    Effect.map((names): ReadonlyArray<string> | "unknown" => names),
    // No logs directory means no retained history; any other failure proves nothing.
    Effect.catch((error) =>
      Effect.succeed(error.reason._tag === "NotFound" ? [] : ("unknown" as const)),
    ),
  );
  if (entries === "unknown") return "unknown" as const;
  const terminalIds = new Set<string>();
  for (const name of entries) {
    const terminalId = historyFileTerminalId(name, threadId);
    if (terminalId !== undefined) terminalIds.add(terminalId);
  }
  return [...terminalIds];
});

/** Terminal IDs with retained history for a thread, or `"unknown"` when unreadable. */
export const listHistoryTerminalIds = (logsDir: string, threadId: string) =>
  listHistoryTerminalIdsEffect(logsDir, threadId);

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const readHistory = (
  logsDir: string,
  historyLineLimit: number,
  threadId: string,
  terminalId: string,
) =>
  readHistoryEffect(logsDir, historyLineLimit, threadId, terminalId).pipe(
    Effect.withSpan("terminal.readHistory"),
  );

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export const deleteHistory = (logsDir: string, threadId: string, terminalId: string) =>
  deleteHistoryEffect(logsDir, threadId, terminalId).pipe(
    Effect.withSpan("terminal.deleteHistory"),
  );

/** Deletes a thread's history files except those of `retainedTerminalIds` (N8). */
export const deleteAllHistoryForThread = (
  logsDir: string,
  threadId: string,
  retainedTerminalIds: ReadonlySet<string> = new Set(),
) =>
  deleteAllHistoryForThreadEffect(logsDir, threadId, retainedTerminalIds).pipe(
    Effect.withSpan("terminal.deleteAllHistoryForThread"),
  );
