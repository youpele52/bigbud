/**
 * Reads Electron main's lifecycle hints from the fd 5 pipe for the backend's lifetime.
 *
 * Each line is a `DesktopLifecycleHint` JSON object. The pipe is read through a non-blocking
 * `net.Socket`, never a file read stream, so it does not hold a libuv threadpool thread while
 * idle. A malformed line is logged and skipped; a closed pipe ends the reader quietly.
 *
 * @module desktopLifecycleHintReader
 */
import * as NFS from "node:fs";
import * as Net from "node:net";
import * as readline from "node:readline";

import { DesktopLifecycleHint } from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { Effect, Layer, Result, Stream } from "effect";

import { ServerConfig } from "../startup/config.ts";
import { SystemSleepEpochs } from "./Services/SystemSleepEpochs.ts";

/** Hint lines are tiny; anything longer is not a hint. */
const MAX_HINT_LINE_CHARS = 4_096;

const decodeHint = decodeJsonResult(DesktopLifecycleHint);

/** Whether `fd` is an open pipe or socket the desktop could have passed. */
export function isHintPipeFd(fd: number, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = NFS.fstatSync(fd);
    return platform === "win32" || stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

/** Decodes one hint line, or returns null for a line that is not a valid hint. */
export function parseDesktopLifecycleHintLine(line: string): DesktopLifecycleHint | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HINT_LINE_CHARS) return null;
  const parsed = decodeHint(trimmed);
  return Result.isSuccess(parsed) ? parsed.success : null;
}

/** Streams decoded hint lines from a readable source until it closes. */
export const desktopLifecycleHintLines = (input: NodeJS.ReadableStream) =>
  Stream.fromAsyncIterable(
    readline.createInterface({ input, crlfDelay: Infinity }),
    (cause) => cause,
  ).pipe(Stream.catch(() => Stream.empty));

/** Applies every hint line from `input` to the sleep epochs. */
export const consumeDesktopLifecycleHints = Effect.fn("consumeDesktopLifecycleHints")(function* (
  input: NodeJS.ReadableStream,
) {
  const epochs = yield* SystemSleepEpochs;
  yield* Stream.runForEach(desktopLifecycleHintLines(input), (line) => {
    const hint = parseDesktopLifecycleHintLine(line);
    if (hint === null) {
      return Effect.logWarning("ignored an invalid desktop lifecycle hint line", {
        length: line.length,
      });
    }
    return epochs.recordDesktopHint(hint);
  });
});

const openHintSocket = (fd: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new Net.Socket({ fd, readable: true, writable: false });
      socket.setEncoding("utf8");
      socket.on("error", () => socket.destroy());
      return socket;
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );

/**
 * Starts the reader when the desktop bootstrap envelope announced the hint pipe. Without the
 * announcement nothing is read: that fd number may belong to Node or libuv.
 */
export const DesktopLifecycleHintReaderLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fd = config.desktopLifecycleHintFd;
    if (fd === undefined) {
      if (config.mode === "desktop") {
        yield* Effect.logInfo(
          "desktop did not announce a lifecycle hint pipe; using other sleep sources",
        );
      }
      return;
    }
    if (!isHintPipeFd(fd)) {
      yield* Effect.logInfo("desktop lifecycle hint pipe is not open; using other sleep sources", {
        fd,
      });
      return;
    }
    const socket = yield* openHintSocket(fd);
    yield* consumeDesktopLifecycleHints(socket).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("desktop lifecycle hint reader stopped", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
