import { ThreadId, MessageId } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SearchPaletteResults } from "./SearchPalette.results";
import { Command } from "../ui/command";

describe("SearchPaletteResults", () => {
  it("shows current-file matches before global results", () => {
    const markup = renderToStaticMarkup(
      <Command>
        <SearchPaletteResults
          query="needle"
          normalizedQuery="needle"
          isSearchPending={false}
          isFileSearchPending={false}
          isProjectSearchPending={false}
          currentFilePath="src/app.ts"
          currentFileMatches={[{ line: 3, lineText: "needle in this file" }]}
          visibleCurrentFileMatches={[{ line: 3, lineText: "needle in this file" }]}
          setVisibleCurrentFileMatchCount={vi.fn()}
          inThreadMessageResults={[
            {
              id: "message:1",
              threadId: "thread-1" as ThreadId,
              messageId: "message-1" as MessageId,
              threadTitle: "Thread",
              projectName: "Project",
              text: "needle elsewhere",
              snippet: "needle elsewhere",
              matchIndex: 0,
              type: "message",
            },
          ]}
          otherThreadMessageResults={[]}
          visibleOtherThreadMessageResults={[]}
          visibleOtherMessageCount={5}
          setVisibleOtherMessageCount={vi.fn()}
          threadResults={[]}
          visibleThreadResults={[]}
          setVisibleThreadCount={vi.fn()}
          projectResults={[]}
          visibleProjectResults={[]}
          setVisibleProjectCount={vi.fn()}
          fileResults={[]}
          visibleFileResults={[]}
          setVisibleFileCount={vi.fn()}
          hasMessageResults
          hasThreadResults={false}
          hasProjectResults={false}
          hasFileResults={false}
          onSelectMessage={vi.fn()}
          onSelectThread={vi.fn()}
          onSelectProject={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCurrentFileMatch={vi.fn()}
          initialVisibleResultCount={5}
        />
      </Command>,
    );

    expect(markup.indexOf("In app.ts")).toBeLessThan(markup.indexOf("In this thread"));
    expect(markup).toContain("Line 3");
  });

  it("shows a current-file no-match message", () => {
    const markup = renderToStaticMarkup(
      <Command>
        <SearchPaletteResults
          query="needle"
          normalizedQuery="needle"
          isSearchPending={false}
          isFileSearchPending={false}
          isProjectSearchPending={false}
          currentFilePath="src/app.ts"
          currentFileMatches={[]}
          visibleCurrentFileMatches={[]}
          setVisibleCurrentFileMatchCount={vi.fn()}
          inThreadMessageResults={[]}
          otherThreadMessageResults={[]}
          visibleOtherThreadMessageResults={[]}
          visibleOtherMessageCount={5}
          setVisibleOtherMessageCount={vi.fn()}
          threadResults={[]}
          visibleThreadResults={[]}
          setVisibleThreadCount={vi.fn()}
          projectResults={[]}
          visibleProjectResults={[]}
          setVisibleProjectCount={vi.fn()}
          fileResults={[]}
          visibleFileResults={[]}
          setVisibleFileCount={vi.fn()}
          hasMessageResults={false}
          hasThreadResults={false}
          hasProjectResults={false}
          hasFileResults={false}
          onSelectMessage={vi.fn()}
          onSelectThread={vi.fn()}
          onSelectProject={vi.fn()}
          onSelectFile={vi.fn()}
          onSelectCurrentFileMatch={vi.fn()}
          initialVisibleResultCount={5}
        />
      </Command>,
    );

    expect(markup).toContain("&quot;needle&quot; wasn&#x27;t found in app.ts.");
  });
});
