import { describe, expect, it, vi } from "vitest";
import { createRelayLeaseEndpoint } from "./backendScope.relay";
import { fakeRelayControl, handshake, makeLease } from "./backendScope.test.helpers";

const signal = new AbortController().signal;

function endpoint(fetchImpl: typeof fetch) {
  const { relay } = fakeRelayControl();
  const onLease = vi.fn();
  let nonce = 0;
  const lease = createRelayLeaseEndpoint({
    relay,
    profileId: "vps-1",
    randomId: () => `12345678-1234-4123-8123-00000000000${++nonce}`,
    fetch: fetchImpl,
    onLease,
  });
  return { relay, lease, onLease };
}

describe("relay lease endpoint", () => {
  it("renews an unreachable lease (local backend restart) and releases the old one", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(handshake))
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(Response.json(handshake));
    const { relay, lease, onLease } = endpoint(fetchImpl);
    relay.openRemoteBackendRelay
      .mockResolvedValueOnce(makeLease(41000))
      .mockResolvedValueOnce(makeLease(42000));
    expect((await lease.resolve(signal)).websocketUrl).toContain("127.0.0.1:41000");
    const first = await relay.openRemoteBackendRelay.mock.results[0]!.value;
    expect((await lease.resolve(signal)).websocketUrl).toContain("127.0.0.1:42000");
    expect(relay.closeRemoteBackendRelay).toHaveBeenCalledWith({ leaseId: first.leaseId });
    expect(onLease).toHaveBeenCalledTimes(2);
    expect(relay.openRemoteBackendRelay).toHaveBeenCalledTimes(2);
  });

  it("cancels by request nonce when the open reply is lost", async () => {
    const { relay, lease } = endpoint(vi.fn<typeof fetch>());
    relay.openRemoteBackendRelay.mockRejectedValueOnce(new Error("reply lost"));
    await expect(lease.resolve(signal)).rejects.toThrow("reply lost");
    const [{ requestId }] = relay.openRemoteBackendRelay.mock.calls[0]!;
    expect(relay.closeRemoteBackendRelay).toHaveBeenCalledWith({ requestId });
  });

  it("does not leak the credential into unreachable-lease errors", async () => {
    const { lease } = endpoint(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 })),
    );
    const failure = await lease.resolve(signal).catch((error: unknown) => error);
    expect(String((failure as Error).message)).not.toContain("e".repeat(16));
  });

  it("releases its lease on close and refuses further resolution", async () => {
    const { relay, lease } = endpoint(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(handshake)),
    );
    await lease.resolve(signal);
    await lease.close();
    expect(relay.closeRemoteBackendRelay).toHaveBeenCalledOnce();
    await expect(lease.resolve(signal)).rejects.toThrow("closed");
  });
});
