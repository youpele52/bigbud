import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), open: vi.fn() }));
vi.mock("./remoteAgentLocalControl.windows.identity.ts", () => ({
  readWindowsControlIdentity: mocks.identity,
}));
vi.mock("./remoteAgentLocalControl.windows.process.ts", () => ({
  WindowsControlProcess: { open: mocks.open },
}));
import {
  sendWindowsControlRequest,
  startWindowsControlServer,
} from "./remoteAgentLocalControl.windows.ts";
const hex = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("hex");
const noFrame = (_line: string) => {};
const noFailure = () => {};
function native() {
  let frame = noFrame;
  let failure = noFailure;
  const child = {
    listen: (next: typeof frame, failed: typeof failure) => {
      frame = next;
      failure = failed;
    },
    send: vi.fn((line: string) => {
      if (line.startsWith("SERVER")) queueMicrotask(() => frame("READY\t1"));
      return true;
    }),
    close: vi.fn(async () => {}),
    receive: (line: string) => frame(line),
    fail: () => failure(),
  };
  mocks.identity.mockResolvedValue({
    filename: "C:\\state\\backend.lock",
    backend: "a".repeat(64),
    fingerprint: "b".repeat(64),
  });
  mocks.open.mockResolvedValue(child);
  return child;
}
afterEach(() => vi.clearAllMocks());
it("publishes only public generation metadata and handles accepted work after disconnect", async () => {
  const child = native();
  let finish!: (value: { v: 1; ok: true; result: string }) => void;
  const handle = vi.fn(
    () =>
      new Promise<{ v: 1; ok: true; result: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const server = await startWindowsControlServer({
    socketPath: "C:\\state\\control\\remote.sock",
    handle,
  });
  child.receive(
    `R\t1\t${hex({ v: 1, method: "install", target: "vps", consent: true, replace: false })}`,
  );
  await Promise.resolve();
  child.receive("C\t1");
  finish({ v: 1, ok: true, result: "accepted-operation-id" });
  await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.stringMatching(/^S\t1\t/)));
  expect(handle).toHaveBeenCalledOnce();
  await server.close();
});
it("returns a bounded invalid-request response without stopping other clients", async () => {
  const child = native();
  const handle = vi.fn();
  const server = await startWindowsControlServer({ socketPath: "socket", handle });
  child.receive("R\t1\t7b");
  const reply = child.send.mock.calls.at(-1)![0].split("\t")[2]!;
  expect(JSON.parse(Buffer.from(reply, "hex").toString())).toMatchObject({
    ok: false,
    error: { code: "invalid-request" },
  });
  expect(handle).not.toHaveBeenCalled();
  expect(child.close).not.toHaveBeenCalled();
  await server.close();
});
it("does not cancel accepted work when the helper exits", async () => {
  const child = native();
  let completed = false;
  let finish!: () => void;
  const server = await startWindowsControlServer({
    socketPath: "socket",
    handle: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      completed = true;
      return { v: 1, ok: true, result: "done" };
    },
  });
  child.receive(`R\t1\t${hex({ v: 1, method: "status", target: "vps" })}`);
  await Promise.resolve();
  child.fail();
  finish();
  await vi.waitFor(() => expect(completed).toBe(true));
  expect(child.send.mock.calls.some(([line]) => line.startsWith("S\t"))).toBe(false);
  await server.close();
});
it("uses the native verified client and rejects malformed responses", async () => {
  const child = native();
  const request = sendWindowsControlRequest("socket", { method: "status", target: "vps" }, 1000);
  await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
  child.receive(`REPLY\t${hex({ v: 1, ok: true, result: "installed" })}`);
  expect(await request).toMatchObject({ ok: true, result: "installed" });
  expect(child.close).toHaveBeenCalledOnce();
});
