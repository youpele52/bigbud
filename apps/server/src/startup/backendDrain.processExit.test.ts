import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { version } from "../../package.json" with { type: "json" };
import { requestBackendDrain } from "./backendDrain.client.ts";
import { backendDrainControlPaths } from "./backendDrain.server.ts";
import { BACKEND_DRAIN_EXIT_DEADLINE_MS } from "./backendDrain.exit.ts";

const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const waitFor = async (check: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

describe("drained backend process", () => {
  it("exits naturally, code 0, well before the forced-exit deadline after a drain", async () => {
    // Short root: the control socket path must fit sun_path.
    const home = await mkdtemp("/tmp/bbexit-");
    roots.push(home);
    const stateDir = join(home, "userdata");
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const child = spawn(
      "bun",
      [
        "src/bin.ts",
        "--mode",
        "web",
        "--port",
        String(port),
        "--no-browser",
        "--auth-token",
        "drain-exit-test",
      ],
      {
        cwd: join(import.meta.dirname, "../.."),
        env: { ...process.env, BIGBUD_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

    await waitFor(() => existsSync(backendDrainControlPaths(stateDir).socketPath), 60_000);
    // The handler registers with the runtime layers, after the socket starts listening.
    let response = await requestBackendDrain({
      stateDir,
      artifactId: `bigbud-server@${version}`,
      consent: "non-interactive",
    });
    for (let attempt = 0; !response.ok && attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      response = await requestBackendDrain({
        stateDir,
        artifactId: `bigbud-server@${version}`,
        consent: "non-interactive",
      });
    }
    expect(response).toMatchObject({ ok: true, status: "drained" });
    const drainedAt = Date.now();

    const code = await Promise.race([
      exited,
      new Promise<"alive">((resolve) =>
        setTimeout(() => resolve("alive"), BACKEND_DRAIN_EXIT_DEADLINE_MS + 8_000),
      ),
    ]);
    const elapsedMs = Date.now() - drainedAt;
    expect(code).toBe(0);
    // Natural exit: the event loop emptied; the 12 s safety net never fired.
    expect(output).not.toContain("graceful shutdown exceeded");
    expect(elapsedMs).toBeLessThan(BACKEND_DRAIN_EXIT_DEADLINE_MS);
    expect(existsSync(join(stateDir, "backend.lock"))).toBe(false);
  }, 120_000);
});
