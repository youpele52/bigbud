import { Effect, Layer } from "effect";

import { ServerConfig } from "../../startup/config";
import { TerminalManager } from "../Services/Manager";
import { PtyAdapter } from "../Services/PTY";
import { makeTerminalManagerWithOptions } from "./Manager.process";

export { makeTerminalManagerWithOptions } from "./Manager.process";

const makeTerminalManager = Effect.fn("makeTerminalManager")(function* () {
  const { terminalLogsDir } = yield* ServerConfig;
  const ptyAdapter = yield* PtyAdapter;
  return yield* makeTerminalManagerWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
  });
});

export const TerminalManagerLive = Layer.effect(TerminalManager, makeTerminalManager());
