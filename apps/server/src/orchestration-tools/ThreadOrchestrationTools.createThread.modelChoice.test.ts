import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createThreadViaOrchestration } from "./ThreadOrchestrationTools.createThread.ts";
import {
  DELEGATION_CREATED_AT,
  callerThread,
  callerThreadId,
  makeSystem,
  sourceMessageId,
} from "./ThreadOrchestrationTools.createThread.test.helpers.ts";
import type { ThreadToolModelSources } from "./ThreadOrchestrationToolDispatcher.ts";
import { provider } from "./ThreadOrchestrationTools.modelChoice.test.helpers.ts";

const trunk = { provider: "codex", model: "gpt-5.4" };
const local = () =>
  makeSystem({
    ...callerThread,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
  });
const sources = (overrides: Partial<ThreadToolModelSources> = {}): ThreadToolModelSources => ({
  getProviders: Effect.succeed([
    provider("codex", {}, [{ slug: "gpt-5.4", name: "GPT-5.4" }]),
    provider("claudeAgent", {}, [{ slug: "claude-sonnet", name: "Claude Sonnet" }]),
  ]),
  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  listRecent: () => Effect.succeed([]),
  hasInteractiveClient: () => true,
  ...overrides,
});

function create(
  system: ReturnType<typeof makeSystem>,
  extra: {
    readonly modelSelection?: unknown;
    readonly modelSources?: ThreadToolModelSources | null;
  },
) {
  return Effect.runPromise(
    createThreadViaOrchestration({
      orchestrationEngine: system.engine,
      threadDelegationRepository: system.repository,
      projectionThreadWatchRepository: system.projectionThreadWatchRepository,
      callerThreadId,
      sourceMessageId,
      invocationId: "invocation-1",
      title: "Child",
      task: "Do the work",
      watchForCompletion: false,
      ...extra,
    }),
  );
}

const commands = (system: ReturnType<typeof makeSystem>) =>
  system.dispatch.mock.calls.map(([command]) => command as Record<string, unknown>);

describe("create_thread without modelSelection", () => {
  it("keeps today's commands, now with the delegation's deterministic createdAt (AC9)", async () => {
    const first = makeSystem();
    await create(first, {});
    const second = makeSystem();
    second.setGetByInvocation(() =>
      Effect.succeed(Option.some({ ...second.delegation, state: "thread_accepted" as const })),
    );
    await create(second, {});
    expect(commands(first).map((command) => command.type)).toEqual([
      "thread.create",
      "thread.activity.append",
      "thread.turn.start",
    ]);
    expect(commands(first).every((command) => command.createdAt === DELEGATION_CREATED_AT)).toBe(
      true,
    );
    expect(commands(second)).toEqual(commands(first));
    expect(JSON.stringify(commands(first))).not.toContain("modelChoice");
    expect(commands(first)[0]).toMatchObject({ modelSelection: trunk });
  });

  // L5: an empty request from any bridge means "no request", never a hold or picker.
  it.each([
    null,
    {},
    { provider: null },
    { provider: "" },
    { provider: "   " },
    { model: "gpt-5" },
  ])("treats modelSelection %j as absent", async (modelSelection) => {
    const baseline = local();
    const baselineResult = await create(baseline, {});
    const system = local();
    const result = await create(system, { modelSelection, modelSources: sources() });
    expect(commands(system)).toEqual(commands(baseline));
    expect(result).toEqual(baselineResult);
    expect(system.storeResult.mock.calls.at(-1)?.[0].resultJson ?? null).toBe(
      baseline.storeResult.mock.calls.at(-1)?.[0].resultJson ?? null,
    );
  });
});

describe("create_thread with modelSelection", () => {
  it("starts a usable requested model immediately and records requested vs used", async () => {
    const system = local();
    const result = await create(system, {
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet", options: { x: 1 } },
      modelSources: sources(),
    });
    const used = { provider: "claudeAgent", model: "claude-sonnet" };
    expect(commands(system).map((command) => command.type)).toEqual([
      "thread.create",
      "thread.activity.append",
      "thread.activity.append",
      "thread.turn.start",
    ]);
    expect(commands(system)[0]).toMatchObject({ modelSelection: used });
    expect(commands(system)[1]).toMatchObject({
      activity: {
        kind: "delegation.child-linked",
        payload: { modelChoice: { status: "resolved" } },
      },
    });
    expect(commands(system)[2]).toMatchObject({
      activity: {
        kind: "delegation.model-choice-resolved",
        payload: { used, outcome: "requested", resolvedBy: "server" },
      },
    });
    expect(commands(system)[3]).toMatchObject({ modelSelection: used });
    expect(result).toMatchObject({
      modelChoice: { status: "resolved", used, outcome: "requested" },
    });
    expect(result).not.toHaveProperty("suggestions");
  });

  it("holds the first turn for a connected user without blocking the tool", async () => {
    const system = local();
    const result = await create(system, {
      modelSelection: { provider: "copilot" },
      modelSources: sources(),
    });
    expect(commands(system).map((command) => command.type)).toEqual([
      "thread.create",
      "thread.activity.append",
      "thread.delegation.model-choice.hold",
    ]);
    expect(commands(system)[0]).toMatchObject({ modelSelection: trunk });
    expect(commands(system)[2]).toMatchObject({
      prompt: { messageId: sourceMessageId, originSegments: [{ kind: "initialDelegation" }] },
      requestedActivity: {
        payload: {
          reason: "unknown-provider",
          fallback: trunk,
          deadlineAt: "2026-10-15T10:00:10.000Z",
          heldMessageId: sourceMessageId,
        },
      },
      createdAt: DELEGATION_CREATED_AT,
    });
    expect(result).toMatchObject({
      modelChoice: { status: "pending", used: trunk },
      suggestions: [{ model: "gpt-5.4", isParentModel: true }, { model: "claude-sonnet" }],
    });
  });

  it.each([
    ["no-client", sources({ hasInteractiveClient: () => false })],
    ["server", null],
    ["server", sources({ getSettings: Effect.fail(new Error("unreadable")) })],
  ] as const)("falls back immediately (%s) and never fails", async (resolvedBy, modelSources) => {
    const system = local();
    const result = await create(system, { modelSelection: { provider: "copilot" }, modelSources });
    expect(commands(system).at(-1)).toMatchObject({
      type: "thread.turn.start",
      modelSelection: trunk,
    });
    expect(result).toMatchObject({
      modelChoice: { status: "resolved", outcome: "fallback", resolvedBy },
    });
  });

  it("uses the winning inherited selection when an overlapping lookup proposes another model", async () => {
    const system = local();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const explicit = create(system, {
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
      modelSources: sources({
        getSettings: Effect.promise(async () => {
          entered();
          await blocked;
          return DEFAULT_SERVER_SETTINGS;
        }),
      }),
    });
    try {
      await started;
      await create(system, {});
    } finally {
      release();
    }
    expect(await explicit).not.toHaveProperty("modelChoice");
    expect(system.claimResult).toHaveBeenCalledTimes(2);
    const dispatched = commands(system);
    expect(dispatched.slice(3)).toEqual(dispatched.slice(0, 3));
    expect(dispatched[0]).toMatchObject({ type: "thread.create", modelSelection: trunk });
  });

  it("reuses the stored decision on an interrupted retry even if the request omits modelSelection", async () => {
    const system = local();
    system.dispatch.mockImplementationOnce(() => Effect.interrupt);
    await expect(
      create(system, { modelSelection: { provider: "copilot" }, modelSources: sources() }),
    ).rejects.toBeDefined();
    expect(system.storeResult).not.toHaveBeenCalled();
    const stored = system.claimResult.mock.calls[0]?.[0];
    expect(JSON.parse(stored?.resultJson ?? "{}").modelDecision.kind).toBe("hold");
    const retry = local();
    retry.setGetByInvocation(() =>
      Effect.succeed(
        Option.some({
          ...retry.delegation,
          state: "project_resolved" as const,
          resultJson: stored?.resultJson ?? null,
        }),
      ),
    );
    const getProviders = vi.fn(() => Effect.succeed([]));
    await create(retry, {
      modelSources: sources({
        hasInteractiveClient: () => false,
        getProviders: Effect.suspend(getProviders),
      }),
    });
    expect(getProviders).not.toHaveBeenCalled();
    expect(commands(retry)[0]).toEqual(commands(system)[0]);
    expect(commands(retry).at(-1)).toMatchObject({ type: "thread.delegation.model-choice.hold" });
    expect(JSON.parse(retry.storeResult.mock.calls.at(-1)?.[0].resultJson ?? "{}")).toMatchObject({
      accepted: true,
      modelDecision: { kind: "hold" },
    });
  });
});
