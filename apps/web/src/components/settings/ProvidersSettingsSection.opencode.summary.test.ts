import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import {
  OPENCODE_RETAINED_HISTORY_ADVISORY,
  opencodeUpdateAdvice,
} from "@bigbud/shared/opencodeAdvisory";
import { expect, it } from "vitest";
import { buildProviderCards } from "./ProvidersSettingsSection.logic";

const provider: ServerProvider = {
  provider: "opencodeV2",
  enabled: true,
  installed: true,
  version: "2.0.28",
  status: "warning",
  auth: { status: "authenticated", label: "Anthropic, OpenAI" },
  checkedAt: "2026-10-14T00:00:00.000Z",
  initialProbeComplete: true,
  message: `Connected to your native OpenCode service. ${OPENCODE_RETAINED_HISTORY_ADVISORY}`,
  models: [],
  slashCommands: [],
  skills: [],
};
const card = (patch: Partial<ServerProvider> = {}, enabled = true) =>
  buildProviderCards({
    serverProviders: [{ ...provider, ...patch }],
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        opencodeV2: { ...DEFAULT_UNIFIED_SETTINGS.providers.opencodeV2, enabled },
      },
    },
  }).find((c) => c.provider === "opencodeV2")!;

it("uses a brief green account-authentication headline for history-only advisory, not execution readiness", () => {
  const value = card();
  expect(value.summary).toEqual({ headline: "Authenticated", detail: null });
  expect(value.statusStyle.dot).toBe("bg-success");
  expect(value.nativeStatus).toMatchObject({
    authenticated: true,
    accounts: "Anthropic, OpenAI",
    attention: null,
    historyAdvisory: OPENCODE_RETAINED_HISTORY_ADVISORY,
  });
  expect(provider.status).toBe("warning");
});

it.each([
  { auth: { status: "unknown" as const } },
  { auth: { status: "unauthenticated" as const } },
  { initialProbeComplete: false },
  { installed: false },
  { enabled: false },
  { status: "disabled" as const },
  {
    failure: {
      classification: "user-action-required" as const,
      reason: "authentication-required" as const,
    },
  },
])(
  "never shows authenticated for missing, pending, disabled or failed authentication: %j",
  (patch) => {
    expect(card(patch).summary.headline).not.toBe("Authenticated");
    expect(card(patch).statusStyle.dot).not.toBe("bg-success");
  },
);

it("uses configured disabled state rather than a stale live authenticated snapshot", () => {
  expect(card({}, false).summary.headline).toBe("Disabled");
  expect(card({}, false).statusStyle.dot).not.toBe("bg-success");
});

it.each(["warning", "error"] as const)(
  "keeps real %s separate from authenticated accounts",
  (status) => {
    const value = card({
      status,
      message: `Native contract incompatible. ${OPENCODE_RETAINED_HISTORY_ADVISORY}`,
    });
    expect(value.summary.headline).toBe("Authenticated");
    expect(value.nativeStatus?.attention).toMatchObject({
      tone: status,
      message: "Native contract incompatible.",
    });
  },
);

it("does not strip advisory substrings or change other providers", () => {
  const message = `Cannot authenticate because ${OPENCODE_RETAINED_HISTORY_ADVISORY} Retry with valid credentials.`;
  expect(card({ message }).nativeStatus?.attention?.message).toBe(message);
  const pi = { ...provider, provider: "pi" as const };
  const result = buildProviderCards({
    settings: DEFAULT_UNIFIED_SETTINGS,
    serverProviders: [pi],
  }).find((c) => c.provider === "pi")!;
  expect(result.summary.headline).toBe("Authenticated · Anthropic, OpenAI");
  expect(result.statusStyle.dot).toBe("bg-warning");
});

it("labels an outdated native service with the update advice instead of a setup problem", () => {
  const connected = "Connected to your native OpenCode service.";
  const advice = opencodeUpdateAdvice("2.1.3", "2.1.4");
  const value = card({
    version: "2.1.3",
    message: `${connected} ${advice}`,
    runtimeUpdateRecommended: "2.1.4",
  });
  expect(value.summary.headline).toBe("Authenticated");
  expect(value.nativeStatus?.attention).toEqual({
    label: "Update recommended",
    tone: "warning",
    message: `${connected} ${advice}`,
  });
  expect(advice).toContain("opencode upgrade");
});
