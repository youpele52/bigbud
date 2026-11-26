import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { runProcess } from "../../utils/processRunner.ts";
import {
  inspectRemoteTerminalProcesses,
  parseRemoteTerminalProcesses,
} from "./Manager.remote-inspection.ts";

vi.mock("../../utils/processRunner.ts", () => ({ runProcess: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const target = "ssh:host=devbox&user=deploy&port=2222&auth=ssh-key";
const output =
  "banner\nbigbud-process-snapshot-start\n100 1 100 200 /bin/zsh\n200 100 200 200 gemini\nbigbud-process-snapshot-end\n";

it("reads POSIX snapshots while rejecting missing/empty/partial unsupported output", () => {
  expect(parseRemoteTerminalProcesses(output)).toHaveLength(2);
  for (const text of [
    "",
    "100 1 100 200 sh",
    output.replace("bigbud-process-snapshot-end", "oops"),
    "bigbud-process-snapshot-start\nbigbud-process-snapshot-end\n",
  ]) {
    expect(() => parseRemoteTerminalProcesses(text)).toThrow();
  }
});

it("treats failures, including output overflow and SSH timeout, as inspection errors", async () => {
  for (const error of [new Error("buffer limit"), new Error("timed out")]) {
    vi.mocked(runProcess).mockRejectedValueOnce(error);
    const result = await Effect.runPromise(Effect.result(inspectRemoteTerminalProcesses(target)));
    expect(result._tag).toBe("Failure");
  }
});
