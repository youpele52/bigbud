import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deriveMcpInvocationStatePath } from "./mcpInvocationStatePath.ts";
import {
  createInvocationFixture,
  deferred,
  spawnBridge,
  toolRequest,
  type JsonObject,
} from "./mcpInvocationIdentity.testSupport.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import {
  renderMcpInvocationIdentitySource,
  type McpInvocationSurface,
} from "./threadOrchestrationBridge.invocationIdentity.ts";

const temporaryRoots: string[] = [];

async function temporaryStatePath(namespace = "orchestration"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-mcp-identity-"));
  temporaryRoots.push(root);
  return path.join(root, namespace);
}

function orchestrationSource(port: number, statePath: string): string {
  return renderOrchestrationMcpServerSource({
    host: "127.0.0.1",
    port,
    threadId: "thread",
    token: "fixture",
    providerSessionId: "provider-session",
    providerInvocationStatePath: statePath,
  });
}

function identityProbeSource(statePath: string, surface: McpInvocationSurface): string {
  return [
    "import { createHash } from 'node:crypto';",
    "import { join } from 'node:path';",
    `const CONFIG = ${JSON.stringify({ threadId: "thread", providerSessionId: "provider-session", providerInvocationStatePath: statePath })};`,
    renderMcpInvocationIdentitySource("PROBE_IDENTITY_REQUIRED", surface),
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (input) => {",
    "  for (const line of input.trim().split('\\n')) void (async () => {",
    "    const request = JSON.parse(line);",
    "    const forwardedInvocationId = await resolveMcpInvocationId(request);",
    "    await completeMcpInvocation(request);",
    "    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { forwardedInvocationId } })}\\n`);",
    "  })();",
    "});",
  ].join("\n");
}

function invocationId(request: JsonObject): string {
  const value = request.invocationId;
  if (typeof value !== "string") throw new Error("Missing invocation identity.");
  return value;
}

async function readRecords(statePath: string): Promise<JsonObject[]> {
  const names = (await fs.readdir(statePath)).filter((name) => /^[a-f0-9]{64}$/.test(name));
  return Promise.all(
    names.map(async (name) =>
      JSON.parse(await fs.readFile(path.join(statePath, name, "record.json"), "utf8")),
    ),
  );
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("durable MCP invocation identity", () => {
  it("preserves overlapping old and replacement process records through another restart", async () => {
    const statePath = await temporaryStatePath();
    const oldGate = deferred<JsonObject>();
    const fixture = await createInvocationFixture(async (body) =>
      body.title === "old" ? oldGate.promise : { result: {} },
    );
    const source = orchestrationSource(fixture.port, statePath);
    const oldBridge = spawnBridge(source);
    const oldResponse = oldBridge.send(toolRequest(1, "old"));

    while (fixture.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const replacement = spawnBridge(source);
    await expect(replacement.send(toolRequest(2, "new"))).resolves.toHaveProperty("result");
    await replacement.close();
    oldGate.resolve({ result: {} });
    await expect(oldResponse).resolves.toHaveProperty("result");
    await oldBridge.close();

    const firstIds = fixture.requests.map(invocationId);
    expect(new Set(firstIds).size).toBe(2);
    const restarted = spawnBridge(source);
    await restarted.send(toolRequest(1, "old"));
    await restarted.send(toolRequest(2, "new"));
    await restarted.close();
    expect(fixture.requests.slice(2).map(invocationId)).toEqual(firstIds);
    await fixture.close();
  });

  it("claims a raced invocation once and fails the unresolved owner closed", async () => {
    const statePath = await temporaryStatePath();
    const gate = deferred<JsonObject>();
    const fixture = await createInvocationFixture(() => gate.promise);
    const source = orchestrationSource(fixture.port, statePath);
    const left = spawnBridge(source);
    const right = spawnBridge(source);
    const responses = [
      left.send(toolRequest("race", "same")),
      right.send(toolRequest("race", "same")),
    ];

    while (fixture.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const early = await Promise.race(responses);
    expect(JSON.stringify(early)).toContain("MCP_INVOCATION_IDENTITY_REQUIRED_REPLAY_AMBIGUOUS");
    expect(fixture.requests).toHaveLength(1);
    gate.resolve({ result: {} });
    await Promise.all(responses);
    await Promise.all([left.close(), right.close()]);
    await fixture.close();
  });

  it("claims an explicit metadata invocation once across bridge processes", async () => {
    const statePath = await temporaryStatePath();
    const gate = deferred<JsonObject>();
    const fixture = await createInvocationFixture(() => gate.promise);
    const source = orchestrationSource(fixture.port, statePath);
    const left = spawnBridge(source);
    const right = spawnBridge(source);
    const responses = [
      left.send(toolRequest(1, "metadata-race", "originating-tool-call")),
      right.send(toolRequest(2, "metadata-race", "originating-tool-call")),
    ];

    while (fixture.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const early = await Promise.race(responses);
    expect(JSON.stringify(early)).toContain("MCP_INVOCATION_IDENTITY_REQUIRED_REPLAY_AMBIGUOUS");
    expect(fixture.requests).toHaveLength(1);
    expect(invocationId(fixture.requests[0]!)).toBe(
      "mcp-meta:provider-session:originating-tool-call",
    );
    gate.resolve({ result: {} });
    await Promise.all(responses);
    await Promise.all([left.close(), right.close()]);
    expect(JSON.stringify(await readRecords(statePath))).not.toContain("originating-tool-call");
    await fixture.close();
  });

  it("fails a concurrent duplicate in one bridge process closed", async () => {
    const statePath = await temporaryStatePath();
    const gate = deferred<JsonObject>();
    let dispatches = 0;
    const fixture = await createInvocationFixture((body) => {
      dispatches += 1;
      return dispatches === 1 ? gate.promise : Promise.resolve({ result: body });
    });
    const bridge = spawnBridge(orchestrationSource(fixture.port, statePath));
    const request = toolRequest("same-process-race", "same-process-race");
    const responses = [bridge.send(request), bridge.send(request)];

    while (fixture.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const early = await Promise.race(responses);
    expect(JSON.stringify(early)).toContain("MCP_INVOCATION_IDENTITY_REQUIRED_REPLAY_AMBIGUOUS");
    expect(fixture.requests).toHaveLength(1);
    gate.resolve({ result: {} });
    const completed = await Promise.all(responses);
    expect(completed.filter((response) => response.error !== undefined)).toHaveLength(1);
    expect(completed.filter((response) => response.result !== undefined)).toHaveLength(1);
    await bridge.close();
    await fixture.close();
  });

  it("reuses completed identity, separates typed IDs and changed arguments, and stores no secret", async () => {
    const statePath = await temporaryStatePath();
    const fixture = await createInvocationFixture();
    const source = orchestrationSource(fixture.port, statePath);
    const secret = "unique-secret-command-content-7c9109";
    for (const request of [
      toolRequest(1, secret),
      toolRequest("1", secret),
      toolRequest(1, `${secret}-changed`),
    ]) {
      const bridge = spawnBridge(source);
      await bridge.send(request);
      await bridge.close();
    }
    const replay = spawnBridge(source);
    await replay.send(toolRequest(1, secret));
    await replay.close();

    const ids = fixture.requests.map(invocationId);
    expect(new Set(ids.slice(0, 3)).size).toBe(3);
    expect(ids[3]).toBe(ids[0]);
    expect(
      await fs.readFile(
        path.join(statePath, await fs.readdir(statePath).then((x) => x[0]!), "record.json"),
        "utf8",
      ),
    ).not.toContain(secret);
    expect(JSON.stringify(await readRecords(statePath))).not.toContain(secret);
    await fixture.close();
  });

  it("bounds completed retention without deleting an unresolved invocation", async () => {
    const statePath = await temporaryStatePath();
    const unresolvedGate = deferred<JsonObject>();
    const fixture = await createInvocationFixture(async (body) =>
      body.title === "unresolved" ? unresolvedGate.promise : { result: {} },
    );
    const source = orchestrationSource(fixture.port, statePath);
    const abandoned = spawnBridge(source);
    void abandoned.send(toolRequest("unresolved", "unresolved")).catch(() => undefined);
    while (fixture.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    abandoned.child.kill("SIGKILL");

    const bridge = spawnBridge(source);
    for (let index = 0; index < 132; index += 1) {
      await bridge.send(toolRequest(index, `completed-${index}`));
    }
    await bridge.close();
    const records = await readRecords(statePath);
    expect(records.filter((record) => record.status === "completed").length).toBeLessThanOrEqual(
      128,
    );
    expect(records.filter((record) => record.status === "in-flight")).toHaveLength(1);
    unresolvedGate.resolve({ result: {} });
    await fixture.close();
  });

  it("does not compact a completed invocation while another process replays it", async () => {
    const statePath = await temporaryStatePath();
    const replayGate = deferred<JsonObject>();
    let blockReplay = false;
    const fixture = await createInvocationFixture(async (body) =>
      blockReplay && body.title === "completed-0" ? replayGate.promise : { result: {} },
    );
    const source = orchestrationSource(fixture.port, statePath);
    const seed = spawnBridge(source);
    for (let index = 0; index < 128; index += 1) {
      await seed.send(toolRequest(index, `completed-${index}`));
    }
    await seed.close();
    const replayedIdentity = invocationId(fixture.requests[0]!);

    blockReplay = true;
    const replay = spawnBridge(source);
    const replayResponse = replay.send(toolRequest(0, "completed-0"));
    while (fixture.requests.length < 129) await new Promise((resolve) => setImmediate(resolve));

    const compactor = spawnBridge(source);
    await compactor.send(toolRequest(128, "completed-128"));
    await compactor.close();
    const duplicate = spawnBridge(source);
    const duplicateResponse = await duplicate.send(toolRequest(0, "completed-0"));
    await duplicate.close();

    expect(JSON.stringify(duplicateResponse)).toContain(
      "MCP_INVOCATION_IDENTITY_REQUIRED_REPLAY_AMBIGUOUS",
    );
    expect(fixture.requests.filter((body) => body.title === "completed-0")).toHaveLength(2);
    replayGate.resolve({ result: {} });
    await replayResponse;
    await replay.close();
    const records = await readRecords(statePath);
    expect(records.filter((record) => record.status === "completed")).toHaveLength(128);
    expect(records.some((record) => record.identity === replayedIdentity)).toBe(true);
    await fixture.close();
  });

  it("isolates orchestration and remote-workspace durable namespaces", async () => {
    const orchestrationPath = await temporaryStatePath("scope.orchestration");
    const remotePath = deriveMcpInvocationStatePath(orchestrationPath, "remote-workspace");
    const orchestration = spawnBridge(identityProbeSource(orchestrationPath, "orchestration"));
    const remote = spawnBridge(identityProbeSource(remotePath, "remote-workspace"));
    const request = toolRequest(1, "identical-request");
    const [orchestrationResponse, remoteResponse] = await Promise.all([
      orchestration.send(request),
      remote.send(request),
    ]);
    await Promise.all([orchestration.close(), remote.close()]);

    expect(remotePath).not.toBe(orchestrationPath);
    await expect(fs.readdir(orchestrationPath)).resolves.toHaveLength(1);
    await expect(fs.readdir(remotePath)).resolves.toHaveLength(1);
    const orchestrationIdentity = (orchestrationResponse.result as JsonObject)
      .forwardedInvocationId;
    const remoteIdentity = (remoteResponse.result as JsonObject).forwardedInvocationId;
    expect(orchestrationIdentity).not.toBe(remoteIdentity);
    expect((await readRecords(orchestrationPath))[0]?.identity).toBe(orchestrationIdentity);
    expect((await readRecords(remotePath))[0]?.identity).toBe(remoteIdentity);
  });
});
