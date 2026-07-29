import { ApprovalRequestId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  REQUEST_LEDGER_LIMIT,
  rehydrateRequestLedger,
  trimRequestLedger,
  type ClaudeRequestLedger,
} from "./Adapter.requestLedger.ts";

describe("Claude request ledger", () => {
  it("keeps the bounded ledger and removes malformed keys during rehydration", () => {
    const ledger: ClaudeRequestLedger = new Map();
    for (let index = 0; index < REQUEST_LEDGER_LIMIT + 1; index += 1) {
      const requestId = ApprovalRequestId.makeUnsafe(`request-${index}`);
      ledger.set(requestId, {
        kind: "approval",
        state: "resolved",
        requestId,
        createdAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: "2026-01-01T00:00:01.000Z",
        requestType: "dynamic_tool_call",
        decision: "accept",
        suggestions: [],
        sessionPermissionApplied: false,
      });
    }
    trimRequestLedger(ledger);
    assert.equal(ledger.size, REQUEST_LEDGER_LIMIT);

    const malformedId = ApprovalRequestId.makeUnsafe("malformed-key");
    const validId = ApprovalRequestId.makeUnsafe("valid-key");
    ledger.set(validId, {
      kind: "approval",
      state: "resolved",
      requestId: malformedId,
      createdAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T00:00:01.000Z",
      requestType: "dynamic_tool_call",
      decision: "decline",
      suggestions: [],
      sessionPermissionApplied: false,
    });
    rehydrateRequestLedger(ledger);
    assert.equal(ledger.has(validId), false);
  });
});
