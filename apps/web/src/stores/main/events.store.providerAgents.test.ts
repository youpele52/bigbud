import type { OrchestrationSession, OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadSession } from "../../models/types";
import { demoteProviderAgentsForSession } from "./events.store.providerAgents";

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
