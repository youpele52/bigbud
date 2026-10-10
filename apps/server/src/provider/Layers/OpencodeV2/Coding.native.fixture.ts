import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Disposable pinned-client native fixture, not vendor conformance or credential discovery. */
export async function makeV2CodingNativeFixture(contextTokens = 32000) {
  const state = {
    tool: "bigbud_write",
    input: { path: "main.py", content: "value = 1\n" } as Record<string, unknown>,
    round: 0,
    modelRequests: 0,
    requests: [] as Record<string, unknown>[],
    advertised: new Set<string>(),
    textOnlyDelegated: false,
  };
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const input = JSON.parse(body) as { tools?: { function: { name: string } }[] };
    state.modelRequests++;
    state.requests.push(JSON.parse(body));
    for (const item of input.tools ?? []) state.advertised.add(item.function.name);
    const delegated = state.textOnlyDelegated && body.includes("delegated_thread_provenance");
    const call = !delegated && Boolean(input.tools?.length) && state.round++ % 2 === 0;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `coding-${state.round}`,
                      type: "function",
                      function: { name: state.tool, arguments: JSON.stringify(state.input) },
                    },
                  ],
                }
              : { role: "assistant", content: "synthetic coding completed" },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ])
      response.write(
        `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic-model", ...chunk })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("fixture missing port");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-coding-native-")));
  const profile = path.join(root, "profile"),
    workspace = path.join(root, "workspace");
  for (const directory of [profile, workspace]) await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(workspace, ".agents", "skills", "example"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    path.join(workspace, ".agents", "skills", "example", "SKILL.md"),
    "# Example\nDisposable read-only skill instructions.\n",
  );
  await mkdir(path.join(profile, "config", "opencode"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(profile, "config", "opencode", "opencode.json"),
    JSON.stringify({
      providers: {
        "bigbud-v2-fixture": {
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "disposable-synthetic-only",
          },
          models: {
            "synthetic-model": {
              name: "synthetic-model",
              limit: { context: contextTokens, output: 4000 },
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  return {
    state,
    profile,
    workspace,
    async close() {
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
