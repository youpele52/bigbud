import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileWorkLog } from "./MobileWorkLog";

const entries = [
  {
    id: "fixture-tool",
    createdAt: "2026-11-13T00:00:00Z",
    label: "Tool completed",
    tone: "tool" as const,
    command: "printf fixture",
    itemType: "command_execution" as const,
  },
];

describe("mobile work-log disclosure", () => {
  it("announces expanded state and connects the touch-sized control to its content", () => {
    const markup = renderToStaticMarkup(<MobileWorkLog entries={entries} />);
    expect(markup).toContain('aria-expanded="true"');
    const id = markup.match(/aria-controls="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`id="${id}"`);
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("printf fixture");
  });
  it("announces collapsed state without a dangling content reference", () => {
    const markup = renderToStaticMarkup(
      <MobileWorkLog entries={entries} defaultExpanded={false} />,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("aria-controls");
    expect(markup).not.toContain("printf fixture");
  });
  it("does not add an empty disclosure", () => {
    expect(renderToStaticMarkup(<MobileWorkLog entries={[]} />)).toBe("");
  });
});
