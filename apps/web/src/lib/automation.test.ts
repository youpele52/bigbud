import { describe, expect, it } from "vitest";

import {
  AUTOMATION_AUTHORING_RUNTIME_MODE,
  AUTOMATION_SKILL_PROMPT,
  buildAutomationSkillDispatchPrompt,
  compareAutomationSchedules,
  deriveAutomationAssistantDisplayState,
  formatAutomationContextDateTime,
  formatAutomationListTimeLabel,
  validateAutomationSkillRequest,
} from "./automation";

describe("automation", () => {
  it("uses supervised authoring mode for automation setup threads", () => {
    expect(AUTOMATION_AUTHORING_RUNTIME_MODE).toBe("approval-required");
  });

  it("adds authoring-only guardrails and current local time to the setup prompt", () => {
    const prompt = buildAutomationSkillDispatchPrompt({
      rawPrompt: `${AUTOMATION_SKILL_PROMPT}check this folder at 18:33 today`,
      defaultProjectName: "Chats",
      deviceTimeZone: "Europe/Berlin",
      now: new Date("2026-06-16T16:31:00.000Z"),
    });

    expect(prompt).toContain("Automation authoring rules:");
    expect(prompt).toContain("Do not perform the requested task now.");
    expect(prompt).toContain(
      "Do not inspect files, run commands, or produce the requested result during setup.",
    );
    expect(prompt).toContain("Current local date/time: 2026-06-16 18:31 (Europe/Berlin)");
    expect(prompt).toContain("User request:\ncheck this folder at 18:33 today");
  });

  it("leaves non-automation prompts unchanged", () => {
    expect(
      buildAutomationSkillDispatchPrompt({
        rawPrompt: "hello",
        defaultProjectName: "Chats",
        deviceTimeZone: "UTC",
      }),
    ).toBe("hello");
  });

  it("formats automation context time in the target timezone", () => {
    expect(
      formatAutomationContextDateTime(new Date("2026-06-16T16:31:00.000Z"), "Europe/Berlin"),
    ).toBe("2026-06-16 18:31");
  });

  it("includes existing automation context for edit flows", () => {
    const prompt = buildAutomationSkillDispatchPrompt({
      rawPrompt: `${AUTOMATION_SKILL_PROMPT}make this run every weekday at 9`,
      defaultProjectName: "Chats",
      deviceTimeZone: "Europe/Berlin",
      existingAutomation: {
        title: "Morning brief",
        prompt: "Summarize today's work",
        projectName: "Chats",
        scheduleLabel: "Once on June 16, 2026 at 9:00 AM",
        timezone: "Europe/Berlin",
      },
      now: new Date("2026-06-16T16:31:00.000Z"),
    });

    expect(prompt).toContain("Existing automation:");
    expect(prompt).toContain("Title: Morning brief");
    expect(prompt).toContain(
      "Preserve unchanged intent unless the user explicitly asks to change it.",
    );
  });

  it("orders active automations before paused and completed ones", () => {
    const ordered = [
      {
        createdAt: "2026-06-16T10:00:00.000Z",
        completedAt: "2026-06-16T11:00:00.000Z",
        nextRunAt: null,
        pausedAt: null,
      },
      {
        createdAt: "2026-06-16T09:00:00.000Z",
        completedAt: null,
        nextRunAt: "2026-06-16T09:30:00.000Z",
        pausedAt: null,
      },
      {
        createdAt: "2026-06-16T08:00:00.000Z",
        completedAt: null,
        nextRunAt: "2026-06-16T10:30:00.000Z",
        pausedAt: "2026-06-16T08:30:00.000Z",
      },
    ].toSorted(compareAutomationSchedules);

    expect(ordered.map((entry) => entry.nextRunAt ?? entry.completedAt)).toEqual([
      "2026-06-16T09:30:00.000Z",
      "2026-06-16T10:30:00.000Z",
      "2026-06-16T11:00:00.000Z",
    ]);
  });

  it("validates one-time automation requests require a future run time", () => {
    expect(
      validateAutomationSkillRequest(
        {
          title: "Morning brief",
          prompt: "Say hello",
          scheduleKind: "once",
          scheduleLabel: "Once tomorrow at 9:00 AM",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
        new Date("2026-06-16T10:00:00.000Z"),
      ),
    ).toBe("One-time automations must include a scheduled run time.");

    expect(
      validateAutomationSkillRequest(
        {
          title: "Morning brief",
          prompt: "Say hello",
          scheduleKind: "once",
          scheduleLabel: "Once tomorrow at 9:00 AM",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          runAt: "2026-06-16T09:00:00.000Z",
        },
        new Date("2026-06-16T10:00:00.000Z"),
      ),
    ).toBe("The scheduled run time must be in the future.");

    expect(
      validateAutomationSkillRequest(
        {
          title: "Morning brief",
          prompt: "Say hello",
          scheduleKind: "custom",
          scheduleLabel: "Weekdays at 9:00 AM",
          cronExpression: "0 9 * * 1-5",
          timezone: "UTC",
        },
        new Date("2026-06-16T10:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("derives a clean visible assistant message for automation requests", () => {
    expect(
      deriveAutomationAssistantDisplayState(
        [
          "I have enough information. Here's your automation request:",
          "",
          "<automation_request>",
          '{ "title": "World Cup Score Check", "prompt": "Check the score", "scheduleKind": "once", "scheduleLabel": "Once tonight", "cronExpression": "40 22 16 6 *", "timezone": "Europe/Berlin", "runAt": "2026-06-16T20:40:12.000Z" }',
          "</automation_request>",
        ].join("\n"),
      ),
    ).toEqual({
      request: {
        title: "World Cup Score Check",
        prompt: "Check the score",
        scheduleKind: "once",
        scheduleLabel: "Once tonight",
        cronExpression: "40 22 16 6 *",
        timezone: "Europe/Berlin",
        runAt: "2026-06-16T20:40:12.000Z",
      },
      requestPayload:
        '{ "title": "World Cup Score Check", "prompt": "Check the score", "scheduleKind": "once", "scheduleLabel": "Once tonight", "cronExpression": "40 22 16 6 *", "timezone": "Europe/Berlin", "runAt": "2026-06-16T20:40:12.000Z" }',
      visibleText: "I have enough information. Here's your automation request:",
    });
  });

  it("formats automation list time labels as next run or frequency", () => {
    expect(
      formatAutomationListTimeLabel({
        scheduleKind: "once",
        scheduleLabel: "Once on June 17, 2026 at 11:37 AM CEST",
        nextRunAt: null,
        completedAt: "2026-06-17T09:37:00.000Z",
        pausedAt: null,
      }),
    ).toBe("Once");

    expect(
      formatAutomationListTimeLabel({
        scheduleKind: "custom",
        scheduleLabel: "Weekdays at 10:26 AM",
        nextRunAt: "2026-06-18T08:26:00.000Z",
        completedAt: null,
        pausedAt: null,
      }),
    ).toContain("2026");

    expect(
      formatAutomationListTimeLabel({
        scheduleKind: "custom",
        scheduleLabel: "Weekdays at 10:26 AM",
        nextRunAt: null,
        completedAt: "2026-06-17T09:37:00.000Z",
        pausedAt: null,
      }),
    ).toBe("Weekdays at 10:26 AM");
  });
});
