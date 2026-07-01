import { ATTACHMENTS_ROUTE_PREFIX } from "../attachments/attachmentPaths.ts";
import { createAttachmentId, resolveAttachmentPath } from "../attachments/attachmentStore.ts";
import type { ComputerUseAction, ComputerUseResult, ThreadId } from "@bigbud/contracts";
import { CommandId, EventId } from "@bigbud/contracts";
import {
  DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS,
  DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS,
} from "@bigbud/contracts/settings";
import { Effect, Option, type FileSystem, type Path } from "effect";

import type { ComputerUseShape } from "../computer-use/Services/ComputerUse.ts";
import { isDesktopSurfaceAction } from "../computer-use/Layers/ComputerUse.ts";
import { guardComputerUseAction } from "../computer-use/computerUseSafety.ts";
import { type OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

const COMPUTER_USE_TOOL_TITLE = "computer_use";

function summarizeRequestedAction(action: ComputerUseAction): string {
  switch (action.action) {
    case "capture":
      return `Capture ${action.surface ?? "browser"} state`;
    case "navigate":
      return `Navigate to ${action.url}`;
    case "click":
      return `Click at (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case "drag":
      return `Drag from (${Math.round(action.startX)}, ${Math.round(action.startY)}) to (${Math.round(action.endX)}, ${Math.round(action.endY)})`;
    case "scroll":
      return `Scroll by (${Math.round(action.deltaX ?? 0)}, ${Math.round(action.deltaY ?? 0)})`;
    case "type":
      return `Type ${JSON.stringify(action.text)}`;
    case "key":
      return `Press ${action.key}`;
    case "wait":
      return `Wait ${action.durationMs}ms`;
    case "get_page_info":
      return "Read page info";
    case "list_windows":
      return "List desktop windows";
    case "list_apps":
      return "List desktop apps";
    case "check_permissions":
      return "Check desktop automation permissions";
    case "doctor":
      return "Run desktop automation diagnostics";
    case "launch_app":
      return `Launch ${JSON.stringify(action.name)}`;
    case "focus_app":
      return action.name ? `Focus ${JSON.stringify(action.name)}` : "Focus desktop app";
    case "get_accessibility_tree":
      return "Capture desktop accessibility tree";
  }
}

function isMutatingAction(action: ComputerUseAction): boolean {
  switch (action.action) {
    case "capture":
    case "list_windows":
    case "list_apps":
    case "check_permissions":
    case "doctor":
    case "get_accessibility_tree":
    case "get_page_info":
      return false;
    default:
      return true;
  }
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestUserMessageTimestamp(thread: {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
}): number | null {
  let latest: number | null = null;
  for (const message of thread.messages) {
    if (message.role !== "user") {
      continue;
    }
    const timestamp = parseTimestamp(message.createdAt);
    if (timestamp !== null && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

function firstComputerUseActivityAfter(
  thread: {
    readonly activities: ReadonlyArray<{
      readonly kind: string;
      readonly createdAt: string;
      readonly payload: unknown;
    }>;
  },
  timestamp: number | null,
): number | null {
  let first: number | null = null;
  for (const activity of thread.activities) {
    if (activity.kind !== "tool.started") {
      continue;
    }
    const payload = activity.payload;
    const title =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).title
        : undefined;
    if (title !== COMPUTER_USE_TOOL_TITLE) {
      continue;
    }
    const activityTimestamp = parseTimestamp(activity.createdAt);
    if (activityTimestamp === null || (timestamp !== null && activityTimestamp <= timestamp)) {
      continue;
    }
    if (first === null || activityTimestamp < first) {
      first = activityTimestamp;
    }
  }
  return first;
}

function hasComputerUseCheckInExpired(input: {
  readonly thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly activities: ReadonlyArray<{
      readonly kind: string;
      readonly createdAt: string;
      readonly payload: unknown;
    }>;
  };
  readonly checkInIntervalMs: number;
  readonly nowMs: number;
}): boolean {
  const latestUserMessage = latestUserMessageTimestamp(input.thread);
  const firstComputerUseActivity = firstComputerUseActivityAfter(input.thread, latestUserMessage);
  return (
    firstComputerUseActivity !== null &&
    input.nowMs - firstComputerUseActivity >= input.checkInIntervalMs
  );
}

const appendToolActivity = (input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly kind: "tool.started" | "tool.completed";
  readonly summary: string;
  readonly detail: string;
  readonly data: Record<string, unknown>;
}) =>
  input.orchestrationEngine
    .dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`computer-use:${crypto.randomUUID()}`),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "tool",
        kind: input.kind,
        summary: input.summary,
        payload: {
          itemType: "mcp_tool_call",
          title: "computer_use",
          detail: input.detail,
          data: input.data,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    })
    .pipe(Effect.asVoid);

const persistScreenshot = (input: {
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly threadId: ThreadId;
  readonly result: ComputerUseResult;
}) =>
  Effect.gen(function* () {
    if (!input.result.screenshot) {
      return input.result;
    }
    const bytes = Uint8Array.from(Buffer.from(input.result.screenshot.dataBase64, "base64"));
    const attachmentId = createAttachmentId(input.threadId);
    if (!attachmentId) {
      return input.result;
    }
    const attachment = {
      type: "image" as const,
      id: attachmentId,
      name: "computer-use.png",
      mimeType: input.result.screenshot.mimeType,
      sizeBytes: bytes.byteLength,
    };
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return input.result;
    }
    yield* input.fileSystem.makeDirectory(input.path.dirname(attachmentPath), { recursive: true });
    yield* input.fileSystem.writeFile(attachmentPath, bytes);
    return {
      ...input.result,
      screenshot: {
        ...input.result.screenshot,
        attachmentId,
        attachmentUrl: `${ATTACHMENTS_ROUTE_PREFIX}/${encodeURIComponent(attachmentId)}`,
      },
    } satisfies ComputerUseResult;
  });

export const computerUseViaOrchestration = Effect.fn("computerUseViaOrchestration")(
  function* (input: {
    readonly attachmentsDir: string;
    readonly computerUse: ComputerUseShape;
    readonly computerUseEnabled: boolean;
    readonly fileSystem: FileSystem.FileSystem;
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly path: Path.Path;
    readonly serverMode: "web" | "desktop";
    readonly threadId: ThreadId;
    readonly action: ComputerUseAction;
    readonly checkInIntervalMs?: number;
    readonly actionTimeoutMs?: number;
  }) {
    const thread = yield* input.orchestrationEngine
      .getReadModel()
      .pipe(
        Effect.map((readModel) =>
          readModel.threads.find((candidate) => candidate.id === input.threadId),
        ),
      );
    if (!thread) {
      return yield* Effect.fail(new Error(`Thread not found: ${input.threadId}`));
    }
    if (!input.computerUseEnabled && isDesktopSurfaceAction(input.action)) {
      return yield* Effect.fail(
        new Error(
          "Desktop computer use is disabled in Bigbud settings. Enable it under Settings → AI → Computer Use to automate native apps such as Calendar and Reminders.",
        ),
      );
    }
    if (isMutatingAction(input.action) && thread.runtimeMode !== "full-access") {
      return yield* Effect.fail(
        new Error(
          "Computer-use mutations require the thread runtime mode to be full-access. Capture and page-info actions are still allowed.",
        ),
      );
    }
    if (isDesktopSurfaceAction(input.action) && input.serverMode !== "desktop") {
      return yield* Effect.fail(
        new Error(
          "Desktop computer-use actions are only available when Bigbud is running in desktop mode. The current runtime mode is 'web'.",
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
      return yield* Effect.fail(
        new Error(
          "Computer use has been running for a while. Ask the user whether to continue before using computer_use again.",
        ),
      );
    }

    const safetyViolation = guardComputerUseAction(input.action);
    if (safetyViolation) {
      return yield* Effect.fail(new Error(safetyViolation));
    }

    const createdAt = new Date().toISOString();
    yield* appendToolActivity({
      orchestrationEngine: input.orchestrationEngine,
      threadId: input.threadId,
      createdAt,
      kind: "tool.started",
      summary: "Computer use started",
      detail: summarizeRequestedAction(input.action),
      data: { action: input.action },
    });

    const actionTimeoutMs = input.actionTimeoutMs ?? DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS;
    const executed = yield* input.computerUse.execute(input.threadId, input.action).pipe(
      Effect.timeoutOption(actionTimeoutMs),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.fail(
              new Error(
                `Computer-use action timed out after ${Math.round(actionTimeoutMs / 1_000)} seconds.`,
              ),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
    const result = yield* persistScreenshot({
      attachmentsDir: input.attachmentsDir,
      fileSystem: input.fileSystem,
      path: input.path,
      threadId: input.threadId,
      result: executed,
    });

    yield* appendToolActivity({
      orchestrationEngine: input.orchestrationEngine,
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      kind: "tool.completed",
      summary: "Computer use completed",
      detail: result.summary,
      data: {
        action: input.action,
        result,
        ...(result.screenshot?.attachmentUrl
          ? { attachmentUrl: result.screenshot.attachmentUrl }
          : {}),
      },
    });

    return result;
  },
);
