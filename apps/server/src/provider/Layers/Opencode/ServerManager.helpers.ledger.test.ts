import { spawn } from "node:child_process";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ProcessLedgerTrackInput } from "../../../process-ledger/Services/ProcessLedger.ts";
import { trackManagedServerChild } from "./ServerManager.helpers.ts";

const recordingLedger = () => {
  const tracked: ProcessLedgerTrackInput[] = [];
  let released = 0;
  return {
    tracked,
    released: () => released,
    ledger: {
      track: (input: ProcessLedgerTrackInput) =>
        Effect.sync(() => {
          tracked.push(input);
          return { release: Effect.sync(() => void (released += 1)) };
        }),
    },
  };
};

describe.skipIf(process.platform === "win32")("trackManagedServerChild", () => {
  it("records a managed server by tree, never by group, and releases it on exit", async () => {
    const recorder = recordingLedger();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));

    await trackManagedServerChild(
      recorder.ledger,
      child,
      { command: "sleep", args: ["30"] },
      "opencode-server",
    );
    expect(recorder.tracked).toEqual([
      { pid: child.pid, command: "sleep", args: ["30"], kill: "tree", label: "opencode-server" },
    ]);
    expect(recorder.released()).toBe(0);

    child.kill("SIGKILL");
    await exited;
    expect(recorder.released()).toBe(1);
  });

  it("releases at once when the child exited before tracking finished", async () => {
    const recorder = recordingLedger();
    const child = spawn("true", [], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));

    await trackManagedServerChild(recorder.ledger, child, { command: "true", args: [] }, "x");
    expect(recorder.released()).toBe(1);
  });
});
