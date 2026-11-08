import { assert, it } from "@effect/vitest";

import {
  exitProcessOnSqliteWorkerFailure,
  SQLITE_WORKER_FAILURE_EXIT_CODE,
} from "./NodeSqliteClient.worker.exit.ts";

it("writes the cause to stderr, then exits exactly once with the worker failure code", () => {
  const lines: string[] = [];
  const exits: number[] = [];
  let flush: (() => void) | undefined;
  exitProcessOnSqliteWorkerFailure(
    { message: "SQLite worker crashed: boom.", cause: new Error("boom") },
    {
      writeStderr: (line, done) => {
        lines.push(line);
        flush = done;
      },
      exit: (code) => exits.push(code),
    },
  );
  assert.deepEqual(exits, []);
  assert.match(lines[0] ?? "", /^FATAL: SQLite worker crashed: boom\./);
  flush?.();
  flush?.();
  assert.deepEqual(exits, [SQLITE_WORKER_FAILURE_EXIT_CODE]);
});

it("exits even when the stderr write never completes", async () => {
  const exits: number[] = [];
  exitProcessOnSqliteWorkerFailure(
    { message: "SQLite worker exited with code 7.", cause: { code: 7 } },
    { writeStderr: () => {}, exit: (code) => exits.push(code) },
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.deepEqual(exits, [SQLITE_WORKER_FAILURE_EXIT_CODE]);
});
