import type { OrchestrationSession, OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadSession } from "../../models/types";
import {
  MAX_THREAD_PROVIDER_AGENTS,
  capProviderAgents,
  demoteProviderAgentsForSession,
  removeProviderAgent,
  upsertProviderAgent,
} from "./events.store.providerAgents";

const agent = { activityFresh: true } as OrchestrationTask;
const previous = { sessionEpoch: 1 } as ThreadSession;

function incoming(status: OrchestrationSession["status"], sessionEpoch = 1) {
  return { status, sessionEpoch } as OrchestrationSession;
}

describe("demoteProviderAgentsForSession", () => {
  it("demotes fresh evidence on transport loss and session replacement", () => {
    expect(demoteProviderAgentsForSession([agent], previous, incoming("error"))?.[0]).toMatchObject(
      {
        activityFresh: false,
      },
    );
    expect(
      demoteProviderAgentsForSession([agent], previous, incoming("running", 2))?.[0],
    ).toMatchObject({ activityFresh: false });
  });

  it("preserves detached child freshness across a ready transition in the same session", () => {
    expect(demoteProviderAgentsForSession([agent], previous, incoming("ready"))?.[0]).toMatchObject(
      {
        activityFresh: true,
      },
    );
  });
});

const task = (index: number, status: OrchestrationTask["status"]) =>
  ({
    id: `agent-${index}`,
    kind: "providerSubagent",
    status,
    createdAt: new Date(Date.UTC(2026, 9, 16, 8, 0, index)).toISOString(),
  }) as OrchestrationTask;

describe("provider agent bounds", () => {
  it("replaces an existing agent in place of a duplicate and removes by ID", () => {
    const first = upsertProviderAgent(undefined, task(1, "inProgress"));
    const updated = upsertProviderAgent(first, { ...task(1, "completed") });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.status).toBe("completed");
    expect(removeProviderAgent(updated, "agent-1")).toEqual([]);
  });

  it("keeps every active agent and drops the oldest terminal ones above the cap", () => {
    const terminal = Array.from({ length: MAX_THREAD_PROVIDER_AGENTS }, (_, index) =>
      task(index, "completed"),
    );
    const active = [task(500, "inProgress"), task(501, "pending")];
    const capped = capProviderAgents([...terminal, ...active]);
    expect(capped).toHaveLength(MAX_THREAD_PROVIDER_AGENTS);
    expect(capped.map((agent) => agent.id)).not.toContain("agent-0");
    expect(capped.map((agent) => agent.id)).not.toContain("agent-1");
    expect(capped.slice(-2).map((agent) => agent.id)).toEqual(["agent-500", "agent-501"]);
  });

  it("caps live upserts at the thread bound", () => {
    let agents: OrchestrationTask[] | undefined;
    for (let index = 0; index < MAX_THREAD_PROVIDER_AGENTS + 20; index += 1) {
      agents = upsertProviderAgent(agents, task(index, "completed"));
    }
    expect(agents).toHaveLength(MAX_THREAD_PROVIDER_AGENTS);
    expect(agents?.[0]?.id).toBe("agent-20");
  });
});
