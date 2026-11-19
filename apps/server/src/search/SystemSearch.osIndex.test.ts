import { describe, expect, it, vi } from "vitest";

import { REMOTE_AGENT_OS_INDEX_SCOPE } from "../remote-agent/remoteAgentProtocol.search.ts";
import { resolveOsIndexScope, runOsIndexSearch, type OsIndexGate } from "./SystemSearch.osIndex.ts";
import { isThisComputerSearchAllowedByPolicy } from "./SystemSearch.policy.ts";
import { collectUpdates, fakeOsIndexAgent } from "./SystemSearch.test.helpers.ts";

const HOME = "/Users/me";
const GATE: OsIndexGate = {
  desktopEmbedded: true,
  allowedByPolicy: true,
  thisComputer: true,
  fileAccessLevel: "common-folders",
};

function hit(path: string) {
  return {
    path,
    isDirectory: false,
    contentType: "com.adobe.pdf",
    sizeBytes: 10,
    modifiedUnixMs: 1_700_000_000_000,
    lastUsedUnixMs: 0,
    score: 1,
  };
}

describe("resolveOsIndexScope", () => {
  it("maps the server's File Access level to the agent scope, and none turns T5 off", () => {
    expect(resolveOsIndexScope(GATE)).toEqual({ level: REMOTE_AGENT_OS_INDEX_SCOPE.commonFolders });
    expect(resolveOsIndexScope({ ...GATE, fileAccessLevel: "unrestricted" })).toEqual({
      level: REMOTE_AGENT_OS_INDEX_SCOPE.unrestricted,
    });
    expect(resolveOsIndexScope({ ...GATE, fileAccessLevel: "none" })).toEqual({
      reason: "file-access-none",
    });
    expect(resolveOsIndexScope({ ...GATE, thisComputer: false })).toEqual({ reason: "disabled" });
    expect(resolveOsIndexScope({ ...GATE, allowedByPolicy: false })).toEqual({ reason: "policy" });
    // The remote-backend profile has no "this computer" tier at all.
    expect(resolveOsIndexScope({ ...GATE, desktopEmbedded: false })).toBeNull();
  });

  it("reads the managed-device policy variable", () => {
    expect(isThisComputerSearchAllowedByPolicy({})).toBe(true);
    expect(isThisComputerSearchAllowedByPolicy({ BIGBUD_SEARCH_THIS_COMPUTER: "0" })).toBe(false);
    expect(isThisComputerSearchAllowedByPolicy({ BIGBUD_SEARCH_THIS_COMPUTER: "1" })).toBe(true);
  });
});

describe("runOsIndexSearch", () => {
  const run = (agent: ReturnType<typeof fakeOsIndexAgent>, gate = GATE, signal?: AbortSignal) => {
    const controller = new AbortController();
    const { updates, emitter } = collectUpdates("q1", signal ?? controller.signal);
    const running = runOsIndexSearch({
      gate,
      localConnection: async () => agent.connection,
      home: HOME,
      query: "invoice",
      emitter,
      signal: signal ?? controller.signal,
    });
    return { updates, running };
  };

  it("queries the scope the server chose and shows ~-relative folders", async () => {
    const agent = fakeOsIndexAgent({
      hits: [hit("/Users/me/Documents/invoice.pdf"), hit("/Users/me/.ssh/id_invoice")],
    });
    const { updates, running } = run(agent, { ...GATE, fileAccessLevel: "unrestricted" });
    await running;
    expect(agent.requests).toMatchObject([
      { scopeLevel: REMOTE_AGENT_OS_INDEX_SCOPE.unrestricted, maxResults: 50, query: "invoice" },
    ]);
    const rows = updates.flatMap((update) => update.items);
    // The server re-checks exclusions even if an agent ever returned an excluded path.
    expect(rows).toEqual([
      expect.objectContaining({
        id: "thisComputer:name:local:/Users/me/Documents/invoice.pdf",
        root: "/Users/me/Documents",
        path: "invoice.pdf",
        label: "~/Documents",
        executionTargetId: "local",
      }),
    ]);
    expect(updates.at(-1)).toMatchObject({ tier: "thisComputer", state: "done" });
  });

  it("never asks the agent when the server settings turn T5 off", async () => {
    const agent = fakeOsIndexAgent();
    const { updates, running } = run(agent, { ...GATE, fileAccessLevel: "none" });
    await running;
    expect(agent.requests).toHaveLength(0);
    expect(updates).toEqual([
      expect.objectContaining({ state: "unavailable", reason: "file-access-none" }),
    ]);
    const absent = run(agent, { ...GATE, desktopEmbedded: false });
    await absent.running;
    expect(absent.updates).toEqual([]);
  });

  it("falls back to an unsupported notice for agents without the capability", async () => {
    const agent = fakeOsIndexAgent({ capable: false });
    const { updates, running } = run(agent);
    await running;
    expect(agent.requests).toHaveLength(0);
    expect(updates.at(-1)).toMatchObject({ state: "unavailable", reason: "unsupported" });
    const offIndex = fakeOsIndexAgent({ errorCode: "UNAVAILABLE" });
    const second = run(offIndex);
    await second.running;
    expect(second.updates.at(-1)).toMatchObject({ reason: "index-unavailable" });
  });

  it("cancels the Spotlight query when superseded", async () => {
    const agent = fakeOsIndexAgent({ hold: true, hits: [hit("/Users/me/Documents/a.pdf")] });
    const controller = new AbortController();
    const { updates, running } = run(agent, GATE, controller.signal);
    await vi.waitFor(() => expect(agent.requests).toHaveLength(1));
    const before = updates.length;
    controller.abort();
    await running;
    expect(agent.cancels).toEqual([agent.requests[0]!.operationId]);
    expect(updates).toHaveLength(before);
  });
});
