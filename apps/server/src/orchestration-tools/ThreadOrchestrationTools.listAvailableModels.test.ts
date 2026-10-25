import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createThreadViaOrchestration } from "./ThreadOrchestrationTools.createThread.ts";
import {
  callerThread,
  callerThreadId,
  makeSystem,
  sourceMessageId,
} from "./ThreadOrchestrationTools.createThread.test.helpers.ts";
import { listAvailableModelsViaOrchestration } from "./ThreadOrchestrationTools.listAvailableModels.ts";
import { provider } from "./ThreadOrchestrationTools.modelChoice.test.helpers.ts";
import { makeThreadToolModelSources } from "./ThreadOrchestrationTools.modelSources.ts";

function harness(settings = DEFAULT_SERVER_SETTINGS) {
  const refresh = vi.fn(() => Effect.succeed([]));
  const registry = {
    getProviders: Effect.succeed([
      provider("codex", {}, [
        { slug: "gpt-5.4", name: "GPT-5.4" },
        { slug: "gpt-5-mini", name: "GPT-5 mini" },
      ]),
      provider("claudeAgent", {}, [{ slug: "claude-sonnet", name: "Claude Sonnet" }]),
      provider("copilot", { auth: { status: "unauthenticated" } }),
    ]),
    refresh,
  };
  const sources = makeThreadToolModelSources({
    providerRegistry: registry,
    serverSettings: { getSettings: Effect.succeed(settings) },
    projectionThreadRepository: {
      listRecentModelSelections: () =>
        Effect.succeed([
          {
            provider: "claudeAgent",
            model: "claude-sonnet",
            lastUsedAt: "2026-10-15T09:00:00.000Z",
          },
        ]),
    },
    delivery: { hasOpenConsumer: () => true },
  });
  const system = makeSystem({
    ...callerThread,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
  });
  const list = (limit?: number, modelSources: typeof sources | null = sources) =>
    Effect.runPromise(
      listAvailableModelsViaOrchestration({
        orchestrationEngine: system.engine,
        callerThreadId,
        limit,
        modelSources,
      }),
    );
  return { refresh, sources, system, list };
}

describe("list_available_models", () => {
  it("lists usable models only, recently used first, with the parent's model flagged", async () => {
    const { list } = harness();
    const result = await list();
    expect(result).toMatchObject({
      parentModel: { provider: "codex", model: "gpt-5.4" },
      agentModelChoice: "agent",
      catalogAvailable: true,
      hasMore: false,
    });
    expect(result.models.map((model) => [model.provider, model.model])).toEqual([
      ["claudeAgent", "claude-sonnet"],
      ["codex", "gpt-5.4"],
      ["codex", "gpt-5-mini"],
    ]);
    expect(result.models[0]).toMatchObject({
      providerLabel: "Claude",
      name: "Claude Sonnet",
      lastUsedAt: "2026-10-15T09:00:00.000Z",
      isParentModel: false,
    });
    expect(result.models[1]?.isParentModel).toBe(true);
  });

  it("bounds the list with hasMore", async () => {
    const { list } = harness();
    const result = await list(1);
    expect(result.models).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it("is empty when agents may not choose and reports a missing catalog", async () => {
    const parent = harness({ ...DEFAULT_SERVER_SETTINGS, delegatedThreadModelChoice: "parent" });
    expect(await parent.list()).toMatchObject({ agentModelChoice: "parent", models: [] });
    const missing = harness();
    expect(await missing.list(undefined, null)).toMatchObject({
      catalogAvailable: false,
      models: [],
    });
  });

  it("never refreshes providers on the tool path", async () => {
    const { refresh, list, sources, system } = harness();
    await list();
    await Effect.runPromise(
      createThreadViaOrchestration({
        orchestrationEngine: system.engine,
        threadDelegationRepository: system.repository,
        projectionThreadWatchRepository: system.projectionThreadWatchRepository,
        callerThreadId,
        sourceMessageId,
        invocationId: "invocation-refresh",
        title: "Child",
        task: "Do the work",
        watchForCompletion: false,
        modelSelection: { provider: "copilot" },
        modelSources: sources,
      }),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
