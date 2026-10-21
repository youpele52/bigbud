import type { ServerStalledPayload } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { describe, expect, it } from "vitest";

import {
  buildServerStallExplanationToast,
  STALL_DROP_LEAD_MS,
  stallExplainsDrop,
} from "./WebSocketConnectionSurface.stall";
import { buildRecoveredToast, describeServerStall } from "./WebSocketConnectionSurface.toasts";

const FREEZE_START = Date.parse("2026-10-21T15:00:00.000Z");

function stall(durationMs: number, overrides: Partial<ServerStalledPayload> = {}) {
  return {
    startedAt: new Date(FREEZE_START).toISOString(),
    endedAt: new Date(FREEZE_START + durationMs).toISOString(),
    durationMs,
    spans: [],
    inFlightRpcMethods: [],
    ...overrides,
  } satisfies ServerStalledPayload;
}

function at(offsetMs: number) {
  return new Date(FREEZE_START + offsetMs).toISOString();
}

describe("stall explanation after the fact", () => {
  it("explains a drop detected during a freeze and recovered after it ended", () => {
    // 75 s freeze; the heartbeat noticed it 20 s in; reconnect after it ended.
    expect(
      stallExplainsDrop(stall(75_000), { disconnectedAt: at(20_000), reconnectedAt: at(76_000) }),
    ).toBe(true);
    // Still disconnected when the report arrives: it will explain the coming recovery.
    expect(
      stallExplainsDrop(stall(75_000), { disconnectedAt: at(20_000), reconnectedAt: null }),
    ).toBe(true);
  });

  it("does not blame a stall that ended well before the drop or began after recovery", () => {
    expect(
      stallExplainsDrop(stall(2_000), {
        disconnectedAt: at(2_000 + STALL_DROP_LEAD_MS + 1),
        reconnectedAt: at(2_000 + STALL_DROP_LEAD_MS + 5_000),
      }),
    ).toBe(false);
    expect(
      stallExplainsDrop(stall(5_000), { disconnectedAt: at(-60_000), reconnectedAt: at(-1) }),
    ).toBe(false);
    expect(
      stallExplainsDrop(stall(5_000, { startedAt: "not a date" }), {
        disconnectedAt: at(0),
        reconnectedAt: null,
      }),
    ).toBe(false);
  });

  it("says the server was busy, names the culprit, and keeps recovery green", () => {
    const payload = stall(75_400, {
      spans: [{ name: "ssh.unlock", startedAt: at(0), endedAt: null }],
    });
    expect(describeServerStall(payload)).toBe(
      "bigbud server was busy for 75s while running ssh.unlock, so this was not a network problem.",
    );
    expect(describeServerStall(stall(2_000, { inFlightRpcMethods: ["server.ping"] }))).toContain(
      "while running server.ping",
    );
    const recovered = buildRecoveredToast(at(20_000), at(76_000), payload);
    expect(recovered.type).toBe("success");
    expect(recovered.description).toMatch(/^bigbud server was busy for 75s/);
    expect(buildRecoveredToast(at(20_000), at(76_000)).description).not.toMatch(/busy/);
    expect(buildServerStallExplanationToast(payload).type).toBe("info");
  });
});
