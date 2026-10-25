import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { describe, expect, it } from "vitest";

import {
  decideModelChoice,
  listRankedUsableModels,
  parseRequestedModelSelection,
} from "./ThreadOrchestrationTools.modelChoice.ts";
import { context, provider, trunk } from "./ThreadOrchestrationTools.modelChoice.test.helpers.ts";

const ids = {
  choiceId: "model-choice:1",
  delegationId: "delegation:1",
  heldMessageId: "message-1",
  deadlineAt: "2026-10-15T10:00:10.000Z",
};
const decide = (request: unknown, ctx = context()) =>
  decideModelChoice({ request, context: ctx, trunk, ...ids });
const reasonOf = (request: unknown, ctx = context({ hasInteractiveClient: false })) => {
  const decision = decide(request, ctx);
  return decision.kind === "immediate" ? decision.resolved.reason : decision.requested.reason;
};

describe("parseRequestedModelSelection", () => {
  it("trims, drops agent options (OD5) and rejects malformed input", () => {
    expect(
      parseRequestedModelSelection({ provider: " codex ", model: " gpt-5 ", options: { x: 1 } }),
    ).toEqual({ provider: "codex", model: "gpt-5" });
    expect(parseRequestedModelSelection(5)).toBeNull();
    expect(parseRequestedModelSelection({ provider: 3 })).toBeNull();
    expect(parseRequestedModelSelection({ provider: "" })).toBeNull();
  });
});

describe("decideModelChoice", () => {
  it("uses a usable requested model immediately", () => {
    const decision = decide({ provider: "claudeAgent", model: "claude-opus" });
    expect(decision.kind).toBe("immediate");
    if (decision.kind !== "immediate") return;
    expect(decision.resolved).toMatchObject({
      used: { provider: "claudeAgent", model: "claude-opus" },
      outcome: "requested",
      resolvedBy: "server",
      reason: null,
    });
    expect(decision.resolved.used).not.toHaveProperty("options");
  });

  it("resolves model names and reuses the trunk's full selection for the trunk's model", () => {
    const byName = decide({ provider: "claudeAgent", model: "Claude Sonnet" });
    expect(byName.kind === "immediate" && byName.resolved.used.model).toBe("claude-sonnet");
    const same = decide({ provider: "codex", model: "gpt-5" });
    expect(same.kind === "immediate" && same.resolved.used).toEqual(trunk);
  });

  it("picks the most recent usable model for a provider-only request, else the first", () => {
    const first = decide({ provider: "claudeAgent" });
    expect(first.kind === "immediate" && first.resolved.used.model).toBe("claude-opus");
    const recent = decide(
      { provider: "claudeAgent" },
      context({
        recent: [
          {
            provider: "claudeAgent",
            model: "claude-locked",
            lastUsedAt: "2026-10-15T09:59:00.000Z",
          },
          {
            provider: "claudeAgent",
            model: "claude-sonnet",
            lastUsedAt: "2026-10-15T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(recent.kind === "immediate" && recent.resolved.used.model).toBe("claude-sonnet");
  });

  it.each([
    ["invalid-request", { provider: 42 }, context()],
    ["unknown-provider", { provider: "nope" }, context()],
    ["provider-retired", { provider: "opencode" }, context()],
    ["unknown-model", { provider: "claudeAgent", model: "claude-9000" }, context()],
    ["model-requires-setup", { provider: "claudeAgent", model: "claude-locked" }, context()],
    [
      "provider-hidden",
      { provider: "claudeAgent" },
      context({
        settings: { ...DEFAULT_SERVER_SETTINGS, hiddenComposerProviders: ["claudeAgent"] },
      }),
    ],
    [
      "provider-disabled",
      { provider: "copilot" },
      context({ providers: [provider("copilot", { enabled: false })] }),
    ],
    [
      "provider-disabled",
      { provider: "copilot" },
      context({ providers: [provider("copilot", { status: "disabled" })] }),
    ],
    [
      "provider-not-installed",
      { provider: "copilot" },
      context({ providers: [provider("copilot", { installed: false })] }),
    ],
    [
      "provider-unavailable",
      { provider: "copilot" },
      context({ providers: [provider("copilot", { status: "error" })] }),
    ],
    [
      "provider-unauthenticated",
      { provider: "copilot" },
      context({ providers: [provider("copilot", { auth: { status: "unauthenticated" } })] }),
    ],
    [
      "provider-untrusted",
      { provider: "opencodeV2" },
      context({ providers: [provider("opencodeV2")] }),
    ],
    [
      "unsupported-execution-target",
      { provider: "copilot" },
      context({
        providers: [provider("copilot", { supportsLocalRuntimeRemoteWorkspace: false })],
        target: { workspaceExecutionTargetId: "remote-1" },
      }),
    ],
    [
      "unsupported-execution-target",
      { provider: "claudeAgent" },
      context({ target: { providerRuntimeExecutionTargetId: "remote-1" } }),
    ],
    [
      "agent-choice-disabled",
      { provider: "claudeAgent" },
      context({ settings: { ...DEFAULT_SERVER_SETTINGS, delegatedThreadModelChoice: "parent" } }),
    ],
    ["catalog-unavailable", { provider: "claudeAgent" }, null],
  ] as const)("falls back with %s", (reason, request, ctx) => {
    const decision = decideModelChoice({
      request,
      context: ctx === null ? null : { ...ctx, hasInteractiveClient: false },
      trunk,
      ...ids,
    });
    expect(decision.kind).toBe("immediate");
    if (decision.kind !== "immediate") return;
    expect(decision.resolved).toMatchObject({ reason, used: trunk, outcome: "fallback" });
  });

  it("accepts unknown auth, custom models and trusted OpenCode V2", () => {
    expect(
      reasonOf(
        { provider: "copilot", model: "my-custom" },
        context({
          hasInteractiveClient: false,
          providers: [
            provider("copilot", { auth: { status: "unknown" } }, [
              { slug: "my-custom", isCustom: true },
            ]),
          ],
        }),
      ),
    ).toBeNull();
    expect(
      reasonOf(
        { provider: "opencodeV2" },
        context({
          hasInteractiveClient: false,
          providers: [provider("opencodeV2")],
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              opencodeV2: {
                ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2,
                nativeServiceTrust: "managed-thread-tools-v2",
              },
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("holds for a connected client with alternatives, else records why it did not wait", () => {
    const held = decide({ provider: "nope" });
    expect(held.kind).toBe("hold");
    if (held.kind === "hold") {
      expect(held.requested).toMatchObject({ reason: "unknown-provider", fallback: trunk, ...ids });
      expect(held.requested.options.filter((option) => option.isFallback)).toHaveLength(1);
    }
    const noClient = decide({ provider: "nope" }, context({ hasInteractiveClient: false }));
    expect(noClient.kind === "immediate" && noClient.resolved.resolvedBy).toBe("no-client");
    const alone = decide(
      { provider: "nope" },
      context({ providers: [provider("codex", {}, [{ slug: "gpt-5" }])] }),
    );
    expect(alone.kind === "immediate" && alone.resolved.resolvedBy).toBe("no-alternatives");
    const disabled = decide(
      { provider: "nope" },
      context({ settings: { ...DEFAULT_SERVER_SETTINGS, delegatedThreadModelChoice: "parent" } }),
    );
    expect(disabled.kind === "immediate" && disabled.resolved.resolvedBy).toBe("disabled");
  });
});

describe("listRankedUsableModels", () => {
  it("offers usable models only, recent first, with the trunk's model flagged", () => {
    const ranked = listRankedUsableModels(
      context({
        settings: { ...DEFAULT_SERVER_SETTINGS, hiddenComposerProviders: ["copilot"] },
        providers: [...context().providers, provider("copilot")],
        recent: [
          {
            provider: "claudeAgent",
            model: "claude-sonnet",
            lastUsedAt: "2026-10-15T09:00:00.000Z",
          },
        ],
      }),
      trunk,
    );
    expect(ranked.map((option) => option.selection.model)).toEqual([
      "claude-sonnet",
      "gpt-5",
      "gpt-5-mini",
      "claude-opus",
    ]);
    expect(ranked[0]?.lastUsedAt).toBe("2026-10-15T09:00:00.000Z");
    expect(ranked.find((option) => option.isFallback)?.selection).toEqual(trunk);
  });
});
