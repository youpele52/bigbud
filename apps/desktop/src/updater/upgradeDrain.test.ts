import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backendDrainControlPaths } from "@bigbud/shared/backendDrain.client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpdateInstallCoordinator } from "./autoUpdater.install";
import { createUpgradeDrain } from "./upgradeDrain";

const TOKEN = "b".repeat(64);
const ARTIFACT = "bigbud-server@0.0.0-test";

/**
 * A same-user drain control socket that answers like the running backend: the
 * scripted status is what the user's consent decision produced.
 */
async function startDrainControl(stateDir: string, statuses: string[]) {
  const { directory, socketPath, tokenPath } = backendDrainControlPaths(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>;
      requests.push(request);
      const response =
        request.token === TOKEN && request.artifactId === ARTIFACT
          ? { v: 1, ok: true, status: statuses.shift() ?? "busy" }
          : { v: 1, ok: false, error: { code: "unauthorized", message: "refused" } };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function harness(stateDir: string) {
  const events: string[] = [];
  const blocked: string[] = [];
  const coordinator = createUpdateInstallCoordinator({
    drainBeforeInstall: createUpgradeDrain({
      stateDir,
      artifactId: ARTIFACT,
      platform: "darwin",
      onDrained: () => events.push("fence-restarts"),
    }),
    onInstallBlocked: (message) => blocked.push(message),
    beginUpdatePreparation: () => events.push("begin-preparation"),
    canInstall: () => true,
    clearUpdateTimers: vi.fn(),
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    getIsQuitting: () => false,
    onHandoffFailure: (message) => events.push(`handoff-failure:${message}`),
    onInstallStart: () => events.push("install-start"),
    onRestartRequiredPreparationFailure: (message) => events.push(`restart-required:${message}`),
    platform: "darwin",
    prepareForUpdateInstall: async () => {
      events.push("stop-backend");
    },
    quitAndInstall: () => events.push("quit-and-install"),
    setIsQuitting: vi.fn(),
  });
  return { coordinator, events, blocked };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function stateDirectory() {
  // Short root: Unix socket paths are limited to ~104 bytes on macOS.
  const stateDir = await mkdtemp(join(tmpdir(), "bb-drain-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

describe("desktop updater upgrade drain (U5/U8)", () => {
  it("Cancel blocks the upgrade, leaves the app running, and a later consent installs", async () => {
    const stateDir = await stateDirectory();
    const control = await startDrainControl(stateDir, ["cancelled", "drained"]);
    cleanups.push(control.close);
    const { coordinator, events, blocked } = harness(stateDir);

    await expect(coordinator.install()).resolves.toEqual({ accepted: true, completed: false });
    expect(events).toEqual([]);
    expect(blocked).toEqual([
      "The upgrade was cancelled. The upgrade was not started; bigbud and your terminals keep running.",
    ]);
    expect(coordinator.isInFlight()).toBe(false);
    expect(control.requests[0]).toMatchObject({ consent: "ui", artifactId: ARTIFACT });

    await coordinator.install();
    expect(events).toEqual([
      "fence-restarts",
      "begin-preparation",
      "stop-backend",
      "install-start",
      "quit-and-install",
    ]);
  });

  it("an unreachable drain control or refusal aborts the upgrade without preparation", async () => {
    const stateDir = await stateDirectory();
    const { coordinator, events, blocked } = harness(stateDir);
    await coordinator.install();
    expect(events).toEqual([]);
    expect(blocked[0]).toContain("drain control is unavailable");

    const control = await startDrainControl(stateDir, ["consent-required"]);
    cleanups.push(control.close);
    await coordinator.install();
    expect(events).toEqual([]);
    expect(blocked[1]).toContain("consent-required");
  });

  it("Windows keeps the existing install path because drain control is unsupported", async () => {
    const drain = createUpgradeDrain({
      stateDir: "/nonexistent",
      artifactId: ARTIFACT,
      platform: "win32",
      request: vi.fn(),
    });
    await expect(drain()).resolves.toMatchObject({ kind: "skipped" });
  });
});
