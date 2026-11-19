import type { SystemSearchTierUpdate } from "@bigbud/contracts/search/systemSearch.ts";

import type { RemoteAgentFrame } from "../remote-agent/remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_OS_INDEX_CAPABILITY,
  REMOTE_AGENT_SEARCH_MODE,
  REMOTE_AGENT_SEARCH_STREAM_CAPABILITY,
  type RemoteAgentOsIndexSearchHit,
  type RemoteAgentOsIndexSearchRequest,
  type RemoteAgentWorkspaceSearchRequest,
} from "../remote-agent/remoteAgentProtocol.search.ts";
import type { SearchAgentConnection } from "./SystemSearch.agentRequest.ts";
import { SystemSearchEmitter } from "./SystemSearch.emitter.ts";

type Predicate = (frame: RemoteAgentFrame) => boolean;

/**
 * A fake agent: every search answers one batch (one name hit per root, plus a content hit per
 * root in `both` mode) and a completion. With `hold`, the completion waits for `CancelRequest`
 * (then ends `cancelled`), so tests can observe in-flight operations.
 */
export function fakeSearchAgent(
  options: { readonly capable?: boolean; readonly hold?: boolean } = {},
) {
  const requests: RemoteAgentWorkspaceSearchRequest[] = [];
  const cancels: string[] = [];
  const inFlight = new Set<string>();
  const frames: RemoteAgentFrame[] = [];
  const waiters: Array<{ predicate: Predicate; resolve: (frame: RemoteAgentFrame) => void }> = [];
  const push = (frame: RemoteAgentFrame) => {
    const waiter = waiters.find((candidate) => candidate.predicate(frame));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    } else frames.push(frame);
  };
  const take = (predicate: Predicate) =>
    new Promise<RemoteAgentFrame>((resolve) => {
      const index = frames.findIndex(predicate);
      if (index >= 0) resolve(frames.splice(index, 1)[0]!);
      else waiters.push({ predicate, resolve });
    });
  const complete = (request: RemoteAgentWorkspaceSearchRequest, stopReason: string) => {
    inFlight.delete(request.operationId);
    push({
      type: "workspaceSearchCompleted",
      value: {
        requestId: request.requestId,
        operationId: request.operationId,
        stopReason,
        truncated: false,
        filesScanned: request.roots.length,
        rootErrors: [],
        errorCode: "",
        errorMessage: "",
        batches: 1,
      },
    });
  };
  const connection: SearchAgentConnection = {
    supportsCapability: (name: string) =>
      (options.capable ?? true) && name === REMOTE_AGENT_SEARCH_STREAM_CAPABILITY,
    request: (async (frame: RemoteAgentFrame, predicate: Predicate) => {
      if (frame.type === "cancelRequest") {
        cancels.push(frame.value.operationId);
        const held = requests.find((request) => request.operationId === frame.value.operationId);
        if (held && inFlight.has(held.operationId)) complete(held, "cancelled");
        return { type: "cancelResponse", value: { requestId: frame.value.requestId } };
      }
      if (frame.type !== "workspaceSearchRequest") throw new Error(`unexpected ${frame.type}`);
      const request = frame.value;
      requests.push(request);
      inFlight.add(request.operationId);
      push({
        type: "workspaceSearchBatch",
        value: {
          requestId: request.requestId,
          operationId: request.operationId,
          sequence: 1,
          names: request.roots.map((root) => ({
            rootId: root.rootId,
            path: "src/match.ts",
            isDirectory: false,
            sizeBytes: 10,
            modifiedUnixMs: 1_700_000_000_000,
            score: 1,
          })),
          contents:
            request.mode === REMOTE_AGENT_SEARCH_MODE.both
              ? request.roots.map((root) => ({
                  rootId: root.rootId,
                  path: "src/match.ts",
                  line: 3,
                  column: 5,
                  excerpt: "const match = 1;",
                }))
              : [],
        },
      });
      if (!options.hold) complete(request, "complete");
      return take(predicate);
    }) as SearchAgentConnection["request"],
    nextFrame: ((predicate: Predicate) => take(predicate)) as SearchAgentConnection["nextFrame"],
  };
  return { connection, requests, cancels, inFlight };
}

/** Collects emitted updates for one query. */
export function collectUpdates(queryId = "q1", signal = new AbortController().signal) {
  const updates: SystemSearchTierUpdate[] = [];
  const emitter = new SystemSearchEmitter(queryId, signal, (update) => updates.push(update));
  return { updates, emitter };
}

/** A fake desktop agent for `os-index.search`: answers one batch and one completion. */
export function fakeOsIndexAgent(
  options: {
    readonly capable?: boolean;
    readonly hits?: ReadonlyArray<RemoteAgentOsIndexSearchHit>;
    readonly errorCode?: string;
    readonly hold?: boolean;
  } = {},
) {
  const requests: RemoteAgentOsIndexSearchRequest[] = [];
  const cancels: string[] = [];
  let pending: ((frame: RemoteAgentFrame) => void) | undefined;
  let queued: RemoteAgentFrame | undefined;
  const completed = (request: RemoteAgentOsIndexSearchRequest, stopReason: string) =>
    ({
      type: "osIndexSearchCompleted",
      value: {
        requestId: request.requestId,
        operationId: request.operationId,
        stopReason: options.errorCode ? "error" : stopReason,
        truncated: false,
        source: "spotlight",
        availability: "ready",
        excluded: 0,
        errorCode: options.errorCode ?? "",
        errorMessage: "",
        batches: 1,
      },
    }) as RemoteAgentFrame;
  const deliver = (frame: RemoteAgentFrame) => {
    if (pending) {
      pending(frame);
      pending = undefined;
    } else queued = frame;
  };
  const connection: SearchAgentConnection = {
    supportsCapability: (name: string) =>
      (options.capable ?? true) && name === REMOTE_AGENT_OS_INDEX_CAPABILITY,
    request: (async (frame: RemoteAgentFrame) => {
      if (frame.type === "cancelRequest") {
        cancels.push(frame.value.operationId);
        const request = requests.at(-1);
        if (request) deliver(completed(request, "cancelled"));
        return { type: "cancelResponse", value: { requestId: frame.value.requestId } };
      }
      if (frame.type !== "osIndexSearchRequest") throw new Error(`unexpected ${frame.type}`);
      requests.push(frame.value);
      if (!options.hold) queued = completed(frame.value, "complete");
      return {
        type: "osIndexSearchBatch",
        value: {
          requestId: frame.value.requestId,
          operationId: frame.value.operationId,
          sequence: 1,
          hits: options.hits ?? [],
        },
      } as RemoteAgentFrame;
    }) as SearchAgentConnection["request"],
    nextFrame: (() =>
      queued
        ? Promise.resolve(queued)
        : new Promise<RemoteAgentFrame>((resolve) => {
            pending = resolve;
          })) as SearchAgentConnection["nextFrame"],
  };
  return { connection, requests, cancels };
}
