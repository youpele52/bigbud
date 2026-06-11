import { describe, expect, it } from "vitest";

import {
  formatMissingOpencodeBinaryDetail,
  readManagedServerListeningUrl,
} from "./ServerManager.ts";

describe("readManagedServerListeningUrl", () => {
  it("reads OpenCode and KiloCode server startup lines", () => {
    expect(
      readManagedServerListeningUrl("opencode server listening on http://127.0.0.1:4321"),
    ).toBe("http://127.0.0.1:4321");
    expect(readManagedServerListeningUrl("kilo server listening on http://127.0.0.1:4322")).toBe(
      "http://127.0.0.1:4322",
    );
  });

  it("ignores unrelated output", () => {
    expect(readManagedServerListeningUrl("Warning: KILO_SERVER_PASSWORD is not set")).toBeNull();
  });
});

describe("formatMissingOpencodeBinaryDetail", () => {
  it("formats a local PATH-missing OpenCode binary error", () => {
    expect(
      formatMissingOpencodeBinaryDetail({
        binaryPath: "opencode",
        executionTargetId: "local",
        detail: "OpenCode server exited with code 127.\nsh: 1: exec: opencode: not found",
      }),
    ).toBe(
      "OpenCode CLI is not installed or not available on PATH. Install 'opencode' locally or set Providers > OpenCode > Binary path to the local executable path.",
    );
  });

  it("formats a remote custom-binary missing error", () => {
    expect(
      formatMissingOpencodeBinaryDetail({
        binaryPath: "/opt/opencode/bin/opencode",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        detail:
          "OpenCode server exited with code 127.\nsh: 1: exec: /opt/opencode/bin/opencode: not found",
      }),
    ).toBe(
      "Remote OpenCode binary was not found at '/opt/opencode/bin/opencode'. Update Providers > OpenCode > Binary path to the correct remote executable path.",
    );
  });

  it("ignores unrelated startup errors", () => {
    expect(
      formatMissingOpencodeBinaryDetail({
        binaryPath: "opencode",
        executionTargetId: "local",
        detail: "OpenCode server exited with code 1.\npermission denied",
      }),
    ).toBeNull();
  });

  it("formats a local PATH-missing KiloCode binary error", () => {
    expect(
      formatMissingOpencodeBinaryDetail({
        provider: "kilocode",
        binaryPath: "kilo",
        executionTargetId: "local",
        detail: "KiloCode server exited with code 127.\nsh: 1: exec: kilo: not found",
      }),
    ).toBe(
      "KiloCode CLI is not installed or not available on PATH. Install 'kilo' locally or set Providers > KiloCode > Binary path to the local executable path.",
    );
  });
});
