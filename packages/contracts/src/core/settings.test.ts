import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vitest";

import {
  ClientSettingsSchema,
  COMPUTER_USE_ACTION_TIMEOUT_MS_MAX,
  COMPUTER_USE_ACTION_TIMEOUT_MS_MIN,
  COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX,
  COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN,
  CONTEXT_WINDOW_WARNING_THRESHOLD_MAX,
  CONTEXT_WINDOW_WARNING_THRESHOLD_MIN,
  DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS,
  DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CONTEXT_WINDOW_WARNING_THRESHOLD,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings";

const decodeClientSettings = Schema.decodeUnknownEffect(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

describe("DEFAULT_CLIENT_SETTINGS", () => {
  test("defaults terminal appearance settings for client settings", () => {
    expect(DEFAULT_CLIENT_SETTINGS.terminalFontFamily).toBe("meslo-nerd-font-mono");
    expect(DEFAULT_CLIENT_SETTINGS.terminalFontSize).toBe(12);
    expect(DEFAULT_CLIENT_SETTINGS.windowMaterial).toBe("automatic");
  });

  test("defaults the context window warning threshold", () => {
    expect(DEFAULT_CLIENT_SETTINGS.contextWindowWarningThresholdTokens).toBe(
      DEFAULT_CONTEXT_WINDOW_WARNING_THRESHOLD,
    );
  });

  test("shows every provider in the composer by default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.hiddenComposerProviders).toEqual([]);
  });
});

describe("DEFAULT_SERVER_SETTINGS", () => {
  test("defaults assistant and thinking streaming to enabled", () => {
    expect(DEFAULT_SERVER_SETTINGS.enableAssistantStreaming).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.enableThinkingStreaming).toBe(true);
  });

  test("defaults Cursor to enabled", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.cursor.enabled).toBe(true);
  });

  test("defaults CLIProxyAPI to enabled without a persisted config path", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.cliProxy).toEqual({
      enabled: true,
      configPath: "",
    });
  });

  test("defaults Cursor to the agent CLI binary", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.cursor.binaryPath).toBe("agent");
  });

  test("defaults desktop computer use to disabled until the user opts in", () => {
    expect(DEFAULT_SERVER_SETTINGS.agentBrowserPreference).toBe("bigbud");
    expect(DEFAULT_SERVER_SETTINGS.computerUseEnabled).toBe(false);
    expect(DEFAULT_SERVER_SETTINGS.hasSeenComputerUsePrompt).toBe(false);
  });

  test("keeps shipped Claude paths enabled and preview features disabled", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeAgent.rollout).toEqual({
      modernTaskExposure: true,
      boundedHookProgress: true,
      forwardedSubagentText: false,
      mcpControls: true,
      fileCheckpointRewind: false,
      nativeFork: false,
    });
  });

  test("defaults computer use limits", () => {
    expect(DEFAULT_SERVER_SETTINGS.computerUseCheckInIntervalMs).toBe(
      DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS,
    );
    expect(DEFAULT_SERVER_SETTINGS.computerUseActionTimeoutMs).toBe(
      DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS,
    );
  });
});

it.effect("decodes valid terminal appearance settings", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientSettings({
      terminalFontFamily: "system-monospace",
      terminalFontSize: 14,
      windowMaterial: "translucent",
    });

    assert.strictEqual(parsed.terminalFontFamily, "system-monospace");
    assert.strictEqual(parsed.terminalFontSize, 14);
    assert.strictEqual(parsed.windowMaterial, "translucent");
  }),
);

it.effect("defaults composer provider visibility when decoding older settings", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientSettings({ terminalFontSize: 14 });

    assert.deepStrictEqual(parsed.hiddenComposerProviders, []);
  }),
);

it.effect("rejects out-of-range terminal font sizes", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeClientSettings({
        terminalFontFamily: "meslo-nerd-font-mono",
        terminalFontSize: 22,
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes valid context window warning thresholds", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientSettings({
      contextWindowWarningThresholdTokens: CONTEXT_WINDOW_WARNING_THRESHOLD_MAX,
    });

    assert.strictEqual(
      parsed.contextWindowWarningThresholdTokens,
      CONTEXT_WINDOW_WARNING_THRESHOLD_MAX,
    );
  }),
);

it.effect("rejects out-of-range context window warning thresholds", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeClientSettings({
        contextWindowWarningThresholdTokens: CONTEXT_WINDOW_WARNING_THRESHOLD_MIN - 1,
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes valid computer use limits", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeServerSettings({
      computerUseCheckInIntervalMs: COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX,
      computerUseActionTimeoutMs: COMPUTER_USE_ACTION_TIMEOUT_MS_MAX,
    });

    assert.strictEqual(parsed.computerUseCheckInIntervalMs, COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX);
    assert.strictEqual(parsed.computerUseActionTimeoutMs, COMPUTER_USE_ACTION_TIMEOUT_MS_MAX);
  }),
);

it.effect("rejects out-of-range computer use limits", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeServerSettings({
        computerUseCheckInIntervalMs: COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN - 1,
        computerUseActionTimeoutMs: COMPUTER_USE_ACTION_TIMEOUT_MS_MIN - 1,
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts supported agent browser preferences and rejects invalid values", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeServerSettings({ agentBrowserPreference: "system" });
    assert.strictEqual(parsed.agentBrowserPreference, "system");

    const invalidSettings = yield* Effect.exit(
      decodeServerSettings({ agentBrowserPreference: "provider-native" }),
    );
    const invalidPatch = yield* Effect.exit(
      Schema.decodeUnknownEffect(ServerSettingsPatch)({
        agentBrowserPreference: "provider-native",
      }),
    );
    assert.strictEqual(invalidSettings._tag, "Failure");
    assert.strictEqual(invalidPatch._tag, "Failure");
  }),
);

test("decodes an agent browser preference patch", () => {
  expect(
    Schema.decodeUnknownSync(ServerSettingsPatch)({ agentBrowserPreference: "system" }),
  ).toEqual({ agentBrowserPreference: "system" });
});

test("decodes a narrow Claude rollout settings patch", () => {
  const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
  expect(
    decodePatch({
      providers: {
        claudeAgent: {
          rollout: {
            modernTaskExposure: true,
            boundedHookProgress: true,
          },
        },
      },
    }),
  ).toEqual({
    providers: {
      claudeAgent: {
        rollout: {
          modernTaskExposure: true,
          boundedHookProgress: true,
        },
      },
    },
  });
});

test("decodes and preserves a CLIProxyAPI config path in settings patches", () => {
  const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

  expect(
    decodePatch({
      providers: {
        cliProxy: {
          configPath: "/Users/example/.cli-proxy-api/config.yaml",
        },
      },
    }),
  ).toEqual({
    providers: {
      cliProxy: {
        configPath: "/Users/example/.cli-proxy-api/config.yaml",
      },
    },
  });
});

test("decodes historical settings without CLIProxyAPI fields", () => {
  const decoded = Schema.decodeUnknownSync(ServerSettings)({
    providers: {
      codex: {
        enabled: false,
        binaryPath: "codex",
        homePath: "",
        customModels: [],
      },
    },
  });

  expect(decoded.providers.cliProxy).toEqual({ enabled: true, configPath: "" });
  expect(decoded.agentBrowserPreference).toBe("bigbud");
});
