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
