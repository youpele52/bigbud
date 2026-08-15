import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FilePreviewHeader } from "./FilePreviewHeader";

describe("FilePreviewHeader", () => {
  it("shows only the immediate directory and file while exposing the absolute path", () => {
    const markup = renderToStaticMarkup(
      <FilePreviewHeader
        breadcrumb={[
          { id: "bigbud", label: "bigbud" },
          { id: "bigbud/docs", label: "docs" },
          { id: "bigbud/docs/plan", label: "plan" },
          { id: "bigbud/docs/plan/file.md", label: "file.md" },
        ]}
        absolutePath="/workspace/bigbud/docs/plan/file.md"
        canNavigateBack={false}
        canNavigateForward={true}
        onNavigateBack={() => undefined}
        onNavigateForward={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain("plan");
    expect(markup).toContain("file.md");
    expect(markup).not.toContain(">docs<");
    expect(markup).toContain("/workspace/bigbud/docs/plan/file.md");
    expect(markup).toContain('data-slot="tooltip-trigger"');
    expect(markup).toContain('aria-label="Close"');
    expect(markup).toContain('aria-label="Back"');
    expect(markup).toContain("disabled");
  });
});
