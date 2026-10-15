import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Schema } from "effect";
import { BrowserAction, ComputerUseAction, ThreadId } from "@bigbud/contracts";

import { ServerConfig } from "../startup/config.ts";
import {
  isThreadOrchestrationToolAuthorized,
  readThreadOrchestrationToolAuthByToken,
} from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { getThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import {
  readCapabilityGuide,
  searchCapabilities,
  type CapabilityGuideSection,
} from "../capabilities/CapabilityCatalog.operations.ts";
import { getEffectiveCapabilityCatalog } from "../capabilities/CapabilityCatalog.dynamic.ts";
import { ThreadToolRequest, ThreadToolRequestError } from "./http.threadTools.schema.ts";
import { handleCreateThreadAction } from "./http.threadTools.createThread.ts";
import {
  handleGetThreadStatusAction,
  handleListAvailableModelsAction,
  handleListPinnedThreadsAction,
  handleListThreadsAction,
} from "./http.threadTools.reads.ts";
import { runRemoteWorkspaceProcess } from "./http.threadTools.remoteWorkspace.ts";
import { handleRenameThreadAction } from "./http.threadTools.rename.ts";
import { enterThreadToolInvocation } from "../orchestration-tools/threadToolInvocationFlights.ts";

const THREAD_TOOLS_PATH = "/api/internal/thread-tools";
const decodeComputerUseAction = Schema.decodeUnknownSync(ComputerUseAction);
const decodeBrowserAction = Schema.decodeUnknownSync(BrowserAction);

export const threadOrchestrationToolsRouteLayer = HttpRouter.add(
  "POST",
  THREAD_TOOLS_PATH,
  Effect.suspend(() => {
    // Ends the in-process flight only when this handler fiber has ended (including interruption).
    let leave: (() => void) | undefined;
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const config = yield* ServerConfig;
      const dispatcher = getThreadOrchestrationToolDispatcher();
      if (!dispatcher) {
        return yield* new ThreadToolRequestError({
          status: 503,
          message: "Thread orchestration tools are not ready.",
        });
      }

      const body = yield* request.json.pipe(
        Effect.flatMap((value) =>
          Schema.decodeEffect(ThreadToolRequest)(value as typeof ThreadToolRequest.Type),
        ),
        Effect.mapError(
          () =>
            new ThreadToolRequestError({
              status: 400,
              message: "Invalid thread tool request.",
            }),
        ),
      );
      if (body.invocationId) {
        leave = enterThreadToolInvocation(body.invocationId);
        if (!leave)
          return yield* new ThreadToolRequestError({
            status: 409,
            message: "Thread tool invocation was abandoned by its caller.",
          });
      }

      const token = request.headers["x-bigbud-thread-tool-token"];
      if (!token) {
        return yield* new ThreadToolRequestError({
          status: 401,
          message: "Unauthorized thread tool request.",
        });
      }
      const authRecord = yield* Effect.tryPromise({
        try: () => readThreadOrchestrationToolAuthByToken({ stateDir: config.stateDir, token }),
        catch: () => null,
      });

      if (
        authRecord === null ||
        !isThreadOrchestrationToolAuthorized({
          record: authRecord,
          threadId: authRecord?.threadId ?? "",
          token,
        })
      ) {
        return yield* new ThreadToolRequestError({
          status: 401,
          message: "Unauthorized thread tool request.",
        });
      }
      const threadId = ThreadId.makeUnsafe(authRecord.threadId);
      const capabilityCatalog = getEffectiveCapabilityCatalog(threadId);

      if (body.action === "get_system_resources") {
        const result = dispatcher.getSystemResources
          ? yield* dispatcher
              .getSystemResources()
              .pipe(
                Effect.catch(() =>
                  Effect.succeed({ available: false, reason: "desktop monitor unavailable" }),
                ),
              )
          : { available: false, reason: "desktop monitor unavailable" };
        return yield* HttpServerResponse.json({ ok: true, result });
      }

      if (body.action === "remote_workspace_process") {
        const result = yield* runRemoteWorkspaceProcess({
          callerThreadId: threadId,
          request: body,
        });
        return yield* HttpServerResponse.json({ ok: true, result });
      }

      if (body.action === "workspace") {
        if (!dispatcher.workspace) {
          return yield* new ThreadToolRequestError({
            status: 503,
            message: "Workspace tools are not ready.",
          });
        }
        if (!body.workspaceTool) {
          return yield* new ThreadToolRequestError({
            status: 400,
            message: "Workspace tool is required.",
          });
        }
        const result = yield* dispatcher
          .workspace({
            callerThreadId: threadId,
            tool: body.workspaceTool,
            arguments: body.workspaceArguments ?? {},
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ThreadToolRequestError({
                  status: error.message.includes("not found") ? 404 : 400,
                  message: error.message,
                }),
            ),
          );
        return yield* HttpServerResponse.json({ ok: true, result });
      }

      if (body.action === "search_capabilities") {
        return yield* HttpServerResponse.json({
          ok: true,
          result: searchCapabilities(body.query ?? "", capabilityCatalog),
        });
      }

      if (body.action === "read_capability_guide") {
        const capabilityId = body.capabilityId?.trim() ?? "";
        if (capabilityId.length === 0) {
          return yield* new ThreadToolRequestError({
            status: 400,
            message: "Capability ID is required.",
          });
        }
        const result = yield* Effect.try({
          try: () =>
            readCapabilityGuide({
              capabilityId,
              ...(capabilityCatalog ? { catalog: capabilityCatalog } : {}),
              ...(body.section ? { section: body.section as CapabilityGuideSection } : {}),
            }),
          catch: (error) =>
            new ThreadToolRequestError({
              status: 404,
              message: error instanceof Error ? error.message : "Capability was not found.",
            }),
        });
        return yield* HttpServerResponse.json({ ok: true, result });
      }

      if (body.action === "create_thread") {
        return yield* handleCreateThreadAction({ dispatcher, callerThreadId: threadId, body });
      }

      if (body.action === "send_thread_message") {
        if (!dispatcher.sendMessage) {
          return yield* new ThreadToolRequestError({
            status: 503,
            message: "Thread messaging is not ready.",
          });
        }
        const targetThreadId = body.threadId?.trim() ?? "";
        const invocationId = body.invocationId?.trim() ?? "";
        if (!targetThreadId || !invocationId) {
          return yield* new ThreadToolRequestError({
            status: 400,
            message: "threadId and invocationId are required.",
          });
        }
        const result = yield* dispatcher
          .sendMessage({
            callerThreadId: threadId,
            threadId: ThreadId.makeUnsafe(targetThreadId),
            message: body.message ?? "",
            delivery: body.delivery ?? "auto",
            invocationId,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ThreadToolRequestError({
                  status: error.message.includes("not found") ? 404 : 400,
                  message: error.message,
                }),
            ),
          );
        return yield* HttpServerResponse.json({ ok: true, result });
      }

      if (
        body.action === "list_pinned" ||
        body.action === "get_status" ||
        body.action === "list_threads" ||
        body.action === "list_available_models"
      ) {
        const readAction = { dispatcher, callerThreadId: threadId, body };
        if (body.action === "list_pinned") {
          return yield* handleListPinnedThreadsAction(readAction);
        }
        if (body.action === "list_available_models") {
          return yield* handleListAvailableModelsAction(readAction);
        }
        if (body.action === "get_status") {
          return yield* handleGetThreadStatusAction(readAction);
        }
        return yield* handleListThreadsAction(readAction);
      }

      if (body.action === "pin" || body.action === "unpin") {
        const targetThreadId = body.threadId?.trim() ?? "";
        if (targetThreadId.length === 0) {
          return yield* new ThreadToolRequestError({
            status: 400,
            message: "Thread ID is required.",
          });
        }
        const result = yield* dispatcher
          .setPinned({
            callerThreadId: threadId,
            threadId: ThreadId.makeUnsafe(targetThreadId),
            pinned: body.action === "pin",
          })
          .pipe(
            Effect.mapError((error) => {
              const message =
                error instanceof Error ? error.message : "Failed to update pinned thread.";
              return new ThreadToolRequestError({
                status: message.includes("not found") ? 404 : 400,
                message,
              });
            }),
          );
        return yield* HttpServerResponse.json({ ok: true, result });
      }

      if (body.action === "rename") {
        return yield* handleRenameThreadAction({ dispatcher, callerThreadId: threadId, body });
      }

      if (body.action === "computer_use") {
        const computerUseAction = yield* Effect.try({
          try: () => decodeComputerUseAction(body.computerUseAction),
          catch: () =>
            new ThreadToolRequestError({
              status: 400,
              message: "Invalid computer-use action.",
            }),
        });
        const result = yield* dispatcher
          .computerUse({
            threadId,
            action: computerUseAction,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ThreadToolRequestError({
                  status: 400,
                  message: error instanceof Error ? error.message : "Computer-use action failed.",
                }),
            ),
          );
        return yield* HttpServerResponse.json({ ok: true, result });
      }

      if (body.action === "browser") {
        const browserAction = yield* Effect.try({
          try: () => decodeBrowserAction(body.browserAction),
          catch: () =>
            new ThreadToolRequestError({ status: 400, message: "Invalid browser action." }),
        });
        const result = yield* dispatcher.browser({ threadId, action: browserAction }).pipe(
          Effect.mapError(
            (error) =>
              new ThreadToolRequestError({
                status: 400,
                message: error instanceof Error ? error.message : "Browser action failed.",
              }),
          ),
        );
        return yield* HttpServerResponse.json({ ok: true, result });
      }

      if (body.threadId === undefined || body.threadId !== authRecord.threadId) {
        return yield* new ThreadToolRequestError({
          status: body.threadId === undefined ? 400 : 401,
          message:
            body.threadId === undefined
              ? "Current thread ID is required."
              : "Unauthorized thread tool request.",
        });
      }
      yield* dispatcher.archive({ threadId }).pipe(
        Effect.mapError(
          (error) =>
            new ThreadToolRequestError({
              status: 400,
              message: error instanceof Error ? error.message : "Failed to archive thread.",
            }),
        ),
      );
      return yield* HttpServerResponse.json({ ok: true, archived: true });
    }).pipe(Effect.ensuring(Effect.sync(() => leave?.())));
  }).pipe(
    Effect.catchTag("ThreadToolRequestError", (error) =>
      HttpServerResponse.json({ ok: false, message: error.message }, { status: error.status }),
    ),
    Effect.catch(() =>
      HttpServerResponse.json(
        { ok: false, message: "Thread tool request failed." },
        { status: 500 },
      ),
    ),
  ),
);
