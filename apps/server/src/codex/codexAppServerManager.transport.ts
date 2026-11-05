import type { CodexSessionContext, CodexWriteOptions } from "./codexAppServerManager.types.ts";
import { CodexRpcError, codexRequestKey } from "./codexAppServerManager.errors.ts";

interface QueuedWrite {
  readonly encoded: string;
  readonly bytes: number;
  readonly method: string;
  readonly shouldDispatch: () => boolean;
  readonly onDispatch: () => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface Writer {
  readonly queue: QueuedWrite[];
  bytes: number;
  running: boolean;
  closed: Error | undefined;
  cancelActive: ((error: Error) => void) | undefined;
}

const writers = new WeakMap<CodexSessionContext, Writer>();
const MAX_QUEUED_WRITES = 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 20_000;

function writerFor(context: CodexSessionContext): Writer {
  let writer = writers.get(context);
  if (!writer) {
    writer = { queue: [], bytes: 0, running: false, closed: undefined, cancelActive: undefined };
    writers.set(context, writer);
    // A write callback can fail before Node emits its stream error; keep a listener
    // after per-write cleanup so that late transport failures are never unhandled.
    context.child.stdin.on("error", (cause) => closeCodexTransport(context, cause));
  }
  return writer;
}

/** Closes this process transport once, preserving each request's dispatch certainty. */
export function closeCodexTransport(context: CodexSessionContext, cause: Error): void {
  const writer = writerFor(context);
  if (!writer.closed) {
    writer.closed = cause;
    writer.cancelActive?.(cause);
    for (const queued of writer.queue.splice(0)) {
      queued.reject(
        new CodexRpcError(
          queued.method,
          context.session.sessionEpoch,
          "not-dispatched",
          cause.message,
          { cause },
        ),
      );
    }
    writer.bytes = 0;
  }
  for (const pending of context.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(
      new CodexRpcError(
        pending.method,
        context.session.sessionEpoch,
        pending.dispatched ? "possibly-applied" : "not-dispatched",
        cause.message,
        { cause },
      ),
    );
  }
  context.pending.clear();
}

function writeOne(context: CodexSessionContext, writer: Writer, entry: QueuedWrite): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdin = context.child.stdin;
    let settled = false;
    let callbackDone = false;
    let drained = false;
    let returned = false;
    const finish = (error?: Error) => {
      if (settled || (!error && (!callbackDone || !drained || !returned))) return;
      settled = true;
      clearTimeout(timeout);
      stdin.off("drain", onDrain);
      stdin.off("error", onError);
      stdin.off("close", onClose);
      writer.cancelActive = undefined;
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => {
      drained = true;
      finish();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Codex app-server stdin closed."));
    const timeout = setTimeout(
      () => finish(new Error("Codex app-server write timed out.")),
      WRITE_TIMEOUT_MS,
    );
    writer.cancelActive = onError;
    stdin.on("drain", onDrain);
    stdin.on("error", onError);
    stdin.on("close", onClose);
    try {
      // From this point a synchronous throw can no longer prove non-delivery.
      entry.onDispatch();
      const accepted = stdin.write(entry.encoded, (error) => {
        callbackDone = true;
        finish(error ?? undefined);
      });
      returned = true;
      drained ||= accepted;
      finish();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function flush(context: CodexSessionContext, writer: Writer): Promise<void> {
  if (writer.running) return;
  writer.running = true;
  try {
    while (!writer.closed && writer.queue.length > 0) {
      const entry = writer.queue.shift()!;
      writer.bytes -= entry.bytes;
      if (!entry.shouldDispatch()) {
        entry.resolve();
        continue;
      }
      if (context.stopping || !context.child.stdin.writable) {
        const cause = new Error("Cannot write to codex app-server stdin.");
        entry.reject(
          new CodexRpcError(
            entry.method,
            context.session.sessionEpoch,
            "not-dispatched",
            cause.message,
          ),
        );
        closeCodexTransport(context, cause);
        break;
      }
      try {
        await writeOne(context, writer, entry);
        entry.resolve();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        entry.reject(
          new CodexRpcError(
            entry.method,
            context.session.sessionEpoch,
            "possibly-applied",
            error.message,
            { cause },
          ),
        );
        closeCodexTransport(context, error);
      }
    }
  } finally {
    writer.running = false;
  }
}

/** Serializes writes through both callback completion and stream backpressure. */
export function writeCodexMessage(
  context: CodexSessionContext,
  message: unknown,
  options?: CodexWriteOptions,
): Promise<void> {
  const writer = writerFor(context);
  const method =
    typeof message === "object" && message && "method" in message
      ? String(message.method)
      : "response";
  return new Promise((resolve, reject) => {
    let encoded: string;
    try {
      encoded = `${JSON.stringify(message)}\n`;
    } catch (cause) {
      reject(
        new CodexRpcError(
          method,
          context.session.sessionEpoch,
          "not-dispatched",
          "Cannot encode Codex protocol message.",
          { cause },
        ),
      );
      return;
    }
    const bytes = Buffer.byteLength(encoded);
    if (
      writer.closed ||
      context.stopping ||
      writer.queue.length >= MAX_QUEUED_WRITES ||
      writer.bytes + bytes > MAX_QUEUED_BYTES
    ) {
      reject(
        new CodexRpcError(
          method,
          context.session.sessionEpoch,
          "not-dispatched",
          writer.closed?.message ??
            "Codex transport is stopped or its bounded write queue is full.",
        ),
      );
      return;
    }
    writer.queue.push({
      encoded,
      bytes,
      method,
      resolve,
      reject,
      shouldDispatch: options?.shouldDispatch ?? (() => true),
      onDispatch: options?.onDispatch ?? (() => {}),
    });
    writer.bytes += bytes;
    void flush(context, writer);
  });
}

/** Registers before writing and cleans up exactly once, including synchronous write failure. */
export async function sendCodexRequest<T>(
  context: CodexSessionContext,
  method: string,
  params: unknown,
  timeoutMs = 20_000,
  shouldDispatch?: () => boolean,
): Promise<T> {
  const id = context.nextRequestId++;
  const key = codexRequestKey(context, id);
  return await new Promise<T>((resolve, reject) => {
    const pending = {
      method,
      dispatched: false,
      timeout: setTimeout(() => {
        context.pending.delete(key);
        reject(
          new CodexRpcError(
            method,
            context.session.sessionEpoch,
            pending.dispatched ? "possibly-applied" : "not-dispatched",
            `Timed out waiting for ${method}.`,
          ),
        );
      }, timeoutMs),
      resolve: (value: unknown) => resolve(value as T),
      reject,
    };
    context.pending.set(key, pending);
    void writeCodexMessage(
      context,
      { method, id, params },
      {
        shouldDispatch: () => {
          if (context.pending.get(key) !== pending) return false;
          if (shouldDispatch?.() ?? true) return true;
          clearTimeout(pending.timeout);
          context.pending.delete(key);
          reject(
            new CodexRpcError(
              method,
              context.session.sessionEpoch,
              "not-dispatched",
              "Codex request admission changed before dispatch.",
            ),
          );
          return false;
        },
        onDispatch: () => {
          pending.dispatched = true;
        },
      },
    ).catch((error) => {
      if (context.pending.get(key) !== pending) return;
      clearTimeout(pending.timeout);
      context.pending.delete(key);
      reject(error);
    });
  });
}
