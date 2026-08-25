import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SyntaxHighlightedCode } from "./SyntaxHighlightedCode";

describe("SyntaxHighlightedCode", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("uses the fallback while loading without suspending on an uncached promise", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = document.createElement("div");
    document.body.append(host);

    await render(
      <SyntaxHighlightedCode
        code={'const greeting = "hello";'}
        language="typescript"
        themeName="pierre-dark"
        fallback={<pre data-testid="highlight-fallback">Loading code...</pre>}
      />,
      { container: host },
    );

    await expect.poll(() => host.querySelector(".chat-markdown-shiki")).not.toBeNull();
    expect(
      consoleError.mock.calls.some(([message]) =>
        String(message).includes("A component was suspended by an uncached promise"),
      ),
    ).toBe(false);
  });
});
