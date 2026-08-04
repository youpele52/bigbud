import { makeKeyedCoalescingWorker } from "@bigbud/shared/KeyedCoalescingWorker";
import { Effect, type FileSystem } from "effect";

import { historyPath } from "./Manager.history-io.ts";
import { toSessionKey } from "./Manager.shell.ts";
import { DEFAULT_PERSIST_DEBOUNCE_MS, type PersistHistoryRequest } from "./Manager.types.ts";

export const makeTerminalPersistence = Effect.fn("makeTerminalPersistence")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly logsDir: string;
}) {
  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) return;
      yield* input.fileSystem
        .writeFileString(historyPath(input.logsDir, threadId, terminalId), request.history)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist terminal history", {
              threadId,
              terminalId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    }),
  });
  const flushPersist = (threadId: string, terminalId: string) =>
    persistWorker.drainKey(toSessionKey(threadId, terminalId));
  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: string,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), { history, immediate: true });
    yield* flushPersist(threadId, terminalId);
  });
  const queuePersist = (threadId: string, terminalId: string, history: string) =>
    persistWorker.enqueue(toSessionKey(threadId, terminalId), { history, immediate: false });
  return { flushPersist, persistHistory, queuePersist };
});
