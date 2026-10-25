import { expect, it, vi } from "vitest";
import type { PiRpcProcess, PiRpcResponse } from "./RpcProcess.types.ts";
import { serializePiPromptRequests } from "./RpcProcess.promptDispatch.ts";

it("serializes queue-mutating requests, but does not delay abort/state requests", async () => {
  let finish!: (response: PiRpcResponse) => void;
  const first = new Promise<PiRpcResponse>((resolve) => {
    finish = resolve;
  });
  const request = vi.fn(async (command: { type: string }) => {
    if (command.type === "prompt") return first;
    return { type: "response", command: command.type, success: true };
  });
  const dispatch = serializePiPromptRequests(request as PiRpcProcess["request"]);
  const prompt = dispatch({ type: "prompt", message: "first" });
  const steer = dispatch({ type: "steer", message: "second" });
  await dispatch({ type: "get_state" });
  expect(request.mock.calls.map(([command]) => command.type)).not.toContain("steer");
  finish({ type: "response", command: "prompt", success: true });
  await Promise.all([prompt, steer]);
  expect(request.mock.calls.map(([command]) => command.type)).toEqual([
    "get_state",
    "prompt",
    "steer",
  ]);
});
