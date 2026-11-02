import { Terminal } from "@xterm/headless";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalRecoveryModel, type TerminalRecoveryModel } from "./TerminalRecoveryModel";

let model: TerminalRecoveryModel | undefined;
afterEach(() => {
  model?.dispose();
  model = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("releases producer pressure when parsing times out, without waiting for a renderer", async () => {
  vi.stubEnv("BIGBUD_TERMINAL_RECOVERY", "1");
  vi.useFakeTimers();
  vi.spyOn(Terminal.prototype, "write").mockImplementation(() => undefined);
  const hold = vi.fn();
  model = createTerminalRecoveryModel("g", 80, 24, hold)!;
  model.write("x".repeat(350_000));
  expect(hold.mock.calls).toEqual([[true]]);
  const capture = model.capture();
  await vi.advanceTimersByTimeAsync(5001);
  expect(await capture).toEqual({ type: "unavailable", reason: "parse-timeout" });
  expect(hold.mock.calls).toEqual([[true], [false]]);
});

it("retains the hard queue cap and releases an already held producer on overflow", () => {
  vi.stubEnv("BIGBUD_TERMINAL_RECOVERY", "1");
  vi.spyOn(Terminal.prototype, "write").mockImplementation(() => undefined);
  const hold = vi.fn();
  model = createTerminalRecoveryModel("g", 80, 24, hold)!;
  model.write("x".repeat(350_000));
  model.write("x".repeat(1_048_576)); // An adapter ignoring pause must not grow the queue.
  expect(model.unavailableReason).toBe("unparsed-output-budget");
  expect(hold.mock.calls).toEqual([[true], [false]]);
});
