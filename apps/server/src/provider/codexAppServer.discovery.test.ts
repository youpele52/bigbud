import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: processMock.spawn, spawnSync: vi.fn() }));
import { probeCodexDiscovery } from "./codexAppServer";

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => {
      child.killed = true;
      return true;
    }),
  });
  processMock.spawn.mockReturnValue(child);
  const send = (id: number, result?: unknown, error?: { message: string }) =>
    child.stdout.write(`${JSON.stringify({ id, result, error })}\n`);
  return { child, send };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("Codex optional discovery enrichment", () => {
  it("reads ChatGPT quota from the same app-server process without starting a turn", async () => {
    const { child, send } = childProcess();
    const result = probeCodexDiscovery({
      binaryPath: "codex",
      cwd: "/workspace",
      includeUsageLimits: true,
    });
    send(1, {});
    send(4, { account: { type: "chatgpt", planType: "plus" } });
    send(3, { data: [] });
    send(2, { data: [] });
    send(5, { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } } });
    expect((await result).usageLimits?.windows[0]).toMatchObject({
      label: "5-hour limit",
      utilization: 30,
    });
    const requests = child.stdin.read()?.toString();
    expect(requests).toContain('"method":"account/rateLimits/read"');
    expect(requests).not.toContain("turn/start");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("does not request subscription quota for API-key accounts", async () => {
    const { child, send } = childProcess();
    const result = probeCodexDiscovery({
      binaryPath: "codex",
      cwd: "/workspace",
      includeUsageLimits: true,
    });
    send(1, {});
    send(4, { account: { type: "apiKey" } });
    send(3, { data: [] });
    send(2, { data: [] });
    expect((await result).usageLimits?.status).toBe("unavailable");
    expect(child.stdin.read()?.toString()).not.toContain("account/rateLimits/read");
  });

  it("a hanging quota read does not discard discovered models", async () => {
    vi.useFakeTimers();
    const { child, send } = childProcess();
    const result = probeCodexDiscovery({
      binaryPath: "codex",
      cwd: "/workspace",
      includeUsageLimits: true,
    });
    send(1, {});
    send(4, { account: { type: "chatgpt" } });
    send(3, { data: [] });
    send(2, { data: [{ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra" }] });
    await vi.advanceTimersByTimeAsync(2_000);
    const snapshot = await result;
    expect(snapshot.usageLimits?.status).toBe("error");
    expect(snapshot.models).toHaveLength(1);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each([
    ["Method not found", "unavailable"],
    ["Authentication required", "unavailable"],
    ["Upstream secret error", "error"],
  ])("isolates quota RPC failures: %s", async (message, status) => {
    const { send } = childProcess();
    const result = probeCodexDiscovery({
      binaryPath: "codex",
      cwd: "/workspace",
      includeUsageLimits: true,
    });
    send(1, {});
    send(4, { account: { type: "chatgpt" } });
    send(2, { data: [] });
    send(3, { data: [] });
    send(5, undefined, { message });
    const snapshot = await result;
    expect(snapshot).toMatchObject({ models: [], usageLimits: { status, windows: [] } });
    expect(JSON.stringify(snapshot)).not.toContain(message);
  });

  it("kills the probe process when interrupted during a quota read", async () => {
    const { child, send } = childProcess();
    const controller = new AbortController();
    const result = probeCodexDiscovery({
      binaryPath: "codex",
      cwd: "/workspace",
      includeUsageLimits: true,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow("Codex discovery probe aborted");
    send(1, {});
    send(4, { account: { type: "chatgpt" } });
    controller.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it("keeps source models when account/read fails", async () => {
    const { child, send } = childProcess();
    const result = probeCodexDiscovery({ binaryPath: "codex", cwd: "/workspace" });
    send(1, {});
    send(4, undefined, { message: "account unavailable" });
    send(3, { data: [] });
    send(2, { data: [{ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra" }] });
    expect((await result).models.map((model) => model.slug)).toEqual(["gpt-6-astra"]);
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it("bounds optional enrichment without discarding source models", async () => {
    vi.useFakeTimers();
    const { child, send } = childProcess();
    const result = probeCodexDiscovery({ binaryPath: "codex", cwd: "/workspace" });
    send(1, {});
    send(2, { data: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ models: [], skills: [], account: { type: "unknown" } });
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it("still rejects actual model discovery failures", async () => {
    const { send } = childProcess();
    const result = probeCodexDiscovery({ binaryPath: "codex", cwd: "/workspace" });
    const rejected = expect(result).rejects.toThrow("model/list failed: source unavailable");
    send(1, {});
    send(2, undefined, { message: "source unavailable" });
    await rejected;
  });
});
