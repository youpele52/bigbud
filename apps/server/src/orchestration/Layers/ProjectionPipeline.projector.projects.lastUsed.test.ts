import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { assert, it } from "@effect/vitest";

import {
  advancesProjectLastUsedAt,
  advancesThreadActivityAt,
} from "./ProjectionPipeline.projector.projects.lastUsed.ts";

function event(type: OrchestrationEvent["type"]): OrchestrationEvent {
  return { type } as OrchestrationEvent;
}

it("advances project recency for active thread workflows", () => {
  assert.equal(advancesProjectLastUsedAt(event("thread.created")), true);
  assert.equal(advancesProjectLastUsedAt(event("thread.session-set")), true);
  assert.equal(advancesProjectLastUsedAt(event("thread.activity-appended")), true);
  assert.equal(advancesThreadActivityAt(event("thread.task-upserted")), true);
});

it("does not advance project recency for deletion lifecycle events", () => {
  assert.equal(advancesProjectLastUsedAt(event("thread.deletion-requested")), false);
  assert.equal(advancesProjectLastUsedAt(event("thread.deletion-failed")), false);
  assert.equal(advancesProjectLastUsedAt(event("thread.deleted")), false);
  assert.equal(advancesProjectLastUsedAt(event("project.deleted")), false);
});
