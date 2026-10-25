import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ contain: vi.fn() }));
vi.mock("./-__root.delivery-routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./-__root.delivery-routing")>();
  mocks.contain.mockImplementation(actual.containDeliveryApplicationFailure);
  return { ...actual, containDeliveryApplicationFailure: mocks.contain };
});

import { WsTransportDisconnectedError } from "../rpc/wsTransport.errors";
import { handleDeliveryApplicationFailure } from "./-__root.delivery-failure";

afterEach(() => {
  vi.restoreAllMocks();
  mocks.contain.mockClear();
});

describe("handleDeliveryApplicationFailure", () => {
  it("rethrows a dropped-socket acknowledgement without bounded recovery", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fallbackToBoundedRecovery = vi.fn(async () => undefined);
    const error = new WsTransportDisconnectedError();

    await expect(
      handleDeliveryApplicationFailure({ itemType: "batch", error, fallbackToBoundedRecovery }),
    ).rejects.toBe(error);

    expect(mocks.contain).not.toHaveBeenCalled();
    expect(fallbackToBoundedRecovery).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("still contains a real application failure with bounded recovery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fallbackToBoundedRecovery = vi.fn(async () => undefined);
    const error = new Error("projection apply failed");

    await expect(
      handleDeliveryApplicationFailure({ itemType: "batch", error, fallbackToBoundedRecovery }),
    ).rejects.toBe(error);

    expect(mocks.contain).toHaveBeenCalledOnce();
    expect(fallbackToBoundedRecovery).toHaveBeenCalledOnce();
  });
});
