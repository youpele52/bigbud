import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import {
  removeRemoteAgentInstallation,
  resumeRemoteAgentRemoval,
  type RemoteAgentTerminalOwnerList,
} from "./remoteAgentInstall.remove.ts";
import type { RemoteAgentOwner } from "./remoteAgentOwners.ts";
import {
  bytes,
  installInput,
  installManagerFixture,
} from "./remoteAgentInstallManager.fixtures.ts";

const ROOT = "/home/u/.bigbud/agent";

function build(
  version: string,
  digest: string,
  binary: "present" | "absent" = "present",
): RemoteAgentRegistryBuild {
  const sha256 = digest.repeat(64);
  const statePath = `${ROOT}/runtimes/g-${digest}`;
  return {
    id: `${version}:${sha256}:x86_64-unknown-linux-musl`,
    runtime: {
      generation: `g-${digest}`,
      version,
      sha256,
      buildDigest: `build-${version}`,
      targetTriple: "x86_64-unknown-linux-musl",
      origin: "managed",
      binaryPath: `${ROOT}/bin/${version}/${sha256}/bigbud-remote-agent`,
      statePath,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    },
    health: "healthy",
    promotion: 1,
    binary,
    authenticated: true,
  };
}

interface Replies {
  backend?: string;
  supervisor?: "absent" | "uncertain";
  socket?: "socket" | "none";
  shutdown?: ReadonlyArray<string | Error>;
  removal?: string | Error;
  probe?: string;
  clock?: string;
}

function removalFixture(patch: Partial<RemoteAgentRegistry> = {}, replies: Replies = {}) {
  let state = parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      promotionSequence: 1,
      builds: [build("0.4.0", "a")],
      ...patch,
    }),
  );
  const fences: Array<string | undefined> = [];
  const shutdowns = [...(replies.shutdown ?? ["shutdown-accepted"])];
  const run = vi.fn(async (command: string, _options?: { readonly timeoutMs?: number }) => {
    if (command === "date +%s") return replies.clock ?? String(Math.floor(Date.now() / 1000));
    if (command.includes("probe:done")) return replies.backend ?? "probe:done\n";
    if (command.includes("printf absent; else printf uncertain"))
      return replies.supervisor ?? "absent";
    if (command.includes("then printf socket")) return replies.socket ?? "none";
    if (command.includes("--shutdown-supervisor")) {
      const reply = shutdowns.length > 1 ? shutdowns.shift()! : shutdowns[0]!;
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (command.includes("printf exited")) return "exited";
    if (command.includes('mv -- "$root"')) {
      if (replies.removal instanceof Error) throw replies.removal;
      return replies.removal ?? "removed";
    }
    if (command.includes("printf gone; else printf present")) return replies.probe ?? "present";
    throw new Error(`Unexpected command: ${command.slice(0, 40)}`);
  });
  const control: RemoteAgentControl = {
    root: ROOT,
    run,
    registry: {
      read: async () => state,
      update: async (transition) => {
        state = parseRemoteAgentRegistry(JSON.stringify(transition(state)));
        fences.push(state.removal?.id);
        return state;
      },
    },
  };
  const commands = () => run.mock.calls.map(([command]) => command);
  const ran = (needle: string) => commands().some((command) => command.includes(needle));
  return { control, run, ran, commands, fences, state: () => state };
}

const owners = (state: RemoteAgentOwner["state"]): RemoteAgentTerminalOwnerList => ({
  owners: [{ state, terminalCwd: "/srv/app" } as RemoteAgentOwner],
  truncated: false,
});

describe("removeRemoteAgentInstallation", () => {
  it("fences the registry, then closes this app's connections right before deleting", async () => {
    const f = removalFixture();
    const order: string[] = [];
    const release = vi.fn(() => order.push("release"));
    const result = await removeRemoteAgentInstallation({
      control: f.control,
      closeLocalConnections: () => order.push(`close:${f.commands().length}`),
      markRemoving: () => {
        order.push("removing");
        return release;
      },
    });
    expect(result).toEqual({ outcome: "removed" });
    const deletion = f.commands().findIndex((command) => command.includes('mv -- "$root"'));
    expect(order).toEqual(["removing", `close:${deletion}`, "release"]);
    const fence = f.fences[0]!;
    expect(fence).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.commands()[deletion]).toContain(`fence='${fence}'`);
    expect(f.run.mock.calls[deletion]?.[1]).toEqual({ timeoutMs: 10 * 60 * 1000 });
  });

  it("is blocked by live terminals, a truncated owner list, stages and pins without fencing", async () => {
    const pinned = build("0.4.0", "a");
    const f = removalFixture({
      stages: [{ id: "s1", buildId: pinned.id, phase: "reserved" }],
      pins: [{ owner: "thread-1", buildId: pinned.id }],
    });
    const closeLocalConnections = vi.fn();
    const result = await removeRemoteAgentInstallation({
      control: f.control,
      terminalOwners: async () => ({ ...owners("may-have-been-sent"), truncated: true }),
      closeLocalConnections,
    });
    expect(result.outcome === "blocked" && result.blockers.map((entry) => entry.kind)).toEqual([
      "stage",
      "process",
      "terminal",
      "terminal",
    ]);
    expect(f.fences).toEqual([]);
    expect(closeLocalConnections).not.toHaveBeenCalled();
    expect(f.ran('mv -- "$root"')).toBe(false);
  });

  it("is blocked by a remote backend runtime and when the probe fails", async () => {
    const services = removalFixture({}, { backend: "service:0123abcd\nprobe:done\n" });
    expect(await removeRemoteAgentInstallation({ control: services.control })).toEqual({
      outcome: "blocked",
      blockers: [{ kind: "backend-runtime", label: "Remote backend service 0123abcd" }],
    });
    const unreadable = removalFixture({}, { backend: "partial" });
    const result = await removeRemoteAgentInstallation({ control: unreadable.control });
    expect(result.outcome === "blocked" && result.blockers[0]?.kind).toBe("backend-runtime");
  });

  it("retries the stop once without this app's connections, then clears the fence on refusal", async () => {
    const f = removalFixture(
      {},
      { supervisor: "uncertain", socket: "socket", shutdown: [new Error("not idle")] },
    );
    const closeLocalConnections = vi.fn();
    const result = await removeRemoteAgentInstallation({
      control: f.control,
      closeLocalConnections,
    });
    expect(result).toEqual({
      outcome: "blocked",
      blockers: [
        {
          kind: "process",
          label: "Agent 0.4.0 is still running terminals, processes or file watchers",
        },
      ],
    });
    expect(closeLocalConnections).toHaveBeenCalledOnce();
    expect(
      f.commands().filter((command) => command.includes("--shutdown-supervisor")),
    ).toHaveLength(2);
    expect(f.state().removal).toBeUndefined();
    expect(f.ran('mv -- "$root"')).toBe(false);
    expect(f.commands().some((command) => /\bkill\b/.test(command))).toBe(false);
  });

  it("succeeds when only this app's connections kept the agent busy", async () => {
    const f = removalFixture(
      {},
      {
        supervisor: "uncertain",
        socket: "socket",
        shutdown: [new Error("watchers"), "shutdown-accepted"],
      },
    );
    const closeLocalConnections = vi.fn();
    await expect(
      removeRemoteAgentInstallation({ control: f.control, closeLocalConnections }),
    ).resolves.toEqual({ outcome: "removed" });
    expect(closeLocalConnections).toHaveBeenCalledTimes(2);
  });

  it("blocks on a live socket whose program is gone and stops runtimes of every binary state", async () => {
    const orphan = { ...build("0.3.3", "b", "absent") };
    const live = removalFixture(
      { builds: [orphan] },
      { supervisor: "uncertain", socket: "socket" },
    );
    const result = await removeRemoteAgentInstallation({ control: live.control });
    expect(result.outcome === "blocked" && result.blockers[0]?.label).toContain(
      "its program is gone",
    );
    expect(live.ran("--shutdown-supervisor")).toBe(false);
    expect(live.ran('mv -- "$root"')).toBe(false);
    const quiet = removalFixture({ builds: [orphan] }, { supervisor: "uncertain", socket: "none" });
    await expect(removeRemoteAgentInstallation({ control: quiet.control })).resolves.toEqual({
      outcome: "removed",
    });
  });

  it.each([
    ["busy:inbox", "stage"],
    ["busy:registry", "admission"],
    ["busy:socket", "process"],
  ])(
    "reports %s from the locked deletion as a blocker and clears the fence",
    async (reply, kind) => {
      const f = removalFixture({}, { removal: reply });
      const result = await removeRemoteAgentInstallation({ control: f.control });
      expect(result.outcome === "blocked" && result.blockers[0]?.kind).toBe(kind);
      expect(f.state().removal).toBeUndefined();
    },
  );

  it.each([
    ["refused:foreign-owner", "owned by another user"],
    ["refused:mount", "mounted file system"],
    ["refused:layout", "unexpected layout"],
    ["refused:fence", "interrupted by another bigbud"],
  ])("refuses %s and clears the fence", async (reply, message) => {
    const f = removalFixture({}, { removal: reply });
    await expect(removeRemoteAgentInstallation({ control: f.control })).rejects.toThrow(message);
    expect(f.state().removal).toBeUndefined();
  });

  it("treats a lost reply after the rename as removed, and otherwise fails with the fence cleared", async () => {
    const done = removalFixture({}, { removal: new Error("timed out"), probe: "gone" });
    await expect(removeRemoteAgentInstallation({ control: done.control })).resolves.toEqual({
      outcome: "removed",
    });
    const failed = removalFixture({}, { removal: new Error("timed out"), probe: "present" });
    await expect(removeRemoteAgentInstallation({ control: failed.control })).rejects.toThrow(
      "timed out",
    );
    expect(failed.state().removal).toBeUndefined();
  });
});

describe("removal clock and path guards", () => {
  it("stamps and renews the fence with the host's clock", async () => {
    const f = removalFixture({}, { clock: "1700000000" });
    await expect(removeRemoteAgentInstallation({ control: f.control })).resolves.toEqual({
      outcome: "removed",
    });
    // Placed, then renewed right before the deletion, both on the host's clock.
    expect(f.fences).toHaveLength(2);
    expect(f.state().removal?.startedAt).toBe(1_700_000_000_000);
  });

  it("never removes or resumes under a home path with whitespace", async () => {
    const f = removalFixture();
    const control = { ...f.control, root: "/home/a b/.bigbud/agent" };
    await expect(removeRemoteAgentInstallation({ control })).rejects.toThrow("spaces");
    await expect(resumeRemoteAgentRemoval(control)).resolves.toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe("resumeRemoteAgentRemoval", () => {
  it("deletes leftovers of an interrupted removal and reports whether it did", async () => {
    const run = vi.fn(
      async (command: string): Promise<string> =>
        command === "date +%s" ? "1800000000" : "removed",
    );
    const update = vi.fn(async (transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry) =>
      transition(emptyRemoteAgentRegistry()),
    );
    const control = { root: ROOT, run, registry: { update } } as unknown as RemoteAgentControl;
    await expect(resumeRemoteAgentRemoval(control)).resolves.toBe(true);
    expect(run.mock.calls[0]?.[0]).toContain('"$parent"/.agent-removing.*');
    run.mockResolvedValueOnce("none");
    await expect(resumeRemoteAgentRemoval(control)).resolves.toBe(false);
    expect(update).toHaveBeenCalled();
    run.mockResolvedValueOnce("refused:mount");
    await expect(resumeRemoteAgentRemoval(control)).rejects.toThrow("could not finish");
  });
});

describe("install after an interrupted removal", () => {
  it("finishes the removal, reopens the control root and uploads instead of adopting", async () => {
    const readArtifactBytes = vi.fn(async () => bytes);
    const resumeRemoval = vi.fn(async () => true);
    const { control } = installManagerFixture();
    const openControl = vi.fn(async () => control);
    const manager = installManagerFixture({
      probePlacedArtifact: async () => "inbox",
      readArtifactBytes,
      resumeRemoval,
      openControl,
    }).manager;
    const result = await manager.install(installInput);
    expect(resumeRemoval).toHaveBeenCalledOnce();
    expect(openControl).toHaveBeenCalledTimes(2);
    expect(readArtifactBytes).toHaveBeenCalledOnce();
    expect(result.placement).toBe("upload");
  });
});
