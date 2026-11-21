/**
 * Reads Electron main's lifecycle hints from the fd 5 pipe for the backend's lifetime.
 *
 * Each line is a `DesktopLifecycleHintLine` JSON object. Power and network hints feed the sleep
 * epochs. A `quit` line is recorded in `AppQuitIntent` and acknowledged on the fd 4 status pipe
 * with a `DesktopLifecycleHintAck`, synchronously inside the data callback, so the ack always
 * follows the recorded intent.
 *
 * The pipe is read through a non-blocking `net.Socket`, never a file read stream, so it does not
 * hold a libuv threadpool thread while idle. Because the fd is non-blocking, pending lines can
 * also be drained synchronously with `fs.readSync` (`drainPendingHints`): on SIGTERM, and before
 * the shutdown path resolves the quit intent, so a quit line written just before the signal is
 * never lost. A malformed line is logged and skipped; a closed pipe ends the reader quietly.
 *
 * @module desktopLifecycleHintReader
 */
import * as NFS from "node:fs";
import * as Net from "node:net";

import {
  type DesktopLifecycleHint,
  type DesktopLifecycleHintAck,
  DesktopLifecycleHintLine,
  type DesktopQuitHint,
} from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { type Cause, Effect, Layer, Option, Queue, Result, Stream } from "effect";

import { AppQuitIntent } from "../lifecycle/AppQuitIntent.ts";
import { ServerConfig } from "../startup/config.ts";
import { DesktopHintLineSplitter } from "./desktopLifecycleHintReader.lines.ts";
import { SystemSleepEpochs, type SystemSleepEpochsShape } from "./Services/SystemSleepEpochs.ts";
import { routeDesktopHintLine } from "./SystemSleepEpochs.sources.logic.ts";

/** Hint lines are tiny; anything longer is not a hint. */
export const MAX_HINT_LINE_CHARS = 4_096;

/**
 * Key of the ack record on the server-to-main status pipe (fd 4):
 * `{"lifecycleHintAck":{"sequence":7}}\n`. Startup status records never carry it.
 */
export const DESKTOP_LIFECYCLE_HINT_ACK_RECORD_KEY = "lifecycleHintAck";

/** At most this many bytes are drained synchronously per call; hint traffic is tiny. */
const MAX_DRAIN_BYTES = 256 * 1024;

const decodeHintLine = decodeJsonResult(DesktopLifecycleHintLine);

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
export function parseDesktopLifecycleHintLine(line: string): DesktopLifecycleHintLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HINT_LINE_CHARS) return null;
  const parsed = decodeHintLine(trimmed);
  return Result.isSuccess(parsed) ? parsed.success : null;
}

/**
 * Writes one ack record on the startup status fd Electron main passed. Returns false when there
 * is no status pipe or the write failed; Electron main then quits after its ack deadline.
 */
export function writeDesktopLifecycleHintAck(
  ack: DesktopLifecycleHintAck,
  env: NodeJS.ProcessEnv = process.env,
  writeSync: (fd: number, line: string) => unknown = NFS.writeSync,
): boolean {
  const statusFd = Number(env.BIGBUD_STARTUP_STATUS_FD);
  if (!Number.isInteger(statusFd) || statusFd < 0) return false;
  try {
    writeSync(statusFd, `${JSON.stringify({ [DESKTOP_LIFECYCLE_HINT_ACK_RECORD_KEY]: ack })}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Reads every byte already in a non-blocking fd without waiting; stops at EAGAIN or EOF. */
export function drainHintFd(fd: number, splitter: DesktopHintLineSplitter): void {
  const buffer = Buffer.allocUnsafe(4_096);
  let drained = 0;
  while (drained < MAX_DRAIN_BYTES) {
    let read: number;
    try {
      read = NFS.readSync(fd, buffer, 0, buffer.length, null);
    } catch {
      return; // EAGAIN: nothing pending. Any other error ends the drain; the socket reports it.
    }
    if (read <= 0) return;
    drained += read;
    splitter.push(Buffer.from(buffer.subarray(0, read)));
  }
}

const activeDrains = new Set<() => void>();

/** Synchronously applies every hint line already written to the fd 5 pipe. */
export function drainPendingHints(): void {
  for (const drain of activeDrains) drain();
}

type HintSignal = "SIGTERM" | "SIGINT";

export interface HintSignalSource {
  prependListener(signal: HintSignal, listener: () => void): unknown;
  removeListener(signal: HintSignal, listener: () => void): unknown;
}

export interface ConsumeDesktopLifecycleHintsOptions {
  /** The non-blocking fd behind `input`, drained synchronously on SIGTERM and at shutdown. */
  readonly drainFd?: number;
  readonly signals?: HintSignalSource;
  readonly writeAck?: (ack: DesktopLifecycleHintAck) => boolean;
}

type HintItem =
  | { readonly _tag: "hint"; readonly hint: DesktopLifecycleHint }
  | { readonly _tag: "quit"; readonly hint: DesktopQuitHint; readonly acked: boolean }
  | { readonly _tag: "invalid"; readonly length: number };

const HINT_SIGNALS: ReadonlyArray<HintSignal> = ["SIGTERM", "SIGINT"];

const logHintItem = (epochs: SystemSleepEpochsShape, item: HintItem) => {
  switch (item._tag) {
    case "hint":
      return epochs.recordDesktopHint(item.hint);
    case "quit":
      return item.acked
        ? Effect.logInfo("desktop announced quit", {
            reason: item.hint.reason ?? "quit",
            sequence: item.hint.sequence,
          })
        : Effect.logWarning("desktop quit hint was not acknowledged", {
            sequence: item.hint.sequence,
          });
    case "invalid":
      return Effect.logWarning("ignored an invalid desktop lifecycle hint line", {
        length: item.length,
      });
  }
};

/**
 * Applies every hint line from `input` until it closes. Quit lines are recorded and acked
 * synchronously as they are split; power hints are applied to the sleep epochs in order.
 */
export const consumeDesktopLifecycleHints = Effect.fn("consumeDesktopLifecycleHints")(function* (
  input: NodeJS.ReadableStream,
  options: ConsumeDesktopLifecycleHintsOptions = {},
) {
  const epochs = yield* SystemSleepEpochs;
  const quitIntent = yield* Effect.serviceOption(AppQuitIntent);
  const writeAck = options.writeAck ?? ((ack) => writeDesktopLifecycleHintAck(ack));
  const queue = yield* Queue.unbounded<HintItem, Cause.Done>();
  // Data callbacks and the SIGTERM drain run outside the fiber; quit lines apply synchronously.
  const runSync = Effect.runSyncWith(yield* Effect.services<never>());

  const applyLine = (line: string) => {
    const parsed = parseDesktopLifecycleHintLine(line);
    if (parsed === null) {
      Queue.offerUnsafe(queue, { _tag: "invalid", length: line.length });
      return;
    }
    const route = routeDesktopHintLine(parsed);
    if (route.target === "sleep-epochs") {
      Queue.offerUnsafe(queue, { _tag: "hint", hint: route.hint });
      return;
    }
    // Record first: an ack promises that the shutdown path will see this intent.
    if (Option.isSome(quitIntent)) runSync(quitIntent.value.record(route.hint));
    const acked = Option.isSome(quitIntent) && writeAck({ sequence: route.hint.sequence });
    Queue.offerUnsafe(queue, { _tag: "quit", hint: route.hint, acked });
  };

  const splitter = new DesktopHintLineSplitter(applyLine, MAX_HINT_LINE_CHARS, (length) =>
    Queue.offerUnsafe(queue, { _tag: "invalid", length }),
  );
  const drainFd = options.drainFd;
  const drain = () => {
    if (drainFd !== undefined) drainHintFd(drainFd, splitter);
  };
  const signals = options.signals ?? process;
  const onData = (chunk: Buffer | string) => splitter.push(chunk);
  const onEnd = () => {
    splitter.end();
    Queue.endUnsafe(queue);
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      input.on("error", onEnd);
      activeDrains.add(drain);
      for (const signal of HINT_SIGNALS) signals.prependListener(signal, drain);
    }),
    () =>
      Effect.sync(() => {
        for (const signal of HINT_SIGNALS) signals.removeListener(signal, drain);
        activeDrains.delete(drain);
        // Shutdown interrupts this reader: apply what the pipe still holds before closing.
        drain();
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.removeListener("close", onEnd);
        input.removeListener("error", onEnd);
      }),
  );
  if (Option.isSome(quitIntent)) yield* quitIntent.value.registerDrain(drain);

  yield* Stream.runForEach(Stream.fromQueue(queue), (item) => logHintItem(epochs, item));
}, Effect.scoped);

const openHintSocket = (fd: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      // Bytes, not strings: the synchronous drain shares the splitter's UTF-8 decoder.
      const socket = new Net.Socket({ fd, readable: true, writable: false });
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
    // `net.Socket` makes the fd non-blocking on POSIX; a Windows pipe is never read synchronously.
    const drainFd = process.platform === "win32" ? undefined : fd;
    yield* consumeDesktopLifecycleHints(socket, drainFd === undefined ? {} : { drainFd }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("desktop lifecycle hint reader stopped", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
