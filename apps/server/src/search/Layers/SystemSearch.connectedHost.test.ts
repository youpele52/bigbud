import { describe, expect, it, vi } from "vitest";

/** The real pool search reads, opened beforehand by another service; `ssh` counts spawns. */
const state = vi.hoisted(() => ({ pool: null as unknown, ssh: 0 }));

vi.mock("../../remote-agent/remoteAgentDefault.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../remote-agent/remoteAgentDefault.ts")>();
  return { ...actual, getConfiguredRemoteAgentComposition: () => ({ pool: state.pool }) };
});

import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "../../remote-agent/remoteAgentConnectionPool.ts";
import { REMOTE_AGENT_SEARCH_STREAM_CAPABILITY } from "../../remote-agent/remoteAgentProtocol.search.ts";
import type { SearchAgentConnection } from "../SystemSearch.agentRequest.ts";
import { fakeLegacySearchAgent, fakeSearchAgent } from "../SystemSearch.test.helpers.ts";
import { runLiveSearch } from "./SystemSearch.layer.test.helpers.ts";

const CAPABLE = "ssh:host=box&transport=agent";
const OLD = "ssh:host=46.225.127.53&user=root&transport=agent";
const IDLE = "ssh:host=100.78.19.8&user=youpele&transport=agent";

function runtime(generation: string) {
  const hash = "d".repeat(64);
  return {
    generation,
    version: "0.1.0",
    sha256: hash,
    buildDigest: "development",
    targetTriple: "x86_64-unknown-linux-gnu" as const,
    origin: "managed" as const,
    binaryPath: `/root/bin/0.1.0/${hash}/bigbud-remote-agent`,
    statePath: `/root/runtimes/${generation}`,
    socketPath: `/root/runtimes/${generation}/supervisor.sock`,
    logPath: `/root/runtimes/${generation}/supervisor.log`,
  };
}

/** Gives a search fake the handshake a pool entry needs; `capabilities` mirror its own. */
function pooled(connection: SearchAgentConnection, capabilities: ReadonlyArray<string>) {
  return {
    ...connection,
    handshake: async () => ({
      protocolMajor: 1,
      protocolMinor: 0,
      agentVersion: "0.1.0",
      buildDigest: "development",
      os: "linux",
      architecture: "x86_64",
      agentInstanceId: "agent-1",
      agentEpoch: "epoch-1",
      capabilities: capabilities.map((name) => ({ name, major: 1, minor: 0 })),
      maxFrameBytes: 1024,
      maxOperationOutputBytes: 1024,
      maxJournalBytes: 1024,
    }),
    close: () => undefined,
  } as unknown as RemoteAgentConnection;
}

describe("search uses a remote connection another service already opened", () => {
  it.each([
    ["Mod+F", { mode: "all" as const, query: "match" }],
    ["Mod+P", { mode: "fileNames" as const, query: "match" }],
  ])(
    "%s searches terminal-connected hosts, old agents by legacy names, without dialing",
    async (_, input) => {
      const capable = fakeSearchAgent();
      const old = fakeLegacySearchAgent("youpele_aie.md");
      const agents: Record<string, RemoteAgentConnection> = {
        [CAPABLE]: pooled(capable.connection, [
          "terminal.pty",
          REMOTE_AGENT_SEARCH_STREAM_CAPABILITY,
        ]),
        [OLD]: pooled(old.connection, ["terminal.pty", "workspace.files", "workspace.search"]),
      };
      const dials: string[] = [];
      const pool = new RemoteAgentConnectionPool({
        create: async (target) => {
          dials.push(target);
          const agent = agents[target];
          if (!agent) throw new Error(`no agent on ${target}`);
          return agent;
        },
      });
      // Durable terminals connect through getBound with each owner's pinned runtime.
      for (const target of [CAPABLE, OLD]) {
        await pool.getBound(
          target,
          { runtime: runtime(`gen-${target}`), expectedEpoch: "epoch-1" },
          ["terminal.pty"],
        );
      }
      state.pool = pool;
      state.ssh = 0;
      const acquire = (["get", "getBound", "getWorkspaceClient", "getProcessClient"] as const).map(
        (method) => vi.spyOn(pool, method),
      );

      const { updates } = await runLiveSearch(
        [
          ["capable", "/srv/capable", CAPABLE],
          ["old", "/srv/old", OLD],
          ["idle", "/srv/idle", IDLE],
        ],
        { ...input, tiers: ["otherProjectFiles"] },
      );

      const of = (target: string) => updates.filter((update) => update.sourceId === target);
      expect(of(CAPABLE).flatMap((u) => u.items.map((item) => item.path))).toContain(
        "src/match.ts",
      );
      expect(of(CAPABLE).at(-1)).toMatchObject({ state: "done" });
      expect(capable.requests.map((request) => request.roots.map((root) => root.root))).toEqual([
        ["/srv/capable"],
      ]);
      // The old agent is connected: legacy names, never "not connected".
      expect(of(OLD).flatMap((u) => u.items.map((item) => item.path))).toEqual(["youpele_aie.md"]);
      expect(of(OLD).at(-1)).toMatchObject({ state: "partial", reason: "agent-update-available" });
      expect(old.folders).toEqual(["/srv/old"]);
      for (const target of [CAPABLE, OLD]) {
        expect(of(target).some((u) => u.reason === "not-connected")).toBe(false);
      }
      // A host nobody connected stays unconnected; the palette hides that notice.
      expect(of(IDLE)).toEqual([expect.objectContaining({ reason: "not-connected" })]);
      // Nothing was dialed, acquired or spawned for the search itself.
      expect(dials).toEqual([CAPABLE, OLD]);
      for (const spy of acquire) expect(spy).not.toHaveBeenCalled();
      expect(state.ssh).toBe(0);
    },
  );
});
