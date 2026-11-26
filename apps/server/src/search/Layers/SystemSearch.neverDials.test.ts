import { describe, expect, it, vi } from "vitest";

/** Every pool member search touched; any member except `liveConnection` would dial. */
const touched = vi.hoisted(() => ({ pool: [] as string[], ssh: 0 }));

vi.mock("../../remote-agent/remoteAgentDefault.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../remote-agent/remoteAgentDefault.ts")>();
  const pool = new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.pool.push(String(property));
        if (property === "liveConnection") return () => null;
        return () => {
          throw new Error(`search must not call pool.${String(property)}`);
        };
      },
    },
  );
  return { ...actual, getConfiguredRemoteAgentComposition: () => ({ pool }) };
});

import { runLiveSearch, type SeedProject } from "./SystemSearch.layer.test.helpers.ts";

const AGENT_REMOTE = "ssh:host=box&transport=agent";
const SSH_ONLY = "ssh:host=old&transport=direct-ssh";
const PROJECTS: ReadonlyArray<SeedProject> = [
  ["remote-current", "/srv/current", AGENT_REMOTE],
  ["remote-other", "/srv/other", AGENT_REMOTE],
  ["ssh-only", "/srv/ssh", SSH_ONLY],
  ["local-other", "/work/other", "local"],
];

describe("search never connects to a remote just to search", () => {
  it.each([
    ["Mod+F", { mode: "all" as const, query: "match" }],
    ["Mod+P", { mode: "fileNames" as const, query: "match" }],
  ])(
    "%s reports unconnected remotes as not-connected (the palette hides it) and dials nothing",
    async (_, input) => {
      touched.pool.length = 0;
      touched.ssh = 0;
      const { updates, local } = await runLiveSearch(PROJECTS, {
        ...input,
        currentProjectId: "remote-current" as never,
        tiers: ["currentProject", "otherProjectFiles", "remoteOutsideProjects"],
      });
      const remote = updates.filter((u) => u.sourceId === AGENT_REMOTE);
      expect(remote.map((u) => [u.tier, u.state, u.reason])).toEqual([
        ["currentProject", "unavailable", "not-connected"],
        ["otherProjectFiles", "unavailable", "not-connected"],
      ]);
      expect(updates.filter((u) => u.sourceId === SSH_ONLY)).toEqual([
        expect.objectContaining({ state: "unavailable", reason: "use-managed-agent" }),
      ]);
      expect(remote.flatMap((u) => u.items)).toEqual([]);
      // Only the non-dialing lookup was used, ssh was never spawned, and local search still ran.
      expect(new Set(touched.pool)).toEqual(new Set(["liveConnection"]));
      expect(touched.ssh).toBe(0);
      expect(local.requests.map((request) => request.roots.map((root) => root.root))).toEqual([
        ["/work/other"],
      ]);
    },
  );
});
