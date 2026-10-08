import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A live input stream: finishing one turn does not exhaust the query. */
export function makeLiveSmokePrompts() {
  const messages: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      if (closed) return;
      if (messages.length === 0)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      if (closed) return;
      const message = messages.shift();
      if (message) yield message;
    }
  };
  return {
    prompt: prompt(),
    send(content: string) {
      messages.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        uuid: randomUUID(),
      });
      wake?.();
      wake = undefined;
    },
    close() {
      closed = true;
      wake?.();
      wake = undefined;
    },
  };
}

/** Isolate workspace state, while retaining ambient authentication without copying secrets. */
export async function makeLiveSmokeWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), "bigbud-claude-live-"));
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

export function liveSmokeOptions(cwd: string): Options {
  return {
    cwd,
    ...(process.env.BIGBUD_CLAUDE_SDK_SMOKE_BINARY === "bundled"
      ? {}
      : {
          pathToClaudeCodeExecutable: process.env.BIGBUD_CLAUDE_SDK_SMOKE_BINARY ?? "claude",
        }),
    settingSources: [],
    settings: { disableAllHooks: true },
    permissionMode: "default",
    tools: [],
    allowedTools: [],
    mcpServers: {},
    maxTurns: 1,
    maxBudgetUsd: 0.15,
    includePartialMessages: true,
    systemPrompt:
      "Validate this harmless conversation. Answer briefly. Never use tools or modify files.",
    canUseTool: async () => ({
      behavior: "deny",
      message: "Tools are disabled for this validation.",
    }),
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "512",
    },
  };
}

/** Select an advertised low-cost model; never silently fall back to a pricier model. */
export async function makeLiveSmokeQuery(cwd: string, options: Partial<Options> = {}) {
  const prompts = makeLiveSmokePrompts();
  const runtime = query({
    prompt: prompts.prompt,
    options: { ...liveSmokeOptions(cwd), ...options },
  });
  const deadline = setTimeout(() => {
    runtime.close();
    prompts.close();
  }, 50_000);
  try {
    const initialization = await runtime.initializationResult();
    const model = initialization.models.find((row) =>
      /haiku/i.test(`${row.value} ${row.displayName}`),
    );
    if (!model)
      throw new Error("Live smoke requires an advertised Haiku model; no fallback was used.");
    await runtime.setModel(model.value);
    return {
      prompts,
      runtime,
      model: model.value,
      iterator: runtime[Symbol.asyncIterator](),
      close() {
        clearTimeout(deadline);
        runtime.close();
        prompts.close();
      },
    };
  } catch (cause) {
    clearTimeout(deadline);
    runtime.close();
    prompts.close();
    throw cause;
  }
}

/** Consume exactly one result without closing the SDK's single-use generator. */
export async function readLiveSmokeTurn(
  iterator: AsyncIterator<SDKMessage>,
  onMessage?: (message: SDKMessage) => Promise<void>,
): Promise<{ messages: SDKMessage[]; result: SDKResultMessage }> {
  const messages: SDKMessage[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error("Live SDK query ended before its turn result.");
    messages.push(next.value);
    await onMessage?.(next.value);
    if (next.value.type === "result") return { messages, result: next.value };
  }
}

export function liveSmokeTextDeltas(messages: ReadonlyArray<SDKMessage>): string {
  return messages
    .flatMap((message) =>
      message.type === "stream_event" &&
      message.event.type === "content_block_delta" &&
      message.event.delta.type === "text_delta"
        ? [message.event.delta.text]
        : [],
    )
    .join("");
}

/** Optional sanitized evidence, never native IDs, authentication or user content. */
export async function writeLiveSmokeReport(name: string, report: Record<string, unknown>) {
  const directory = process.env.BIGBUD_CLAUDE_SDK_SMOKE_REPORT_DIR;
  if (directory)
    await writeFile(join(directory, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
}
