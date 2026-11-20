import { expect, it, vi } from "vitest";
import {
  deferred,
  fixture,
  ownerKey,
  prepared,
  request,
} from "./DirectShellLaunch.dispatch.test.helpers";

it.each([false, true])(
  "never transports or rolls back when reserve throws (committed=%s)",
  async (committed) => {
    const f = fixture();
    const failure = new Error("reserve persistence failed");
    const reserve = vi.mocked(f.store.reserve).getMockImplementation()!;
    vi.mocked(f.store.reserve).mockImplementationOnce(async (owner) => {
      if (committed) await reserve(owner);
      throw failure;
    });
    await expect(f.controller()(request())).rejects.toBe(failure);
    expect(f.entries.has(ownerKey)).toBe(committed);
    if (committed) expect((await f.controller("other")(request())).action).toBe("retained");
    expect(f.store.claimDispatch).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.store.cancelPrepared).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "retains ambiguous ownership on claim exception, including lost acknowledgement (committed=%s)",
  async (committed) => {
    const f = fixture();
    const failure = new Error("claim acknowledgement lost");
    const claim = vi.mocked(f.store.claimDispatch).getMockImplementation()!;
    vi.mocked(f.store.claimDispatch).mockImplementationOnce(async (...args) => {
      if (committed) expect(await claim(...args)).toBe(true);
      throw failure;
    });
    await expect(f.controller()(request())).rejects.toBe(failure);
    expect(f.entries.get(ownerKey)?.state).toBe(committed ? "may-have-been-sent" : "prepared");
    expect((await f.controller("restart")(request())).action).toBe("retained");
    expect(f.store.claimDispatch).toHaveBeenCalledTimes(1);
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.store.cancelPrepared).not.toHaveBeenCalled();
    expect(f.store.markUnknown).not.toHaveBeenCalled();
  },
);

it("requires acknowledged durable claim before any transport, including while claim is pending", async () => {
  const f = fixture();
  const gate = deferred();
  const entered = deferred();
  const claim = vi.mocked(f.store.claimDispatch).getMockImplementation()!;
  vi.mocked(f.store.claimDispatch).mockImplementationOnce(async (...args) => {
    expect(await claim(...args)).toBe(true);
    entered.release();
    await gate.promise;
    return true;
  });
  f.transport.mockImplementation(async () => {
    expect(f.entries.get(ownerKey)?.state).toBe("may-have-been-sent");
  });
  const pending = f.controller()(request());
  await entered.promise;
  expect(f.transport).not.toHaveBeenCalled();
  expect((await f.controller("racing")(request())).action).toBe("retained");
  gate.release();
  expect((await pending).action).toBe("dispatched");
  expect(f.transport).toHaveBeenCalledTimes(1);
});

it("does not transport or cancel when the claim CAS loses", async () => {
  const f = fixture();
  vi.mocked(f.store.claimDispatch).mockResolvedValueOnce(false);
  await expect(f.controller()(request())).rejects.toThrow("claim was not granted");
  expect(f.entries.get(ownerKey)?.state).toBe("prepared");
  expect((await f.controller()(request())).action).toBe("retained");
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.store.cancelPrepared).not.toHaveBeenCalled();
  expect(f.store.claimDispatch).toHaveBeenCalledTimes(1);
});

it.each(["success", "false", "throw"] as const)(
  "retains possibly-dispatched ownership on transport throw and preserves original error (markUnknown=%s)",
  async (mark) => {
    const f = fixture();
    const failure = new Error("transport failed after possible send");
    f.transport.mockImplementationOnce(() => {
      throw failure;
    });
    if (mark === "false") vi.mocked(f.store.markUnknown).mockResolvedValueOnce(false);
    if (mark === "throw")
      vi.mocked(f.store.markUnknown).mockRejectedValueOnce(new Error("disk failed"));
    await expect(f.controller()(request())).rejects.toBe(failure);
    expect(f.entries.get(ownerKey)?.state).toBe(
      mark === "success" ? "outcome-unknown" : "may-have-been-sent",
    );
    const saved = f.entries.get(ownerKey)!;
    expect(f.store.markUnknown).toHaveBeenCalledExactlyOnceWith(
      ownerKey,
      saved.reservationId,
      saved.controllerId,
    );
    expect((await f.controller("retry")(request())).action).toBe("retained");
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.store.cancelPrepared).not.toHaveBeenCalled();
  },
);

it("also preserves rejected asynchronous transport failures without fallback", async () => {
  const f = fixture();
  const failure = new Error("lost transport response");
  f.transport.mockRejectedValueOnce(failure);
  await expect(f.controller()(request())).rejects.toBe(failure);
  expect(f.entries.get(ownerKey)?.state).toBe("outcome-unknown");
  expect(f.transport).toHaveBeenCalledTimes(1);
});

it("fails closed if reserve incorrectly reports a different reservation as newly created", async () => {
  const f = fixture();
  vi.mocked(f.store.reserve).mockResolvedValueOnce({ created: true, owner: prepared() });
  await expect(f.controller()(request())).rejects.toThrow("reservation identity conflict");
  expect(f.store.claimDispatch).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.store.cancelPrepared).not.toHaveBeenCalled();
});
