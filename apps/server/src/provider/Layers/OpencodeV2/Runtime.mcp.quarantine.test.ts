import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { V2IsolatedMcp } from "./Runtime.mcp.ts";

const threadId = ThreadId.makeUnsafe("mcp-uncertain");
const modelSelection = {
  provider: "opencodeV2",
  model: "synthetic-model",
  subProviderID: "synthetic-provider",
} as const;
const config = { type: "remote", url: "http://127.0.0.1:12345/mcp", disabled: true };

for (const operation of ["add", "connect"] as const)
  it(`quarantines abort-ignoring ${operation} beyond its deadline until late settlement AND verified state`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      const session = runtime.get(threadId);
      const states = new Map<string, boolean>();
      let resolve!: () => void;
      let dispatched = "";
      let verified = false;
      const list = vi.spyOn(http.client.mcp, "list").mockImplementation(async () => ({
        location: session.native.location,
        data: [...states].map(([name, enabled]) => ({
          name,
          status: { status: enabled ? ("connected" as const) : ("disabled" as const) },
        })),
      }));
      const remove = vi.spyOn(http.client.mcp, "remove").mockImplementation(async (input) => {
        states.delete(input.server);
      });
      const disconnect = vi
        .spyOn(http.client.mcp, "disconnect")
        .mockImplementation(async (input) => {
          states.set(input.server, false);
        });
      const add = vi.spyOn(http.client.mcp, "add").mockImplementation(async (input) => {
        states.set(input.server, !input.config.disabled);
      });
      const connect = vi.spyOn(http.client.mcp, "connect").mockImplementation(async (input) => {
        states.set(input.server, true);
      });
      const mcp = new V2IsolatedMcp(runtime, 25);
      if (operation === "connect") await mcp.replace(threadId, { fixture: config });
      const mutator = operation === "add" ? add : connect;
      mutator.mockImplementationOnce((input) => {
        dispatched = input.server;
        // Deliberately ignores the aborted signal; native state changes only after the deadline.
        return new Promise<void>((done) => {
          resolve = () => {
            states.set(dispatched, true);
            done();
          };
        });
      });
      const pending =
        operation === "add"
          ? mcp.replace(threadId, { fixture: { ...config, disabled: false } })
          : mcp.connect(threadId, "fixture", true);
      await expect(pending).rejects.toThrow("timed out");
      await expect(mcp.replace(threadId, {})).rejects.toThrow("quarantined");
      await expect(mcp.connect(threadId, "fixture", false)).rejects.toThrow("quarantined");
      await expect(
        runtime.send({
          threadId,
          modelSelection,
          requestMessageId: MessageId.makeUnsafe("blocked-mcp-prompt"),
          input: "must not run",
        }),
      ).rejects.toThrow("quarantined");
      expect(remove).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
      expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
      // A mismatched authoritative catalog cannot discharge quarantine even after raw success.
      list.mockImplementation(async () => ({ location: session.native.location, data: [] }));
      resolve();
      await new Promise((done) => setTimeout(done, 10));
      expect(() => runtime.mutations.assertSafe()).toThrow("quarantined");
      list.mockImplementation(async () => {
        verified = true;
        return {
          location: session.native.location,
          data: [...states].map(([name, enabled]) => ({
            name,
            status: { status: enabled ? ("connected" as const) : ("disabled" as const) },
          })),
        };
      });
      await mcp.refresh(threadId);
      await expect
        .poll(() => {
          try {
            runtime.mutations.assertSafe();
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      expect(verified).toBe(true);
      if (operation === "add") await mcp.replace(threadId, {});
      else await mcp.connect(threadId, "fixture", false);
      expect([...states.values()].some(Boolean)).toBe(false);
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("safe-mcp-prompt"),
        input: "synthetic safe prompt",
      });
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    });
  });

it("retains rejected/unconfirmed MCP operations and storage namespace across logical stop until physical exit", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    await runtime.start({
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    const session = runtime.get(threadId);
    vi.spyOn(http.client.mcp, "add").mockRejectedValue(
      new Error("transport abort; native outcome unknown"),
    );
    await expect(
      new V2IsolatedMcp(runtime, 25).replace(threadId, { fixture: config }),
    ).rejects.toThrow();
    vi.spyOn(session.lease.process, "close").mockResolvedValue(undefined);
    await runtime.stop(threadId);
    await expect(
      runtime.start({
        threadId: ThreadId.makeUnsafe("successor"),
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      }),
    ).rejects.toThrow("quarantined");
    expect(
      http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST"),
    ).toHaveLength(1);
    expect(session.lease.process.hasExited?.()).toBe(false);
    expect(() => runtime.mutations.assertSafe()).toThrow("quarantined");
    await expect(runtime.close()).rejects.toThrow(
      "OpenCode v2 manager shutdown remains unconfirmed; native namespaces retained.",
    );
    expect(session.lease.process.hasExited?.()).toBe(false);
    expect(() => runtime.mutations.assertSafe()).toThrow("quarantined");
    http.die();
    expect(() => runtime.mutations.assertSafe()).not.toThrow();
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
