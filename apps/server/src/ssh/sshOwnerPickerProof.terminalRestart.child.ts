import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import type { RemoteAgentOwner } from "../remote-agent/remoteAgentOwners.ts";
import { makeNativeDirectSshTerminal } from "../terminal-host/localTerminalHost.directSsh.owner.ts";
import { nativeDirectSshBinding } from "../terminal-host/localTerminalHost.directSsh.owner.lifecycle.ts";
import type { PtySequencedData, PtySpawnInput } from "../terminal/Services/PTY.ts";
import { attachPickerProofOwner, type PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import type { PickerProofTerminalReplay } from "./sshOwnerPickerProof.codec.terminal.ts";
import { makePickerProofTerminalAdapter } from "./sshOwnerPickerProof.terminalAdapter.ts";
import { verifyProofTerminalReplay } from "./sshOwnerPickerProof.terminalAdapter.replay.ts";
import { makeTerminalRestartRecovery } from "./sshOwnerPickerProof.terminalRestart.recovery.ts";

export type TerminalRestartRequest = {
  database: string;
  socketPath: string;
  capability: string;
  profileBinding: string;
  targetId: string;
  cwd: string;
} & ({ phase: "open"; marker: string } | { phase: "recover" });

export interface TerminalRestartObservation {
  dispatcherPid: number;
  ptyPid: number;
  recovered: boolean | undefined;
  resourceId: string | undefined;
  epoch: string;
  writer: string;
  route: RemoteAgentOwner;
  chunks: ReadonlyArray<{ sequence: number; base64: string }>;
  nextSequence: number;
  delivered?: PtySequencedData[];
  closedState?: RemoteAgentOwner["state"] | undefined;
}

const pane = JSON.stringify(["restart-thread", "restart-pane"]);
const key = `terminal:${pane}`;
const ready = "BIGBUD_SSH_OWNER_PROOF_PTY_READY";
const echo = "BIGBUD_SSH_OWNER_PROOF_PTY_ECHO:";
const text = (cut: PickerProofTerminalReplay) =>
  Buffer.concat(cut.chunks.map(({ data }) => data)).toString();

async function waitFor<A>(probe: () => A | undefined | Promise<A | undefined>, message: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await delay(25);
  }
  throw new Error(message);
}

async function dispatch(
  request: TerminalRestartRequest,
  sql: SqlClient.SqlClient,
  owner: PickerProofOwner,
): Promise<TerminalRestartObservation> {
  const { targetId, phase, cwd } = request;
  const root = path.dirname(request.database);
  const binaryPath = path.join(root, "picker-owner");
  const sha256 = createHash("sha256")
    .update(await readFile(binaryPath))
    .digest("hex");
  const store = await Effect.runPromise(
    makeRemoteAgentRuntimeBindings.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  );
  const [writer] = await Effect.runPromise(sql<{ epoch: string }>`
    SELECT writer_epoch AS epoch FROM ssh_owner_writer WHERE singleton = 1
  `);
  if (!writer) throw new Error("The proof dispatcher did not hydrate the SQLite writer.");
  const retained = await store.get(key);
  if ((phase === "open" && retained) || (phase === "recover" && !retained))
    throw new Error("Unexpected durable pane state at process startup.");

  let cold: PickerProofTerminalReplay | undefined;
  let writeReceipt: ReturnType<PickerProofOwner["writeProofTerminalInput"]> | undefined;
  const port =
    phase === "open"
      ? makePickerProofTerminalAdapter(
          {
            ...owner,
            writeProofTerminalInput: (...args) =>
              (writeReceipt = owner.writeProofTerminalInput(...args)),
          },
          targetId,
        ).port
      : makeTerminalRestartRecovery(owner, targetId, (cut) => {
          cold = cut;
        });
  // The dispatcher intentionally masks transport errors. Retain the cause for this isolated test.
  let dispatchFailure: unknown;
  const record =
    <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) =>
    async (...args: Args) => {
      try {
        return await operation(...args);
      } catch (cause) {
        dispatchFailure = cause;
        throw cause;
      }
    };
  const dispatcher = makeNativeDirectSshTerminal(
    {
      port: {
        ...port,
        prepareOpen: record(port.prepareOpen),
        open: record(port.open),
        reattach: record(port.reattach),
      },
      owners: () => ({ ...store, reserve: record(store.reserve) }),
      runtime: {
        generation: "picker-proof",
        version: "0.1.0",
        sha256,
        buildDigest: sha256,
        targetTriple:
          process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl",
        origin: "legacy-external",
        binaryPath,
        statePath: root,
        // Required metadata for the shared store; this dispatcher never starts a supervisor.
        socketPath: path.join(root, "supervisor.sock"),
        logPath: path.join(root, "supervisor.log"),
      },
    },
    (candidate) => candidate === targetId,
    () => false,
  );
  const input: PtySpawnInput = {
    ownerKey: pane,
    executionTargetId: targetId,
    remoteCwd: cwd,
    cwd: root,
    shell: path.join(root, "no-legacy-shell"),
    args: [],
    env: {},
    cols: 96,
    rows: 34,
  };
  const pty = await Effect.runPromise(
    dispatcher.spawn(
      retained
        ? {
            ...input,
            recoverOnly: true,
            expectedRemoteResourceId: retained.resourceId,
          }
        : input,
    ),
  ).catch((error: unknown) => {
    throw dispatchFailure ?? error;
  });
  const route = await store.get(key);
  if (!route) throw new Error("The dispatcher did not persist the exact proof PTY binding.");
  const binding = nativeDirectSshBinding(route);
  const lease = Buffer.from(binding.leaseId, "hex");
  const receipt = (cut: PickerProofTerminalReplay): TerminalRestartObservation => ({
    dispatcherPid: process.pid,
    ptyPid: pty.pid,
    recovered: pty.recovered,
    resourceId: pty.remoteResourceId,
    epoch: Buffer.from(owner.ownerEpoch).toString("hex"),
    writer: writer.epoch,
    route,
    chunks: cut.chunks.map(({ sequence, data }) => ({
      sequence,
      base64: Buffer.from(data).toString("base64"),
    })),
    nextSequence: cut.nextSequence,
  });

  if (request.phase === "open") {
    const { marker } = request;
    const read = async () =>
      verifyProofTerminalReplay(lease, 0, await owner.replayProofTerminal(lease, 0));
    await waitFor(
      async () => (text(await read()).includes(ready) ? true : undefined),
      "PTY never became ready.",
    );
    let inputError: Error | undefined;
    pty.onError?.((error) => {
      inputError = error;
    });
    pty.write(`${marker}\n`);
    await waitFor(() => {
      if (inputError) throw inputError;
      return writeReceipt;
    }, "The first dispatcher did not send input.");
    const cut = await waitFor(async () => {
      if (inputError) throw inputError;
      const candidate = await read();
      return text(candidate).includes(`${echo}${marker}\r\n`) ? candidate : undefined;
    }, "The first proof PTY did not echo the marker.");
    // Still attached here. The parent kills this process at the barrier; no detach or close runs.
    return receipt(cut);
  }

  if (!cold) throw new Error("The cold dispatcher did not take a replay cut.");
  const cut = cold;
  const delivered: PtySequencedData[] = [];
  pty.onSequencedData?.((event) => delivered.push(event));
  const lifecycle = dispatcher.runtimeForTarget(targetId)?.localSshClient;
  if (!lifecycle) throw new Error("The cold dispatcher has no terminal lifecycle.");
  try {
    await waitFor(
      () => (delivered.length === cut.chunks.length ? true : undefined),
      "The recovered dispatcher did not emit the complete cut.",
    );
  } finally {
    pty.detach?.();
    await lifecycle.close(route);
  }
  return { ...receipt(cut), delivered, closedState: (await store.get(key))?.state };
}

async function run(request: TerminalRestartRequest) {
  const layer = makeSqlitePersistenceLive(request.database, { worker: false }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const observation = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* Effect.promise(async () => {
        const owner = await attachPickerProofOwner({
          socketPath: request.socketPath,
          capability: Buffer.from(request.capability, "hex"),
          profileBinding: Buffer.from(request.profileBinding, "hex"),
          targetId: request.targetId,
          sql,
        });
        try {
          if (request.phase === "open") {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected isolated first-use trust.");
            await owner.approveTrust(trust.challenge);
          }
          const result = await dispatch(request, sql, owner);
          if (request.phase === "recover") return result;
          process.send?.({ observation: result });
          // Keep both SQLite and the Unix attachment open until actual process death.
          await new Promise<void>((resolve) => process.once("disconnect", resolve));
          return undefined;
        } finally {
          await owner.close();
        }
      });
    }).pipe(Effect.provide(layer)),
  );
  if (observation) process.send?.({ observation });
}

process.once("message", (request: TerminalRestartRequest) => {
  void run(request)
    .catch((cause: unknown) => {
      process.exitCode = 1;
      process.send?.({ error: String(cause) });
    })
    .finally(() => {
      if (process.connected) process.disconnect();
    });
});
