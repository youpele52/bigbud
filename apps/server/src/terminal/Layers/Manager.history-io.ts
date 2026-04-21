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

const deleteAllHistoryForThreadEffect = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
  logsDir: string,
  threadId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const threadPrefix = `${toSafeThreadId(threadId)}_`;
  const entries = yield* fileSystem
    .readDirectory(logsDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
  yield* Effect.forEach(
    entries.filter(
      (name) =>
        name === `${toSafeThreadId(threadId)}.log` ||
        name === `${legacySafeThreadId(threadId)}.log` ||
        name.startsWith(threadPrefix),
    ),
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

export const deleteAllHistoryForThread = (logsDir: string, threadId: string) =>
  deleteAllHistoryForThreadEffect(logsDir, threadId).pipe(
    Effect.withSpan("terminal.deleteAllHistoryForThread"),
  );
