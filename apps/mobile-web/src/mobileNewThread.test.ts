import { BUILT_IN_CHATS_PROJECT_ID, ProjectId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMobileDraftThread,
  createMobileDraftThread,
  getMobileDraftThread,
  setMobileDraftThread,
} from "./mobileDraftThread";
import { buildMobileCreateThreadBootstrap } from "./mobileNewThread.logic";

function createSessionStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

describe("mobileDraftThread", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createSessionStorageMock());
  });

  it("stores and clears draft threads in session storage", () => {
    const draft = createMobileDraftThread(BUILT_IN_CHATS_PROJECT_ID);
    setMobileDraftThread(draft);
    expect(getMobileDraftThread(draft.threadId)).toEqual(draft);
    clearMobileDraftThread(draft.threadId);
    expect(getMobileDraftThread(draft.threadId)).toBeNull();
  });
});

describe("buildMobileCreateThreadBootstrap", () => {
  it("builds a create-thread bootstrap for a project", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const bootstrap = buildMobileCreateThreadBootstrap({
      project: {
        id: projectId,
        title: "Demo",
        workspaceRoot: "/tmp/demo",
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletingAt: null,
        deletedAt: null,
      },
      promptText: "Ship mobile new chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      branch: null,
      worktreePath: null,
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    expect(bootstrap.createThread?.projectId).toBe(projectId);
    expect(bootstrap.createThread?.title).toBe("Ship mobile new chat");
    expect(bootstrap.createThread?.modelSelection).toEqual({
      provider: "codex",
      model: "gpt-5",
    });
    expect(bootstrap.createThread?.worktreePath).toBeNull();
  });
});
