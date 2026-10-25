import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@bigbud/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { resolveV2RuntimeBinding } from "../../provider/Layers/OpencodeV2/Runtime.binding.ts";
import { FRESH_REPLAY_EXCLUDED_PROVIDERS } from "./ProviderCommandReactorSessionOps.recovery.turnStart.ts";
import {
  completeFirstTurn,
  dispatchTurn,
  failures,
  recoveries,
  sessionDead,
  sourceSends,
} from "./ProviderCommandReactor.sessionRecovery.test.helpers.ts";
import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const created: string[] = [];
const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
};

/**
 * Gate G2a (plan D13): fresh replay is allowed for OpenCode V2 only if a fresh start creates a new
 * native session that does not touch the retired one.
 */
describe("gate G2a: OpenCode V2 fresh-session replay", () => {
  registerProviderCommandReactorTestCleanup();
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("a fresh V2 start resolves the same native session as the retired one", async () => {
    const options = {
      config: { runtimeTargetId: "local", profileRoot: await tempDir("g2a-profile-") },
    } as never;
    const cwd = await tempDir("g2a-workspace-");
    const start = (sessionEpoch: number) =>
      resolveV2RuntimeBinding(options, {
        provider: "opencodeV2",
        threadId: ThreadId.makeUnsafe("thread-g2a"),
        cwd,
        runtimeMode: "full-access",
        sessionEpoch,
      });
    const retired = await start(1);
    // startSessionFresh only drops the resume cursor and advances the epoch.
    const fresh = await start(2);
    expect(fresh.nativeSessionId).toBe(retired.nativeSessionId);
    expect(fresh.nativeSessionId).toMatch(/^ses_bigbud_[0-9a-f]{64}$/);
    // Not isolated, so a transcript replay would duplicate native history: V2 is excluded.
    expect(FRESH_REPLAY_EXCLUDED_PROVIDERS.has("opencodeV2")).toBe(true);
  });

  it("a session-dead V2 turn start gets one revive and never a fresh transcript replay", async () => {
    const harness = await createHarness({
      workspaceRoot: await tempDir("g2a-recovery-workspace-"),
      threadModelSelection: { provider: "opencodeV2", model: "synthetic-model" },
      sessionRecovery: "resume-restart",
    });
    await completeFirstTurn(harness);
    harness.sendTurn.mockImplementation(sessionDead as never);
    await dispatchTurn(harness, "second", "second question");
    await waitFor(async () => (await failures(harness)).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(sourceSends(harness)).toHaveLength(3); // first turn + attempt + revive
    expect(await failures(harness)).toHaveLength(1);
    const steps = (await recoveries(harness)).map((entry) => `${entry.step}:${entry.outcome}`);
    expect(steps).toEqual(["revive:started", "revive:failed"]);
  });
});
