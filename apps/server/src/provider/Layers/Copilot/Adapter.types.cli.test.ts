import { describe, expect, it } from "vitest";

import { buildNodeWrapper } from "./Adapter.types.cli.ts";

describe("CopilotAdapter.types.cli", () => {
  it("builds a POSIX wrapper that uses the current executable path", () => {
    const wrapper = buildNodeWrapper({
      cliPath: "/tmp/copilot/index.js",
      nodeExecutablePath: "/Applications/bigbud.app/Contents/MacOS/bigbud",
      platform: "darwin",
    });

    expect(wrapper.wrapperPath.endsWith(".sh")).toBe(true);
    expect(wrapper.content).toContain("export ELECTRON_RUN_AS_NODE=1");
    expect(wrapper.content).toContain(
      'exec "/Applications/bigbud.app/Contents/MacOS/bigbud" "/tmp/copilot/index.js" "$@"',
    );
    expect(wrapper.content).not.toContain("exec node ");
  });

  it("builds a Windows wrapper that uses the current executable path", () => {
    const wrapper = buildNodeWrapper({
      cliPath: "C:\\copilot\\index.js",
      nodeExecutablePath: "C:\\Program Files\\bigbud\\bigbud.exe",
      platform: "win32",
    });

    expect(wrapper.wrapperPath.endsWith(".cmd")).toBe(true);
    expect(wrapper.content).toContain("set ELECTRON_RUN_AS_NODE=1");
    expect(wrapper.content).toContain(
      '"C:\\Program Files\\bigbud\\bigbud.exe" "C:\\copilot\\index.js" %*',
    );
  });
});
