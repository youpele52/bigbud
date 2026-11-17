import * as Cause from "effect/Cause";
import { describe, expect, it } from "vitest";
import { StateDirLockError } from "../startup/stateDirLock.ts";
import { BackendCliError } from "./cli.backend.effect.ts";
import { backendUnitRunning, describeBackendFailure } from "./cli.backend.failure.ts";

const native = (stderr: string) =>
  new BackendCliError({
    message: "Backend operation did not complete; inspect its state before retrying.",
    cause: new Error(`Local supervisor command failed (code=1). ${stderr}`),
  });

describe("backend CLI failure reasons", () => {
  it("surfaces only the native launcher's own refusal lines", () => {
    const failure = native(
      "Error: account-service operation failed\n\nCaused by:\n    the Rust unit needs a working systemd user manager; run backend status for remediation",
    );
    expect(describeBackendFailure(Cause.fail(failure), "setup")).toBe(
      "Native launcher refused: the Rust unit needs a working systemd user manager; run backend status for remediation",
    );
    const nested = new BackendCliError({ message: "PRIVATE /home/account", cause: failure });
    expect(describeBackendFailure(Cause.fail(nested), "start")).toContain("needs a working");
  });

  it("keeps the generic message for private or unstructured failures", () => {
    for (const error of [
      new BackendCliError({ message: "PRIVATE /home/account/.bigbud" }),
      new BackendCliError({
        message: "PRIVATE",
        cause: new Error("ENOENT: no such file or directory, open '/home/account/secret'"),
      }),
      native("sh: 1: cannot open /home/account/secret: No such file"),
    ])
      expect(describeBackendFailure(Cause.fail(error), "stop")).toBeUndefined();
  });

  it("explains an in-use state directory per action without its path or owner", () => {
    const inUse = new StateDirLockError({
      stateDir: "/home/account/.bigbud/state",
      message: "Another bigbud backend (pid 42, port 1) owns /home/account/.bigbud/state",
      reason: "state_directory_in_use",
    });
    const enable = describeBackendFailure(
      Cause.fail(new BackendCliError({ message: "PRIVATE", cause: inUse })),
      "enable",
    );
    expect(enable).toContain("bigbud backend stop");
    expect(enable).not.toContain("/home/account");
    expect(describeBackendFailure(Cause.fail(inUse), "start")).toContain("nothing was started");
  });

  it("recognises only the exact running backend unit line", () => {
    const authority = "a".repeat(32);
    const unit = `bigbud-backend-${authority}.service`;
    expect(backendUnitRunning(`${unit}: Active; crash-restarts=0\n`, authority)).toBe(true);
    for (const output of [
      `${unit}: Starting; crash-restarts=0`,
      `${unit}: NeedsRepair; crash-restarts=6`,
      `bigbud-rust-${authority}.service: Active; crash-restarts=0`,
      `bigbud-backend-${"b".repeat(32)}.service: Active; crash-restarts=0`,
    ])
      expect(backendUnitRunning(output, authority)).toBe(false);
  });
});
