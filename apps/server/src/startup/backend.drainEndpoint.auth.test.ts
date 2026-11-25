import { mkdtemp, rm, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestBackendDrain } from "./backendDrain.client.ts";
import {
  handleBackendDrain,
  isBackendDrainRunning,
  registerBackendDrainHandler,
} from "./backendDrain.handler.ts";
import { BACKEND_DRAIN_VERSION } from "./backendDrain.protocol.ts";
import { backendDrainControlPaths, startBackendDrainControlServer } from "./backendDrain.server.ts";

const roots: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
const token = "a".repeat(64);

async function endpoint(
  handle: Parameters<typeof startBackendDrainControlServer>[0]["handle"] = async () => ({
    v: 1,
    ok: true,
    status: "drained",
  }),
) {
  const stateDir = await mkdtemp("/tmp/bbdrain-");
  roots.push(stateDir);
  const server = await startBackendDrainControlServer({ stateDir, token, handle });
  servers.push(server);
  return { stateDir, paths: backendDrainControlPaths(stateDir) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("backend drain endpoint authentication", () => {
  it("accepts only the same-user private token and owner-only socket", async () => {
    const { stateDir, paths } = await endpoint();
    const socket = await stat(paths.socketPath);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o077).toBe(0);
    expect((await stat(paths.tokenPath)).mode & 0o077).toBe(0);
    await expect(
      requestBackendDrain({ stateDir, artifactId: "build-a", consent: "non-interactive" }),
    ).resolves.toEqual({ v: 1, ok: true, status: "drained" });
  });

  it("refuses a foreign token file and never reaches the handler", async () => {
    const handle = vi.fn(async () => ({ v: 1, ok: true, status: "drained" }) as const);
    const { stateDir, paths } = await endpoint(handle);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(paths.tokenPath, `${"b".repeat(64)}\n`, { mode: 0o600 });
    await expect(
      requestBackendDrain({ stateDir, artifactId: "build-a", consent: "non-interactive" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects a malformed or unavailable artifact without draining", async () => {
    const handle = vi.fn(async (request: { readonly artifactId: string }) =>
      request.artifactId === "build-a"
        ? ({ v: 1, ok: true, status: "drained" } as const)
        : ({ v: 1, ok: true, status: "unknown-artifact" } as const),
    );
    const { stateDir } = await endpoint(handle);
    await expect(
      requestBackendDrain({ stateDir, artifactId: "foreign-build", consent: "non-interactive" }),
    ).resolves.toMatchObject({ status: "unknown-artifact" });
  });

  it("serializes the registry so a second drain reports busy", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unregister = registerBackendDrainHandler(async () => {
      await blocker;
      return { v: 1, ok: true, status: "drained" };
    });
    try {
      const first = handleBackendDrain({
        v: BACKEND_DRAIN_VERSION,
        token,
        method: "drain",
        artifactId: "build-a",
        consent: "non-interactive",
        waitMs: 1_000,
      });
      expect(isBackendDrainRunning()).toBe(true);
      await expect(
        handleBackendDrain({
          v: BACKEND_DRAIN_VERSION,
          token,
          method: "drain",
          artifactId: "build-a",
          consent: "non-interactive",
          waitMs: 1_000,
        }),
      ).resolves.toEqual({ v: 1, ok: true, status: "busy" });
      release();
      await expect(first).resolves.toEqual({ v: 1, ok: true, status: "drained" });
      expect(isBackendDrainRunning()).toBe(false);
    } finally {
      unregister();
    }
  });

  it("does not infer a handler when none is registered", async () => {
    const { stateDir } = await endpoint(handleBackendDrain);
    const response = await requestBackendDrain({
      stateDir,
      artifactId: "build-a",
      consent: "non-interactive",
    });
    expect(response).toMatchObject({ v: 1, ok: false, error: { code: "unavailable" } });
  });
});
