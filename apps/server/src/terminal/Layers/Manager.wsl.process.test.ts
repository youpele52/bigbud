import { describe, expect, it, vi } from "vitest";
import {
  decodeWslOutput,
  listWslDistributions,
  parseWslDistributions,
  runWslProcess,
} from "./Manager.wsl.process";
import { runProcess } from "../../utils/processRunner";

vi.mock("../../utils/processRunner", () => ({ runProcess: vi.fn() }));
const raw = (value: string, encoding: BufferEncoding = "utf8") =>
  Buffer.from(value, encoding).toString("latin1");
const result = (stdout = "Ubuntu\r\n") => ({
  stdout: raw(stdout),
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

describe("WSL discovery and process boundary", () => {
  it.each(["utf8", "utf16le"] as const)("decodes %s exact names and line endings", (encoding) => {
    expect(parseWslDistributions(raw("Ubuntu dev\r\n日本語\r\n", encoding))).toEqual([
      "Ubuntu dev",
      "日本語",
    ]);
    expect(decodeWslOutput(raw("\ufeffUbuntu\r\n", encoding))).toBe("Ubuntu\r\n");
  });
  it.each([" a\n", "a\na\n", "a\rb\n"])("rejects malformed listing %j", (value) => {
    expect(() => parseWslDistributions(raw(value))).toThrow();
  });
  it("does not invoke WSL on non-Windows hosts", async () => {
    const runner = vi.fn();
    expect(await listWslDistributions(runner, "darwin")).toEqual({
      supported: false,
      distributions: [],
    });
    expect(runner).not.toHaveBeenCalled();
  });
  it("lists installed names only, and rejects unavailable or timed-out results", async () => {
    const runner = vi.fn().mockResolvedValue(result());
    expect(await listWslDistributions(runner, "win32")).toEqual({
      supported: true,
      distributions: ["Ubuntu"],
    });
    expect(runner.mock.calls[0]?.[0]).toEqual(["--list", "--quiet"]);
    runner.mockResolvedValueOnce({ ...result(), timedOut: true });
    await expect(listWslDistributions(runner, "win32")).rejects.toThrow("discovery failed");
    runner.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(listWslDistributions(runner, "win32")).rejects.toThrow("ENOENT");
  });
  it("uses direct executable argv, bounded raw bytes, and cancellation", async () => {
    vi.mocked(runProcess).mockResolvedValue(result());
    const signal = new AbortController().signal;
    const args = ["--distribution", 'dev & %PATH% "x"', "--exec", "/bin/sh"];
    await runWslProcess(args, { signal });
    expect(runProcess).toHaveBeenCalledWith(
      expect.stringMatching(/\\System32\\wsl\.exe$/),
      args,
      expect.objectContaining({
        shell: false,
        settleOnTimeout: true,
        encoding: "latin1",
        maxBufferBytes: 8192,
        timeoutMs: 10_000,
        signal,
      }),
    );
  });
  it("redacts dynamic environment argv from process failure diagnostics", async () => {
    vi.mocked(runProcess).mockRejectedValueOnce(
      new Error("wsl.exe SECRET=private exceeded stdout buffer limit"),
    );
    await expect(runWslProcess(["SECRET=private"])).rejects.toThrow(
      "WSL process output exceeded the buffer limit",
    );
  });
});
