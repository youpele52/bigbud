/**
 * Fake Codex CLI for the remote backend measurement (WP-6A). It never contacts a model and
 * needs no credentials. It answers `--version`, `login status` and a minimal `app-server`
 * JSON-RPC dialogue over stdio, and streams a scripted turn: reasoning, an agent message in
 * deltas, a command execution with output, then `turn/completed`.
 *
 * Run by the backend through a wrapper (`exec <node> fakeCodex.ts "$@"`). Turn shape comes
 * from env set by the wrapper: BB_FAKE_CODEX_DELTAS, BB_FAKE_CODEX_DELTA_CHARS,
 * BB_FAKE_CODEX_OUTPUT_LINES, BB_FAKE_CODEX_DELTA_MS. Only `node:` imports.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export const FAKE_CODEX_VERSION = "0.140.0";

const numberEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const DELTAS = numberEnv("BB_FAKE_CODEX_DELTAS", 40);
const DELTA_CHARS = numberEnv("BB_FAKE_CODEX_DELTA_CHARS", 48);
const OUTPUT_LINES = numberEnv("BB_FAKE_CODEX_OUTPUT_LINES", 40);
const DELTA_MS = numberEnv("BB_FAKE_CODEX_DELTA_MS", 10);

const write = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: object) => write({ method, params });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROSE =
  "The measurement turn streams realistic assistant prose so projections, the event log and " +
  "client delivery do the same work as a real provider turn would. ";

function text(index: number, chars: number) {
  const offset = (index * 17) % PROSE.length;
  return (PROSE.slice(offset) + PROSE).slice(0, chars);
}

const threads = new Set<string>();
let turnChain: Promise<void> = Promise.resolve();

async function runTurn(threadId: string, turnId: string) {
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
  const reasoningId = `rs_${randomUUID()}`;
  notify("item/started", { threadId, turnId, item: { type: "reasoning", id: reasoningId } });
  for (let index = 0; index < Math.ceil(DELTAS / 4); index += 1) {
    notify("item/reasoning/summaryTextDelta", {
      threadId,
      turnId,
      itemId: reasoningId,
      delta: text(index, DELTA_CHARS),
      summaryIndex: 0,
    });
  }
  notify("item/completed", {
    threadId,
    turnId,
    item: { type: "reasoning", id: reasoningId, summary: [], content: [] },
  });

  const commandId = `cmd_${randomUUID()}`;
  const command = "ls -la src";
  notify("item/started", {
    threadId,
    turnId,
    item: {
      type: "commandExecution",
      id: commandId,
      command,
      cwd: process.cwd(),
      status: "inProgress",
    },
  });
  let output = "";
  for (let line = 0; line < OUTPUT_LINES; line += 1) {
    const chunk = `-rw-r--r-- 1 user user ${1000 + line} Nov 18 00:00 file-${line}.ts\n`;
    output += chunk;
    notify("item/commandExecution/outputDelta", {
      threadId,
      turnId,
      itemId: commandId,
      delta: chunk,
    });
  }
  notify("item/completed", {
    threadId,
    turnId,
    item: {
      type: "commandExecution",
      id: commandId,
      command,
      cwd: process.cwd(),
      status: "completed",
      aggregatedOutput: output,
      exitCode: 0,
      durationMs: 12,
    },
  });

  const messageId = `msg_${randomUUID()}`;
  notify("item/started", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: messageId, text: "" },
  });
  let message = "";
  for (let index = 0; index < DELTAS; index += 1) {
    const delta = text(index, DELTA_CHARS);
    message += delta;
    notify("item/agentMessage/delta", { threadId, turnId, itemId: messageId, delta });
    if (DELTA_MS > 0) await delay(DELTA_MS);
  }
  notify("item/completed", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: messageId, text: message },
  });
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      total: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 },
      last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 },
      modelContextWindow: 200000,
    },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } });
}

function handle(request: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
  const respond = (result: unknown) => write({ id: request.id, result });
  switch (request.method) {
    case "initialize":
      return respond({ userAgent: `bigbud-measure-fake-codex/${FAKE_CODEX_VERSION}` });
    case "model/list":
      return respond({
        data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "gpt-5.4", isDefault: true }],
        nextCursor: null,
      });
    case "account/read":
      return respond({ account: { type: "apiKey" }, requiresOpenaiAuth: false });
    case "thread/start":
    case "thread/resume": {
      const threadId =
        (typeof request.params?.threadId === "string" && request.params.threadId) ||
        `fake-thread-${randomUUID()}`;
      threads.add(threadId);
      return respond({ thread: { id: threadId, turns: [] }, model: "gpt-5.4" });
    }
    case "thread/read":
      return respond({ thread: { id: request.params?.threadId, turns: [] } });
    case "turn/start": {
      const threadId = String(request.params?.threadId ?? "");
      const turnId = `turn_${randomUUID()}`;
      respond({ turn: { id: turnId, status: "inProgress", items: [] } });
      turnChain = turnChain.then(() => runTurn(threadId, turnId)).catch(() => undefined);
      return;
    }
    case "turn/interrupt":
      return respond({});
    default:
      if (request.id !== undefined && request.method !== undefined) {
        write({
          id: request.id,
          error: { code: -32601, message: `fake codex: ${request.method}` },
        });
      }
  }
}

function main(argv: ReadonlyArray<string>) {
  if (argv.includes("--version")) {
    process.stdout.write(`codex-cli ${FAKE_CODEX_VERSION}\n`);
    return;
  }
  if (argv[0] === "login" && argv[1] === "status") {
    process.stdout.write('{"authenticated":true}\n');
    return;
  }
  if (argv[0] !== "app-server") {
    process.stderr.write("fake codex: only --version, login status and app-server exist\n");
    process.exitCode = 2;
    return;
  }
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    try {
      handle(JSON.parse(line));
    } catch {
      // Malformed input is ignored, like an unknown notification.
    }
  });
  lines.on("close", () => {
    void turnChain.finally(() => process.exit(0));
  });
}

main(process.argv.slice(2));
