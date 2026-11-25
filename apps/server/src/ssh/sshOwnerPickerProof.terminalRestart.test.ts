import { execFile, fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import type {
  TerminalRestartObservation,
  TerminalRestartRequest,
} from "./sshOwnerPickerProof.terminalRestart.child.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const execute = promisify(execFile);

function startDispatcher(entry: string, env: NodeJS.ProcessEnv, request: TerminalRestartRequest) {
  const child = fork(entry, [], {
    cwd: path.dirname(entry),
    env,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4000);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const observation = new Promise<TerminalRestartObservation>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Dispatcher ${request.phase} timed out: ${stderr}`));
      kill();
    }, 25_000);
    child.once(
      "message",
      (message: { observation: TerminalRestartObservation } | { error: string }) => {
        if ("observation" in message) resolve(message.observation);
        else reject(new Error(`Dispatcher ${request.phase}: ${message.error}\n${stderr}`));
      },
    );
    child.on("error", reject);
    void exited.then(({ code, signal }) =>
      reject(new Error(`Dispatcher ${request.phase} exited (${code ?? signal}): ${stderr}`)),
    );
    child.send(request, (error) => {
      if (error) reject(error);
    });
    void exited.then(() => clearTimeout(timer));
  });
  return {
    observation,
    exited,
    stop: () => {
      kill();
      return exited;
    },
  };
}

it.skipIf(!pickerProofOptedIn)(
  "replaces the isolated Node terminal dispatcher and replays the same live Rust-owned PTY from SQLite",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ allowPty: true });
    let owner: LaunchedPickerProofOwner | undefined;
    let first: ReturnType<typeof startDispatcher> | undefined;
    let second: ReturnType<typeof startDispatcher> | undefined;
    try {
      const entry = path.join(fixture.root, "dispatcher.mjs");
      await execute(
        "bun",
        [
          "build",
          path.join(import.meta.dirname, "sshOwnerPickerProof.terminalRestart.child.ts"),
          "--target=node",
          "--external=@effect/sql-sqlite-bun/*",
          `--outfile=${entry}`,
        ],
        {
          env: { ...fixture.env, PATH: process.env.PATH },
          timeout: 25_000,
        },
      );
      const database = path.join(fixture.root, "terminal-restart.sqlite");
      const socketPath = path.join(fixture.root, "owner.sock");
      const capability = randomBytes(32);
      const options = await proofOptions(fixture, socketPath);
      const targetId = options.targetId.replace("transport=agent", "transport=direct-ssh");
      const marker = `restart-cut-${randomUUID()}`;
      await fixture.start();
      const ownerEpoch = await storageScope(database, (sql) =>
        Effect.promise(async () => {
          owner = await startPickerProofOwner({
            ...options,
            targetId,
            sql,
            workspaceRoot: fixture.folder,
            attachment: { socketPath, capability },
          });
          const epoch = Buffer.from(owner.ownerEpoch).toString("hex");
          await owner.detach();
          return epoch;
        }),
      );
      const request = {
        database,
        socketPath,
        capability: capability.toString("hex"),
        profileBinding: options.profileBinding.toString("hex"),
        targetId,
        cwd: fixture.folder,
      };
      first = startDispatcher(entry, fixture.env, { ...request, phase: "open", marker });
      const before = await first.observation;
      expect(before).toMatchObject({
        recovered: false,
        epoch: ownerEpoch,
        route: {
          state: "may-have-been-sent",
          target: targetId,
          epoch: ownerEpoch,
          resourceId: before.resourceId,
          terminalCwd: fixture.folder,
        },
      });
      expect(before.resourceId).toMatch(/^[0-9a-f]{64}$/);
      expect(before.route.connectionId).toMatch(/^ssh-owner:[0-9a-f]{64}$/);
      expect(before.ptyPid).toBeGreaterThan(1);
      const network = fixture.connectionStarts();
      expect(await first.stop()).toEqual({ code: null, signal: "SIGKILL" });
      // Probe only the local SSH child PID reported by our private, still-running owner.
      expect(() => process.kill(before.ptyPid, 0)).not.toThrow();

      second = startDispatcher(entry, fixture.env, { ...request, phase: "recover" });
      const after = await second.observation;
      expect(await second.exited).toEqual({ code: 0, signal: null });
      expect(after.dispatcherPid).not.toBe(before.dispatcherPid);
      expect(after.writer).not.toBe(before.writer);
      expect(after).toMatchObject({
        ptyPid: before.ptyPid,
        recovered: true,
        resourceId: before.resourceId,
        epoch: ownerEpoch,
        route: before.route,
        closedState: "terminal",
      });
      expect(after.chunks).toEqual(before.chunks);
      expect(after.nextSequence).toBe(before.nextSequence);
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
      expect(after.delivered).toEqual(
        before.chunks.map(({ sequence, base64 }) => ({
          sequence,
          data: decoder.decode(Buffer.from(base64, "base64"), { stream: true }),
        })),
      );
      expect(after.delivered?.map(({ data }) => data).join("")).toContain(
        `BIGBUD_SSH_OWNER_PROOF_PTY_ECHO:${marker}`,
      );
      expect(fixture.connectionStarts()).toBe(network);
      expect(fixture.acceptedPublicKeys()).toBe(1);
      expect(await fixture.launchNames()).toEqual([]);
    } finally {
      await Promise.all([first?.stop(), second?.stop()]);
      await owner?.killForTest();
      await owner?.close();
      await fixture.dispose();
    }
  },
  120_000,
);
