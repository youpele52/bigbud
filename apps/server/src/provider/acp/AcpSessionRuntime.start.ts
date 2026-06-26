import { Deferred, Effect, Exit, Ref } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  extractModelConfigId,
  parseSessionModeState,
  type AcpSessionModeState,
} from "./AcpRuntimeModel.ts";

import type {
  AcpSessionRequestLogEvent,
  AcpSessionRuntimeStartResult,
} from "./AcpSessionRuntime.methods.ts";

export type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpSessionRuntimeStartResult };

interface AcpSessionRuntimeStartDeps {
  readonly options: {
    readonly cwd: string;
    readonly resumeSessionId?: string;
    readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
    readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
    readonly clientInfo: {
      readonly name: string;
      readonly version: string;
    };
    readonly authMethodId?: string;
    readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  };
  readonly acp: {
    readonly agent: {
      readonly initialize: (
        payload: EffectAcpSchema.InitializeRequest,
      ) => Effect.Effect<EffectAcpSchema.InitializeResponse, EffectAcpErrors.AcpError>;
      readonly authenticate: (
        payload: EffectAcpSchema.AuthenticateRequest,
      ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
      readonly loadSession: (
        payload: EffectAcpSchema.LoadSessionRequest,
      ) => Effect.Effect<EffectAcpSchema.LoadSessionResponse, EffectAcpErrors.AcpError>;
      readonly createSession: (
        payload: EffectAcpSchema.NewSessionRequest,
      ) => Effect.Effect<EffectAcpSchema.NewSessionResponse, EffectAcpErrors.AcpError>;
    };
  };
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly configOptionsRef: Ref.Ref<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly startStateRef: Ref.Ref<AcpStartState>;
}

export function makeStartMethods(
  deps: AcpSessionRuntimeStartDeps,
  runLoggedRequest: <A>(
    method: string,
    payload: unknown,
    effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
  ) => Effect.Effect<A, EffectAcpErrors.AcpError>,
) {
  const initializeClientCapabilities = {
    fs: {
      readTextFile: false,
      writeTextFile: false,
      ...deps.options.clientCapabilities?.fs,
    },
    terminal: deps.options.clientCapabilities?.terminal ?? false,
    ...(deps.options.clientCapabilities?.auth
      ? { auth: deps.options.clientCapabilities.auth }
      : {}),
    ...(deps.options.clientCapabilities?.elicitation
      ? { elicitation: deps.options.clientCapabilities.elicitation }
      : {}),
    ...(deps.options.clientCapabilities?._meta
      ? { _meta: deps.options.clientCapabilities._meta }
      : {}),
  } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

  const startOnce = Effect.gen(function* () {
    const initializePayload = {
      protocolVersion: 1,
      clientCapabilities: initializeClientCapabilities,
      clientInfo: deps.options.clientInfo,
    } satisfies EffectAcpSchema.InitializeRequest;

    const initializeResult = yield* runLoggedRequest(
      "initialize",
      initializePayload,
      deps.acp.agent.initialize(initializePayload),
    );

    const authMethodId = resolveAuthMethodId(initializeResult, deps.options.authMethodId);
    if (authMethodId) {
      const authenticatePayload = {
        methodId: authMethodId,
      } satisfies EffectAcpSchema.AuthenticateRequest;

      yield* runLoggedRequest(
        "authenticate",
        authenticatePayload,
        deps.acp.agent.authenticate(authenticatePayload),
      );
    }

    const { sessionId, sessionSetupResult } = yield* loadOrCreateSession(deps, runLoggedRequest);
    yield* Ref.set(deps.modeStateRef, parseSessionModeState(sessionSetupResult));
    yield* Ref.set(deps.configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

    return {
      sessionId,
      initializeResult,
      sessionSetupResult,
      modelConfigId: extractModelConfigId(sessionSetupResult),
    } satisfies AcpSessionRuntimeStartResult;
  });

  const start = Effect.gen(function* () {
    const deferred = yield* Deferred.make<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>();
    const effect = yield* Ref.modify(deps.startStateRef, (state) => {
      switch (state._tag) {
        case "Started":
          return [Effect.succeed(state.result), state] as const;
        case "Starting":
          return [Deferred.await(state.deferred), state] as const;
        case "NotStarted":
          return [
            startOnce.pipe(
              Effect.tap((result) =>
                Ref.set(deps.startStateRef, { _tag: "Started", result }).pipe(
                  Effect.andThen(Deferred.succeed(deferred, result)),
                ),
              ),
              Effect.onError((cause) =>
                Deferred.failCause(deferred, cause).pipe(
                  Effect.andThen(Ref.set(deps.startStateRef, { _tag: "NotStarted" })),
                ),
              ),
            ),
            { _tag: "Starting", deferred } satisfies AcpStartState,
          ] as const;
      }
    });
    return yield* effect;
  });

  return { start };
}

function resolveAuthMethodId(
  initializeResult: EffectAcpSchema.InitializeResponse,
  preferredAuthMethodId: string | undefined,
): string | undefined {
  if (!preferredAuthMethodId) {
    return undefined;
  }
  const authMethods = initializeResult.authMethods ?? [];
  return (
    authMethods.find((method) => method.id === preferredAuthMethodId)?.id ?? authMethods[0]?.id
  );
}

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

function loadOrCreateSession(
  deps: Pick<AcpSessionRuntimeStartDeps, "options" | "acp">,
  runLoggedRequest: <A>(
    method: string,
    payload: unknown,
    effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
  ) => Effect.Effect<A, EffectAcpErrors.AcpError>,
): Effect.Effect<
  {
    readonly sessionId: string;
    readonly sessionSetupResult:
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse;
  },
  EffectAcpErrors.AcpError
> {
  if (deps.options.resumeSessionId) {
    const resumedSessionId = deps.options.resumeSessionId;
    const loadPayload = {
      sessionId: resumedSessionId,
      cwd: deps.options.cwd,
      mcpServers: deps.options.mcpServers ?? [],
    } satisfies EffectAcpSchema.LoadSessionRequest;
    return runLoggedRequest(
      "session/load",
      loadPayload,
      deps.acp.agent.loadSession(loadPayload),
    ).pipe(
      Effect.exit,
      Effect.flatMap((resumed) => {
        if (Exit.isSuccess(resumed)) {
          return Effect.succeed({
            sessionId: resumedSessionId,
            sessionSetupResult: resumed.value,
          });
        }
        return createSession(deps, runLoggedRequest);
      }),
    );
  }
  return createSession(deps, runLoggedRequest);
}

function createSession(
  deps: Pick<AcpSessionRuntimeStartDeps, "options" | "acp">,
  runLoggedRequest: <A>(
    method: string,
    payload: unknown,
    effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
  ) => Effect.Effect<A, EffectAcpErrors.AcpError>,
) {
  const createPayload = {
    cwd: deps.options.cwd,
    mcpServers: deps.options.mcpServers ?? [],
  } satisfies EffectAcpSchema.NewSessionRequest;
  return runLoggedRequest(
    "session/new",
    createPayload,
    deps.acp.agent.createSession(createPayload),
  ).pipe(
    Effect.map((sessionSetupResult) => ({
      sessionId: sessionSetupResult.sessionId,
      sessionSetupResult,
    })),
  );
}
