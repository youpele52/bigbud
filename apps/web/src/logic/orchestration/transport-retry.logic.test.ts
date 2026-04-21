import { describe, expect, it, vi } from "vitest";

import { retryTransportRecoveryOperation } from "./transport-retry.logic";

describe("retryTransportRecoveryOperation", () => {
  it("retries transport disconnects before succeeding", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => undefined);

    await expect(
      retryTransportRecoveryOperation(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("SocketCloseError: 1006");
          }

          return "ok";
        },
        { sleep },
      ),
    ).resolves.toBe("ok");

    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not retry non-transport failures", async () => {
    let attempts = 0;

    await expect(
      retryTransportRecoveryOperation(async () => {
        attempts += 1;
        throw new Error("snapshot failed");
      }),
    ).rejects.toThrow("snapshot failed");

    expect(attempts).toBe(1);
  });

  it("stops after the configured transport retry budget", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => undefined);

    await expect(
      retryTransportRecoveryOperation(
        async () => {
          attempts += 1;
          throw new Error("SocketCloseError: 1006");
        },
        {
          maxRetries: 2,
          sleep,
        },
      ),
    ).rejects.toThrow("SocketCloseError: 1006");

    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
});
