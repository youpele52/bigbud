import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SimpleWorkEntryRow } from "./MessagesTimeline.workEntry";

describe("SimpleWorkEntryRow", () => {
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
