import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SimpleWorkEntryRow } from "./MessagesTimeline.workEntry";
import {
  type TimelineWorkEntry,
  toolWorkEntryHeading,
  workEntryCopyText,
} from "./MessagesTimeline.workEntry.logic";

describe("SimpleWorkEntryRow", () => {
  it.each([
    ["bigbud_orchestration: screenshot", "bigbud_orchestration: screenshot"],
    ["Bigbud_orchestration: search_capabilities", "bigbud_orchestration: search_capabilities"],
    ["BiGbUd_OrChEsTrAtIoN: CaptureScreenshot", "bigbud_orchestration: CaptureScreenshot"],
    ["BIGBUD_ORCHESTRATION", "bigbud_orchestration"],
    ["mcp__bigbud_orchestration__screenshot", "Mcp__bigbud_orchestration__screenshot"],
    [
      "mcp__BiGbUd_OrChEsTrAtIoN__CaptureScreenshot",
      "Mcp__bigbud_orchestration__CaptureScreenshot",
    ],
    [
      "Bigbud_orchestration_Thread-1_CaptureScreenshot",
      "bigbud_orchestration_Thread-1_CaptureScreenshot",
    ],
    ["bigbud_orchestration: screenshot completed", "bigbud_orchestration: screenshot"],
  ])("normalizes only the namespace in %s", (toolTitle, expected) => {
    expect(
      toolWorkEntryHeading({
        id: "work-entry-tool",
        createdAt: "2026-05-15T18:00:00.000Z",
        label: "Tool",
        tone: "tool",
        toolTitle,
      }),
    ).toBe(expected);
  });

  it.each([undefined, ""])(
    "normalizes structured fallback labels with toolTitle %s",
    (toolTitle) => {
      expect(
        toolWorkEntryHeading({
          id: "work-entry-label",
          createdAt: "2026-05-15T18:00:00.000Z",
          label: "Bigbud_orchestration: CaptureScreenshot complete",
          tone: "tool",
          ...(toolTitle !== undefined ? { toolTitle } : {}),
        }),
      ).toBe("bigbud_orchestration: CaptureScreenshot");
    },
  );

  it.each([
    ["readFile", "ReadFile"],
    ["other_namespace: CaptureScreenshot completed", "Other_namespace: CaptureScreenshot"],
    ["mcp__OtherNamespace__CaptureScreenshot", "Mcp__OtherNamespace__CaptureScreenshot"],
    ["Bigbud_orchestrations: CaptureScreenshot", "Bigbud_orchestrations: CaptureScreenshot"],
    [
      "other_bigbud_orchestration: CaptureScreenshot",
      "Other_bigbud_orchestration: CaptureScreenshot",
    ],
    [
      "inspect Bigbud_orchestration: CaptureScreenshot",
      "Inspect Bigbud_orchestration: CaptureScreenshot",
    ],
    ["Bigbud_orchestration is Running", "Bigbud_orchestration is Running"],
  ])("preserves existing capitalization for %s", (toolTitle, expected) => {
    expect(
      toolWorkEntryHeading({
        id: "work-entry-other-tool",
        createdAt: "2026-05-15T18:00:00.000Z",
        label: "Tool",
        tone: "tool",
        toolTitle,
      }),
    ).toBe(expected);
  });

  it.each([
    ["capture", "Captured browser"],
    ["navigate", "Navigating browser"],
    ["click", "Clicking browser"],
    ["drag", "Dragging in browser"],
    ["scroll", "Scrolling browser"],
    ["type", "Typing in browser"],
    ["key", "Pressing key in browser"],
    ["wait", "Waiting for browser"],
    ["get_page_info", "Reading page information"],
    ["get_page_text", "Reading page text"],
    ["go_back", "Going back in browser"],
    ["go_forward", "Going forward in browser"],
    ["reload", "Reloading browser"],
    ["release_tab", "Releasing browser tab"],
    ["close_tab", "Closing browser tab"],
    [undefined, "Browser"],
  ])("preserves browser action copy for %s", (toolAction, expected) => {
    expect(
      toolWorkEntryHeading({
        id: "work-entry-browser-action",
        createdAt: "2026-05-15T18:00:00.000Z",
        label: "Tool",
        tone: "tool",
        toolTitle: "bigbud_orchestration_browser",
        ...(toolAction !== undefined ? { toolAction } : {}),
      }),
    ).toBe(expected);
  });

  it("uses the same namespace heading for display, title and copy without changing tool content", () => {
    const workEntry: TimelineWorkEntry = {
      id: "work-entry-screenshot",
      createdAt: "2026-05-15T18:00:00.000Z",
      label: "Tool",
      tone: "tool",
      toolTitle: "Bigbud_orchestration: CaptureScreenshot",
      detail: "Bigbud_orchestration: Keep This Description",
      changedFiles: ["/Screenshots/Bigbud_orchestration/Capture.PNG"],
    };
    const heading = toolWorkEntryHeading(workEntry);
    const markup = renderToStaticMarkup(<SimpleWorkEntryRow workEntry={workEntry} />);

    expect(heading).toBe("bigbud_orchestration: CaptureScreenshot");
    expect(markup).toContain(`>${heading}</span>`);
    expect(markup).toContain(`title="${heading} - ${workEntry.detail}"`);
    expect(workEntryCopyText(workEntry)).toBe(
      `${heading}\n${workEntry.detail}\nChanged files:\n${workEntry.changedFiles!.join("\n")}`,
    );

    const command = "Bigbud_orchestration --Path /Screenshots/Capture.PNG";
    const rawCommand = 'Bigbud_orchestration --Arguments {"Name":"CaptureScreenshot"}';
    expect(workEntryCopyText({ ...workEntry, command, changedFiles: [] })).toBe(
      `${heading}\n${command}`,
    );
    expect(workEntryCopyText({ ...workEntry, command, rawCommand, changedFiles: [] })).toBe(
      `${heading}\n${rawCommand}`,
    );
  });

  it("uses action-specific copy for thread-scoped browser tools", () => {
    expect(
      toolWorkEntryHeading({
        id: "work-entry-browser",
        createdAt: "2026-05-15T18:00:00.000Z",
        label: "Tool",
        tone: "tool",
        toolTitle: "bigbud_orchestration_thread-1_browser",
        toolAction: "navigate",
      }),
    ).toBe("Navigating browser");
  });

  it("uses action-specific copy for MCP-qualified browser tools", () => {
    expect(
      toolWorkEntryHeading({
        id: "work-entry-mcp-browser",
        createdAt: "2026-05-15T18:00:00.000Z",
        label: "MCP tool call",
        tone: "tool",
        toolTitle: "mcp__bigbud_orchestration__browser",
        toolAction: "capture",
      }),
    ).toBe("Captured browser");
  });

  it("labels page-text browser inspection", () => {
    expect(
      toolWorkEntryHeading({
        id: "work-entry-browser-page-text",
        createdAt: "2026-05-15T18:00:00.000Z",
        label: "Tool",
        tone: "tool",
        toolTitle: "browser",
        toolAction: "get_page_text",
      }),
    ).toBe("Reading page text");
  });

  it("renders the copy action beneath the work log content on the left", () => {
    const markup = renderToStaticMarkup(
      <SimpleWorkEntryRow
        workEntry={{
          id: "work-entry-1",
          createdAt: "2026-05-15T18:00:00.000Z",
          label: "Provider turn start failed",
          detail: "Remote Pi CLI is not installed or not available on PATH.",
          tone: "error",
        }}
      />,
    );

    expect(markup).toContain("Copy message");
    expect(markup).toContain("mt-1.5 flex justify-start pl-6");
    expect(markup).not.toContain("mt-0.5 h-5 w-5 shrink-0");
  });

  it("renders an unlock action for SSH passphrase failures on remote targets", () => {
    const markup = renderToStaticMarkup(
      <SimpleWorkEntryRow
        executionTargetId="ssh:host=devbox&user=root&port=22&auth=ssh-key&keyPath=%7E%2F.ssh%2Fopen_stack"
        workEntry={{
          id: "work-entry-2",
          createdAt: "2026-05-15T18:00:00.000Z",
          label: "Provider turn start failed",
          detail:
            "SSH key '~/.ssh/open_stack' requires a passphrase. Load it into ssh-agent with 'ssh-add ~/.ssh/open_stack' before using this target.",
          tone: "error",
        }}
      />,
    );

    expect(markup).toContain("Unlock SSH key");
  });
});
