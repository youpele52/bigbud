import type { ModelCapabilities } from "@bigbud/contracts/core/model.ts";
import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { describe, expect, it } from "vitest";

import { asThreadId, createSendTurnHarness } from "./codexAppServerManager.test.helpers";

const capabilities = (
  reasoningEffortLevels: ModelCapabilities["reasoningEffortLevels"],
): ModelCapabilities => ({
  reasoningEffortLevels,
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
});

const model = (
  slug: string,
  reasoningEffortLevels: ModelCapabilities["reasoningEffortLevels"],
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: capabilities(reasoningEffortLevels),
});

const catalog = [
  model("gpt-current-codex", [
    { value: "medium", label: "Medium", isDefault: true },
    { value: "max", label: "Max" },
    { value: "ultra", label: "Ultra" },
    { value: "future-depth", label: "Future Depth" },
  ]),
  model("gpt-next-codex", [
    { value: "high", label: "High", isDefault: true },
    { value: "ultra", label: "Ultra" },
  ]),
] satisfies ReadonlyArray<ServerProviderModel>;

describe("Codex manager model selection integration", () => {
  it.each(["max", "ultra", "future-depth"])(
    "forwards exact dynamic effort %s and commits it after success",
    async (effort) => {
      const { manager, context, sendRequest, updateSession } = createSendTurnHarness({
        activeModelCatalog: catalog,
      });

      await manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: "Use this effort",
        model: "gpt-current-codex",
        effort,
      });

      expect(sendRequest).toHaveBeenCalledWith(
        context,
        "turn/start",
        expect.objectContaining({
          model: "gpt-current-codex",
          effort,
        }),
        undefined,
      );
      expect(context.effectiveModelSelection).toEqual({
        model: "gpt-current-codex",
        effort,
      });
      expect(updateSession).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ model: "gpt-current-codex" }),
      );
    },
  );

  it("inherits the last applied effort on the same model", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness({
      activeModelCatalog: catalog,
      effectiveModelSelection: {
        model: "gpt-current-codex",
        effort: "ultra",
      },
    });
    context.session.model = "gpt-current-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Continue",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      expect.objectContaining({
        model: "gpt-current-codex",
        effort: "ultra",
      }),
      undefined,
    );
  });

  it("prefers the current session model over stale effective selection state", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness({
      activeModelCatalog: catalog,
      effectiveModelSelection: {
        model: "gpt-current-codex",
        effort: "max",
      },
    });
    context.session.model = "gpt-next-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Use the current session model",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      expect.objectContaining({
        model: "gpt-next-codex",
        effort: "high",
      }),
      undefined,
    );
  });

  it("uses the new model default instead of carrying effort across models", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness({
      activeModelCatalog: catalog,
      effectiveModelSelection: {
        model: "gpt-current-codex",
        effort: "max",
      },
    });

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Switch models",
      model: "gpt-next-codex",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      expect.objectContaining({
        model: "gpt-next-codex",
        effort: "high",
      }),
      undefined,
    );
    expect(context.effectiveModelSelection).toEqual({
      model: "gpt-next-codex",
      effort: "high",
    });
  });

  it("uses the same resolved effort for standard and collaboration mode settings", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness({
      activeModelCatalog: catalog,
    });

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan this",
      model: "gpt-current-codex",
      effort: "max",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      expect.objectContaining({
        effort: "max",
        collaborationMode: expect.objectContaining({
          settings: expect.objectContaining({ reasoning_effort: "max" }),
        }),
      }),
      undefined,
    );
  });

  it("rejects unsupported and case-mismatched efforts before turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness({
      activeModelCatalog: catalog,
      effectiveModelSelection: {
        model: "gpt-current-codex",
        effort: "max",
      },
    });

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: "Reject this",
        model: "gpt-current-codex",
        effort: "Ultra",
      }),
    ).rejects.toMatchObject({
      name: "CodexModelSelectionError",
      kind: "unsupported-effort",
    });
    expect(sendRequest).not.toHaveBeenCalled();
    expect(context.effectiveModelSelection).toEqual({
      model: "gpt-current-codex",
      effort: "max",
    });
  });

  it("rejects an unknown explicit model when the catalog is loaded", async () => {
    const { manager, sendRequest } = createSendTurnHarness({
      activeModelCatalog: catalog,
    });

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: "Reject this model",
        model: "gpt-unknown-codex",
      }),
    ).rejects.toMatchObject({
      name: "CodexModelSelectionError",
      kind: "unknown-model",
    });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("rejects explicit effort when catalog discovery is unavailable", async () => {
    const { manager, sendRequest } = createSendTurnHarness();

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: "Cannot validate this",
        effort: "ultra",
      }),
    ).rejects.toMatchObject({
      name: "CodexModelSelectionError",
      kind: "catalog-unavailable",
    });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("does not mutate effective selection after turn/start fails", async () => {
    const previousSelection = {
      model: "gpt-current-codex",
      effort: "max",
    } as const;
    const { manager, context, sendRequest, updateSession } = createSendTurnHarness({
      activeModelCatalog: catalog,
      effectiveModelSelection: previousSelection,
    });
    sendRequest.mockRejectedValueOnce(new Error("turn/start failed"));

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: "Switch models",
        model: "gpt-next-codex",
      }),
    ).rejects.toThrow("turn/start failed");

    expect(context.effectiveModelSelection).toBe(previousSelection);
    expect(updateSession).not.toHaveBeenCalled();
  });
});
