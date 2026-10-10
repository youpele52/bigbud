import { Effect, Option } from "effect";
import { expect, it } from "vitest";
import { ThreadId, TurnId } from "@bigbud/contracts";
import { restoreV2StartSelection } from "./ProviderService.modelSelection.v2.ts";
import { recordAcceptedSendTurn } from "./ProviderService.sendTurn.record.ts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

const old = { provider: "opencodeV2", subProviderID: "opencode", model: "big-pickle" } as const;
const next = {
  provider: "opencodeV2",
  subProviderID: "openai",
  model: "gpt-6.1-sol",
  options: { variant: "high" },
} as const;
const threadId = ThreadId.makeUnsafe("bound-model-start");
const input = {
  threadId,
  provider: "opencodeV2",
  modelSelection: next,
  runtimeMode: "full-access",
} as const;
const cursor = {
  provider: "opencodeV2",
  nativeSessionId: "ses_bound",
  storageIdentity: "storage",
  directory: "/workspace",
} as const;
const binding = {
  threadId,
  provider: "opencodeV2",
  resumeCursor: cursor,
  runtimePayload: { modelSelection: old },
} as const;

it("rebinds legacy native cursors with their stored selection without modifying the captured new turn", async () => {
  expect(await Effect.runPromise(restoreV2StartSelection(input, binding, true))).toEqual(old);
  expect(input.modelSelection).toBe(next);
});

it.each([false, true])(
  "records current V2 cursor provider/variant after original request replay (idle=%s)",
  async (idle) => {
    let saved: ProviderRuntimeBinding | undefined;
    const directory: ProviderSessionDirectoryShape = {
      upsert: (value) =>
        Effect.sync(() => {
          saved = value;
        }),
      getBinding: () => Effect.succeed(Option.none()),
      getProvider: () => Effect.succeed("opencodeV2"),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed([]),
    };
    const captured = { ...old, model: "same-id", options: { variant: "low" } };
    await Effect.runPromise(
      recordAcceptedSendTurn({
        adapter: {
          provider: "opencodeV2",
          listSessions: () =>
            Effect.succeed(
              idle
                ? [
                    {
                      threadId,
                      provider: "opencodeV2",
                      model: "same-id",
                      status: "ready",
                      runtimeMode: "full-access",
                      createdAt: "2026-10-10T00:00:00Z",
                      updatedAt: "2026-10-10T00:00:00Z",
                    },
                  ]
                : [],
            ),
        },
        directory,
        liveness: Option.none(),
        threadId,
        turnId: TurnId.makeUnsafe("original-replay"),
        sessionEpoch: 1,
        modelSelection: captured,
        resumeCursor: {
          ...cursor,
          model: { providerID: "openai", id: "same-id", variant: "high" },
        },
      }),
    );
    expect(saved?.runtimePayload).toMatchObject({
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "openai",
        model: "same-id",
        options: { variant: "high" },
      },
    });
    expect(captured.options.variant).toBe("low");
  },
);

it("prefers the verified current cursor selection to stale replay metadata, including exact provider and variant", async () => {
  const current = {
    ...binding,
    resumeCursor: {
      ...cursor,
      model: { providerID: "openai", id: "gpt-6.1-sol", variant: "high" },
    },
  };
  expect(await Effect.runPromise(restoreV2StartSelection(input, current, true))).toEqual(next);
});

it("does not manufacture a native binding or apply V2 policy to other providers/fresh starts", async () => {
  for (const saved of [
    undefined,
    { ...binding, resumeCursor: null },
    { ...binding, provider: "opencode" as const },
  ])
    expect(await Effect.runPromise(restoreV2StartSelection(input, saved, true))).toBe(next);
  expect(await Effect.runPromise(restoreV2StartSelection(input, binding, false))).toBe(next);
  const other = {
    ...input,
    provider: "opencode" as const,
    modelSelection: { provider: "opencode" as const, model: "other" },
  };
  expect(await Effect.runPromise(restoreV2StartSelection(other, binding, true))).toBe(
    other.modelSelection,
  );
});

it("rejects malformed saved cursor/model state instead of rebinding or using the new selection as fallback", async () => {
  for (const saved of [
    { ...binding, resumeCursor: { ...cursor, provider: "opencode" } },
    { ...binding, resumeCursor: { ...cursor, model: { providerID: "", id: "model" } } },
    { ...binding, runtimePayload: {} },
  ])
    await expect(Effect.runPromise(restoreV2StartSelection(input, saved, true))).rejects.toThrow(
      "no history was rebound",
    );
});
