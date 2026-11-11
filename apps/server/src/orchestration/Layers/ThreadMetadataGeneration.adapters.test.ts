import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { EventId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import {
  decodeMetadataContext,
  type MetadataCaptureOptions,
} from "./ThreadMetadataGeneration.context.ts";
import { metadataTitleAdapter } from "./ThreadMetadataGeneration.title.ts";
import { metadataSummaryAdapter } from "./ThreadMetadataGeneration.summary.ts";
import { resetThreadTitleLockForTests } from "../../orchestration-tools/ThreadTitleLock.ts";

const now = "2026-11-09T00:00:00.000Z";
function thread(count = 5): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe("captured-thread"),
    projectId: ProjectId.makeUnsafe("captured-project"),
    title: "New thread",
    elevatorSummary: null,
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "thread-model" },
    worktreePath: "/workspace",
    branch: "dev",
    workspaceExecutionTargetId: "local",
    archivedAt: null,
    deletingAt: null,
    deletedAt: null,
    activities: [],
    runtimeMode: "approval-required",
    interactionMode: "default",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    proposedPlans: [],
    checkpoints: [],
    watchingThreads: [],
    session: null,
    messages: Array.from({ length: count }, (_, index) => ({
      id: MessageId.makeUnsafe(`message-${index}`),
      role: index % 2 === 0 ? "user" : "assistant",
      text: `Repair metadata recovery ${index}`,
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    })),
  };
}
const options = (): MetadataCaptureOptions => ({
  cwd: "/workspace",
  expectedRevision: 3,
  configEpoch: "opaque-configuration-epoch",
  configuredPrimary: true,
  primaryPath: {
    selection: { provider: "codex", model: "captured", options: { reasoningEffort: "high" } },
    transport: "codex-cli",
    accountIdentity: "opaque-account-id",
    executionTarget: "local",
    promptVersion: "title-v1",
    validatorVersion: "title-v1",
    mode: "auxiliary",
  },
  threadPath: null,
});

function summary(count = 5, attemptedFrontier = 0) {
  const initial = thread(count);
  const context = metadataSummaryAdapter.capture(initial, { ...options(), attemptedFrontier });
  if (!context) throw new Error("Expected summary capture");
  return { initial, context };
}

describe("captured metadata operation adapters", () => {
  it("round-trips typed captured input without runtime provider settings or authority", async () => {
    const { context } = summary();
    expect(await Effect.runPromise(decodeMetadataContext(JSON.stringify(context)))).toEqual(
      context,
    );
    for (const changed of [
      { ...context, version: 2 },
      { ...context, providerSettings: { secret: "not-allowed" } },
      { ...context, source: { ...context.source, frontier: -1 } },
      { ...context, workspace: { ...context.workspace, credential: "not-allowed" } },
    ]) {
      expect(
        (
          await Effect.runPromise(
            decodeMetadataContext(JSON.stringify(changed)).pipe(Effect.result),
          )
        )._tag,
      ).toBe("Failure");
    }
  });

  it("snapshots full model options rather than retaining mutable settings references", () => {
    const original = options();
    const context = metadataSummaryAdapter.capture(thread(), {
      ...original,
      attemptedFrontier: 0,
    })!;
    Object.assign(original.primaryPath!.selection, { model: "changed" });
    expect(context.primaryPath?.selection.model).toBe("captured");
    expect(context.primaryPath?.selection.options).toEqual({ reasoningEffort: "high" });
  });

  it("accepts append-only growth but commits the captured summary message count", () => {
    const { context } = summary();
    const appended = thread(9);
    expect(metadataSummaryAdapter.isCurrent(context, appended, 3, "/workspace")).toBe(true);
    expect(context.source.frontier).toBe(5);
    expect(context.previousSummary).toBeNull();
  });

  it.each([
    "edit",
    "delete",
    "reorder",
    "revision",
    "workspace",
    "target",
    "cwd",
    "summary",
    "deleting",
  ])("rejects a stale summary after %s", (change) => {
    const { context } = summary();
    const current = thread();
    const changed =
      change === "edit"
        ? {
            ...current,
            messages: current.messages.map((m, i) => (i === 0 ? { ...m, text: "edited" } : m)),
          }
        : change === "delete"
          ? { ...current, messages: current.messages.slice(1) }
          : change === "reorder"
            ? { ...current, messages: current.messages.toReversed() }
            : change === "workspace"
              ? { ...current, worktreePath: "/other" }
              : change === "target"
                ? { ...current, workspaceExecutionTargetId: "remote" }
                : change === "summary"
                  ? { ...current, elevatorSummary: "Newer summary" }
                  : change === "deleting"
                    ? { ...current, deletingAt: now }
                    : current;
    expect(
      metadataSummaryAdapter.isCurrent(
        context,
        changed,
        change === "revision" ? 4 : 3,
        change === "cwd" ? "/other" : "/workspace",
      ),
    ).toBe(false);
  });

  it("uses the attempted frontier to resume ordinary refresh after ten more messages", () => {
    expect(
      metadataSummaryAdapter.capture(thread(14), { ...options(), attemptedFrontier: 5 }),
    ).toBeNull();
    expect(summary(15, 5).context.source.frontier).toBe(15);
    expect(
      metadataSummaryAdapter.capture(
        { ...thread(24), elevatorSummaryMessageCount: 15 },
        { ...options(), attemptedFrontier: 5 },
      ),
    ).toBeNull();
    expect(
      metadataSummaryAdapter.capture(thread(4), { ...options(), attemptedFrontier: 0 }),
    ).toBeNull();
  });

  it("bounds captured summary text to 8,000 characters and retains previous metadata", () => {
    const current = { ...thread(), elevatorSummary: "Keep this on failure" };
    const messages = current.messages.map((m) => ({ ...m, text: m.text.repeat(5_000) }));
    const captured = metadataSummaryAdapter.capture(
      { ...current, messages },
      { ...options(), attemptedFrontier: 0 },
    )!;
    expect(captured.transcript.length).toBeLessThanOrEqual(8_000);
    expect(captured.previousSummary).toBe("Keep this on failure");
    expect(current.elevatorSummary).toBe("Keep this on failure");
  });

  it.each(["manual", "terminal"] as const)(
    "does not capture or overwrite %s title ownership",
    (source) => {
      resetThreadTitleLockForTests();
      const initial = thread();
      const context = metadataTitleAdapter.capture(initial, {
        ...options(),
        message: "Repair metadata",
      })!;
      const owned = {
        ...initial,
        activities: [
          {
            id: EventId.makeUnsafe("owner"),
            kind: "thread.title-ownership",
            turnId: null,
            payload: { source },
            tone: "info" as const,
            summary: "Ownership",
            createdAt: now,
          },
        ],
      };
      expect(
        metadataTitleAdapter.capture(owned, { ...options(), message: "Repair metadata" }),
      ).toBeNull();
      expect(metadataTitleAdapter.isCurrent(context, owned, 3, "/workspace")).toBe(false);
    },
  );

  it("rejects a title changed after capture even when its visible text is another default", () => {
    const current = thread();
    const context = metadataTitleAdapter.capture(current, {
      ...options(),
      message: "Repair metadata",
    })!;
    expect(
      metadataTitleAdapter.isCurrent(context, { ...current, title: "New chat" }, 3, "/workspace"),
    ).toBe(false);
  });
});
