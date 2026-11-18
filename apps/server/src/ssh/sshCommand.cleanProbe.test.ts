import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { buildSshCommandInvocation } from "./sshCommand.ts";

it.skipIf(process.platform === "win32")(
  "executes the clean wrapper without inherited environment or argument interpolation",
  () => {
    const value = "literal ' quote $(not-executed); space";
    const invocation = buildSshCommandInvocation({
      executionTargetId: "ssh:host=devbox&user=root&auth=ssh-key",
      shellMode: "clean-posix",
      cwd: "/",
      env: { BIGBUD_PROBE_VALUE: value },
      command: "/usr/bin/env",
    });
    // Exercise only the generated command locally, not an SSH connection/account shell.
    const output = execFileSync("/bin/sh", ["-c", invocation.args.at(-1)!], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", BIGBUD_INHERITED_PROBE: "must-not-leak" },
      timeout: 3000,
    });
    expect(output.split("\n")).toContain(`BIGBUD_PROBE_VALUE=${value}`);
    expect(output.split("\n")).toContain("PATH=/usr/bin:/bin");
    expect(output.split("\n")).toContain("LC_ALL=C");
    expect(output).not.toContain("BIGBUD_INHERITED_PROBE");
  },
);
