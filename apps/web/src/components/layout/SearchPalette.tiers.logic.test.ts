import { MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import type {
  ConversationMessageSearchHit,
  SearchConversationMessagesResult,
} from "@bigbud/contracts/orchestration/orchestration.search";
import { describe, expect, it } from "vitest";

import {
  describeSearchTiers,
  partitionMessageTiers,
  partitionTerminalTiers,
  partitionThreadTiers,
  searchQueryRules,
  searchResultId,
  SEARCH_TIERS,
} from "./SearchPalette.tiers.logic";
import type { TerminalSearchResult } from "./SearchPalette.terminalResults.logic";

const THREAD = ThreadId.makeUnsafe("current-thread");
const PROJECT = ProjectId.makeUnsafe("current-project");
const context = { currentThreadId: THREAD, currentProjectId: PROJECT };

function hit(id: string, threadId: string, projectId: string): ConversationMessageSearchHit {
  return {
    messageId: MessageId.makeUnsafe(id),
    threadId: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe(projectId),
    threadTitle: "Thread",
    projectName: "Project",
    snippet: `Needle ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function page(
  hits: ConversationMessageSearchHit[],
  extra: Partial<SearchConversationMessagesResult> = {},
): SearchConversationMessagesResult {
  return { status: "ready", projectionSequence: 1, hits, ...extra };
}

describe("search tiers", () => {
  it("keeps the fixed T1–T6 order", () => {
    expect(SEARCH_TIERS).toEqual([
      "currentThread",
      "currentProject",
      "bigbudData",
      "otherProjectFiles",
      "thisComputer",
      "remoteOutsideProjects",
    ]);
  });

  it("builds stable tier:source:target:path[:line] ids", () => {
    expect(
      searchResultId({ tier: "currentProject", source: "content", target: "t", path: "a.ts" }),
    ).toBe("currentProject:content:t:a.ts");
    expect(
      searchResultId({
        tier: "thisComputer",
        source: "spotlight",
        target: "local",
        path: "/x",
        line: 4,
      }),
    ).toBe("thisComputer:spotlight:local:/x:4");
  });

  it("splits messages into thread, project and other tiers without duplicates", () => {
    const tiers = partitionMessageTiers(
      [
        page([hit("other", "x", "y"), hit("thread", "current-thread", "current-project")], {
          currentThreadHits: [hit("thread", "current-thread", "current-project")],
          currentProjectHits: [hit("sibling", "sibling", "current-project")],
        }),
      ],
      context,
      "needle",
    );
    expect(tiers.currentThread.map((row) => row.messageId)).toEqual(["thread"]);
    expect(tiers.currentProject.map((row) => row.messageId)).toEqual(["sibling"]);
    expect(tiers.other.map((row) => row.messageId)).toEqual(["other"]);
    expect(tiers.other[0]?.id).toBe("bigbudData:message:x:other");
    expect(tiers.currentThread[0]?.matchIndex).toBe(0);
  });

  it("only appends rows when a later page arrives", () => {
    const first = page([hit("b", "x", "y"), hit("a", "x", "y")]);
    const before = partitionMessageTiers([first], context, "needle").other.map((row) => row.id);
    const after = partitionMessageTiers(
      [first, page([hit("c", "x", "y"), hit("b", "x", "y")])],
      context,
      "needle",
    ).other.map((row) => row.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(3);
  });

  it("puts the current project's threads and the current thread's terminals first", () => {
    const threads = partitionThreadTiers(
      [
        {
          id: "",
          threadId: ThreadId.makeUnsafe("t1"),
          projectId: PROJECT,
          title: "a",
          projectName: "P",
          matchedMessageText: "",
          type: "thread",
        },
        {
          id: "",
          threadId: ThreadId.makeUnsafe("t2"),
          projectId: ProjectId.makeUnsafe("other"),
          title: "b",
          projectName: "O",
          matchedMessageText: "",
          type: "thread",
        },
      ],
      context,
    );
    expect(threads.currentProject.map((row) => row.id)).toEqual(["currentProject:thread:local:t1"]);
    expect(threads.other.map((row) => row.id)).toEqual(["bigbudData:thread:local:t2"]);
    const terminal = (threadId: ThreadId) => ({ threadId }) as TerminalSearchResult;
    const terminals = partitionTerminalTiers(
      [terminal(ThreadId.makeUnsafe("x")), terminal(THREAD)],
      context,
    );
    expect(terminals.currentThread.map((row) => row.threadId)).toEqual([THREAD]);
    expect(terminals.other.map((row) => row.threadId)).toEqual(["x"]);
  });

  it("applies the short-query rules", () => {
    expect(searchQueryRules("ab", context)).toEqual({
      titles: true,
      currentThreadMessages: true,
      messages: false,
      fileContents: false,
    });
    expect(searchQueryRules("ab", { currentThreadId: null, currentProjectId: null })).toMatchObject(
      { currentThreadMessages: false },
    );
    expect(searchQueryRules("abc", context)).toMatchObject({ messages: true, fileContents: true });
    expect(searchQueryRules("a".repeat(161), context)).toMatchObject({
      messages: false,
      currentThreadMessages: false,
    });
  });

  it("summarises non-empty tiers for screen readers", () => {
    const tiers = partitionMessageTiers(
      [page([hit("a", "current-thread", "p"), hit("b", "x", "y"), hit("c", "z", "y")])],
      context,
      "needle",
    );
    expect(
      describeSearchTiers({
        currentThread: { messages: tiers.currentThread, terminals: [] },
        currentProject: { messages: [], threads: [], files: [] },
        bigbudData: { messages: tiers.other, threads: [], projects: [], terminals: [] },
      }),
    ).toBe("1 result in this thread, 2 results elsewhere in bigbud");
  });
});
