import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import { actionOutcome, refusedActionMessage } from "./ComputerUse.desktop.outcome.ts";
import { callDesktopTool, mutationSummary } from "./ComputerUse.desktop.results.ts";

const driverReturning = (structuredContent: unknown): CuaDriverShape =>
  ({
    callTool: () => Effect.succeed({ content: [{ type: "text", text: "ok" }], structuredContent }),
  }) as unknown as CuaDriverShape;

describe("actionOutcome", () => {
  it("keeps the 0.9.1 vocabulary unchanged", () => {
    expect(
      actionOutcome({
        verified: true,
        effect: "confirmed",
        path: "ax",
        escalation: { recommended: "px", reason: "ax_unavailable" },
      }),
    ).toEqual({
      verified: true,
      effect: "confirmed",
      path: "ax",
      escalation: { recommended: "px", reason: "ax_unavailable" },
    });
    expect(actionOutcome({ effect: "suspected_noop" })).toEqual({ effect: "suspected_noop" });
    expect(actionOutcome({ effect: "unverifiable" })).toEqual({ effect: "unverifiable" });
    expect(actionOutcome({})).toBeUndefined();
  });

  it("maps 0.38 partial to unverifiable and never derives path from route", () => {
    expect(actionOutcome({ effect: "partial", route: "accessibility" })).toEqual({
      effect: "unverifiable",
    });
  });

  it("maps 0.38 escalation targets and drops session", () => {
    const escalate = (target: string) =>
      actionOutcome({
        effect: "unverifiable",
        route: "global_input",
        escalation: { target, reason: "effect_unconfirmed" },
      })?.escalation;
    expect(escalate("pixel")).toEqual({ recommended: "px", reason: "effect_unconfirmed" });
    expect(escalate("foreground")).toEqual({
      recommended: "foreground",
      reason: "effect_unconfirmed",
    });
    expect(escalate("page")).toEqual({ recommended: "page", reason: "effect_unconfirmed" });
    expect(escalate("session")).toBeUndefined();
  });

  it("is a contract-compatible partial result for unverifiable summaries", () => {
    expect(mutationSummary("click", "Notes", actionOutcome({ effect: "partial" }))).toContain(
      "could not be verified",
    );
  });
});

describe("refused actions", () => {
  it("builds an error message from the 0.38 refusal", () => {
    expect(
      refusedActionMessage("click", {
        effect: "refused",
        route: "accessibility",
        error: { code: "target_not_found", hint: "Capture again." },
      }),
    ).toBe("Desktop tool 'click' was refused: target_not_found (Capture again.)");
    expect(refusedActionMessage("click", { effect: "refused", summary: "No window." })).toBe(
      "Desktop tool 'click' was refused: refused (No window.)",
    );
    expect(refusedActionMessage("click", { effect: "confirmed" })).toBeNull();
  });

  it("reads the refusal envelopes upstream emits", () => {
    // `{effect: "refused", code, hint | suggestion}` (tool.rs:5017-5021,6932).
    expect(
      refusedActionMessage("click", {
        effect: "refused",
        code: "window_target_not_found",
        suggestion: "Call get_window_state again.",
        candidates: [],
      }),
    ).toBe(
      "Desktop tool 'click' was refused: window_target_not_found (Call get_window_state again.)",
    );
    // `{status: "refused", refusal: {code, message}}` (tool.rs:6161-6169).
    expect(
      refusedActionMessage("type_text", {
        status: "refused",
        refusal: { code: "stale_element_token", message: "element_token is stale" },
      }),
    ).toBe("Desktop tool 'type_text' was refused: stale_element_token (element_token is stale)");
    expect(refusedActionMessage("click", { status: "ok", code: "noise" })).toBeNull();
    expect(refusedActionMessage("click", "refused")).toBeNull();
  });

  it("fails the tool call instead of reporting it as sent", async () => {
    // Regression (lean M4): a refused effect without isError used to map to "Sent ...".
    const exit = await Effect.runPromiseExit(
      callDesktopTool(
        driverReturning({ effect: "refused", route: "accessibility", error: { code: "blocked" } }),
        "type_text",
        { text: "x" },
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("Desktop tool 'type_text' was refused: blocked");
  });

  it("keeps 0.9.1 results as successful outcomes", async () => {
    const result = await Effect.runPromise(
      callDesktopTool(driverReturning({ verified: false, effect: "unverifiable" }), "click", {}),
    );
    expect(result.actionOutcome).toEqual({ verified: false, effect: "unverifiable" });
    expect(result.text).toBe("ok");
  });
});
