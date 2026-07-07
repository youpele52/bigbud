import {
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { type SessionConfig } from "@github/copilot-sdk";
import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";
import { Effect } from "effect";

import type { PendingApprovalRequest, PendingUserInputRequest } from "./Adapter.types.ts";
import {
  USER_INPUT_QUESTION_ID,
  getCopilotSessionApprovalMetadata,
  isCopilotModelSelection,
  requestDetailFromPermissionRequest,
  requestTypeFromPermissionRequest,
} from "./Adapter.types.ts";

export function buildSessionConfig(input: {
  readonly threadId: ThreadId;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly cwd?: string;
  readonly modelSelection?:
    | ProviderSendTurnInput["modelSelection"]
    | ProviderSession["resumeCursor"];
  readonly sessionConfigOverrides?: Partial<SessionConfig>;
  readonly pendingApprovals: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputs: Map<string, PendingUserInputRequest>;
  readonly activeTurnId: () => TurnId | undefined;
  readonly stoppedRef: { stopped: boolean };
  readonly emit: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors existing session deps typing
  readonly makeSyntheticEvent: (
    threadId: ThreadId,
    type: string,
    payload: any,
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ) => Effect.Effect<ProviderRuntimeEvent>;
}): SessionConfig {
  const systemMessage = input.sessionConfigOverrides?.systemMessage;

  return {
    ...(isCopilotModelSelection(input.modelSelection)
      ? {
          model: input.modelSelection.model,
          ...(input.modelSelection.options?.reasoningEffort
            ? { reasoningEffort: input.modelSelection.options.reasoningEffort }
            : {}),
        }
      : {}),
    ...(input.cwd ? { workingDirectory: input.cwd } : {}),
    streaming: true,
    systemMessage: {
      mode: "append",
      content:
        "You have access to a Chromium browser in this environment. " +
        "Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. " +
        "Prefer codebase inspection first when the task is local-only. " +
        "Summarize what was verified, including URL and important observations. " +
        "Avoid unnecessary browser use when terminal or file tools are sufficient." +
        (systemMessage?.content ? ` ${systemMessage.content}` : ""),
    },
    ...(input.sessionConfigOverrides?.excludedTools
      ? { excludedTools: input.sessionConfigOverrides.excludedTools }
      : {}),
    ...(input.sessionConfigOverrides?.tools ? { tools: input.sessionConfigOverrides.tools } : {}),
    ...(input.sessionConfigOverrides?.mcpServers
      ? { mcpServers: input.sessionConfigOverrides.mcpServers }
      : {}),
    ...(input.sessionConfigOverrides?.createSessionFsProvider
      ? { createSessionFsProvider: input.sessionConfigOverrides.createSessionFsProvider }
      : {}),
    onPermissionRequest: (request) => {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const currentTurnId = input.activeTurnId();
        const requestType = requestTypeFromPermissionRequest(request);
        const requestDetail = requestDetailFromPermissionRequest(request);
        const sessionApproval = getCopilotSessionApprovalMetadata(request);
        input.pendingApprovals.set(requestId, {
          request,
          requestType,
          turnId: currentTurnId,
          resolve,
        });

        void input
          .makeSyntheticEvent(
            input.threadId,
            "request.opened",
            {
              requestType,
              ...(requestDetail ? { detail: requestDetail } : {}),
              args: request,
              sessionApprovalAvailable: sessionApproval.available,
              ...(sessionApproval.label ? { sessionApprovalLabel: sessionApproval.label } : {}),
              ...(input.runtimeMode === "full-access"
                ? { autoApproveAfterMs: FULL_ACCESS_AUTO_APPROVE_AFTER_MS }
                : {}),
            },
            {
              ...(currentTurnId ? { turnId: currentTurnId } : {}),
              requestId,
            },
          )
          .pipe(
            Effect.flatMap((event) => input.emit([event])),
            Effect.runPromise,
          )
          .catch(() => undefined);

        if (input.runtimeMode === "full-access") {
          void Effect.gen(function* () {
            yield* Effect.sleep(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
            if (input.stoppedRef.stopped) {
              return;
            }
            const pending = input.pendingApprovals.get(requestId);
            if (!pending) {
              return;
            }

            input.pendingApprovals.delete(requestId);
            pending.resolve({ kind: "approve-once" });

            const event = yield* input.makeSyntheticEvent(
              input.threadId,
              "request.resolved",
              {
                requestType,
                decision: "accept",
              },
              {
                ...(currentTurnId ? { turnId: currentTurnId } : {}),
                requestId,
              },
            );
            yield* input.emit([event]);
          })
            .pipe(Effect.runPromise)
            .catch(() => undefined);
        }
      });
    },
    onUserInputRequest: (request, _invocation) =>
      new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const currentTurnId = input.activeTurnId();
        input.pendingUserInputs.set(requestId, {
          turnId: currentTurnId,
          choices: request.choices ?? [],
          resolve,
        });

        const question: UserInputQuestion = {
          id: USER_INPUT_QUESTION_ID,
          header: "Question",
          question: request.question,
          options: (request.choices ?? []).map((choice: string) => ({
            label: choice,
            description: choice,
          })),
        };

        void input
          .makeSyntheticEvent(
            input.threadId,
            "user-input.requested",
            { questions: [question] },
            {
              ...(currentTurnId ? { turnId: currentTurnId } : {}),
              requestId,
            },
          )
          .pipe(
            Effect.flatMap((event) => input.emit([event])),
            Effect.runPromise,
          )
          .catch(() => undefined);
      }),
  };
}
