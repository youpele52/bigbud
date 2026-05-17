import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AcpError from "./errors.ts";
import type * as AcpProtocol from "./protocol.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import {
  decodeExtNotificationRegistration,
  decodeExtRequestRegistration,
} from "./_internal/shared.ts";

export interface AcpClientCoreRequestHandlers {
  requestPermission?: (
    request: AcpSchema.RequestPermissionRequest,
  ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>;
  elicitation?: (
    request: AcpSchema.ElicitationRequest,
  ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>;
  readTextFile?: (
    request: AcpSchema.ReadTextFileRequest,
  ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>;
  writeTextFile?: (
    request: AcpSchema.WriteTextFileRequest,
  ) => Effect.Effect<AcpSchema.WriteTextFileResponse | void, AcpError.AcpError>;
  createTerminal?: (
    request: AcpSchema.CreateTerminalRequest,
  ) => Effect.Effect<AcpSchema.CreateTerminalResponse, AcpError.AcpError>;
  terminalOutput?: (
    request: AcpSchema.TerminalOutputRequest,
  ) => Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>;
  terminalWaitForExit?: (
    request: AcpSchema.WaitForTerminalExitRequest,
  ) => Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>;
  terminalKill?: (
    request: AcpSchema.KillTerminalRequest,
  ) => Effect.Effect<AcpSchema.KillTerminalResponse | void, AcpError.AcpError>;
  terminalRelease?: (
    request: AcpSchema.ReleaseTerminalRequest,
  ) => Effect.Effect<AcpSchema.ReleaseTerminalResponse | void, AcpError.AcpError>;
}

interface BufferedNotificationHandler<A> {
  readonly handlers: Array<(notification: A) => Effect.Effect<void, AcpError.AcpError>>;
  readonly pending: Array<A>;
}

interface AcpNotificationHandlers {
  readonly sessionUpdate: BufferedNotificationHandler<AcpSchema.SessionNotification>;
  readonly elicitationComplete: BufferedNotificationHandler<AcpSchema.ElicitationCompleteNotification>;
}

export interface AcpClientRegistrationShape {
  readonly handleRequestPermission: (
    handler: (
      request: AcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleElicitation: (
    handler: (
      request: AcpSchema.ElicitationRequest,
    ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleReadTextFile: (
    handler: (
      request: AcpSchema.ReadTextFileRequest,
    ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleWriteTextFile: (
    handler: (
      request: AcpSchema.WriteTextFileRequest,
    ) => Effect.Effect<AcpSchema.WriteTextFileResponse | void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleCreateTerminal: (
    handler: (
      request: AcpSchema.CreateTerminalRequest,
    ) => Effect.Effect<AcpSchema.CreateTerminalResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleTerminalOutput: (
    handler: (
      request: AcpSchema.TerminalOutputRequest,
    ) => Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleTerminalWaitForExit: (
    handler: (
      request: AcpSchema.WaitForTerminalExitRequest,
    ) => Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleTerminalKill: (
    handler: (
      request: AcpSchema.KillTerminalRequest,
    ) => Effect.Effect<AcpSchema.KillTerminalResponse | void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleTerminalRelease: (
    handler: (
      request: AcpSchema.ReleaseTerminalRequest,
    ) => Effect.Effect<AcpSchema.ReleaseTerminalResponse | void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleSessionUpdate: (
    handler: (
      notification: AcpSchema.SessionNotification,
    ) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleElicitationComplete: (
    handler: (
      notification: AcpSchema.ElicitationCompleteNotification,
    ) => Effect.Effect<void, AcpError.AcpError>,
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

export interface AcpClientHandlerRuntime {
  readonly coreHandlers: AcpClientCoreRequestHandlers;
  readonly dispatchNotification: (
    notification: AcpProtocol.AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
  readonly dispatchExtRequest: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly registration: AcpClientRegistrationShape;
}

export function makeClientHandlerRuntime(): AcpClientHandlerRuntime {
  const coreHandlers: AcpClientCoreRequestHandlers = {};
  const notificationHandlers: AcpNotificationHandlers = {
    sessionUpdate: { handlers: [], pending: [] },
    elicitationComplete: { handlers: [], pending: [] },
  };
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

  const runNotificationHandlers = <A>(
    registration: BufferedNotificationHandler<A>,
    notification: A,
  ) =>
    Effect.forEach(
      registration.handlers,
      (handler) => handler(notification).pipe(Effect.catch(() => Effect.void)),
      { discard: true },
    );

  const flushBufferedNotifications = <A>(registration: BufferedNotificationHandler<A>) =>
    Effect.suspend(() => {
      if (registration.handlers.length === 0 || registration.pending.length === 0) {
        return Effect.void;
      }
      const pending = registration.pending.splice(0, registration.pending.length);
      return Effect.forEach(
        pending,
        (notification) => runNotificationHandlers(registration, notification),
        { discard: true },
      );
    });

  return {
    coreHandlers,
    dispatchNotification: (notification) => {
      switch (notification._tag) {
        case "SessionUpdate": {
          if (notificationHandlers.sessionUpdate.handlers.length === 0) {
            notificationHandlers.sessionUpdate.pending.push(notification.params);
            return Effect.void;
          }
          return runNotificationHandlers(notificationHandlers.sessionUpdate, notification.params);
        }
        case "ElicitationComplete": {
          if (notificationHandlers.elicitationComplete.handlers.length === 0) {
            notificationHandlers.elicitationComplete.pending.push(notification.params);
            return Effect.void;
          }
          return runNotificationHandlers(
            notificationHandlers.elicitationComplete,
            notification.params,
          );
        }
        case "ExtNotification": {
          const handler = extNotificationHandlers.get(notification.method);
          if (handler) {
            return handler(notification.params);
          }
          return unknownExtNotificationHandler
            ? unknownExtNotificationHandler(notification.method, notification.params)
            : Effect.void;
        }
      }
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
      handleRequestPermission: (handler) =>
        Effect.suspend(() => {
          coreHandlers.requestPermission = handler;
          return Effect.void;
        }),
      handleElicitation: (handler) =>
        Effect.suspend(() => {
          coreHandlers.elicitation = handler;
          return Effect.void;
        }),
      handleReadTextFile: (handler) =>
        Effect.suspend(() => {
          coreHandlers.readTextFile = handler;
          return Effect.void;
        }),
      handleWriteTextFile: (handler) =>
        Effect.suspend(() => {
          coreHandlers.writeTextFile = handler;
          return Effect.void;
        }),
      handleCreateTerminal: (handler) =>
        Effect.suspend(() => {
          coreHandlers.createTerminal = handler;
          return Effect.void;
        }),
      handleTerminalOutput: (handler) =>
        Effect.suspend(() => {
          coreHandlers.terminalOutput = handler;
          return Effect.void;
        }),
      handleTerminalWaitForExit: (handler) =>
        Effect.suspend(() => {
          coreHandlers.terminalWaitForExit = handler;
          return Effect.void;
        }),
      handleTerminalKill: (handler) =>
        Effect.suspend(() => {
          coreHandlers.terminalKill = handler;
          return Effect.void;
        }),
      handleTerminalRelease: (handler) =>
        Effect.suspend(() => {
          coreHandlers.terminalRelease = handler;
          return Effect.void;
        }),
      handleSessionUpdate: (handler) =>
        Effect.suspend(() => {
          notificationHandlers.sessionUpdate.handlers.push(handler);
          return flushBufferedNotifications(notificationHandlers.sessionUpdate);
        }),
      handleElicitationComplete: (handler) =>
        Effect.suspend(() => {
          notificationHandlers.elicitationComplete.handlers.push(handler);
          return flushBufferedNotifications(notificationHandlers.elicitationComplete);
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
