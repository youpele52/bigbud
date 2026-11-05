import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentWorkingBlob } from "./agent-working-blob";

describe("AgentWorkingBlob", () => {
  it("renders a decorative working loader at the default size with agent colours", () => {
    const markup = renderToStaticMarkup(<AgentWorkingBlob />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('data-state="working"');
    expect(markup).toContain('width="14"');
    expect(markup).toContain("--agent-blob-working:var(--info)");
    expect(markup).toContain("--agent-blob-shift:var(--primary)");
    expect(markup).toContain("--agent-blob-done:var(--success)");
  });

  it("uses the subagent violet preset and accepts per-colour overrides", () => {
    const subagent = renderToStaticMarkup(<AgentWorkingBlob tone="subagent" />);
    expect(subagent).toContain("--agent-blob-working:var(--subagent)");

    const custom = renderToStaticMarkup(
      <AgentWorkingBlob colors={{ working: "var(--warning)", shift: null }} />,
    );
    expect(custom).toContain("--agent-blob-working:var(--warning)");
    // no shift colour keeps the blob solid
    expect(custom).toContain("--agent-blob-shift:var(--warning)");
  });

  it("clamps tiny sizes to the inline minimum and allows large ones", () => {
    expect(renderToStaticMarkup(<AgentWorkingBlob size={3} />)).toContain('width="8"');
    expect(renderToStaticMarkup(<AgentWorkingBlob size={96} />)).toContain('width="96"');
  });

  it("marks the done state and passes data attributes through", () => {
    const markup = renderToStaticMarkup(
      <AgentWorkingBlob state="done" data-subagent-status-dot="" />,
    );
    expect(markup).toContain('data-state="done"');
    expect(markup).toContain("data-subagent-status-dot");
  });

  it("gives each instance its own SVG ids so masks never collide", () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentWorkingBlob />
        <AgentWorkingBlob />
      </>,
    );
    const maskIds = [...markup.matchAll(/<mask id="([^"]+)"/g)].map((match) => match[1]);
    expect(maskIds).toHaveLength(2);
    expect(new Set(maskIds).size).toBe(2);
  });
});
