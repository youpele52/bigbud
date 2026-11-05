import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerUsageSummaryResult } from "../server/usage";
import { OrchestrationEvent } from "./orchestration.events";
import { OrchestrationReadModel } from "./orchestration.thread";

const at = "2026-10-29T10:00:00.000Z";
const selection = {
  provider: "kilocode",
  model: "legacy-model",
  subProviderID: "openrouter",
  options: { reasoningEffort: "high", historicalExtra: { keep: true } },
};
const recovery = {
  status: "awaiting-user",
  reason: "tool-in-flight",
  toolSummary: "Run tests",
  attempt: 0,
  provider: "kilocode",
  messageId: "message-1",
  updatedAt: at,
};
const prompt = { id: "message-2", text: "Continue", modelSelection: selection, createdAt: at };
const project = {
  id: "project-1",
  title: "Legacy project",
  workspaceRoot: null,
  defaultModelSelection: selection,
  scripts: [],
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
};
const thread = {
  id: "thread-1",
  projectId: project.id,
  title: "Legacy chat",
  modelSelection: selection,
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  recovery,
  queuedPrompts: [prompt],
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
  messages: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: "thread-1",
    providerName: "kilocode",
    status: "stopped",
    activeTurnId: null,
    lastError: null,
    updatedAt: at,
  },
};

describe("KiloCode history compatibility", () => {
  it("round-trips a complete snapshot with project preference, session, recovery, and queued prompt", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationReadModel)({
      snapshotSequence: 12,
      projects: [project],
      threads: [thread],
      updatedAt: at,
    });
    const encoded = Schema.encodeSync(OrchestrationReadModel)(decoded);
    expect(encoded.projects[0]?.defaultModelSelection).toEqual(selection);
    expect(encoded.threads[0]?.modelSelection).toEqual(selection);
    expect(encoded.threads[0]?.queuedPrompts?.[0]?.modelSelection).toEqual(selection);
    expect(encoded.threads[0]?.session?.providerName).toBe("kilocode");
    expect(encoded.threads[0]?.recovery?.provider).toBe("kilocode");
  });

  it.each([
    ["project.created", { ...project, projectId: project.id }],
    ["thread.created", { ...thread, threadId: thread.id }],
    ["thread.meta-updated", { threadId: thread.id, modelSelection: selection, updatedAt: at }],
    ["thread.prompt-queued", { threadId: thread.id, prompt }],
    ["thread.recovery-updated", { threadId: thread.id, recovery, createdAt: at }],
  ])("round-trips historical %s events", (type, payload) => {
    const decoded = Schema.decodeUnknownSync(OrchestrationEvent)({
      sequence: 1,
      eventId: "event-1",
      aggregateKind: type === "project.created" ? "project" : "thread",
      aggregateId: type === "project.created" ? project.id : thread.id,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    });
    expect(
      Schema.decodeUnknownSync(OrchestrationEvent)(Schema.encodeSync(OrchestrationEvent)(decoded)),
    ).toEqual(decoded);
  });

  it("keeps historical usage coverage and totals readable", () => {
    const decoded = Schema.decodeUnknownSync(ServerUsageSummaryResult)({
      range: "all",
      generatedAt: at,
      historyStatus: "ready",
      providerCoverage: [{ provider: "kilocode", status: "available", reason: null }],
      totals: {
        usedTokens: 42,
        inputTokens: 30,
        cachedInputTokens: 0,
        outputTokens: 12,
        reasoningOutputTokens: 0,
        turnCount: 1,
      },
      buckets: [],
      providers: [{ id: "kilocode", label: "KiloCode", usedTokens: 42, turnCount: 1 }],
      models: [],
      favoriteProvider: null,
      favoriteModel: null,
      favoriteMode: null,
      streakDays: 0,
    });
    expect(Schema.encodeSync(ServerUsageSummaryResult)(decoded).providerCoverage[0]?.provider).toBe(
      "kilocode",
    );
    expect(decoded.totals.usedTokens).toBe(42);
  });
});
