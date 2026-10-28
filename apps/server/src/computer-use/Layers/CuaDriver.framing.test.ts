import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestResponse, stderrTails, writeMessage } from "./CuaDriver.framing.ts";

// No spawned child, socket, daemon, permission or desktop interaction.
function child() {
  const process = new EventEmitter();
  const stdout = new EventEmitter();
  const write = vi.fn((_message: string, callback: (error?: Error) => void) => callback());
  const value = Object.assign(process, {
    stdout,
    stdin: { write },
  }) as unknown as ChildProcessWithoutNullStreams;
  return { value, stdout, write };
}
afterEach(() => vi.useRealTimers());

describe("legacy MCP framing extraction", () => {
  it("writes precisely one newline-delimited MCP message", async () => {
    const mock = child();
    await writeMessage(mock.value, { jsonrpc: "2.0", id: 1 });
    expect(mock.write).toHaveBeenCalledWith('{"jsonrpc":"2.0","id":1}\n', expect.any(Function));
  });
  it("preserves partial stream assembly and ignores other response IDs", async () => {
    const mock = child();
    const response = requestResponse(mock.value, 3, "tools/call", { name: "list_apps" });
    mock.stdout.emit("data", Buffer.from('\n{"id":2,"result":false}\n{"id":3,"res'));
    mock.stdout.emit("data", Buffer.from('ult":{"content":[]}}\n'));
    await expect(response).resolves.toEqual({ content: [] });
    expect(mock.write.mock.calls[0]?.[0]).toBe(
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_apps"}}\n',
    );
    expect(mock.stdout.listenerCount("data")).toBe(0);
    expect(mock.value.listenerCount("exit")).toBe(0);
  });
  it("preserves structured MCP errors rather than resolving an empty result", async () => {
    const mock = child();
    const response = requestResponse(mock.value, 1, "tools/call");
    mock.stdout.emit("data", Buffer.from('{"id":1,"error":{"message":"refused"}}\n'));
    await expect(response).rejects.toThrow("refused");
    expect(mock.stdout.listenerCount("data")).toBe(0);
  });
  it("retains the bounded diagnostic suffix on process exit", async () => {
    const mock = child();
    stderrTails.set(mock.value, "diagnostic");
    const response = requestResponse(mock.value, 1, "initialize");
    mock.value.emit("exit", 1, null);
    await expect(response).rejects.toThrow("Driver diagnostics: diagnostic");
    expect(mock.stdout.listenerCount("data")).toBe(0);
  });
  it("cleans listeners after a request deadline without executing a child", async () => {
    vi.useFakeTimers();
    const mock = child();
    const response = requestResponse(mock.value, 1, "tools/list");
    const rejected = expect(response).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await rejected;
    expect(mock.stdout.listenerCount("data")).toBe(0);
    expect(mock.value.listenerCount("error")).toBe(0);
  });
  it("rejects malformed JSON and write errors", async () => {
    const mock = child();
    const response = requestResponse(mock.value, 1, "tools/list");
    mock.stdout.emit("data", Buffer.from("not json\n"));
    await expect(response).rejects.toThrow();
    mock.write.mockImplementationOnce((_message, callback) => callback(new Error("closed")));
    await expect(writeMessage(mock.value, {})).rejects.toThrow("closed");
  });
});
