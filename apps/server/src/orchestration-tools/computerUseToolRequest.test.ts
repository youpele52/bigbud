import { ComputerUseAction, ThreadId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  decodeComputerUseToolRequest,
  dispatchComputerUseToolRequest,
  unroutedComputerUseV2Result,
} from "./computerUseToolRequest.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-22222222-2222-4222-8222-222222222222");
const decodeLegacy = Schema.decodeUnknownSync(ComputerUseAction);

describe("decodeComputerUseToolRequest", () => {
  it("is exactly the legacy decoder under the legacy profile", () => {
    const raw = { action: "focus_app", surface: "desktop", pid: 42 };
    expect(decodeComputerUseToolRequest(raw, "legacy")).toEqual({
      kind: "legacy",
      action: decodeLegacy(raw),
    });
    expect(() => decodeComputerUseToolRequest({ action: "nope" }, "legacy")).toThrow();
    // The default profile is legacy for any pinned Driver.
    expect(decodeComputerUseToolRequest(raw).kind).toBe("legacy");
  });

  it("keeps browser requests on the legacy schema under v2", () => {
    const raw = { action: "click", x: 1, y: 2 };
    expect(decodeComputerUseToolRequest(raw, "v2")).toEqual({
      kind: "legacy",
      action: decodeLegacy(raw),
    });
  });

  it("refuses ungrounded and raw-selector desktop requests under v2", () => {
    expect(
      decodeComputerUseToolRequest({ action: "click", surface: "desktop", x: 1, y: 2 }, "v2"),
    ).toEqual({ kind: "refused", action: "click", code: "version_required" });
    expect(
      decodeComputerUseToolRequest(
        { action: "focus_app", surface: "desktop", schemaVersion: 2, pid: 7 },
        "v2",
      ),
    ).toEqual({ kind: "refused", action: "focus_app", code: "selector_conflict" });
    expect(
      decodeComputerUseToolRequest({ action: "type", surface: "desktop", schemaVersion: 2 }, "v2"),
    ).toEqual({ kind: "refused", action: "type", code: "invalid_arguments" });
    // A model-supplied action name is bounded before it reaches a result.
    const long = decodeComputerUseToolRequest(
      { action: "x".repeat(500), surface: "desktop" },
      "v2",
    );
    expect(long.kind === "refused" && long.action.length).toBe(64);
  });

  it("decodes closed v2 desktop actions", () => {
    const request = decodeComputerUseToolRequest(
      { action: "click", surface: "desktop", schemaVersion: 2, observationRef: "o1", x: 3, y: 4 },
      "v2",
    );
    expect(request.kind).toBe("desktop_v2");
  });
});

describe("dispatchComputerUseToolRequest", () => {
  it("sends legacy requests to the unchanged legacy route", async () => {
    const computerUse = vi.fn(() =>
      Effect.succeed({ surface: "browser" as const, action: "capture", summary: "ok" }),
    );
    const action = decodeLegacy({ action: "capture" });
    const result = await Effect.runPromise(
      dispatchComputerUseToolRequest({ computerUse }, THREAD_ID, { kind: "legacy", action }),
    );
    expect(computerUse).toHaveBeenCalledWith({ threadId: THREAD_ID, action });
    expect(result.summary).toBe("ok");
  });

  it("fails closed when no v2 route is wired", async () => {
    const computerUse = vi.fn();
    const request = decodeComputerUseToolRequest(
      { action: "list_apps", surface: "desktop", schemaVersion: 2 },
      "v2",
    );
    const result = await Effect.runPromise(
      dispatchComputerUseToolRequest({ computerUse }, THREAD_ID, request),
    );
    expect(computerUse).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      schemaVersion: 2,
      action: "list_apps",
      executionStatus: "failed",
      completion: "not_started",
      refused: true,
      errorCode: "control_unavailable",
    });
  });

  it("uses one shared unrouted refusal that keeps a decode refusal's code", () => {
    const refused = decodeComputerUseToolRequest(
      { action: "click", surface: "desktop", x: 1, y: 2 },
      "v2",
    );
    if (refused.kind === "legacy") throw new Error("expected a v2 request");
    expect(unroutedComputerUseV2Result(refused)).toMatchObject({
      action: "click",
      refused: true,
      errorCode: "version_required",
    });
    const grounded = decodeComputerUseToolRequest(
      { action: "list_apps", surface: "desktop", schemaVersion: 2 },
      "v2",
    );
    if (grounded.kind === "legacy") throw new Error("expected a v2 request");
    expect(unroutedComputerUseV2Result(grounded).errorCode).toBe("control_unavailable");
  });
});
