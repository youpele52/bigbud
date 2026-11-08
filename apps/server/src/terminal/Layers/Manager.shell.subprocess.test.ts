import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { runProcess } from "../../utils/processRunner";
import { defaultSubprocessChecker } from "./Manager.shell.subprocess.ts";

vi.mock("../../utils/processRunner", () => ({ runProcess: vi.fn() }));
const result = (code: number, stdout = "") => ({
  code,
  stdout,
  stderr: "",
  signal: null,
  timedOut: false,
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("counts direct children, including background jobs, without relying on output", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  vi.mocked(runProcess).mockResolvedValueOnce(result(0, "1234\n"));
  expect(await Effect.runPromise(defaultSubprocessChecker(123))).toBe(true);
});

it("allows a confirmed unused shell", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  vi.mocked(runProcess).mockResolvedValueOnce(result(1));
  expect(await Effect.runPromise(defaultSubprocessChecker(123))).toBe(false);
});

it("does not collapse dual POSIX inspection failures to false", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  vi.mocked(runProcess).mockRejectedValue(new Error("inspection failed"));
  await expect(Effect.runPromise(defaultSubprocessChecker(123))).rejects.toThrow(
    "both pgrep and ps",
  );
});

it("does not treat truncated fallback evidence as confirmed idle", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  vi.mocked(runProcess)
    .mockResolvedValueOnce(result(2))
    .mockResolvedValueOnce({ ...result(0, "1 0\n"), stdoutTruncated: true });
  await expect(Effect.runPromise(defaultSubprocessChecker(123))).rejects.toThrow(
    "both pgrep and ps",
  );
});

it("distinguishes Windows inspection failure from successful no-child detection", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.mocked(runProcess).mockResolvedValueOnce(result(2));
  await expect(Effect.runPromise(defaultSubprocessChecker(123))).rejects.toThrow(
    "inspection failed",
  );
  expect(vi.mocked(runProcess).mock.calls[0]![1]!.join(" ")).toContain("catch { exit 2 }");
  vi.mocked(runProcess).mockResolvedValueOnce(result(1));
  expect(await Effect.runPromise(defaultSubprocessChecker(123))).toBe(false);
});
