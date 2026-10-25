import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { Writable, Readable } from "node:stream";
import { expect, it } from "vitest";
import { readOwnershipLock } from "@bigbud/shared/backendOwnership.record";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import { attachOwnershipHandoff, isOwnershipHandedOff } from "./ownershipHandoff";
import { createOwnershipRecovery } from "./ownershipRecovery";

it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "hands off a real test-owned process through native identity, parent quiescence and finalizers",
  async () => {
    const root = path.resolve(import.meta.dirname, "../../../..");
    const directory = await mkdtemp(path.join(os.tmpdir(), "bigbud-ownership-integration-"));
    const stateDir = await realpath(directory);
    const entry = path.join(root, "apps/server/src/startup/ownershipHandoff.fixture.mjs");
    const child: ChildProcess = spawn(process.execPath, [entry, "--bootstrap-fd", "3"], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "ignore", "pipe", "pipe"],
    });
    const streams = child.stdio as ReadonlyArray<Readable | Writable | null>;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = once(child, "close");
    let quiesced = false;
    attachOwnershipHandoff(child, stateDir, () => {
      quiesced = true;
    });
    let replacement: ChildProcess | undefined;
    try {
      (streams[3] as Writable).end(JSON.stringify({ stateDir }));
      let messages = "";
      const status = streams[4] as Readable;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`fixture readiness timed out: ${stderr}`)),
          10000,
        );
        child.once("close", () => {
          clearTimeout(timer);
          reject(new Error(`fixture exited: ${stderr}`));
        });
        status.on("data", (chunk) => {
          messages += String(chunk);
          if (messages.includes("ready\n")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const contender = spawn(process.execPath, [entry, "--bootstrap-fd", "3"], {
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe", "ignore", "pipe", "pipe"],
      });
      const contenderClosed = once(contender, "close");
      (contender.stdio[3] as Writable).end(JSON.stringify({ stateDir }));
      expect((await contenderClosed)[0]).not.toBe(0);
      let state: DesktopBackendStartupState = {
        generation: 1,
        startedAt: 1,
        status: "failed",
        failureReason: "state_directory_in_use",
      };
      const recovery = createOwnershipRecovery({
        state: () => state,
        launch: () => ({
          generation: 1,
          stateDir,
          launcher: process.execPath,
          entry,
          inspector: path.join(root, "target/debug/bigbud-desktop-supervisor"),
        }),
        blocked: () => false,
        childPresent: () => false,
        publish: (_generation, ownershipRecovery) => {
          state = { ...state, ownershipRecovery };
        },
        start: async () => {
          expect(quiesced).toBe(true);
          expect(messages).toContain("finalized\n");
          replacement = spawn(process.execPath, [entry, "--bootstrap-fd", "3"], {
            stdio: ["ignore", "ignore", "ignore", "pipe", "pipe", "ignore", "pipe", "pipe"],
          });
          const replacementStatus = replacement.stdio[4] as Readable;
          const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("replacement readiness timeout")),
              10000,
            );
            replacementStatus.once("data", (chunk) => {
              clearTimeout(timer);
              if (String(chunk).includes("ready")) resolve();
              else reject(new Error("replacement not ready"));
            });
            replacement!.once("close", () => {
              clearTimeout(timer);
              reject(new Error("replacement exited"));
            });
          });
          (replacement.stdio[3] as Writable).end(JSON.stringify({ stateDir }));
          await ready;
          state = { generation: 2, startedAt: 2, status: "ready" };
        },
      });
      await recovery(1);
      expect(state, JSON.stringify({ state, stderr, quiesced, messages })).toMatchObject({
        generation: 2,
        status: "ready",
      });
      await closed;
      expect(isOwnershipHandedOff()).toBe(true);
      expect((await readOwnershipLock(path.join(stateDir, "backend.lock")))?.pid).toBe(
        replacement?.pid,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await closed;
      }
      if (replacement && replacement.exitCode === null && replacement.signalCode === null) {
        const replacementClosed = once(replacement, "close");
        replacement.kill("SIGTERM");
        await replacementClosed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
