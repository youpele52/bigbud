import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@bigbud/contracts";
import { Layer } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeClaudeAdapterLive, type ClaudeAdapterLiveOptions } from "./Adapter.ts";
import type {
  ClaudeInitializationResult,
  ClaudeInterruptReceipt,
  ClaudeContextUsage,
  ClaudeMcpPermissionModeOverrideResult,
  ClaudeMcpServerStatuses,
  ClaudeMcpSetServersResult,
  ClaudeQueryControlSurface,
  ClaudeQueryRuntime,
  ClaudeRewindFilesResult,
} from "./Adapter.sdk.ts";

export class FakeClaudeQuery implements ClaudeQueryRuntime {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private readonly controlFailures = new Map<keyof ClaudeQueryControlSurface, unknown>();
  private done = false;
  private failure: unknown | undefined;
  private initializationResponse: ClaudeInitializationResult | undefined;

  public interruptResult: ClaudeInterruptReceipt = undefined;
  public contextUsageResult: ClaudeContextUsage = {
    categories: [],
    totalTokens: 0,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 0,
    gridRows: [],
    model: "fake-claude",
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  };
  public mcpServerStatusesResult: ClaudeMcpServerStatuses = [
    { name: "bigbud_orchestration", status: "connected" },
    { name: "bigbud_remote_workspace", status: "connected" },
  ];
  public mcpPermissionModeOverrideResult: ClaudeMcpPermissionModeOverrideResult = {};
  public rewindFilesResult: ClaudeRewindFilesResult = {
    canRewind: false,
    error: "Fake Claude query rewind response was not configured.",
  };
  public setMcpServersResult: ClaudeMcpSetServersResult = {
    added: [],
    removed: [],
    errors: {},
  };

  public readonly interruptCalls: Array<void> = [];
  public readonly initializationResultCalls: Array<void> = [];
  public readonly reinitializeCalls: Array<void> = [];
  public readonly applyFlagSettingsCalls: Array<
    Parameters<ClaudeQueryRuntime["applyFlagSettings"]>[0]
  > = [];
  public readonly mcpServerStatusCalls: Array<void> = [];
  public readonly setMcpPermissionModeOverrideCalls: Array<{
    serverName: string;
    mode: Parameters<ClaudeQueryRuntime["setMcpPermissionModeOverride"]>[1];
  }> = [];
  public readonly reconnectMcpServerCalls: Array<string> = [];
  public readonly toggleMcpServerCalls: Array<{ serverName: string; enabled: boolean }> = [];
  public readonly setMcpServersCalls: Array<Parameters<ClaudeQueryRuntime["setMcpServers"]>[0]> =
    [];
  public readonly rewindFilesCalls: Array<{
    userMessageId: string;
    options?: Parameters<ClaudeQueryRuntime["rewindFiles"]>[1];
  }> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<
    Parameters<ClaudeQueryRuntime["setMaxThinkingTokens"]>
  > = [];
  public closeCalls = 0;
  public reopenOnReinitialize = false;
  public mcpConnectedAfterIteration = false;
  public iterationStarted = false;

  setInitializationResponse(response: ClaudeInitializationResult): void {
    this.initializationResponse = response;
  }

  failControl(name: keyof ClaudeQueryControlSurface, cause: unknown): void {
    this.controlFailures.set(name, cause);
  }

  private throwControlFailure(name: keyof ClaudeQueryControlSurface): void {
    if (!this.controlFailures.has(name)) {
      return;
    }
    const cause = this.controlFailures.get(name);
    this.controlFailures.delete(name);
    throw cause;
  }

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  /** Test-only malformed-wire seam; production query streams remain SDK-typed. */
  emitUnchecked(message: unknown): void {
    this.emit(message as SDKMessage);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly interrupt: ClaudeQueryRuntime["interrupt"] = async () => {
    this.interruptCalls.push(undefined);
    this.throwControlFailure("interrupt");
    return this.interruptResult;
  };

  readonly getContextUsage: ClaudeQueryRuntime["getContextUsage"] = async () => {
    this.throwControlFailure("getContextUsage");
    return this.contextUsageResult;
  };

  readonly initializationResult: ClaudeQueryRuntime["initializationResult"] = async () => {
    this.initializationResultCalls.push(undefined);
    this.throwControlFailure("initializationResult");
    if (!this.initializationResponse) {
      throw new Error("Fake Claude query initialization response was not configured.");
    }
    return this.initializationResponse;
  };

  readonly reinitialize: ClaudeQueryRuntime["reinitialize"] = async () => {
    this.reinitializeCalls.push(undefined);
    this.throwControlFailure("reinitialize");
    if (this.reopenOnReinitialize) {
      this.done = false;
      this.failure = undefined;
    }
    if (!this.initializationResponse) {
      throw new Error("Fake Claude query reinitialization response was not configured.");
    }
    return this.initializationResponse;
  };

  readonly applyFlagSettings: ClaudeQueryRuntime["applyFlagSettings"] = async (settings) => {
    this.applyFlagSettingsCalls.push(settings);
    this.throwControlFailure("applyFlagSettings");
  };

  readonly mcpServerStatus: ClaudeQueryRuntime["mcpServerStatus"] = async () => {
    this.mcpServerStatusCalls.push(undefined);
    this.throwControlFailure("mcpServerStatus");
    return this.mcpConnectedAfterIteration && !this.iterationStarted
      ? this.mcpServerStatusesResult.map((status) => ({ ...status, status: "pending" as const }))
      : this.mcpServerStatusesResult;
  };

  readonly setMcpPermissionModeOverride: ClaudeQueryRuntime["setMcpPermissionModeOverride"] =
    async (serverName, mode) => {
      this.setMcpPermissionModeOverrideCalls.push({ serverName, mode });
      this.throwControlFailure("setMcpPermissionModeOverride");
      return this.mcpPermissionModeOverrideResult;
    };

  readonly reconnectMcpServer: ClaudeQueryRuntime["reconnectMcpServer"] = async (serverName) => {
    this.reconnectMcpServerCalls.push(serverName);
    this.throwControlFailure("reconnectMcpServer");
  };

  readonly toggleMcpServer: ClaudeQueryRuntime["toggleMcpServer"] = async (serverName, enabled) => {
    this.toggleMcpServerCalls.push({ serverName, enabled });
    this.throwControlFailure("toggleMcpServer");
  };

  readonly setMcpServers: ClaudeQueryRuntime["setMcpServers"] = async (servers) => {
    this.setMcpServersCalls.push(servers);
    this.throwControlFailure("setMcpServers");
    return this.setMcpServersResult;
  };

  readonly rewindFiles: ClaudeQueryRuntime["rewindFiles"] = async (userMessageId, options) => {
    this.rewindFilesCalls.push({ userMessageId, ...(options ? { options } : {}) });
    this.throwControlFailure("rewindFiles");
    return this.rewindFilesResult;
  };

  readonly setModel: ClaudeQueryRuntime["setModel"] = async (model) => {
    this.setModelCalls.push(model);
    this.throwControlFailure("setModel");
  };

  readonly setPermissionMode: ClaudeQueryRuntime["setPermissionMode"] = async (mode) => {
    this.setPermissionModeCalls.push(mode);
    this.throwControlFailure("setPermissionMode");
  };

  readonly setMaxThinkingTokens: ClaudeQueryRuntime["setMaxThinkingTokens"] = async (
    maxThinkingTokens,
    thinkingDisplay,
  ) => {
    this.setMaxThinkingTokensCalls.push([maxThinkingTokens, thinkingDisplay]);
    this.throwControlFailure("setMaxThinkingTokens");
  };

  readonly close: ClaudeQueryRuntime["close"] = () => {
    this.closeCalls += 1;
    try {
      this.throwControlFailure("close");
    } finally {
      this.finish();
    }
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    this.iterationStarted = true;
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

export function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly remoteWorkspaceReadinessProbe?: ClaudeAdapterLiveOptions["remoteWorkspaceReadinessProbe"];
}) {
  const query = new FakeClaudeQuery();
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    remoteWorkspaceReadinessProbe:
      config?.remoteWorkspaceReadinessProbe ??
      (async () => ({ os: "linux", architecture: "x86_64" })),
    createQuery: (input) => {
      createInput = input;
      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: makeClaudeAdapterLive(adapterOptions).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}

export function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

export async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

export async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

export const THREAD_ID = ThreadId.makeUnsafe("thread-claude-1");
export const RESUME_THREAD_ID = ThreadId.makeUnsafe("thread-claude-resume");
