import { BUILT_IN_CHATS_PROJECT_ID, ProjectId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { Project } from "~/models/types";

import { resolveAutomationDefaultProjectId } from "./AutomationWorkspace";

describe("resolveAutomationDefaultProjectId", () => {
  const documentsProject = {
    id: ProjectId.makeUnsafe("project-documents"),
    name: "Documents",
    cwd: "/Users/test/Documents",
  } as Project;
  const workProject = {
    id: ProjectId.makeUnsafe("project-work"),
    name: "Work",
    cwd: "/Users/test/Work",
  } as Project;

  it("prefers the default chat folder project when no project is selected", () => {
    expect(
      resolveAutomationDefaultProjectId({
        defaultChatCwd: "/Users/test/Documents",
        preferredProjectId: null,
        projects: [workProject, documentsProject],
        uiSelectedProjectId: null,
      }),
    ).toBe(documentsProject.id);
  });

  it("keeps an explicit preferred project", () => {
    expect(
      resolveAutomationDefaultProjectId({
        defaultChatCwd: "/Users/test/Documents",
        preferredProjectId: workProject.id,
        projects: [documentsProject, workProject],
        uiSelectedProjectId: documentsProject.id,
      }),
    ).toBe(workProject.id);
  });

  it("keeps an explicit preferred Chats project", () => {
    expect(
      resolveAutomationDefaultProjectId({
        defaultChatCwd: "/Users/test/Documents",
        preferredProjectId: BUILT_IN_CHATS_PROJECT_ID,
        projects: [documentsProject, workProject],
        uiSelectedProjectId: documentsProject.id,
      }),
    ).toBe(BUILT_IN_CHATS_PROJECT_ID);
  });

  it("keeps an explicit Chats selection from UI state", () => {
    expect(
      resolveAutomationDefaultProjectId({
        defaultChatCwd: "/Users/test/Documents",
        preferredProjectId: null,
        projects: [documentsProject, workProject],
        uiSelectedProjectId: BUILT_IN_CHATS_PROJECT_ID,
      }),
    ).toBe(BUILT_IN_CHATS_PROJECT_ID);
  });

  it("falls back to the built-in Chats project when the default chat folder does not match a project", () => {
    expect(
      resolveAutomationDefaultProjectId({
        defaultChatCwd: "/Users/test/Desktop",
        preferredProjectId: null,
        projects: [documentsProject, workProject],
        uiSelectedProjectId: null,
      }),
    ).toBe(BUILT_IN_CHATS_PROJECT_ID);
  });
});
