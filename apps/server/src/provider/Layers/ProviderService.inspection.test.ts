import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSession } from "@bigbud/contracts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
import { makeConfirmInspectedTurn, makeInspectActiveTurn } from "./ProviderService.inspection.ts";
import type { InspectionConfirmation } from "../Services/ProviderInspectionTerminal.ts";
import { exactRewindInput } from "../../codex/codexAppServerManager.reliability.test.helpers.ts";

function harness() {
  const binding: ProviderRuntimeBinding = {
    threadId: exactRewindInput.threadId,
    provider: "codex",
    resumeCursor: { threadId: "native" },
    runtimePayload: { sessionEpoch: 2 },
  };
  const state = {
    binding,
    session: {
      threadId: binding.threadId,
      provider: "codex",
      status: "running",
      sessionEpoch: 2,
      resumeCursor: binding.resumeCursor,
    } as ProviderSession,
  };
  const inspectActiveTurn = vi.fn(() =>
    Effect.succeed({ status: "completed" as const, observedAt: new Date().toISOString() }),
  );
  const listSessions = vi.fn(() => Effect.succeed([state.session]));
  const confirmInspectedTurn = vi.fn(() => Effect.succeed<InspectionConfirmation>("confirmed"));
  const adapter = {
    hasSession: () => Effect.succeed(true),
    listSessions,
    inspectActiveTurn,
    confirmInspectedTurn,
  };
  const getByProvider = vi.fn(() => Effect.succeed(adapter));
  const directory = {
    getBinding: () => Effect.sync(() => Option.some(state.binding)),
  } as unknown as ProviderSessionDirectoryShape;
  const registry = { getByProvider } as unknown as ProviderAdapterRegistryShape;
  return {
    state,
    inspectActiveTurn,
    listSessions,
    getByProvider,
    confirmInspectedTurn,
    confirm: () =>
      makeConfirmInspectedTurn(
        registry,
        directory,
      )({
        threadId: binding.threadId,
        turnId: exactRewindInput.expectedTurnIds[1]!,
        sessionEpoch: 2,
        status: "completed",
      }),
    inspect: () =>
      makeInspectActiveTurn(
        registry,
        directory,
      )({
        threadId: binding.threadId,
        turnId: exactRewindInput.expectedTurnIds[1]!,
        sessionEpoch: 2,
      }),
  };
}

describe("inspection session/binding fencing", () => {
  it.each(["confirmed", "absent", "rejected"] as const)(
    "preserves the native %s confirmation rather than guessing from session listing",
    async (outcome) => {
      const test = harness();
      test.confirmInspectedTurn.mockReturnValue(Effect.succeed(outcome));
      expect(await Effect.runPromise(test.confirm())).toBe(outcome);
    },
  );

  it("rejects an absent-process result if its binding changes asynchronously", async () => {
    const test = harness();
    test.confirmInspectedTurn.mockImplementation(() =>
      Effect.promise(async () => {
        test.state.binding = { ...test.state.binding, runtimePayload: { sessionEpoch: 3 } };
        return "absent" as const;
      }),
    );
    expect(await Effect.runPromise(test.confirm())).toBe("rejected");
  });
  it("does not read through an initially stale epoch", async () => {
    const test = harness();
    test.state.binding = { ...test.state.binding, runtimePayload: { sessionEpoch: 3 } };
    expect((await Effect.runPromise(test.inspect())).status).toBe("unavailable");
    expect(test.getByProvider).not.toHaveBeenCalled();
  });

  it("rechecks binding after asynchronous registry lookup", async () => {
    const test = harness();
    const adapter = await Effect.runPromise(test.getByProvider());
    test.getByProvider.mockImplementation(() =>
      Effect.promise(async () => {
        test.state.binding = { ...test.state.binding, runtimePayload: { sessionEpoch: 3 } };
        return adapter;
      }),
    );
    expect((await Effect.runPromise(test.inspect())).status).toBe("unavailable");
    expect(test.inspectActiveTurn).not.toHaveBeenCalled();
  });

  it.each(["epoch", "native", "provider", "process"])(
    "discards %s changes while reading",
    async (fault) => {
      const test = harness();
      test.inspectActiveTurn.mockImplementation(() =>
        Effect.promise(async () => {
          if (fault === "epoch")
            test.state.binding = { ...test.state.binding, runtimePayload: { sessionEpoch: 3 } };
          if (fault === "native")
            test.state.binding = {
              ...test.state.binding,
              resumeCursor: { threadId: "replacement" },
            };
          if (fault === "provider")
            test.state.binding = { ...test.state.binding, provider: "claudeAgent" };
          if (fault === "process") test.state.session = { ...test.state.session, sessionEpoch: 3 };
          return { status: "completed", observedAt: new Date().toISOString() };
        }),
      );
      expect((await Effect.runPromise(test.inspect())).status).toBe("unavailable");
    },
  );

  it("rechecks the directory after the asynchronous session-list lookup", async () => {
    const test = harness();
    test.listSessions.mockImplementationOnce(() =>
      Effect.promise(async () => {
        test.state.binding = { ...test.state.binding, runtimePayload: { sessionEpoch: 3 } };
        return [test.state.session];
      }),
    );
    expect((await Effect.runPromise(test.inspect())).status).toBe("unavailable");
    expect(test.inspectActiveTurn).not.toHaveBeenCalled();
  });
});
