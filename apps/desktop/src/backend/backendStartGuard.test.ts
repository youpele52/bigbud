import { describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("backend start quiescence", () => {
  it("drains a pending start and prevents it from reaching backend spawn", async () => {
    vi.resetModules();
    const guard = await import("./backendStartGuard");
    const quiescence = await import("./installedProcessQuiescence");
    const environment = deferred<NodeJS.ProcessEnv>();
    const pendingStart = guard.resolveBackendStartWhenAllowed(() => environment.promise);

    quiescence.beginInstalledProcessQuiescence();
    let drained = false;
    const draining = quiescence.waitForInstalledProcessStarts().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    environment.resolve({ BIGBUD_CUA_DRIVER_PATH: "/resources/cua-driver" });
    await draining;

    await expect(pendingStart).resolves.toBeUndefined();
    const resolver = vi.fn(async () => ({}));
    await expect(guard.resolveBackendStartWhenAllowed(resolver)).resolves.toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });
});
