import { ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  clearThreadUi,
  markThreadUnread,
  markThreadVisited,
  PERSISTED_STATE_KEY,
  persistState,
  readPersistedState,
  reorderProjects,
  sanitizePersistedThreadLastVisitedAt,
  setFavouritesExpanded,
  setProjectExpanded,
  setSidebarSectionExpanded,
  setThreadChangedFilesExpanded,
  syncProjects,
  syncThreads,
  type UiState,
} from "./ui.store";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    chatsExpanded: true,
    favouritesExpanded: true,
    projectExpandedById: {},
    projectOrder: [],
    projectsExpanded: false,
    remoteProjectsExpanded: false,
    selectedProjectId: null,
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, latestTurnCompletedAt);

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, null);

    expect(next).toBe(initialState);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState = makeUiState({
      projectOrder: [project1, project2, project3],
    });

    const next = reorderProjects(initialState, project1, project3);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("syncProjects preserves current project order during snapshot recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
        [project2]: false,
      },
      projectOrder: [project2, project1],
    });

    const next = syncProjects(initialState, [
      { id: project1, cwd: "/tmp/project-1" },
      { id: project2, cwd: "/tmp/project-2" },
      { id: project3, cwd: "/tmp/project-3" },
    ]);

    expect(next.projectOrder).toEqual([project2, project1, project3]);
    expect(next.projectExpandedById[project2]).toBe(false);
  });

  it("syncProjects preserves manual order when a project is recreated with the same cwd", () => {
    const oldProject1 = ProjectId.makeUnsafe("project-1");
    const oldProject2 = ProjectId.makeUnsafe("project-2");
    const recreatedProject2 = ProjectId.makeUnsafe("project-2b");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [oldProject1]: true,
          [oldProject2]: false,
        },
        projectOrder: [oldProject2, oldProject1],
      }),
      [
        { id: oldProject1, cwd: "/tmp/project-1" },
        { id: oldProject2, cwd: "/tmp/project-2" },
      ],
    );

    const next = syncProjects(initialState, [
      { id: oldProject1, cwd: "/tmp/project-1" },
      { id: recreatedProject2, cwd: "/tmp/project-2" },
    ]);

    expect(next.projectOrder).toEqual([recreatedProject2, oldProject1]);
    expect(next.projectExpandedById[recreatedProject2]).toBe(false);
  });

  it("syncProjects returns a new state when only project cwd changes", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [project1]: false,
        },
        projectOrder: [project1],
      }),
      [{ id: project1, cwd: "/tmp/project-1" }],
    );

    const next = syncProjects(initialState, [{ id: project1, cwd: "/tmp/project-1-renamed" }]);

    expect(next).not.toBe(initialState);
    expect(next.projectOrder).toEqual([project1]);
    expect(next.projectExpandedById[project1]).toBe(false);
  });

  it("syncThreads prunes missing thread UI state", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const thread2 = ThreadId.makeUnsafe("thread-2");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
        [thread2]: "2026-02-25T12:36:00.000Z",
      },
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
        [thread2]: {
          "turn-2": false,
        },
      },
    });

    const next = syncThreads(initialState, [{ id: thread1 }]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
    expect(next.threadChangedFilesExpandedById).toEqual({
      [thread1]: {
        "turn-1": false,
      },
    });
  });

  it("syncThreads seeds visit state for unseen snapshot threads", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState();

    const next = syncThreads(initialState, [
      {
        id: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
  });

  it("setProjectExpanded updates expansion without touching order", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
      },
      projectOrder: [project1],
    });

    const next = setProjectExpanded(initialState, project1, false);

    expect(next.projectExpandedById[project1]).toBe(false);
    expect(next.projectOrder).toEqual([project1]);
  });

  it("setFavouritesExpanded updates the favourites section state", () => {
    const initialState = makeUiState({
      favouritesExpanded: true,
    });

    const next = setFavouritesExpanded(initialState, false);

    expect(next.favouritesExpanded).toBe(false);
  });

  it("setSidebarSectionExpanded updates each persisted sidebar section", () => {
    const initialState = makeUiState();

    const chatsCollapsed = setSidebarSectionExpanded(initialState, "chatsExpanded", false);
    const projectsExpanded = setSidebarSectionExpanded(chatsCollapsed, "projectsExpanded", true);
    const remoteProjectsExpanded = setSidebarSectionExpanded(
      projectsExpanded,
      "remoteProjectsExpanded",
      true,
    );

    expect(remoteProjectsExpanded).toMatchObject({
      chatsExpanded: false,
      projectsExpanded: true,
      remoteProjectsExpanded: true,
    });
  });

  it("persists sidebar section expansion for the next launch", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    try {
      persistState(
        makeUiState({
          chatsExpanded: false,
          projectsExpanded: true,
          remoteProjectsExpanded: true,
        }),
      );

      expect(JSON.parse(values.get(PERSISTED_STATE_KEY)!)).toMatchObject({
        chatsExpanded: false,
        projectsExpanded: true,
        remoteProjectsExpanded: true,
      });
      expect(readPersistedState()).toMatchObject({
        chatsExpanded: false,
        projectsExpanded: true,
        remoteProjectsExpanded: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clearThreadUi removes visit state for deleted threads", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
      },
    });

    const next = clearThreadUi(initialState, thread1);

    expect(next.threadLastVisitedAtById).toEqual({});
    expect(next.threadChangedFilesExpandedById).toEqual({});
  });

  it("setThreadChangedFilesExpanded stores expanded turns per thread", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState();

    const next = setThreadChangedFilesExpanded(initialState, thread1, "turn-1", true);

    expect(next.threadChangedFilesExpandedById).toEqual({
      [thread1]: {
        "turn-1": true,
      },
    });
  });

  it("setThreadChangedFilesExpanded removes thread overrides when collapsed again", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState({
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": true,
        },
      },
    });

    const next = setThreadChangedFilesExpanded(initialState, thread1, "turn-1", false);

    expect(next.threadChangedFilesExpandedById).toEqual({});
  });

  it("markThreadVisited keeps the later visit when merging another window", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const thread2 = ThreadId.makeUnsafe("thread-2");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-08-19T00:05:00.000Z",
      },
    });

    const next = markThreadVisited(
      markThreadVisited(initialState, thread1, "2026-08-19T00:04:00.000Z"),
      thread2,
      "2026-08-19T00:06:00.000Z",
    );

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-08-19T00:05:00.000Z",
      [thread2]: "2026-08-19T00:06:00.000Z",
    });
  });

  it("sanitizePersistedThreadLastVisitedAt keeps valid ISO timestamps", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");

    expect(
      sanitizePersistedThreadLastVisitedAt({
        [thread1]: "2026-08-19T00:06:00.000Z",
        "bad-thread": "not-a-date",
      }),
    ).toEqual({
      [thread1]: "2026-08-19T00:06:00.000Z",
    });
  });
});
