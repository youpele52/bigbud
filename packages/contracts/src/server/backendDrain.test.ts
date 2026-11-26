import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  BackendDrainConsentSnapshot,
  BackendDrainDecisionResult,
  DecideBackendDrainInput,
} from "./backendDrain";

const decode = Schema.decodeUnknownSync;

describe("backend drain consent contracts", () => {
  it("round-trips a bounded snapshot and decision", () => {
    const snapshot = decode(BackendDrainConsentSnapshot)({
      drainId: "drain-1",
      deadlineAt: 1,
      panes: [
        {
          paneId: "thread:terminal",
          threadId: "thread",
          terminalId: "terminal",
          threadTitle: "Thread",
          paneTitle: "Pane",
          surface: "direct-ssh",
          keepMode: true,
        },
      ],
    });
    expect(snapshot.panes).toHaveLength(1);
    expect(decode(DecideBackendDrainInput)({ drainId: "drain-1", decision: "drain-now" })).toEqual({
      drainId: "drain-1",
      decision: "drain-now",
    });
    expect(decode(BackendDrainDecisionResult)({ status: "already-decided" })).toEqual({
      status: "already-decided",
    });
  });

  it("rejects more than 64 panes, empty identities and unknown decisions", () => {
    const pane = {
      paneId: "thread:terminal",
      threadId: "thread",
      terminalId: "terminal",
      threadTitle: "Thread",
      paneTitle: "Pane",
      surface: "local",
      keepMode: false,
    };
    expect(() =>
      decode(BackendDrainConsentSnapshot)({
        drainId: "drain-1",
        deadlineAt: 1,
        panes: Array.from({ length: 65 }, () => pane),
      }),
    ).toThrow();
    expect(() => decode(DecideBackendDrainInput)({ drainId: "", decision: "cancel" })).toThrow();
    expect(() =>
      decode(DecideBackendDrainInput)({ drainId: "drain-1", decision: "quit" }),
    ).toThrow();
  });
});
