import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonitorScopeToggle } from "./MonitorScopeToggle";

describe("MonitorScopeToggle", () => {
  it.each(["system", "bigbud"] as const)("reuses the compact markdown toolbar for %s", (scope) => {
    const markup = renderToStaticMarkup(
      <MonitorScopeToggle scope={scope} onScopeChange={() => undefined} />,
    );
    expect(markup).toContain('data-variant="toolbar"');
    expect(markup).toContain('data-size="xs"');
    expect(markup).toContain('aria-label="Switch monitor scope"');
    expect(markup).toContain('aria-label="Monitor system resources"');
    expect(markup).toContain('aria-label="Monitor bigbud resources"');
    expect(markup).toContain('aria-pressed="true"');
  });
});
