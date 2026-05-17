import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { AGENT_METHODS } from "./_generated/meta.gen.ts";
import {
  decodeExtNotificationRegistration,
  decodeExtRequestRegistration,
} from "./_internal/shared.ts";
import * as AcpError from "./errors.ts";
import type * as AcpProtocol from "./protocol.ts";

export interface AcpAgentCoreRequestHandlers {
  initialize?: (
    request: AcpSchema.InitializeRequest,
  ) => Effect.Effect<AcpSchema.InitializeResponse, AcpError.AcpError>;
  authenticate?: (
    request: AcpSchema.AuthenticateRequest,
  ) => Effect.Effect<AcpSchema.AuthenticateResponse, AcpError.AcpError>;
  logout?: (
    request: AcpSchema.LogoutRequest,
  ) => Effect.Effect<AcpSchema.LogoutResponse, AcpError.AcpError>;
  createSession?: (
    request: AcpSchema.NewSessionRequest,
  ) => Effect.Effect<AcpSchema.NewSessionResponse, AcpError.AcpError>;
  loadSession?: (
    request: AcpSchema.LoadSessionRequest,
  ) => Effect.Effect<AcpSchema.LoadSessionResponse, AcpError.AcpError>;
  listSessions?: (
    request: AcpSchema.ListSessionsRequest,
  ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>;
  forkSession?: (
    request: AcpSchema.ForkSessionRequest,
  ) => Effect.Effect<AcpSchema.ForkSessionResponse, AcpError.AcpError>;
  resumeSession?: (
    request: AcpSchema.ResumeSessionRequest,
  ) => Effect.Effect<AcpSchema.ResumeSessionResponse, AcpError.AcpError>;
  closeSession?: (
    request: AcpSchema.CloseSessionRequest,
  ) => Effect.Effect<AcpSchema.CloseSessionResponse, AcpError.AcpError>;
  setSessionModel?: (
    request: AcpSchema.SetSessionModelRequest,
  ) => Effect.Effect<AcpSchema.SetSessionModelResponse, AcpError.AcpError>;
  setSessionConfigOption?: (
    request: AcpSchema.SetSessionConfigOptionRequest,
  ) => Effect.Effect<AcpSchema.SetSessionConfigOptionResponse, AcpError.AcpError>;
  prompt?: (
    request: AcpSchema.PromptRequest,
  ) => Effect.Effect<AcpSchema.PromptResponse, AcpError.AcpError>;
}

export interface AcpAgentRegistrationShape {
  readonly handleInitialize: (
    handler: (
      request: AcpSchema.InitializeRequest,
    ) => Effect.Effect<AcpSchema.InitializeResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleAuthenticate: (
    handler: (
      request: AcpSchema.AuthenticateRequest,
    ) => Effect.Effect<AcpSchema.AuthenticateResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleLogout: (
    handler: (
      request: AcpSchema.LogoutRequest,
    ) => Effect.Effect<AcpSchema.LogoutResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleCreateSession: (
    handler: (
      request: AcpSchema.NewSessionRequest,
    ) => Effect.Effect<AcpSchema.NewSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleLoadSession: (
    handler: (
      request: AcpSchema.LoadSessionRequest,
    ) => Effect.Effect<AcpSchema.LoadSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleListSessions: (
    handler: (
      request: AcpSchema.ListSessionsRequest,
    ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleForkSession: (
    handler: (
      request: AcpSchema.ForkSessionRequest,
    ) => Effect.Effect<AcpSchema.ForkSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleResumeSession: (
    handler: (
      request: AcpSchema.ResumeSessionRequest,
    ) => Effect.Effect<AcpSchema.ResumeSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleCloseSession: (
    handler: (
      request: AcpSchema.CloseSessionRequest,
    ) => Effect.Effect<AcpSchema.CloseSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleSetSessionModel: (
    handler: (
      request: AcpSchema.SetSessionModelRequest,
    ) => Effect.Effect<AcpSchema.SetSessionModelResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleSetSessionConfigOption: (
    handler: (
      request: AcpSchema.SetSessionConfigOptionRequest,
    ) => Effect.Effect<AcpSchema.SetSessionConfigOptionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handlePrompt: (
    handler: (
      request: AcpSchema.PromptRequest,
    ) => Effect.Effect<AcpSchema.PromptResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleCancel: (
    handler: (notification: AcpSchema.CancelNotification) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleUnknownExtRequest: (
    handler: (method: string, params: unknown) => Effect.Effect<unknown, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleUnknownExtNotification: (
    handler: (method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleExtRequest: <A, I>(
    method: string,
    payload: Schema.Codec<A, I>,
    handler: (payload: A) => Effect.Effect<unknown, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleExtNotification: <A, I>(
    method: string,
    payload: Schema.Codec<A, I>,
    handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
}

export interface AcpAgentHandlerRuntime {
  readonly coreHandlers: AcpAgentCoreRequestHandlers;
  readonly dispatchNotification: (
    notification: AcpProtocol.AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
  readonly dispatchExtRequest: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly registration: AcpAgentRegistrationShape;
}

const decodeCancelNotification = Schema.decodeUnknownEffect(AcpSchema.CancelNotification);

export function makeAgentHandlerRuntime(): AcpAgentHandlerRuntime {
  const coreHandlers: AcpAgentCoreRequestHandlers = {};
  const cancelHandlers: Array<
    (notification: AcpSchema.CancelNotification) => Effect.Effect<void, AcpError.AcpError>
  > = [];
  const extRequestHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, AcpError.AcpError>
  >();
  const extNotificationHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<void, AcpError.AcpError>
  >();
  let unknownExtRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, AcpError.AcpError>)
    | undefined;
  let unknownExtNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>)
    | undefined;

  return {
    coreHandlers,
    dispatchNotification: (notification) => {
      if (
        notification._tag === "ExtNotification" &&
        notification.method === AGENT_METHODS.session_cancel
      ) {
        return decodeCancelNotification(notification.params).pipe(
          Effect.mapError(
            (error) =>
              new AcpError.AcpProtocolParseError({
                detail: `Invalid ${AGENT_METHODS.session_cancel} notification payload`,
                cause: error,
              }),
          ),
          Effect.flatMap((decoded) =>
            Effect.forEach(cancelHandlers, (handler) => handler(decoded), { discard: true }),
          ),
        );
      }

      if (notification._tag !== "ExtNotification") {
        return Effect.void;
      }

      const handler = extNotificationHandlers.get(notification.method);
      if (handler) {
        return handler(notification.params);
      }
      return unknownExtNotificationHandler
        ? unknownExtNotificationHandler(notification.method, notification.params)
        : Effect.void;
    },
    dispatchExtRequest: (method, params) => {
      const handler = extRequestHandlers.get(method);
      if (handler) {
        return handler(params);
      }
      return unknownExtRequestHandler
        ? unknownExtRequestHandler(method, params)
        : Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    },
    registration: {
      handleInitialize: (handler) =>
        Effect.suspend(() => {
          coreHandlers.initialize = handler;
          return Effect.void;
        }),
      handleAuthenticate: (handler) =>
        Effect.suspend(() => {
          coreHandlers.authenticate = handler;
          return Effect.void;
        }),
      handleLogout: (handler) =>
        Effect.suspend(() => {
          coreHandlers.logout = handler;
          return Effect.void;
        }),
      handleCreateSession: (handler) =>
        Effect.suspend(() => {
          coreHandlers.createSession = handler;
          return Effect.void;
        }),
      handleLoadSession: (handler) =>
        Effect.suspend(() => {
          coreHandlers.loadSession = handler;
          return Effect.void;
        }),
      handleListSessions: (handler) =>
        Effect.suspend(() => {
          coreHandlers.listSessions = handler;
          return Effect.void;
        }),
      handleForkSession: (handler) =>
        Effect.suspend(() => {
          coreHandlers.forkSession = handler;
          return Effect.void;
        }),
      handleResumeSession: (handler) =>
        Effect.suspend(() => {
          coreHandlers.resumeSession = handler;
          return Effect.void;
        }),
      handleCloseSession: (handler) =>
        Effect.suspend(() => {
          coreHandlers.closeSession = handler;
          return Effect.void;
        }),
      handleSetSessionModel: (handler) =>
        Effect.suspend(() => {
          coreHandlers.setSessionModel = handler;
          return Effect.void;
        }),
      handleSetSessionConfigOption: (handler) =>
        Effect.suspend(() => {
          coreHandlers.setSessionConfigOption = handler;
          return Effect.void;
        }),
      handlePrompt: (handler) =>
        Effect.suspend(() => {
          coreHandlers.prompt = handler;
          return Effect.void;
        }),
      handleCancel: (handler) =>
        Effect.suspend(() => {
          cancelHandlers.push(handler);
          return Effect.void;
        }),
      handleUnknownExtRequest: (handler) =>
        Effect.suspend(() => {
          unknownExtRequestHandler = handler;
          return Effect.void;
        }),
      handleUnknownExtNotification: (handler) =>
        Effect.suspend(() => {
          unknownExtNotificationHandler = handler;
          return Effect.void;
        }),
      handleExtRequest: (method, payload, handler) =>
        Effect.suspend(() => {
          extRequestHandlers.set(method, decodeExtRequestRegistration(method, payload, handler));
          return Effect.void;
        }),
      handleExtNotification: (method, payload, handler) =>
        Effect.suspend(() => {
          extNotificationHandlers.set(
            method,
            decodeExtNotificationRegistration(method, payload, handler),
          );
          return Effect.void;
        }),
    },
  };
}
