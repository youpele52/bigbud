import { describe, expect, it, vi } from "vitest";

import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import {
  activeRemoteAgentRemovalFence,
  assertRemoteAgentRemovalFenceTransition,
  dropExpiredRemoteAgentRemovalFence,
  REMOTE_AGENT_REMOVAL_FENCE_TTL_MS,
  RemoteAgentRemovalInProgressError,
  withoutRemoteAgentRemovalFence,
  withRemoteAgentRemovalFence,
} from "./remoteAgentInstall.registry.removalFence.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { parseRemoteAgentBackendRuntimeProbe } from "./remoteAgentInstall.remove.blockers.ts";

const NOW = 1_800_000_000_000;
const ID = "11111111-2222-4333-8444-555555555555";
const BUILD_ID = `0.4.0:${"a".repeat(64)}:x86_64-unknown-linux-musl`;

function base(): RemoteAgentRegistry {
  const statePath = "/h/.bigbud/agent/runtimes/g-a";
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      promotionSequence: 1,
      builds: [
        {
          id: BUILD_ID,
          runtime: {
            generation: "g-a",
            version: "0.4.0",
            sha256: "a".repeat(64),
            buildDigest: "commit",
            targetTriple: "x86_64-unknown-linux-musl",
            origin: "managed",
            binaryPath: `/h/.bigbud/agent/bin/0.4.0/${"a".repeat(64)}/bigbud-remote-agent`,
            statePath,
            socketPath: `${statePath}/supervisor.sock`,
            logPath: `${statePath}/supervisor.log`,
          },
          health: "healthy",
          promotion: 1,
          binary: "present",
          authenticated: true,
        },
      ],
    }),
  );
}

const fenced = (startedAt = NOW) =>
  withRemoteAgentRemovalFence(base(), { id: ID, controllerId: "c1", startedAt }, NOW);
const withStage = (state: RemoteAgentRegistry) =>
  parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      stages: [{ id: "stage-1", buildId: BUILD_ID, phase: "reserved" }],
    }),
  );
const withLaunch = (state: RemoteAgentRegistry) =>
  parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      launches: [{ id: "launch-1", buildId: BUILD_ID, phase: "reserved", epoch: "e" }],
    }),
  );

describe("remote agent removal fence", () => {
  it("refuses new stages and launches while fresh, and allows them once cleared or expired", () => {
    const state = fenced();
    expect(() => assertRemoteAgentRemovalFenceTransition(state, withStage(state), NOW)).toThrow(
      RemoteAgentRemovalInProgressError,
    );
    expect(() => assertRemoteAgentRemovalFenceTransition(state, withLaunch(state), NOW)).toThrow(
      RemoteAgentRemovalInProgressError,
    );
    const cleared = withoutRemoteAgentRemovalFence(state, ID);
    expect(cleared.removal).toBeUndefined();
    expect(() =>
      assertRemoteAgentRemovalFenceTransition(cleared, withStage(cleared), NOW),
    ).not.toThrow();
    const stale = fenced(NOW - REMOTE_AGENT_REMOVAL_FENCE_TTL_MS - 1);
    expect(() =>
      assertRemoteAgentRemovalFenceTransition(stale, withStage(stale), NOW),
    ).not.toThrow();
  });

  it("lets only its own removal replace or clear the fence", () => {
    const state = fenced();
    expect(() =>
      withRemoteAgentRemovalFence(
        state,
        { id: "99999999-2222-4333-8444-555555555555", controllerId: "c2", startedAt: NOW },
        NOW,
      ),
    ).toThrow(RemoteAgentRemovalInProgressError);
    expect(withoutRemoteAgentRemovalFence(state, "other-id-0000")).toBe(state);
  });

  it("is enforced by the cross-controller registry store before any write", async () => {
    const text = JSON.stringify(fenced(Date.now()));
    const run = vi.fn(async (command: string) =>
      command.includes("base64 -w0") ? Buffer.from(text).toString("base64") : "committed",
    );
    const store = makeRemoteAgentRegistryStore("/h/.bigbud/agent", { run });
    await expect(store.update(withStage)).rejects.toThrow(RemoteAgentRemovalInProgressError);
    expect(run).toHaveBeenCalledOnce();
  });
});

function storeReading(state: RemoteAgentRegistry, hostSeconds?: number) {
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
  const run = vi.fn(async (command: string) =>
    command.includes("base64 -w0")
      ? `${hostSeconds === undefined ? "" : `clock=${hostSeconds}\n`}${encoded}`
      : "committed",
  );
  return { store: makeRemoteAgentRegistryStore("/h/.bigbud/agent", { run }), run };
}

describe("stale and skewed removal fences", () => {
  it("drops an expired fence on the next registry write", async () => {
    const stale = fenced(Date.now() - REMOTE_AGENT_REMOVAL_FENCE_TTL_MS - 1000);
    const { store } = storeReading(stale);
    const written = await store.update(withStage);
    expect(written.removal).toBeUndefined();
    expect(written.stages).toHaveLength(1);
    expect(dropExpiredRemoteAgentRemovalFence(stale).removal).toBeUndefined();
    expect(dropExpiredRemoteAgentRemovalFence(fenced(Date.now()))).toEqual(fenced(Date.now()));
  });

  it("times fences by the host's clock from the registry read, not this controller's", async () => {
    // Fresh by this controller's clock, but expired on the host: new work is allowed.
    const local = fenced(Date.now());
    const hostLater = Math.floor((Date.now() + REMOTE_AGENT_REMOVAL_FENCE_TTL_MS + 60_000) / 1000);
    await expect(storeReading(local, hostLater).store.update(withStage)).resolves.toMatchObject({
      stages: [{ id: "stage-1" }],
    });
    // Ancient by this controller's clock, but fresh on the host: new work is refused.
    const hostStamped = fenced(NOW);
    await expect(
      storeReading(hostStamped, Math.floor(NOW / 1000) + 5).store.update(withStage),
    ).rejects.toThrow(RemoteAgentRemovalInProgressError);
  });

  it("treats a future-dated fence as active, up to one TTL ahead", () => {
    expect(activeRemoteAgentRemovalFence(fenced(NOW + 5 * 60_000), NOW)).not.toBeNull();
    expect(
      activeRemoteAgentRemovalFence(fenced(NOW + REMOTE_AGENT_REMOVAL_FENCE_TTL_MS + 1), NOW),
    ).toBeNull();
  });
});

describe("parseRemoteAgentBackendRuntimeProbe", () => {
  it("requires the completion marker", () => {
    expect(() => parseRemoteAgentBackendRuntimeProbe("service:x\n")).toThrow("Incomplete");
    expect(parseRemoteAgentBackendRuntimeProbe("probe:done\n")).toEqual([]);
  });
});
