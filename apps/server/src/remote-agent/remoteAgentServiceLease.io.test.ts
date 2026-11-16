import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { NativeLeaseIo } from "./remoteAgentServiceLease.io.ts";
function fixture() {
  const connection = RemoteAgentConnection.local({
    binaryPath: process.execPath,
    args: [
      "--experimental-transform-types",
      fileURLToPath(new URL("./remoteAgentServiceLease.io.fixture.mjs", import.meta.url)),
    ],
    env: {},
  });
  return { connection, io: new NativeLeaseIo(connection) };
}
it("correlates real pipe replies and joins original proxy after cancelled/lost reply", async () => {
  const { connection, io } = fixture();
  const abort = new AbortController();
  try {
    const pending = io.request(
      (id) => ({
        type: "serviceLeaseStatusRequest",
        value: { requestId: id, binding: undefined, capability: new Uint8Array([9]) },
      }),
      abort.signal,
    );
    // The second real reply proves the first write was accepted by the fixture.
    const observed = await io.request((id) => ({
      type: "serviceLeaseControlRequest",
      value: {
        requestId: id,
        binding: undefined,
        capability: new Uint8Array(),
        generation: 0,
        action: "observe",
      },
    }));
    expect(observed.originalChildPid).toBe(2);
    abort.abort();
    await expect(pending).rejects.toThrow(/unresolved/);
    const fence = await io.request((id) => ({
      type: "serviceLeaseControlRequest",
      value: {
        requestId: id,
        binding: undefined,
        capability: new Uint8Array(),
        generation: 0,
        action: "cancel-pending",
      },
    }));
    expect(fence.state).toBe("cancelled");
    expect(fence.originalChildPid).toBe(3);
    await io.dispose();
    await expect(
      io.request((id) => ({
        type: "serviceLeaseStatusRequest",
        value: { requestId: id, binding: undefined, capability: new Uint8Array() },
      })),
    ).rejects.toThrow(/disposed/);
    expect(connection.processId).toBeGreaterThan(1); // Diagnostic only; closeConfirmed owns the actual Child.
  } finally {
    await io.dispose();
  }
});
it("bounds unresolved real pipe requests and disposal settles all waiters", async () => {
  const { io } = fixture();
  const requests = Array.from({ length: 16 }, () =>
    io.request((id) => ({
      type: "serviceLeaseStatusRequest",
      value: { requestId: id, binding: undefined, capability: new Uint8Array([9]) },
    })),
  );
  const settled = Promise.allSettled(requests);
  try {
    await expect(
      io.request((id) => ({
        type: "serviceLeaseStatusRequest",
        value: { requestId: id, binding: undefined, capability: new Uint8Array() },
      })),
    ).rejects.toThrow(/capacity/);
    await io.dispose();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
  } finally {
    await io.dispose();
  }
});
