import { chmod, copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  isolatedEnvironment,
  startOwnedV2Process,
  type OwnedV2Process,
} from "./ServerManager.child.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { OpencodeV2DevelopmentSessions } from "./DevelopmentSessions.ts";
import { makeNoExecutionAdmissionTransport } from "./Adapter.admission.ts";
import { Effect } from "effect";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { admissionCorrelation } from "./Admission.identity.ts";

const roots: string[] = [];
const processes: OwnedV2Process[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function config() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bigbud-v2-synthetic-"));
  roots.push(root);
  const binaryPath = path.join(root, "fixture-v2");
  await copyFile(
    fileURLToPath(new URL("./ServerManager.fixture.mjs", import.meta.url)),
    binaryPath,
  );
  await chmod(binaryPath, 0o700);
  return {
    runtimeTargetId: "local",
    binaryPath,
    profileRoot: path.join(
      await import("node:fs/promises").then((fs) => fs.realpath(root)),
      "profile",
    ),
  };
}

describe.skipIf(process.platform === "win32")(
  "synthetic V2 child protocol conformance (not live native evidence)",
  () => {
    it("owns an authenticated loopback endpoint/stdin lease and preserves synthetic history on close", async () => {
      const input = await config();
      const process = await startOwnedV2Process(input);
      processes.push(process);
      expect(process.isRunning()).toBe(true);
      expect((await process.client.server.info()).version).toBe("2.0.19");
      await process.close();
      expect(process.isRunning()).toBe(false);
      expect(await readFile(path.join(input.profileRoot, "synthetic-history"), "utf8")).toBe(
        "retained",
      );
    });
    it("never inherits provider credentials and rejects unverified SSH before bootstrap", async () => {
      const input = await config();
      const environment = await isolatedEnvironment(input);
      expect(
        Object.keys(environment).some(
          (key) =>
            key.includes("API_KEY") ||
            key.startsWith("BIGBUD_") ||
            key === "OPENCODE_SERVER_PASSWORD",
        ),
      ).toBe(false);
      expect(environment.HOME).toBe(input.profileRoot);
      await expect(
        isolatedEnvironment({ ...input, runtimeTargetId: "ssh-fixture" }),
      ).rejects.toThrow("unavailable");
    });
    it("creates only isolated deny-all sessions and explicit no-execution admissions; stop retains history", async () => {
      const input = await config();
      await mkdir(input.profileRoot, { mode: 0o700 });
      await mkdir(path.join(input.profileRoot, "workspace"), { recursive: true });
      const manager = new OpencodeV2ServerManager({
        maxProcesses: 1,
        maxOwners: 32,
        maxQueuedEvents: 4,
        maxEventBytes: 1024,
        consumerTimeoutMs: 100,
      });
      const sessions = new OpencodeV2DevelopmentSessions(manager);
      try {
        const threadId = ThreadId.makeUnsafe("synthetic-thread");
        const session = await sessions.start({
          threadId,
          config: input,
          directory: path.join(input.profileRoot, "workspace"),
          model: { providerID: "synthetic", id: "not-a-real-model" },
          epoch: 1,
          onDirty: () => {},
        });
        expect(session.native.permissions).toEqual([
          { action: "*", resource: "*", effect: "deny" },
        ]);
        const identity = {
          namespace: "foreground" as const,
          ownerThreadId: threadId,
          requestMessageId: MessageId.makeUnsafe("synthetic-request"),
        };
        const row = {
          ...identity,
          ...admissionCorrelation(identity),
          fingerprint: "synthetic",
          state: "dispatch-intent" as const,
          revision: 1,
          createdAt: "fixture",
          updatedAt: "fixture",
          finalText: null,
          binding: {
            provider: "opencodeV2",
            threadId,
            nativeSessionId: session.native.id,
            location: session.native.location.directory,
            runtimeTargetId: "local",
            workspaceTargetId: "local",
            storageIdentity: "fixture",
          },
        };
        const transport = makeNoExecutionAdmissionTransport(
          session.lease.process.client,
          "synthetic text",
        );
        expect(await Effect.runPromise(transport.dispatch(row))).toBe(true);
        expect(await Effect.runPromise(transport.reconcile(row))).toBe("accepted");
        await sessions.stop(threadId);
        expect(sessions.list()).toEqual([]);
        expect(await readFile(path.join(input.profileRoot, "synthetic-history"), "utf8")).toBe(
          "retained",
        );
      } finally {
        await sessions.close();
      }
    });
  },
);
