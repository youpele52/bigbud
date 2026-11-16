import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

it("retains failed intent, shares concurrent preparation and bounds automatic attempts", async () => {
  const preparation = await import("./mobileGatewayPreparation");
  const failure = new Error("port occupied");
  const prepare = vi.fn(async () => {
    throw failure;
  });
  preparation.configureMobileGatewayPreparation(prepare);
  for (let attempt = 0; attempt < 5; attempt++) {
    const first = preparation.runMobileGatewayPreparation();
    const concurrent = preparation.runMobileGatewayPreparation();
    await expect(first).rejects.toBe(failure);
    await expect(concurrent).rejects.toBe(failure);
  }
  await expect(preparation.runMobileGatewayPreparation()).rejects.toThrow("explicit retry");
  expect(prepare).toHaveBeenCalledTimes(5);
  expect(preparation.mobileGatewayPreparationFailed()).toBe(true);
  prepare.mockResolvedValue(undefined as never);
  await preparation.runMobileGatewayPreparation(true);
  expect(prepare).toHaveBeenCalledTimes(6);
  expect(preparation.mobileGatewayPreparationFailed()).toBe(false);
});
