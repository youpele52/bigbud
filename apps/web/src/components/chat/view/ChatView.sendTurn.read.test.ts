import { describe, expect, it } from "vitest";

import { formatReadDocumentPrompt, parseReadDocumentCommand } from "./ChatView.sendTurn.read";

describe("ChatView.sendTurn.read", () => {
  it("parses a standalone /read URL command", () => {
    expect(parseReadDocumentCommand(" /read https://example.com/report.pdf ")).toEqual({
      url: "https://example.com/report.pdf",
    });
  });

  it("rejects non-http read commands", () => {
    expect(parseReadDocumentCommand("/read file:///tmp/report.pdf")).toBeNull();
    expect(parseReadDocumentCommand("/read not-a-url")).toBeNull();
  });

  it("formats extracted document content into a readable prompt block", () => {
    const prompt = formatReadDocumentPrompt({
      sourceUrl: "https://example.com/report",
      resolvedUrl: "https://cdn.example.com/report.pdf",
      title: "Quarterly <Report>",
      text: "Revenue & margin",
    });

    expect(prompt).toContain("Source URL: https://example.com/report");
    expect(prompt).toContain("Resolved URL: https://cdn.example.com/report.pdf");
    expect(prompt).toContain("Title: Quarterly &lt;Report&gt;");
    expect(prompt).toContain("Revenue &amp; margin");
    expect(prompt).toContain("<read_document_result>");
    expect(prompt).toContain("<document_contents>");
  });
});
