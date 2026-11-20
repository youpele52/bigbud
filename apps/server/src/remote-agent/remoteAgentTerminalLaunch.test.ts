import { describe, expect, it } from "vitest";

import {
  remoteAgentLegacyTerminalLaunch,
  remoteAgentTerminalEnvironment,
  remoteAgentTerminalLaunch,
} from "./remoteAgentTerminalLaunch.ts";
import { profileLaunch } from "./remoteAgentOwnedPty.profile.testUtils.ts";

describe("remote terminal launch policy", () => {
  it("preserves legacy policy when explicit intent is absent", () => {
    expect(remoteAgentTerminalLaunch({ TERM: "xterm" })).toEqual(
      remoteAgentLegacyTerminalLaunch({ TERM: "xterm" }),
    );
  });

  it("dispatches exact executable/argv without a shell wrapper or desktop account env", () => {
    const intent = profileLaunch();
    const launch = remoteAgentTerminalLaunch(
      { TERM: "xterm", HOME: "/desktop", PATH: "/desktop/bin" },
      intent,
    );
    expect(launch).toEqual({
      shell: intent.executable,
      args: intent.args,
      profileLaunch: true,
      environment: [{ name: "TERM", value: "xterm" }],
    });
    expect(launch.args).not.toBe(intent.args);
    expect(launch).not.toHaveProperty("shellLaunchIdentity");
  });

  it("preserves the execution account's legacy login-shell startup", () => {
    expect(remoteAgentLegacyTerminalLaunch({ TERM: "xterm-256color" })).toEqual({
      shell: "/bin/sh",
      args: ["-lc", 'exec "${SHELL:-/bin/sh}" -l'],
      environment: [{ name: "TERM", value: "xterm-256color" }],
    });
  });

  it("forwards only terminal and valid locale variables", () => {
    expect(
      remoteAgentTerminalEnvironment({
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LC_MESSAGES: "C.UTF-8",
        HOME: "/desktop/home",
        PATH: "/desktop/bin",
        SHELL: "/desktop/shell",
        SSH_AUTH_SOCK: "/desktop/agent",
        API_TOKEN: "private",
        LC_: "invalid",
        LC_lowercase: "invalid",
        LC_ALL1: "invalid",
        "LC_ALL;COMMAND": "invalid",
        LC_CTYPE: undefined,
      }),
    ).toEqual([
      { name: "TERM", value: "xterm-256color" },
      { name: "COLORTERM", value: "truecolor" },
      { name: "LANG", value: "C.UTF-8" },
      { name: "LC_ALL", value: "C.UTF-8" },
      { name: "LC_MESSAGES", value: "C.UTF-8" },
    ]);
  });

  it("does not invent locale defaults or discard explicitly empty terminal values", () => {
    expect(remoteAgentTerminalEnvironment({})).toEqual([]);
    expect(remoteAgentTerminalEnvironment({ TERM: "", LANG: undefined })).toEqual([
      { name: "TERM", value: "" },
    ]);
  });
});
