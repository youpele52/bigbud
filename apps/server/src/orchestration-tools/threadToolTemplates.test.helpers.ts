import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import type { ThreadOrchestrationHttpConfig } from "./threadOrchestrationBridge.shared.ts";

/** Runs only generated owned fixture tools against a loopback HTTP recorder. */
export async function withFixture(
  run: (
    config: ThreadOrchestrationHttpConfig,
    requests: Array<Record<string, unknown>>,
  ) => Promise<void>,
  /** Response body for each recorded request; defaults to a successful rename. */
  respond: (body: Record<string, unknown>) => unknown = () => ({ ok: true, title: "ohno" }),
) {
  const directory = await mkdtemp(join(tmpdir(), "canonical-rename-template-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    expect(request.headers["x-bigbud-thread-tool-token"]).toBe("owned-fixture-token");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    requests.push(parsed);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(respond(parsed)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  try {
    await run(
      {
        host: "127.0.0.1",
        port: address.port,
        threadId: "canonical-caller",
        token: "owned-fixture-token",
        providerSessionId: "owned-native-session",
        providerInvocationStatePath: join(directory, "mcp-identity.json"),
      },
      requests,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runSource(source: string, input = "") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exit = once(child, "exit");
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code] = await exit;
    expect(code, stderr).toBe(0);
    return stdout;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/** Points a generated Pi extension at the installed Pi packages. */
export function resolvePiExtensionSource(source: string): string {
  const agentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const aiUrl = pathToFileURL(
    join(dirname(fileURLToPath(agentUrl)), "../../pi-ai/dist/index.js"),
  ).href;
  return source
    .replace('"@earendil-works/pi-ai"', JSON.stringify(aiUrl))
    .replace('"@earendil-works/pi-coding-agent"', JSON.stringify(agentUrl));
}
