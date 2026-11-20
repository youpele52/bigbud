import { MessageId, ThreadId } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Command } from "../ui/command";
import type { MessageSearchResult, ThreadSearchResult } from "./SearchPalette.results";
import type { SectionVisibility } from "./SearchPalette.visibility";
import {
  SearchPaletteTierSections,
  type SearchPaletteTierSectionsProps,
} from "./SearchPalette.tierSections";
import type { SystemSearchNotice } from "./SearchPalette.systemSearch.logic";
import type { SearchPaletteTiers } from "./SearchPalette.tiers.logic";

const visibility: SectionVisibility = {
  slice: (_id, rows) => rows.slice(0, 5),
  showMore: vi.fn(),
};

function message(id: string, snippet: string): MessageSearchResult {
  return {
    id,
    threadId: ThreadId.makeUnsafe(`thread-${id}`),
    messageId: MessageId.makeUnsafe(id),
    threadTitle: `Thread ${id}`,
    projectName: "Project",
    text: snippet,
    snippet,
    matchIndex: 0,
    type: "message",
  };
}

function thread(id: string, title: string): ThreadSearchResult {
  return {
    id,
    threadId: ThreadId.makeUnsafe(id),
    title,
    projectName: "Project",
    matchedMessageText: "",
    type: "thread",
  };
}

function file(id: string, tier: string) {
  return {
    id: `${tier}:name:local:/r/${id}`,
    kind: "name" as const,
    executionTargetId: "local",
    root: "/r",
    path: id,
    label: "Label",
  };
}

function emptyTiers(): SearchPaletteTiers {
  return {
    currentThread: { messages: [], terminals: [] },
    currentProject: { messages: [], threads: [], files: [] },
    bigbudData: { messages: [], threads: [], projects: [], terminals: [] },
    otherProjectFiles: { files: [] },
    thisComputer: { files: [] },
    remoteOutsideProjects: { files: [] },
  };
}

function renderSections(overrides: Partial<SearchPaletteTierSectionsProps>) {
  return renderToStaticMarkup(
    <Command>
      <SearchPaletteTierSections
        query="needle"
        normalizedQuery="needle"
        tiers={emptyTiers()}
        pending={{
          debounce: false,
          messages: false,
          files: false,
          projects: false,
          terminals: false,
        }}
        currentFile={{ path: null, matches: [], onSelect: vi.fn() }}
        visibility={visibility}
        hasMoreMessagePages={false}
        onShowMoreMessages={vi.fn()}
        onSelectMessage={vi.fn()}
        onSelectThread={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectFile={vi.fn()}
        onSelectTerminal={vi.fn()}
        {...overrides}
      />
    </Command>,
  );
}

function notices(
  reasons: ReadonlyArray<readonly [string, SystemSearchNotice["reason"]]>,
): SystemSearchNotice[] {
  return reasons.map(([sourceId, reason]) => ({
    tier: "otherProjectFiles",
    sourceId,
    reason,
    state: "unavailable",
  }));
}

describe("SearchPaletteTierSections", () => {
  it("shows current-file matches before global results", () => {
    const tiers = emptyTiers();
    tiers.currentThread.messages.push(message("m1", "needle elsewhere"));
    const markup = renderSections({
      tiers,
      currentFile: {
        path: "src/app.ts",
        matches: [{ line: 3, lineText: "needle in this file" }],
        onSelect: vi.fn(),
      },
    });
    expect(markup.indexOf("In app.ts")).toBeLessThan(markup.indexOf("In this thread"));
    expect(markup).toContain("Line 3");
  });

  it("shows a current-file no-match message", () => {
    const markup = renderSections({
      currentFile: { path: "src/app.ts", matches: [], onSelect: vi.fn() },
    });
    expect(markup).toContain("&quot;needle&quot; wasn&#x27;t found in app.ts.");
  });

  it("renders sections in fixed tier order: thread, project, then other bigbud data", () => {
    const tiers = emptyTiers();
    tiers.bigbudData.messages.push(message("m3", "needle in another project"));
    tiers.bigbudData.threads.push(thread("t3", "needle other thread"));
    tiers.currentProject.messages.push(message("m2", "needle in this project"));
    tiers.currentProject.threads.push(thread("t2", "needle project thread"));
    tiers.currentThread.messages.push(message("m1", "needle in this thread"));
    const markup = renderSections({ tiers });
    const order = [
      "In this thread",
      "In this project",
      "Threads in this project",
      "Messages in other threads",
      "All threads",
    ].map((label) => markup.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((left, right) => left - right));
  });

  it("shows fast tiers while the slow tiers are still debouncing", () => {
    const tiers = emptyTiers();
    tiers.bigbudData.threads.push(thread("t3", "needle other thread"));
    tiers.bigbudData.messages.push(message("m3", "fast server row"));
    tiers.currentProject.files.push(file("current.ts", "currentProject"));
    const markup = renderSections({
      tiers,
      pending: { debounce: true, messages: false, files: false, projects: false, terminals: false },
    });
    expect(markup).toContain("needle other thread");
    expect(markup).toContain("fast server row");
    expect(markup).toContain("current.ts");
    expect(markup).toContain("Searching...");
  });

  it("renders streamed file tiers after bigbud data in fixed order T2, T4, T5, T6", () => {
    const tiers = emptyTiers();
    tiers.remoteOutsideProjects.files.push(file("remote-folder.ts", "remoteOutsideProjects"));
    tiers.thisComputer.files.push(file("desktop.pdf", "thisComputer"));
    tiers.otherProjectFiles.files.push(file("other.ts", "otherProjectFiles"));
    tiers.bigbudData.threads.push(thread("t3", "needle other thread"));
    tiers.currentProject.files.push(file("current.ts", "currentProject"));
    const markup = renderSections({
      tiers,
      systemNotices: [
        {
          tier: "otherProjectFiles",
          sourceId: "ssh:host=box",
          reason: "use-managed-agent",
          state: "unavailable",
        },
      ],
    });
    const order = [
      "Files in this project",
      "All threads",
      "Files in other projects",
      "This computer",
      "Remote folders outside projects",
      "1 host not fully searched",
    ].map((label) => markup.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((left, right) => left - right));
  });

  it("hides not-connected remotes and folds hints into one muted summary line", () => {
    const idle = renderSections({
      tiers: emptyTiers(),
      systemNotices: notices([["ssh:host=idle&transport=agent", "not-connected"]]),
    });
    expect(idle).not.toContain("not connected");
    expect(idle).not.toContain("not fully searched");
    const markup = renderSections({
      tiers: emptyTiers(),
      systemNotices: notices([
        ["ssh:host=idle&transport=agent", "not-connected"],
        ["ssh:host=a&transport=direct-ssh", "use-managed-agent"],
        ["ssh:host=b&transport=agent", "agent-update-available"],
        ["ssh:host=c&transport=agent", "error"],
      ]),
    });
    expect(markup.match(/not fully searched/g)).toHaveLength(1);
    expect(markup).toContain("2 hosts not fully searched");
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("text-amber-600");
    // The per-host reasons are the summary's details (tooltip, and text for screen readers).
    expect(markup).toContain("Use the bigbud agent on a for faster search");
    expect(markup).toContain("Showing file names only on b.");
    // A real failure keeps its own line.
    expect(markup).toContain("File search on c failed.");
    expect(markup).not.toContain("not connected");
  });
});
