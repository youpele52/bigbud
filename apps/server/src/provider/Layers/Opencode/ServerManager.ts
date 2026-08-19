import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { resolveExecutionTargetId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";

import {
  OpencodeServerManager,
  type OpencodeServerAcquireInput,
  type OpencodeServerHandle,
} from "../../Services/Opencode/ServerManager.ts";
import { buildClientOptions, resolveBinaryPath } from "./ServerManager.helpers.ts";
import { startManagedServer } from "./ServerManager.child.ts";
export { formatMissingOpencodeBinaryDetail } from "./ServerManager.errors.ts";
export { readManagedServerListeningUrl } from "./ServerManager.helpers.ts";

export interface RunningManagedServer {
  readonly url: string;
  isRunning?(): boolean;
  onUnexpectedDeath?(listener: () => void): () => void;
  close(): void | Promise<void>;
}

type ManagedServerProvider = "opencode" | "kilocode";
const SERVER_CONFIGS = {
  opencode: {
    provider: "opencode",
    displayName: "OpenCode",
    defaultBinary: "opencode",
    configContentEnvKey: "OPENCODE_CONFIG_CONTENT",
  },
  kilocode: {
    provider: "kilocode",
    displayName: "KiloCode",
    defaultBinary: "kilo",
    configContentEnvKey: "KILO_CONFIG_CONTENT",
    directoryHeader: "x-kilo-directory",
  },
} as const;
export type ManagedServerConfig = (typeof SERVER_CONFIGS)[ManagedServerProvider];

interface TargetState {
  readonly targetKey: string;
  readonly targetIdentity: string;
  readonly generation: number;
  refCount: number;
  invalidated: boolean;
  closed: boolean;
  startPromise: Promise<RunningManagedServer> | null;
  serverHandle: RunningManagedServer | null;
  readonly invalidationListeners: Set<() => void>;
  unsubscribeDeath: (() => void) | null;
}

export interface OpencodeServerManagerFactoryOptions {
  readonly startServer?: (input: {
    readonly config: ManagedServerConfig;
    readonly executionTargetId: string;
    readonly binaryPath: string;
  }) => Promise<RunningManagedServer>;
}

export function makeOpencodeServerManager(options: OpencodeServerManagerFactoryOptions = {}) {
  const states = new Map<string, TargetState>();
  const allStates = new Set<TargetState>();
  let closing = false;
  let nextGeneration = 1;
  const closeState = async (state: TargetState, pending?: RunningManagedServer) => {
    if (state.closed) return;
    state.closed = true;
    state.unsubscribeDeath?.();
    state.unsubscribeDeath = null;
    const server = pending ?? state.serverHandle;
    state.serverHandle = null;
    state.startPromise = null;
    state.refCount = 0;
    if (states.get(state.targetKey) === state) states.delete(state.targetKey);
    allStates.delete(state);
    await server?.close();
  };
  const invalidateState = (state: TargetState) => {
    if (state.invalidated || state.closed) return;
    state.invalidated = true;
    if (states.get(state.targetKey) === state) states.delete(state.targetKey);
    for (const listener of state.invalidationListeners) listener();
    state.invalidationListeners.clear();
    if (state.serverHandle && state.refCount === 0) void closeState(state);
  };
  const readState = (targetKey: string, targetIdentity: string) => {
    const existing = states.get(targetKey);
    if (existing && !existing.invalidated) return existing;
    const state: TargetState = {
      targetKey,
      targetIdentity,
      generation: nextGeneration++,
      refCount: 0,
      invalidated: false,
      closed: false,
      startPromise: null,
      serverHandle: null,
      invalidationListeners: new Set(),
      unsubscribeDeath: null,
    };
    states.set(targetKey, state);
    allStates.add(state);
    return state;
  };
  const makeHandle = (
    server: RunningManagedServer,
    directory: string | undefined,
    state: TargetState,
    config: ManagedServerConfig,
  ): OpencodeServerHandle => {
    let released = false;
    const subscriptions = new Set<() => void>();
    const release = (invalidate: boolean) => {
      if (released) return;
      released = true;
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
      state.refCount = Math.max(0, state.refCount - 1);
      if (invalidate) invalidateState(state);
      else if (state.invalidated && state.refCount === 0) void closeState(state);
    };
    return {
      client: createOpencodeClient(buildClientOptions(config, server.url, directory)),
      url: server.url,
      generation: state.generation,
      release: () => release(false),
      invalidate: () => release(true),
      onInvalidated: (listener) => {
        if (state.invalidated) {
          listener();
          return () => undefined;
        }
        state.invalidationListeners.add(listener);
        const unsubscribe = () => state.invalidationListeners.delete(listener);
        subscriptions.add(unsubscribe);
        return () => {
          subscriptions.delete(unsubscribe);
          unsubscribe();
        };
      },
    };
  };
  const acquire = async (input?: OpencodeServerAcquireInput): Promise<OpencodeServerHandle> => {
    if (closing) throw new Error("OpenCode server manager is shutting down.");
    const config = SERVER_CONFIGS[input?.provider ?? "opencode"];
    const executionTargetId = resolveExecutionTargetId(input?.executionTargetId);
    const binaryPath = resolveBinaryPath(config, input?.binaryPath);
    const targetKey = JSON.stringify([config.provider, executionTargetId, binaryPath]);
    const targetIdentity = JSON.stringify([config.provider, executionTargetId]);
    for (const state of allStates)
      if (state.targetIdentity === targetIdentity && state.targetKey !== targetKey)
        invalidateState(state);
    let state = readState(targetKey, targetIdentity);
    if (state.serverHandle && state.serverHandle.isRunning?.() !== false) {
      state.refCount += 1;
      return makeHandle(state.serverHandle, input?.directory, state, config);
    }
    if (state.serverHandle) {
      invalidateState(state);
      state = readState(targetKey, targetIdentity);
    }
    if (!state.startPromise)
      state.startPromise = Promise.resolve()
        .then(
          () =>
            options.startServer?.({ config, executionTargetId, binaryPath }) ??
            startManagedServer({ config, executionTargetId, binaryPath }),
        )
        .catch((error) => {
          state.startPromise = null;
          if (states.get(targetKey) === state) states.delete(targetKey);
          allStates.delete(state);
          throw error;
        });
    const server = await state.startPromise;
    if (closing || state.invalidated) {
      await closeState(state, server);
      throw new Error(`${config.displayName} server start was superseded.`);
    }
    state.serverHandle = server;
    state.startPromise = null;
    state.unsubscribeDeath = server.onUnexpectedDeath?.(() => invalidateState(state)) ?? null;
    if (closing || state.invalidated) {
      await closeState(state, server);
      throw new Error(`${config.displayName} server start was superseded.`);
    }
    state.refCount += 1;
    return makeHandle(server, input?.directory, state, config);
  };
  const closeAll = async () => {
    closing = true;
    await Promise.all(
      [...allStates].map(async (state) =>
        closeState(
          state,
          state.serverHandle ??
            (state.startPromise ? await state.startPromise.catch(() => undefined) : undefined),
        ),
      ),
    );
    states.clear();
    allStates.clear();
  };
  return { acquire, closeAll };
}

export const OpencodeServerManagerLive = Layer.effect(
  OpencodeServerManager,
  Effect.acquireRelease(Effect.sync(makeOpencodeServerManager), (manager) =>
    Effect.promise(manager.closeAll),
  ).pipe(Effect.map(({ acquire }) => ({ acquire }))),
);
