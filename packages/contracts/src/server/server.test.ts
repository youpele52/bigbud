import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfigStreamEvent, ServerVerifyExecutionTargetResult } from "./server";

describe("ServerVerifyExecutionTargetResult", () => {
  it("round-trips the remote agent upgrade requirement", () => {
    const result = {
      executionTargetId: "ssh:example",
      message: "Remote agent upgrade required.",
      remoteAgent: {
        status: "upgrade-required" as const,
        currentVersion: "0.1.0",
        targetVersion: "0.2.0",
      },
    };

    const encoded = Schema.encodeUnknownSync(ServerVerifyExecutionTargetResult)(result);
    expect(Schema.decodeUnknownSync(ServerVerifyExecutionTargetResult)(encoded)).toEqual(result);
  });
});

describe("ServerConfigStreamEvent", () => {
  it("canonicalizes only the observed snapshot newline variant", () => {
    const config = {
      cwd: "/workspace",
      storage: { notesDir: "/notes", kanbanDir: "/kanban" },
      keybindingsConfigPath: "/keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      discovery: { agents: [], skills: [] },
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: {
        enableAssistantStreaming: true,
        enableThinkingStreaming: false,
        threadRetentionPolicy: "never",
      },
    };
    expect(
      Schema.decodeUnknownSync(ServerConfigStreamEvent)({ version: 1, type: "snapshot\n", config }),
    ).toMatchObject({ type: "snapshot" });
    for (const type of [" snapshot", "snapshot ", "snapshot\r\n", "settingsUpdated\n"]) {
      expect(() =>
        Schema.decodeUnknownSync(ServerConfigStreamEvent)({ version: 1, type, config }),
      ).toThrow();
    }
  });
});
