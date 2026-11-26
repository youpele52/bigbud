import type { ModelCapabilities } from "@bigbud/contracts/core/model";
import { SELECTABLE_PROVIDER_KINDS } from "@bigbud/contracts/constants/provider.constant.ts";
import { describe, expect, it } from "vitest";

import { listDelegatedEffort } from "./ThreadOrchestrationTools.modelChoice.effort.ts";
import { context, provider, trunk } from "./ThreadOrchestrationTools.modelChoice.test.helpers.ts";
import { decideModelChoice } from "./ThreadOrchestrationTools.modelChoice.ts";

const liveHigh: ModelCapabilities = {
  reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
  effortMetadataOrigin: "live",
  effortMetadataStatus: "verified-supported",
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const fields = {
  codex: "reasoningEffort",
  claudeAgent: "effort",
  cliProxy: "effort",
  copilot: "reasoningEffort",
  cursor: "reasoning",
  devin: "reasoning",
  muse: "reasoningEffort",
  opencodeV2: "variant",
  pi: "thinkingLevel",
} satisfies Record<(typeof SELECTABLE_PROVIDER_KINDS)[number], string>;

const decide = (request: unknown, ctx: ReturnType<typeof context>) =>
  decideModelChoice({
    request,
    context: ctx,
    trunk: { ...trunk, provider: "codex", options: { reasoningEffort: "low", fastMode: true } },
    choiceId: "choice",
    delegationId: "delegation",
    heldMessageId: "message",
    deadlineAt: "2026-11-23T00:00:00.000Z",
  });

const catalog = (caps: ModelCapabilities | null = liveHigh) =>
  context({ providers: [provider("codex", {}, [{ slug: "gpt-5", capabilities: caps }])] });

describe("strict delegated model effort", () => {
  it.each(SELECTABLE_PROVIDER_KINDS)(
    "advertises and patches the verified native field for %s",
    (kind) => {
      const model = {
        slug: "exact-model",
        subProviderID: "upstream",
        effortCatalogDirectory: "/project",
        capabilities: liveHigh,
      };
      const ctx = context({
        providers: [provider(kind, {}, [model])],
        target: { workspaceRoot: "/project" },
      });
      const selection = { provider: kind, model: model.slug, subProviderID: model.subProviderID };
      expect(listDelegatedEffort(ctx, selection)).toEqual({
        status: "supported",
        levels: liveHigh.reasoningEffortLevels,
      });
      const request = { requested: "high", reason: null };
      // V2's resolver additionally checks preview/trust; its same-location mapping is tested below.
      if (kind === "opencodeV2") return;
      const actual = decide({ ...selection, effort: " high ", options: { fastMode: true } }, ctx);
      expect(actual).toMatchObject({
        kind: "immediate",
        resolved: {
          effort: { ...request, configured: "high" },
          used: { options: { [fields[kind]]: "high" } },
        },
      });
      expect(actual.kind === "immediate" && actual.resolved.used.options).toEqual({
        [fields[kind]]: "high",
      });
    },
  );

  it.each([null, false, 5, " ", "x".repeat(65)])(
    "isolates malformed effort %j from model choice",
    (effort) => {
      expect(decide({ provider: "codex", model: "gpt-5", effort }, catalog())).toMatchObject({
        kind: "immediate",
        resolved: {
          outcome: "requested",
          reason: null,
          effort: { reason: "invalid-effort" },
          used: { options: { fastMode: true, reasoningEffort: "low" } },
        },
      });
    },
  );

  it("patches only effort on the parent's model and never copies it to a hold or disabled choice", () => {
    const ctx = catalog();
    expect(decide({ provider: "codex", model: "gpt-5", effort: "high" }, ctx)).toMatchObject({
      resolved: { used: { options: { fastMode: true, reasoningEffort: "high" } } },
    });
    const disabled = {
      ...ctx,
      settings: { ...ctx.settings, delegatedThreadModelChoice: "parent" as const },
    };
    expect(decide({ provider: "codex", effort: "high" }, disabled)).toMatchObject({
      resolved: {
        effort: { requested: "high", reason: "agent-choice-disabled" },
        used: { options: { reasoningEffort: "low" } },
      },
    });
    expect(decide({ provider: "claudeAgent", effort: "high" }, ctx)).toMatchObject({
      resolved: {
        effort: { requested: "high", reason: "model-not-selected" },
        used: { options: { reasoningEffort: "low" } },
      },
    });
  });

  it.each(["codex", "pi"] as const)(
    "reports unknown on a remote %s runtime despite verified local support",
    (kind) => {
      const selection = {
        provider: kind,
        model: "exact",
        ...(kind === "pi" ? { subProviderID: "upstream" } : {}),
      };
      const ctx = context({
        providers: [
          provider(kind, {}, [
            {
              slug: "exact",
              ...(kind === "pi" ? { subProviderID: "upstream" } : {}),
              capabilities: liveHigh,
            },
          ]),
        ],
      });
      expect(listDelegatedEffort(ctx, selection).status).toBe("supported");
      const remote = { ...ctx, target: { providerRuntimeExecutionTargetId: "ssh:elsewhere" } };
      expect(listDelegatedEffort(remote, selection)).toEqual({ status: "unknown", levels: [] });
      expect(decide({ ...selection, effort: "high" }, remote)).toMatchObject({
        resolved: {
          outcome: "requested",
          effort: { requested: "high", reason: "capabilities-unknown" },
        },
      });
    },
  );

  it("does not treat seed tiers or case-insensitive values as proof", () => {
    expect(
      decide(
        { provider: "codex", effort: "high" },
        catalog({ ...liveHigh, effortMetadataOrigin: "seed" }),
      ),
    ).toMatchObject({
      resolved: { effort: { reason: "capabilities-unknown" } },
    });
    expect(decide({ provider: "codex", effort: "High" }, catalog())).toMatchObject({
      resolved: { effort: { requested: "High", reason: "unsupported-effort" } },
    });
    expect(
      listDelegatedEffort(
        catalog({
          ...liveHigh,
          effortMetadataStatus: "verified-unsupported",
          reasoningEffortLevels: [],
        }),
        trunk,
      ),
    ).toEqual({ status: "unsupported", levels: [] });
  });

  it("does not switch the provider-only recent model to get a supported tier", () => {
    const ctx = context({
      providers: [
        provider("codex", {}, [{ slug: "gpt-5", capabilities: liveHigh }, { slug: "recent" }]),
      ],
      recent: [{ provider: "codex", model: "recent", lastUsedAt: "2026-11-23T00:00:00.000Z" }],
    });
    expect(decide({ provider: "codex", effort: "high" }, ctx)).toMatchObject({
      resolved: { used: { model: "recent" }, effort: { reason: "capabilities-unknown" } },
    });
  });

  it("keys model aliases and same slugs by exact upstream identity", () => {
    const ctx = context({
      providers: [
        provider("pi", {}, [
          { slug: "same", name: "Provider A", subProviderID: "a" },
          { slug: "same", name: "Provider B", subProviderID: "b", capabilities: liveHigh },
        ]),
      ],
    });
    expect(decide({ provider: "pi", model: "Provider B", effort: "high" }, ctx)).toMatchObject({
      resolved: { used: { model: "same", subProviderID: "b", options: { thinkingLevel: "high" } } },
    });
    expect(
      decide({ provider: "pi", model: "same", subProviderID: "a", effort: "high" }, ctx),
    ).toMatchObject({ resolved: { effort: { reason: "capabilities-unknown" } } });
    expect(decide({ provider: "pi", model: "same", effort: "high" }, ctx)).toMatchObject({
      resolved: { effort: { reason: "capabilities-unknown" } },
    });
  });

  it("does not apply an OpenCode variant based on a different catalog directory", () => {
    const selection = { provider: "opencodeV2", model: "model", subProviderID: "gateway" } as const;
    const ctx = context({
      providers: [
        provider("opencodeV2", {}, [
          {
            slug: selection.model,
            subProviderID: selection.subProviderID,
            effortCatalogDirectory: "/one",
            capabilities: liveHigh,
          },
        ]),
      ],
      target: { workspaceRoot: "/two" },
    });
    expect(listDelegatedEffort(ctx, selection).status).toBe("unknown");
    expect(
      listDelegatedEffort({ ...ctx, target: { workspaceRoot: "/one" } }, selection).status,
    ).toBe("supported");
  });
});
