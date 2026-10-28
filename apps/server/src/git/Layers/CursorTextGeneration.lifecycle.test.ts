import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProcessLedger,
  type ProcessLedgerTrackInput,
} from "../../process-ledger/Services/ProcessLedger.ts";
import { processAlive } from "../../utils/processGroup.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeCursorTextGenerationLive } from "./CursorTextGeneration.ts";
import {
  type FakeCursorAgentMode,
  writeFakeCursorAgent,
} from "./CursorTextGeneration.test.fakeAgent.ts";

const tempDirs: string[] = [];
const callerScopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of callerScopes.splice(0))
    await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// The release's SIGTERM window (2 s) plus its SIGKILL exit wait (1 s), with margin.
const waitFor = async (predicate: () => boolean, timeoutMs = 6_000) => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

function setup(mode: FakeCursorAgentMode, timeoutMs = 30_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-cursor-textgen-"));
  tempDirs.push(dir);
  const agent = writeFakeCursorAgent(dir, mode);
  const layer = makeCursorTextGenerationLive({ timeoutMs }).pipe(
    Layer.provideMerge(
      ServerSettingsService.layerTest({ providers: { cursor: { binaryPath: agent.binaryPath } } }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  // Every request runs with a recording process ledger, as in the server.
  const tracked: ProcessLedgerTrackInput[] = [];
  const agentAliveAtRelease: boolean[] = [];
  const ledger = {
    track: (input: ProcessLedgerTrackInput) =>
      Effect.sync(() => {
        tracked.push(input);
        return {
          release: Effect.sync(() => void agentAliveAtRelease.push(processAlive(input.pid))),
        };
      }),
  };
  // Like the prompt suggestion reactor's `forkScoped` fibers, the caller carries a long-lived
  // ambient Scope (open until afterEach). The agent must not attach to it.
  const callerScope = Effect.runSync(Scope.make());
  callerScopes.push(callerScope);
  const generateTitle = Effect.gen(function* () {
    const textGeneration = yield* TextGeneration;
    return yield* textGeneration.generateThreadTitle({
      cwd: dir,
      message: "Name this thread",
      modelSelection: { provider: "cursor", model: "default" },
    });
  }).pipe(
    Effect.provideService(Scope.Scope, callerScope),
    Effect.provideService(ProcessLedger, ledger),
  );
  const expectAgentTreeGone = async () => {
    const { agentPid, grandchildPid } = agent.readPids();
    expect(await waitFor(() => !processAlive(agentPid))).toBe(true);
    // The grandchild stands in for the agent's MCP servers and ignores SIGTERM: the release must
    // escalate to a group SIGKILL to reach it.
    expect(await waitFor(() => !processAlive(grandchildPid))).toBe(true);
    // The ledger record is dropped exactly once, and only after the agent died.
    expect(await waitFor(() => agentAliveAtRelease.length > 0)).toBe(true);
    expect(agentAliveAtRelease).toEqual([false]);
  };
  return { agent, layer, generateTitle, expectAgentTreeGone, tracked };
}

describe.skipIf(process.platform === "win32")("CursorTextGeneration agent lifecycle", () => {
  it("kills the agent and its group after a successful request", async () => {
    const { layer, generateTitle, expectAgentTreeGone } = setup("ok");
    const result = await Effect.runPromise(generateTitle.pipe(Effect.provide(layer)));
    expect(result.title).toBe("Fake title");
    await expectAgentTreeGone();
  });

  it("kills the agent after a failed request", async () => {
    const { layer, generateTitle, expectAgentTreeGone } = setup("invalid-output");
    const error = await Effect.runPromise(generateTitle.pipe(Effect.flip, Effect.provide(layer)));
    expect(error.detail).toBe("Cursor Agent returned invalid structured output.");
    await expectAgentTreeGone();
  });

  it("kills the agent when the request times out", async () => {
    const { layer, generateTitle, expectAgentTreeGone } = setup("hang", 1_500);
    const error = await Effect.runPromise(generateTitle.pipe(Effect.flip, Effect.provide(layer)));
    expect(error.detail).toBe("Cursor Agent request timed out.");
    await expectAgentTreeGone();
  });

  it("kills the agent when the caller is interrupted", async () => {
    const { agent, layer, generateTitle, expectAgentTreeGone } = setup("hang");
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(generateTitle);
        yield* Effect.promise(() =>
          waitFor(() => {
            try {
              agent.readPids();
              return true;
            } catch {
              return false;
            }
          }),
        );
        // Let the handshake reach the hanging prompt before interrupting.
        yield* Effect.sleep("300 millis");
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer)),
    );
    await expectAgentTreeGone();
  });

  it("records the agent in the ambient process ledger as a process group", async () => {
    const { agent, layer, generateTitle, expectAgentTreeGone, tracked } = setup("ok");
    await Effect.runPromise(generateTitle.pipe(Effect.provide(layer)));
    await expectAgentTreeGone();
    expect(tracked).toEqual([
      {
        pid: agent.readPids().agentPid,
        command: agent.binaryPath,
        args: ["--trust", "acp"],
        kill: "group",
        label: "acp-agent",
      },
    ]);
  });
});
