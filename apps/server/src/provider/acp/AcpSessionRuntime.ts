import { Deferred, Effect, Layer, Queue, Ref, Scope, ServiceMap, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import {
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";
import {
  makeAcpSessionRuntimeMethods,
  type AcpSessionRequestLogEvent as AcpSessionRequestLogEventShape,
  type AcpSessionRuntimeStartResult as AcpSessionRuntimeStartResultShape,
} from "./AcpSessionRuntime.methods.ts";
import {
  handleSessionUpdate,
  type AcpAssistantSegmentState,
} from "./AcpSessionRuntime.sessionUpdate.ts";

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId: string;
  readonly requestLogger?: (event: AcpSessionRequestLogEventShape) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: import("effect").Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

export interface AcpSessionRuntimeShape {
  readonly handleRequestPermission: EffectAcpClient.AcpClientShape["handleRequestPermission"];
  readonly handleElicitation: EffectAcpClient.AcpClientShape["handleElicitation"];
  readonly handleReadTextFile: EffectAcpClient.AcpClientShape["handleReadTextFile"];
  readonly handleWriteTextFile: EffectAcpClient.AcpClientShape["handleWriteTextFile"];
  readonly handleCreateTerminal: EffectAcpClient.AcpClientShape["handleCreateTerminal"];
  readonly handleTerminalOutput: EffectAcpClient.AcpClientShape["handleTerminalOutput"];
  readonly handleTerminalWaitForExit: EffectAcpClient.AcpClientShape["handleTerminalWaitForExit"];
  readonly handleTerminalKill: EffectAcpClient.AcpClientShape["handleTerminalKill"];
  readonly handleTerminalRelease: EffectAcpClient.AcpClientShape["handleTerminalRelease"];
  readonly handleSessionUpdate: EffectAcpClient.AcpClientShape["handleSessionUpdate"];
  readonly handleElicitationComplete: EffectAcpClient.AcpClientShape["handleElicitationComplete"];
  readonly handleUnknownExtRequest: EffectAcpClient.AcpClientShape["handleUnknownExtRequest"];
  readonly handleUnknownExtNotification: EffectAcpClient.AcpClientShape["handleUnknownExtNotification"];
  readonly handleExtRequest: EffectAcpClient.AcpClientShape["handleExtRequest"];
  readonly handleExtNotification: EffectAcpClient.AcpClientShape["handleExtNotification"];
  readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
  readonly getEvents: () => Stream.Stream<AcpParsedSessionEvent, never>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly notify: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export class AcpSessionRuntime extends ServiceMap.Service<
  AcpSessionRuntime,
  AcpSessionRuntimeShape
>()("bigcode/provider/acp/AcpSessionRuntime") {
  static layer(
    options: AcpSessionRuntimeOptions,
  ): Layer.Layer<
    AcpSessionRuntime,
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    return Layer.effect(AcpSessionRuntime, makeAcpSessionRuntime(options));
  }
}

const makeAcpSessionRuntime = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntimeShape,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    const configOptionsRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>(
      [],
    );
    const startStateRef = yield* Ref.make<
      | { readonly _tag: "NotStarted" }
      | {
          readonly _tag: "Starting";
          readonly deferred: Deferred.Deferred<
            AcpSessionRuntimeStartResultShape,
            EffectAcpErrors.AcpError
          >;
        }
      | { readonly _tag: "Started"; readonly result: AcpSessionRuntimeStartResultShape }
    >({ _tag: "NotStarted" });

    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.spawn.command, [...options.spawn.args], {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: { ...process.env, ...options.spawn.env } } : {}),
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

    yield* acp.handleSessionUpdate((notification) =>
      handleSessionUpdate({
        queue: eventQueue,
        modeStateRef,
        toolCallsRef,
        assistantSegmentRef,
        params: notification,
      }),
    );

    const methods = makeAcpSessionRuntimeMethods({
      options,
      acp,
      eventQueue,
      modeStateRef,
      assistantSegmentRef,
      configOptionsRef,
      startStateRef,
    });

    return {
      handleRequestPermission: acp.handleRequestPermission,
      handleElicitation: acp.handleElicitation,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleUnknownExtRequest: acp.handleUnknownExtRequest,
      handleUnknownExtNotification: acp.handleUnknownExtNotification,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      ...methods,
    } satisfies AcpSessionRuntimeShape;
  });
