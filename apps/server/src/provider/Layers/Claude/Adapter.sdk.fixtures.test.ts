import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLAUDE_AGENT_SDK_VERSION } from "./Adapter.sdk.ts";
import {
  sdkApiRetryFixture,
  sdkBackgroundTasksFixture,
  sdkElicitationCompleteFixture,
  sdkHookProgressFixture,
  sdkTaskNotificationFixture,
  sdkTaskStartedFixture,
  sdkTaskUpdatedFixture,
} from "./Adapter.sdk.fixtures.ts";
import {
  decodeClaudeApiRetryMessage,
  decodeClaudeBackgroundTasksChangedMessage,
  decodeClaudeCommandsChangedMessage,
  decodeClaudeElicitationCompleteMessage,
  decodeClaudeHookMessage,
  decodeClaudeMcpInitialization,
  decodeClaudeRefusalMessage,
  decodeClaudeResultMessage,
  decodeClaudeTaskNotificationMessage,
  decodeClaudeTaskProgressMessage,
  decodeClaudeTaskStartedMessage,
  decodeClaudeTaskUpdatedMessage,
} from "./Adapter.sdk.messages.ts";

interface FixtureBundle {
  readonly sdkVersion: string;
  readonly messages: ReadonlyArray<unknown>;
}

function loadFixtureBundle(): FixtureBundle {
  const path = new URL("./fixtures/sdk-0.3.219-task-messages.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as FixtureBundle;
}

describe("Claude SDK 0.3.219 task fixtures", () => {
  it("decodes the redacted task update and background snapshot shapes", () => {
    const fixture = loadFixtureBundle();
    expect(fixture.sdkVersion).toBe(CLAUDE_AGENT_SDK_VERSION);

    const taskUpdate = fixture.messages.find(
      (message) => decodeClaudeTaskUpdatedMessage(message) !== undefined,
    );
    const backgroundSnapshot = fixture.messages.find(
      (message) => decodeClaudeBackgroundTasksChangedMessage(message) !== undefined,
    );

    expect(decodeClaudeTaskUpdatedMessage(taskUpdate)).toMatchObject({
      subtype: "task_updated",
      taskId: "task-redacted-1",
      patch: { status: "running", is_backgrounded: true },
    });
    expect(decodeClaudeBackgroundTasksChangedMessage(backgroundSnapshot)).toMatchObject({
      subtype: "background_tasks_changed",
      tasks: [{ taskId: "task-redacted-1", taskType: "agent" }],
    });
  });

  it("decodes every consumed non-stream fixture family", () => {
    const path = new URL("./fixtures/sdk-0.3.219-message-families.json", import.meta.url);
    const fixture = JSON.parse(readFileSync(path, "utf8")) as FixtureBundle;
    const decoders = [
      decodeClaudeTaskStartedMessage,
      decodeClaudeTaskProgressMessage,
      decodeClaudeTaskNotificationMessage,
      decodeClaudeHookMessage,
      decodeClaudeResultMessage,
      decodeClaudeApiRetryMessage,
      decodeClaudeRefusalMessage,
      decodeClaudeCommandsChangedMessage,
      decodeClaudeMcpInitialization,
      decodeClaudeElicitationCompleteMessage,
    ];
    expect(fixture.sdkVersion).toBe(CLAUDE_AGENT_SDK_VERSION);
    expect(fixture.messages.map((message, index) => decoders[index]?.(message))).not.toContain(
      undefined,
    );
  });

  it("builds deterministic typed SDK 0.3.219 message fixtures", () => {
    expect(decodeClaudeTaskStartedMessage(sdkTaskStartedFixture())?.taskId).toBe("task-fixture");
    expect(decodeClaudeTaskNotificationMessage(sdkTaskNotificationFixture())?.status).toBe(
      "completed",
    );
    expect(decodeClaudeTaskUpdatedMessage(sdkTaskUpdatedFixture())?.patch).toEqual({
      status: "running",
    });
    expect(
      decodeClaudeBackgroundTasksChangedMessage(sdkBackgroundTasksFixture())?.tasks,
    ).toHaveLength(1);
    expect(decodeClaudeHookMessage(sdkHookProgressFixture())?.hookId).toBe("hook-fixture");
    expect(decodeClaudeApiRetryMessage(sdkApiRetryFixture())?.errorStatus).toBe(429);
    expect(
      decodeClaudeElicitationCompleteMessage(sdkElicitationCompleteFixture())?.serverName,
    ).toBe("mcp-fixture");
  });

  it("rejects malformed fixture-shaped data", () => {
    expect(
      decodeClaudeTaskUpdatedMessage({
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: { status: "unknown" },
        uuid: "not-important",
        session_id: "session",
      }),
    ).toBeUndefined();

    expect(
      decodeClaudeBackgroundTasksChangedMessage({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "task-1" }],
        uuid: "not-important",
        session_id: "session",
      }),
    ).toBeUndefined();
  });
});
