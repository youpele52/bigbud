import { Effect, type Queue, Ref, Stream } from "effect";
import type * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  collectSessionConfigOptionValues,
  findSessionConfigOption,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
} from "./AcpRuntimeModel.ts";
import { makeStartMethods, type AcpStartState } from "./AcpSessionRuntime.start.ts";
import {
  closeActiveAssistantSegment,
  type AcpAssistantSegmentState,
} from "./AcpSessionRuntime.sessionUpdate.ts";

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

interface AcpSessionRuntimeMethodsDeps {
  readonly options: {
    readonly cwd: string;
    readonly resumeSessionId?: string;
    readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
    readonly clientInfo: {
      readonly name: string;
      readonly version: string;
    };
    readonly authMethodId: string;
    readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  };
  readonly acp: EffectAcpClient.AcpClientShape;
  readonly eventQueue: Queue.Queue<AcpParsedSessionEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly configOptionsRef: Ref.Ref<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly startStateRef: Ref.Ref<AcpStartState>;
}

export interface AcpSessionRuntimeMethods {
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

export function makeAcpSessionRuntimeMethods(
  deps: AcpSessionRuntimeMethodsDeps,
): AcpSessionRuntimeMethods {
  const logRequest = (event: AcpSessionRequestLogEvent) =>
    deps.options.requestLogger ? deps.options.requestLogger(event) : Effect.void;

  const runLoggedRequest = <A>(
    method: string,
    payload: unknown,
    effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
  ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
    logRequest({ method, payload, status: "started" }).pipe(
      Effect.flatMap(() =>
        effect.pipe(
          Effect.tap((result) =>
            logRequest({
              method,
              payload,
              status: "succeeded",
              result,
            }),
          ),
          Effect.onError((cause) =>
            logRequest({
              method,
              payload,
              status: "failed",
              cause,
            }),
          ),
        ),
      ),
    );

  const getStartedState = Effect.gen(function* () {
    const state = yield* Ref.get(deps.startStateRef);
    if (state._tag === "Started") {
      return state.result;
    }
    return yield* new EffectAcpErrors.AcpTransportError({
      detail: "ACP session runtime has not been started",
      cause: new Error("ACP session runtime has not been started"),
    });
  });

  const validateConfigOptionValue = (
    configId: string,
    value: string | boolean,
  ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
    Effect.gen(function* () {
      const configOption = findSessionConfigOption(yield* Ref.get(deps.configOptionsRef), configId);
      if (!configOption) {
        return;
      }
      if (configOption.type === "boolean") {
        if (typeof value === "boolean") {
          return;
        }
        return yield* invalidConfigValueError(configOption.id, "boolean", value);
      }
      if (typeof value !== "string") {
        return yield* invalidConfigValueError(configOption.id, "string", value);
      }
      const allowedValues = collectSessionConfigOptionValues(configOption);
      if (allowedValues.includes(value)) {
        return;
      }
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
        data: {
          configId: configOption.id,
          allowedValues,
          receivedValue: value,
        },
      });
    });

  const updateConfigOptions = (
    response:
      | EffectAcpSchema.SetSessionConfigOptionResponse
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse,
  ): Effect.Effect<void> => Ref.set(deps.configOptionsRef, sessionConfigOptionsFromSetup(response));

  const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
    Ref.update(deps.modeStateRef, (current) =>
      current ? { ...current, currentModeId: modeId } : current,
    );

  const setConfigOption = (
    configId: string,
    value: string | boolean,
  ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
    validateConfigOptionValue(configId, value).pipe(
      Effect.flatMap(() => getStartedState),
      Effect.flatMap((started) =>
        Ref.get(deps.configOptionsRef).pipe(
          Effect.flatMap((configOptions) => {
            const existing = findSessionConfigOption(configOptions, configId);
            if (existing && configOptionCurrentValueMatches(existing, value)) {
              return Effect.succeed({
                configOptions,
              } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
            }
            const requestPayload =
              typeof value === "boolean"
                ? ({
                    sessionId: started.sessionId,
                    configId,
                    type: "boolean",
                    value,
                  } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                : ({
                    sessionId: started.sessionId,
                    configId,
                    value: String(value),
                  } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
            return runLoggedRequest(
              "session/set_config_option",
              requestPayload,
              deps.acp.agent.setSessionConfigOption(requestPayload),
            ).pipe(Effect.tap((response) => updateConfigOptions(response)));
          }),
        ),
      ),
    );

  const { start } = makeStartMethods(deps, runLoggedRequest);

  return {
    start: () => start,
    getEvents: () => Stream.fromQueue(deps.eventQueue),
    getModeState: Ref.get(deps.modeStateRef),
    getConfigOptions: Ref.get(deps.configOptionsRef),
    prompt: (payload) =>
      getStartedState.pipe(
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId: started.sessionId,
            ...payload,
          } satisfies EffectAcpSchema.PromptRequest;
          return closeActiveAssistantSegment({
            queue: deps.eventQueue,
            assistantSegmentRef: deps.assistantSegmentRef,
          }).pipe(
            Effect.andThen(
              runLoggedRequest(
                "session/prompt",
                requestPayload,
                deps.acp.agent.prompt(requestPayload),
              ),
            ),
            Effect.tap(() =>
              closeActiveAssistantSegment({
                queue: deps.eventQueue,
                assistantSegmentRef: deps.assistantSegmentRef,
              }),
            ),
          );
        }),
      ),
    cancel: getStartedState.pipe(
      Effect.flatMap((started) => deps.acp.agent.cancel({ sessionId: started.sessionId })),
    ),
    setMode: (modeId) =>
      Ref.get(deps.modeStateRef).pipe(
        Effect.flatMap((modeState) => {
          if (modeState?.currentModeId === modeId) {
            return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
          }
          return setConfigOption("mode", modeId).pipe(
            Effect.tap(() => updateCurrentModeId(modeId)),
            Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
          );
        }),
      ),
    setConfigOption,
    setModel: (model) =>
      getStartedState.pipe(
        Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
        Effect.asVoid,
      ),
    request: (method, payload) =>
      runLoggedRequest(method, payload, deps.acp.raw.request(method, payload)),
    notify: deps.acp.raw.notify,
  };
}

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
        readonly sessionId?: string;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

function invalidConfigValueError(
  configId: string,
  expectedType: "boolean" | "string",
  receivedValue: string | boolean,
) {
  return new EffectAcpErrors.AcpRequestError({
    code: -32602,
    errorMessage: `Invalid value ${JSON.stringify(receivedValue)} for session config option "${configId}": expected ${expectedType}`,
    data: {
      configId,
      expectedType,
      receivedValue,
    },
  });
}
