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
          reason: "not-connected",
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
      "box is not connected",
    ].map((label) => markup.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((left, right) => left - right));
  });
});
