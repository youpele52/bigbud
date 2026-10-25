import type { SessionInfo } from "@opencode/client";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { V2RuntimeHttpFixture } from "./Runtime.fixture.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

type TaskEvent = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;
export const taskEvents = (events: ProviderRuntimeEvent[]) =>
  events.filter((event): event is TaskEvent => event.type === "task.updated");

/** Accepted parent with a native subagent call, through the real client/admission fixture. */
export async function startRunning(
  runtime: OpencodeV2Runtime,
  http: V2RuntimeHttpFixture,
  directory: string,
  name: string,
  subagentCall = true,
) {
  const threadId = ThreadId.makeUnsafe(name);
  http.autoComplete = false;
  await runtime.start({ threadId, cwd: directory, modelSelection, runtimeMode: "full-access" });
  await runtime.send({
    threadId,
    modelSelection,
    requestMessageId: MessageId.makeUnsafe(`${name}-request`),
    input: "synthetic",
  });
  const session = runtime.get(threadId);
  http.messages.get(session.native.id)!.push({
    id: "msg_parent",
    type: "assistant",
    agent: "build",
    model: session.model,
    time: { created: 3 },
    content: subagentCall
      ? [
          {
            type: "tool",
            id: "tool_subagent",
            name: "subagent",
            time: { created: 3 },
            state: { status: "running", input: {}, metadata: {} },
          },
        ]
      : [],
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  return session;
}

/** Native session projection only; this does not authorize execution or assert native fidelity. */
export function addChild(
  http: V2RuntimeHttpFixture,
  session: V2RuntimeSession,
  patch: Partial<SessionInfo> = {},
) {
  const child: SessionInfo = {
    id: "ses_child",
    parentID: session.native.id,
    projectID: "synthetic",
    agent: "explore",
    title: "Index the docs folder",
    model: { providerID: "synthetic-provider", id: "synthetic-model", variant: "high" },
    cost: 0.002,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 5, write: 0 } },
    time: { created: 1_000, updated: 2_000 },
    location: session.native.location,
    ...patch,
  };
  http.sessions.set(child.id, child);
  return child;
}
