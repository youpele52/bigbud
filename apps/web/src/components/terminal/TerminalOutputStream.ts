import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import { readNativeApi } from "../../rpc/nativeApi";
import type { TerminalStreamDiagnostics } from "./TerminalDiagnostics";
import { TerminalSessionStream, type TerminalSessionStreamHandlers } from "./TerminalSessionStream";

export interface TerminalOutputSubscriber {
  readonly onEvent: (event: TerminalEvent) => void;
  /** Credited output this view still has queued or in flight. */
  readonly outstanding?: () => number;
  /** The stream restarted and events may be missing; the view must replay a snapshot. */
  readonly onResync?: () => void;
}

export interface TerminalOutputSubscription {
  /** Resolves once the server registered the stream, so a following open cannot miss events. */
  readonly ready: Promise<void>;
  /** Report that parsed output released credit. */
  readonly parsed: () => void;
  readonly diagnostics: () => TerminalStreamDiagnostics | null;
  readonly unsubscribe: () => void;
}

type StreamFactory = (
  threadId: string,
  terminalId: string,
  handlers: TerminalSessionStreamHandlers,
) => TerminalSessionStream | null;

interface Entry {
  readonly subscribers: Set<TerminalOutputSubscriber>;
  stream: TerminalSessionStream | null;
}

const entries = new Map<string, Entry>();
const READY = Promise.resolve();

const defaultFactory: StreamFactory = (threadId, terminalId, handlers) => {
  const terminal = readNativeApi()?.terminal;
  return terminal?.subscribeSession
    ? new TerminalSessionStream(terminal, { threadId, terminalId }, handlers)
    : null;
};
let streamFactory: StreamFactory = defaultFactory;

function key(threadId: string, terminalId: string): string {
  return JSON.stringify([threadId, terminalId]);
}

/** Test seam; production views always use the native API's scoped stream. */
export function setTerminalSessionStreamFactory(factory: StreamFactory | null): void {
  streamFactory = factory ?? defaultFactory;
}

/** Synchronous fan-out to the mounted views of one terminal (also the test injection point). */
export function publishTerminalOutput(event: TerminalEvent): void {
  for (const subscriber of entries.get(key(event.threadId, event.terminalId))?.subscribers ?? [])
    subscriber.onEvent(event);
}

/**
 * The first view of a terminal opens its scoped, flow-controlled stream and the last one closes
 * it. Several views share the stream; credit follows the slowest view.
 */
export function subscribeTerminalOutput(
  threadId: string,
  terminalId: string,
  subscriber: TerminalOutputSubscriber,
): TerminalOutputSubscription {
  const id = key(threadId, terminalId);
  let entry = entries.get(id);
  if (!entry) {
    const created: Entry = { subscribers: new Set(), stream: null };
    entries.set(id, created);
    created.stream = streamFactory(threadId, terminalId, {
      deliver: (event) => {
        for (const current of created.subscribers) current.onEvent(event);
      },
      outstanding: () =>
        Math.max(0, ...[...created.subscribers].map((current) => current.outstanding?.() ?? 0)),
      resync: () => {
        // Snapshot: a resync replaces the view's lane and unsubscribes while this loop runs.
        for (const current of Array.from(created.subscribers)) current.onResync?.();
      },
    });
    entry = created;
  }
  const owner = entry;
  owner.subscribers.add(subscriber);
  let active = true;
  return {
    ready: owner.stream?.ready ?? READY,
    parsed: () => {
      if (active) owner.stream?.parsed();
    },
    diagnostics: () => owner.stream?.diagnostics ?? null,
    unsubscribe: () => {
      if (!active) return;
      active = false;
      owner.subscribers.delete(subscriber);
      if (owner.subscribers.size > 0 || entries.get(id) !== owner) return;
      entries.delete(id);
      owner.stream?.close();
    },
  };
}
