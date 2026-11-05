/**
 * v2 desktop computer_use through orchestration (selected only when the pinned
 * Driver is 0.38.0). Applies the same thread gates as the legacy path
 * (enablement, desktop mode, full-access for mutations, check-in, hard
 * safety guards) and records the same started/terminal activities, then
 * executes through the supervised port. With no supervised port connected the
 * request fails closed with `control_unavailable`; it never reaches the
 * legacy Driver runtime.
 */
import type { ComputerUseAction, ThreadId } from "@bigbud/contracts";
import type {
  ComputerUseDesktopV2Action,
  ComputerUseDesktopV2Result,
} from "@bigbud/contracts/orchestration/computerUseDesktopV2.ts";
import {
  DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS,
  DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS,
} from "@bigbud/contracts/settings";
import { Cause, Effect, Exit, Option } from "effect";

import { guardComputerUseAction } from "../computer-use/computerUseSafety.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  computerUseV2RequestActionName,
  refusedComputerUseV2Result,
  type ComputerUseV2ToolRequest,
} from "./computerUseToolRequest.ts";
import { appendComputerUseActivity } from "./ThreadComputerUseTools.activity.ts";
import {
  hasComputerUseCheckInExpired,
  isMutatingComputerUseActionName,
} from "./ThreadComputerUseTools.ts";

/** The native supervised owner client; absent until the transport is wired. */
export interface SupervisedComputerUsePort {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly operationId: string;
    readonly action: ComputerUseDesktopV2Action;
  }) => Effect.Effect<ComputerUseDesktopV2Result, Error>;
}

/** Legacy-shaped view of exactly the fields the hard safety guard reads. */
function legacyGuardView(action: ComputerUseDesktopV2Action): ComputerUseAction | null {
  switch (action.action) {
    case "key":
      return { action: "key", key: action.key };
    case "type":
      return { action: "type", text: action.text };
    case "launch_app":
      return { action: "launch_app", name: action.name };
    case "focus_app":
      return action.name === undefined
        ? { action: "focus_app" }
        : { action: "focus_app", name: action.name };
    case "navigate":
      return { action: "navigate", url: action.url };
    default:
      return null;
  }
}

/** Activity detail: action and references only, never typed text. */
function summarizeV2Action(action: ComputerUseDesktopV2Action): string {
  switch (action.action) {
    case "click":
      return `Click at (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case "navigate":
      return `Navigate to ${action.url}`;
    case "launch_app":
      return `Launch ${JSON.stringify(action.name)}`;
    case "type":
      return `Type ${action.text.length} characters`;
    case "key":
      return `Press ${action.key}`;
    default:
      return `Desktop ${action.action.replaceAll("_", " ")}`;
  }
}

export const computerUseV2ViaOrchestration = Effect.fn("computerUseV2ViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly computerUseEnabled: boolean;
    readonly serverMode: "web" | "desktop";
    readonly threadId: ThreadId;
    readonly request: ComputerUseV2ToolRequest;
    readonly supervised?: SupervisedComputerUsePort;
    readonly checkInIntervalMs?: number;
    readonly actionTimeoutMs?: number;
  }) {
    const operationId = crypto.randomUUID();
    const actionName = computerUseV2RequestActionName(input.request);
    if (input.request.kind === "refused") {
      return refusedComputerUseV2Result({
        operationId,
        action: actionName,
        code: input.request.code,
      });
    }
    const action = input.request.action;
    const thread = yield* input.orchestrationEngine
      .getReadModel()
      .pipe(Effect.map((model) => model.threads.find((item) => item.id === input.threadId)));
    if (!thread) return yield* Effect.fail(new Error(`Thread not found: ${input.threadId}`));
    if (!input.computerUseEnabled) {
      return yield* Effect.fail(
        new Error(
          "Desktop computer use is disabled in bigbud settings. Enable it under Settings → AI → Computer Use to automate native apps such as Calendar and Reminders.",
        ),
      );
    }
    if (isMutatingComputerUseActionName(action.action) && thread.runtimeMode !== "full-access") {
      return yield* Effect.fail(
        new Error(
          "Computer-use mutations require the thread runtime mode to be full-access. Capture and page-info actions are still allowed.",
        ),
      );
    }
    if (input.serverMode !== "desktop") {
      return yield* Effect.fail(
        new Error(
          "Desktop computer-use actions are only available when bigbud is running in desktop mode. The current runtime mode is 'web'.",
        ),
      );
    }
    if (
      hasComputerUseCheckInExpired({
        thread,
        checkInIntervalMs: input.checkInIntervalMs ?? DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS,
        nowMs: Date.now(),
      })
    ) {
      return refusedComputerUseV2Result({
        operationId,
        action: actionName,
        code: "checkin_required",
      });
    }
    const guardView = legacyGuardView(action);
    const violation = guardView ? guardComputerUseAction(guardView) : null;
    if (violation) return yield* Effect.fail(new Error(violation));

    const supervised = input.supervised;
    if (!supervised) {
      return refusedComputerUseV2Result({
        operationId,
        action: actionName,
        code: "control_unavailable",
      });
    }
    const actionTimeoutMs = input.actionTimeoutMs ?? DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS;
    const record = (kind: "tool.started" | "tool.completed", summary: string, data: object) =>
      appendComputerUseActivity({
        orchestrationEngine: input.orchestrationEngine,
        operationId,
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
        kind,
        summary,
        detail: summarizeV2Action(action),
        data: { schemaVersion: 2, action: action.action, ...data },
      });
    yield* record("tool.started", "Computer use started", {});
    const executed = yield* supervised
      .execute({ threadId: input.threadId, operationId, action })
      .pipe(
        Effect.timeoutOption(actionTimeoutMs),
        Effect.map((result) =>
          Option.getOrElse(result, () => ({
            ...refusedComputerUseV2Result({
              operationId,
              action: actionName,
              code: "deadline_exceeded",
            }),
            executionStatus: "timed_out" as const,
            completion: "unknown" as const,
            refused: false,
          })),
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : record(
                "tool.completed",
                Cause.hasInterrupts(exit.cause) ? "Computer use cancelled" : "Computer use failed",
                { executionStatus: Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed" },
              ),
        ),
      );
    yield* record(
      "tool.completed",
      executed.refused ? "Computer use refused" : "Computer use completed",
      { executionStatus: executed.executionStatus, result: executed },
    );
    return executed;
  },
);
