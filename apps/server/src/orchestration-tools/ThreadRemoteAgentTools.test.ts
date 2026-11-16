import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentControlRequest } from "../remote-agent/remoteAgentLocalControl.protocol.ts";
import { OPENCODE_ORCHESTRATION_MCP_TOOL_TIMEOUT_MS } from "./orchestrationMcpBridge.ts";
import {
  makeThreadRemoteAgentTool,
  REMOTE_AGENT_TOOL_FOLLOW_MS,
  remoteAgentToolViaOrchestration,
  setThreadRemoteAgentToolHandler,
} from "./ThreadRemoteAgentTools.ts";

const operationId = "00000000-0000-4000-8000-000000000001";

describe("thread remote agent tools", () => {
  it("never grants consent and adds user guidance for unapproved hosts", async () => {
    const handle = vi.fn(async (_request: RemoteAgentControlRequest) => ({
      v: 1 as const,
      ok: true as const,
      result: { status: "consent-required", executionTargetId: "ssh:host=x&transport=agent" },
    }));
    const result = await Effect.runPromise(
      makeThreadRemoteAgentTool(handle)({
        tool: "remote_agent_install",
        arguments: { target: "x", replace: true, consent: true },
      }),
    );
    expect(handle).toHaveBeenCalledExactlyOnceWith({
      method: "install",
      target: "x",
      replace: true,
      consent: false,
    });
    expect(result).toMatchObject({ status: "consent-required", guidance: expect.any(String) });
  });

  it("follows an accepted install once and resumes by operation ID", async () => {
    const handle = vi.fn(async (request: RemoteAgentControlRequest) => ({
      v: 1 as const,
      ok: true as const,
      result:
        request.method === "install"
          ? { operationId, state: "running" }
          : { operationId, state: "completed", outcome: "active" },
    }));
    const tool = makeThreadRemoteAgentTool(handle);
    expect(
      await Effect.runPromise(tool({ tool: "remote_agent_install", arguments: { target: "x" } })),
    ).toMatchObject({ outcome: "active" });
    expect(handle.mock.calls.map(([request]) => request.method)).toEqual(["install", "operation"]);
    await Effect.runPromise(tool({ tool: "remote_agent_install", arguments: { operationId } }));
    expect(handle.mock.calls.at(-1)?.[0]).toMatchObject({ method: "operation", operationId });
    expect(
      await Effect.runPromise(tool({ tool: "remote_agent_status", arguments: {} })),
    ).toMatchObject({ ok: false });
  });

  it("is typed unavailable until a backend registers the handler", async () => {
    setThreadRemoteAgentToolHandler(null);
    expect(
      await Effect.runPromise(
        remoteAgentToolViaOrchestration({
          tool: "remote_agent_status",
          arguments: { target: "x" },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("follows an install within the shortest provider tool-call limit, then hands back the ID", async () => {
    // Initial request plus follow must leave headroom under the OpenCode bridges' 10 s abort.
    expect(REMOTE_AGENT_TOOL_FOLLOW_MS * 2).toBeLessThanOrEqual(
      OPENCODE_ORCHESTRATION_MCP_TOOL_TIMEOUT_MS,
    );
    const handle = vi.fn(async (request: RemoteAgentControlRequest) => ({
      v: 1 as const,
      ok: true as const,
      result:
        request.method === "install"
          ? { operationId, state: "running" }
          : { operationId, state: "running", outcome: null },
    }));
    const result = await Effect.runPromise(
      makeThreadRemoteAgentTool(handle)({
        tool: "remote_agent_install",
        arguments: { target: "x" },
      }),
    );
    expect(handle).toHaveBeenLastCalledWith({
      method: "operation",
      operationId,
      waitMs: REMOTE_AGENT_TOOL_FOLLOW_MS,
    });
    expect(result).toMatchObject({ operationId, state: "running" });
  });
});
