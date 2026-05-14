import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";

import {
  approvalDecisionToPermissionResult,
  getCopilotSessionApprovalMetadata,
  requestDetailFromPermissionRequest,
  requestTypeFromPermissionRequest,
} from "./Adapter.types.ts";

describe("CopilotAdapter.types", () => {
  it("maps acceptForSession shell approvals to approve-for-session command rules", () => {
    const request = {
      kind: "shell",
      canOfferSessionApproval: true,
      commands: [{ identifier: "git" }, { identifier: "rg" }],
      fullCommandText: "git status && rg TODO",
    } as PermissionRequest;

    expect(approvalDecisionToPermissionResult("acceptForSession", request)).toEqual({
      kind: "approve-for-session",
      approval: {
        kind: "commands",
        commandIdentifiers: ["git", "rg"],
      },
    });
  });

  it("falls back to approve-once when session-scoped approval is unsupported", () => {
    const request = {
      kind: "url",
      url: "https://example.com",
    } as PermissionRequest;

    expect(approvalDecisionToPermissionResult("acceptForSession", request)).toEqual({
      kind: "approve-once",
    });
  });

  it("reports when session-scoped shell approval is unavailable", () => {
    const request = {
      kind: "shell",
      canOfferSessionApproval: false,
      commands: [{ identifier: "grep" }],
      fullCommandText: "grep foo file.ts",
    } as PermissionRequest;

    expect(getCopilotSessionApprovalMetadata(request)).toEqual({
      available: false,
    });
  });

  it("classifies memory and hook permission requests as dynamic tool calls", () => {
    expect(requestTypeFromPermissionRequest({ kind: "memory" } as PermissionRequest)).toBe(
      "dynamic_tool_call",
    );
    expect(requestTypeFromPermissionRequest({ kind: "hook" } as PermissionRequest)).toBe(
      "dynamic_tool_call",
    );
  });

  it("extracts details for memory and hook permission requests", () => {
    expect(
      requestDetailFromPermissionRequest({
        kind: "memory",
        subject: "user preferences",
        fact: "prefers dark mode",
      } as PermissionRequest),
    ).toBe("user preferences");

    expect(
      requestDetailFromPermissionRequest({
        kind: "hook",
        hookMessage: "Run formatter before applying patch",
        toolName: "format-hook",
      } as PermissionRequest),
    ).toBe("Run formatter before applying patch");
  });
});
