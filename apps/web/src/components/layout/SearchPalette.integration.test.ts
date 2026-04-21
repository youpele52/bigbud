import { ProjectId, ThreadId, MessageId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../models/types";
import type { Project } from "../../models/types";

/**
 * Integration tests for search functionality.
 * Tests the search filtering logic that would be used by SearchPalette.
 */

function createMockThread(overrides: Partial<Thread> & { id: string }): Thread {
  const baseThread: Thread = {
    id: overrides.id as ThreadId,
    codexThreadId: null,
    projectId: (overrides.projectId ?? "project-1") as ProjectId,
    title: overrides.title ?? "Untitled Thread",
    modelSelection: { provider: "codex", model: "gpt-4o" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };

  return { ...baseThread, ...overrides };
}

function createMockProject(overrides: Partial<Project> & { id: string }): Project {
  const baseProject: Project = {
    id: overrides.id as ProjectId,
    name: overrides.name ?? "Test Project",
    cwd: overrides.cwd ?? "/test/path",
    defaultModelSelection: { provider: "codex", model: "gpt-4o" },
    scripts: [],
  };

  return { ...baseProject, ...overrides };
}

function filterThreadsByQuery(
  threads: Thread[],
  projects: Project[],
  query: string,
): Array<{ thread: Thread; projectName: string }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  return threads
    .filter((thread) => thread.archivedAt === null)
    .filter((thread) => {
      const title = thread.title.toLowerCase();
      return title.includes(normalizedQuery);
    })
    .map((thread) => {
      const project = projects.find((p) => p.id === thread.projectId);
      const projectName = project?.name ?? (thread.projectId === "__chats__" ? "Chats" : "Project");
      return { thread, projectName };
    });
}

function searchMessagesInThread(
  thread: Thread | null,
  query: string,
): Array<{
  messageId: string;
  text: string;
  snippet: string;
  matchIndex: number;
}> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || !thread) return [];

  const results: Array<{
    messageId: string;
    text: string;
    snippet: string;
    matchIndex: number;
  }> = [];

  for (const message of thread.messages) {
    const text = message.text ?? "";
    const lowerText = text.toLowerCase();
    const matchIndex = lowerText.indexOf(normalizedQuery);
    if (matchIndex !== -1) {
      const snippetLength = 70;
      const start = Math.max(0, matchIndex - Math.floor(snippetLength / 2));
      const end = Math.min(text.length, start + snippetLength);
      let snippet = text.slice(start, end);
      if (start > 0) snippet = "..." + snippet;
      if (end < text.length) snippet = snippet + "...";

      results.push({
        messageId: message.id,
        text,
        snippet,
        matchIndex,
      });
    }
  }
  return results;
}

describe("Search integration", () => {
  describe("filterThreadsByQuery", () => {
    const projects = [
      createMockProject({ id: "project-1" as ProjectId, name: "Server Project" }),
      createMockProject({ id: "project-2" as ProjectId, name: "Web Project" }),
    ];

    const threads = [
      createMockThread({
        id: "thread-1" as ThreadId,
        projectId: "project-1" as ProjectId,
        title: "API Design Project",
      }),
      createMockThread({
        id: "thread-2" as ThreadId,
        projectId: "project-1" as ProjectId,
        title: "Database Schema",
      }),
      createMockThread({
        id: "thread-3" as ThreadId,
        projectId: "project-2" as ProjectId,
        title: "Component Library Project",
      }),
      createMockThread({
        id: "thread-4" as ThreadId,
        projectId: "__chats__" as ProjectId,
        title: "Random Chat",
      }),
    ];

    it("filters threads by title query", () => {
      const results = filterThreadsByQuery(threads, projects, "api");
      expect(results).toHaveLength(1);
      expect(results[0]?.thread.title).toBe("API Design Project");
    });

    it("returns multiple matching threads", () => {
      const results = filterThreadsByQuery(threads, projects, "project");
      expect(results).toHaveLength(2);
    });

    it("is case-insensitive", () => {
      const results = filterThreadsByQuery(threads, projects, "API");
      expect(results).toHaveLength(1);
      expect(results[0]?.thread.title).toBe("API Design Project");
    });

    it("excludes archived threads", () => {
      const threadsWithArchived = [
        ...threads,
        createMockThread({
          id: "thread-5" as ThreadId,
          title: "Old API Discussion",
          archivedAt: "2026-01-01T00:00:00Z",
        }),
      ];
      const results = filterThreadsByQuery(threadsWithArchived, projects, "api");
      expect(results).toHaveLength(1); // Only the non-archived "API Design"
    });

    it("includes project name in results", () => {
      const results = filterThreadsByQuery(threads, projects, "component");
      expect(results).toHaveLength(1);
      expect(results[0]?.projectName).toBe("Web Project");
    });

    it("handles chats project correctly", () => {
      const results = filterThreadsByQuery(threads, projects, "random");
      expect(results).toHaveLength(1);
      expect(results[0]?.projectName).toBe("Chats");
    });

    it("returns empty array for no matches", () => {
      const results = filterThreadsByQuery(threads, projects, "xyz123");
      expect(results).toHaveLength(0);
    });

    it("returns empty array for empty query", () => {
      const results = filterThreadsByQuery(threads, projects, "");
      expect(results).toHaveLength(0);
    });

    it("returns empty array for whitespace-only query", () => {
      const results = filterThreadsByQuery(threads, projects, "   ");
      expect(results).toHaveLength(0);
    });
  });

  describe("searchMessagesInThread", () => {
    const thread = createMockThread({
      id: "thread-1" as ThreadId,
      title: "Test Thread",
      messages: [
        {
          id: "msg-1" as MessageId,
          role: "user",
          text: "How do I implement user authentication?",
          createdAt: "2026-01-01T00:00:00Z",
          attachments: [],
          streaming: false,
        },
        {
          id: "msg-2" as MessageId,
          role: "assistant",
          text: "You can use JWT tokens for secure login. Here's an example implementation.",
          createdAt: "2026-01-01T00:01:00Z",
          attachments: [],
          streaming: false,
        },
        {
          id: "msg-3" as MessageId,
          role: "user",
          text: "Thanks! That helps a lot.",
          createdAt: "2026-01-01T00:02:00Z",
          attachments: [],
          streaming: false,
        },
      ],
    });

    it("finds messages containing query", () => {
      const results = searchMessagesInThread(thread, "authentication");
      expect(results).toHaveLength(1);
      expect(results[0]?.messageId).toBe("msg-1");
    });

    it("finds multiple messages with same query", () => {
      const results = searchMessagesInThread(thread, "example");
      expect(results).toHaveLength(1);
    });

    it("is case-insensitive", () => {
      const results = searchMessagesInThread(thread, "AUTHENTICATION");
      expect(results).toHaveLength(1);
    });

    it("generates snippet around match", () => {
      const results = searchMessagesInThread(thread, "JWT");
      expect(results).toHaveLength(1);
      expect(results[0]?.snippet).toContain("JWT");
      expect(results[0]?.snippet.length).toBeLessThanOrEqual(80); // 70 + ellipsis
    });

    it("returns empty array for null thread", () => {
      const results = searchMessagesInThread(null, "query");
      expect(results).toHaveLength(0);
    });

    it("returns empty array for empty query", () => {
      const results = searchMessagesInThread(thread, "");
      expect(results).toHaveLength(0);
    });

    it("returns empty array for no matches", () => {
      const results = searchMessagesInThread(thread, "xyz123");
      expect(results).toHaveLength(0);
    });

    it("handles messages with empty text", () => {
      const threadWithEmptyMessage = createMockThread({
        id: "thread-2" as ThreadId,
        title: "Empty Message Thread",
        messages: [
          {
            id: "msg-empty" as MessageId,
            role: "user",
            text: "",
            createdAt: "2026-01-01T00:00:00Z",
            attachments: [],
            streaming: false,
          },
        ],
      });
      const results = searchMessagesInThread(threadWithEmptyMessage, "query");
      expect(results).toHaveLength(0);
    });

    it("handles very long messages with proper snippet", () => {
      const longText =
        "This is a very long message. ".repeat(20) +
        "SEARCH_TARGET" +
        " More text here.".repeat(20);
      const threadWithLongMessage = createMockThread({
        id: "thread-3" as ThreadId,
        title: "Long Message Thread",
        messages: [
          {
            id: "msg-long" as MessageId,
            role: "user",
            text: longText,
            createdAt: "2026-01-01T00:00:00Z",
            attachments: [],
            streaming: false,
          },
        ],
      });
      const results = searchMessagesInThread(threadWithLongMessage, "SEARCH_TARGET");
      expect(results).toHaveLength(1);
      expect(results[0]?.snippet.length).toBeLessThanOrEqual(80);
      expect(results[0]?.snippet).toContain("SEARCH_TARGET");
    });
  });
});
