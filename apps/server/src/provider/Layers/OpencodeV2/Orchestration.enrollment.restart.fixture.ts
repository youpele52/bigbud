import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireStateDirLock, type StateDirLockHandle } from "../../../startup/stateDirLock.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import type { OpencodeV2Client } from "./Client.ts";
import type { V2ThreadOwner } from "./Orchestration.protocol.ts";
import { makeBackendInstance } from "../../../startup/backendInstance.ts";
import { prepareV2DeadBackendRecovery } from "./Orchestration.enrollment.deadBackend.ts";

/** Real child-process "backend A": acquires the lock, persists records, reports ready, then is
 * SIGKILLed without cleanup. The native plugin stays in this process as the long-lived daemon. */
export async function runKilledBackend(input: Record<string, unknown>) {
  const child = spawn(
    "bun",
    [
      fileURLToPath(
        new URL("./Orchestration.enrollment.restart.process.fixture.ts", import.meta.url),
      ),
    ],
    { cwd: process.cwd(), shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (errors.length < 4096) errors += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const ready = new Promise<{ pid: number; nonce: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Synthetic backend deadline. ${errors}`)),
      15000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split("\n").find((candidate) => candidate.includes('"ready"'));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Synthetic backend exited early (${code}). ${errors}`));
    });
  });
  child.stdin.end(JSON.stringify(input));
  const value = await ready;
  child.kill("SIGKILL");
  await exited; // Reaped: the PID is provably gone (ESRCH) for the successor's takeover.
  return value;
}

export interface V2DeadBackendScenario {
  readonly app: Awaited<ReturnType<typeof makeV2ThreadPluginFixture>>;
  readonly host: ReturnType<typeof makeV2ThreadPluginHost>;
  readonly owner: V2ThreadOwner;
  readonly digest: string;
  readonly key: string;
  readonly receiptKey: string;
  readonly records: V2ThreadRecords;
  readonly lock: StateDirLockHandle;
  readonly backendA: { pid: number; nonce: string };
  readonly active: Record<string, unknown>;
  readonly client: OpencodeV2Client;
  /** Native thread-tools RPC methods issued through `client`, in order. */
  readonly calls: string[];
  /** Native RPC methods that fail (transport error) through `client`. */
  readonly failing: Set<string>;
  /** Simulates an OpenCode daemon restart: the plugin's in-memory lease registry is empty. */
  readonly restartPlugin: () => Promise<void>;
  /** Backend B's production recovery wiring (lock-holder identity + per-instance fence). */
  readonly recovery: () => Promise<
    NonNullable<Awaited<ReturnType<typeof prepareV2DeadBackendRecovery>>>
  >;
  readonly scope: {
    storageIdentity: string;
    nativeSessionId: string;
    threadId: string;
    directory: string;
  };
}

/** Backend A enrolled `owner` natively and died; backend B now holds the lock. */
export async function withV2DeadBackendScenario(
  run: (scenario: V2DeadBackendScenario) => Promise<void>,
  options: { readonly marker?: boolean; readonly expiryMs?: number } = {},
) {
  const app = await makeV2ThreadPluginFixture();
  const owner = app.bind("ses_restart_native", app.root);
  const host = makeV2ThreadPluginHost(owner);
  const plugin = (await import(app.artifact.entryUri)).default;
  let dispose = await plugin.setup(host.context);
  let lock: StateDirLockHandle | undefined;
  try {
    const expiry = Date.now() + (options.expiryMs ?? 55000),
      signed = app.envelope("enroll", 1, expiry);
    await host.call("enroll", signed);
    const key = JSON.stringify([owner.storageIdentity, owner.nativeSessionId, owner.threadId]);
    const receiptKey = JSON.stringify([
      owner.storageIdentity,
      "turn-of-dead-backend",
      owner.nativeSessionId,
      "assistant-dead",
      "call-dead",
    ]);
    const backendA = await runKilledBackend({
      stateDir: app.root,
      root: app.artifact.root,
      privateKey: app.artifact.privateKey,
      publicKey: app.artifact.publicKey,
      key,
      marker: options.marker ?? false,
      enrollment: {
        owner,
        digest: signed.ownerDigest,
        state: "active",
        acknowledged: { revision: 1, expiry },
        pending: null,
      },
      receipt: { key: receiptKey, value: { fingerprint: "f".repeat(64), state: "reserved" } },
    });
    lock = await acquireStateDirLock({ stateDir: app.root, port: 0 });
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const active: Record<string, unknown> = {};
    const calls: string[] = [],
      failing = new Set<string>();
    const client = {
      rpc: {
        call: async (input: { method: string; input: unknown }) => {
          calls.push(input.method);
          if (failing.has(input.method)) throw new Error("synthetic native transport failure");
          return { output: await host.call(input.method, input.input) };
        },
      },
      session: { active: async () => active },
    } as unknown as OpencodeV2Client;
    await run({
      app,
      host,
      owner,
      digest: signed.ownerDigest,
      key,
      receiptKey,
      records,
      lock,
      backendA,
      active,
      client,
      calls,
      failing,
      restartPlugin: async () => {
        await dispose();
        dispose = await plugin.setup(host.context);
      },
      recovery: async () =>
        (await prepareV2DeadBackendRecovery({
          stateDir: app.root,
          instance: makeBackendInstance(lock!, app.root),
          records,
          privateKey: app.artifact.privateKey,
        }))!,
      scope: {
        storageIdentity: owner.storageIdentity,
        nativeSessionId: owner.nativeSessionId,
        threadId: owner.threadId,
        directory: owner.directory,
      },
    });
  } finally {
    await lock?.release();
    await dispose();
    await app.close();
  }
}
