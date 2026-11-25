import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, vi } from "vitest";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import { TerminalViewRegistry } from "../terminal/activity/terminalViewRegistry.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager.process.ts";
import type { TerminalManagerOptions } from "../terminal/Layers/Manager.types.ts";
import { makeSshOwnerDevTerminal } from "./sshOwnerDevTerminal.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { proofOptions, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

type LoopbackFixture = Awaited<ReturnType<typeof makeLoopbackPickerFixture>>;

const setup = Effect.fn("sshOwnerDevTerminal.managerFixture")(function* (input: {
  fixture: LoopbackFixture;
  options: Awaited<ReturnType<typeof proofOptions>>;
  label: string;
  database: string;
  sql: SqlClient.SqlClient;
}) {
  const { fixture, options, label, database, sql } = input;
  const binaryPath = path.join(fixture.root, "picker-owner");
  const launcher = path.join(fixture.root, "start-interactive-owner");
  const sha256 = yield* Effect.promise(async () => {
    await writeFile(
      launcher,
      `#!/bin/sh\nexec '${options.binary}' "$@" --dev-interactive-terminal\n`,
      {
        mode: 0o700,
      },
    );
    return createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex");
  });
  const targetId = options.targetId.replace("transport=agent", "transport=direct-ssh");
  const pane = {
    threadId: `${label}-thread`,
    terminalId: `${label}-pane`,
    executionTargetId: targetId,
    cwd: fixture.folder,
    cols: 80,
    rows: 24,
  };
  const key = `terminal:${JSON.stringify([pane.threadId, pane.terminalId])}`;
  const store = yield* makeRemoteAgentRuntimeBindings.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  // Read only committed owner rows, independently of the manager's connection.
  const readerRuntime = yield* Effect.acquireRelease(
    Effect.sync(() => ManagedRuntime.make(NodeSqlite.layer({ filename: database }))),
    (runtime) => Effect.promise(() => runtime.dispose()),
  );
  const reader = yield* Effect.promise(() =>
    readerRuntime.runPromise(makeRemoteAgentRuntimeBindings),
  );
  const owner = yield* Effect.acquireRelease(
    Effect.promise(() =>
      startPickerProofOwner({
        ...options,
        binary: launcher,
        targetId,
        sql,
        workspaceRoot: fixture.folder,
      }),
    ),
    (owner) => Effect.promise(() => owner.close()),
  );
  yield* Effect.promise(async () => {
    const trust = await owner.inspectTrust();
    if (trust.state !== "approvalRequired") throw new Error("Expected isolated first-use trust");
    await owner.approveTrust(trust.challenge);
  });
  const dev = makeSshOwnerDevTerminal({
    targetId,
    workspaceRoot: fixture.folder,
    withOwner: async (id, use) => {
      expect(id).toBe(targetId);
      return use(owner);
    },
    owners: () => store,
    runtime: {
      generation: `manager-${label}-fixture`,
      version: "0.1.0",
      sha256,
      buildDigest: sha256,
      targetTriple:
        process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl",
      origin: "legacy-external",
      binaryPath,
      statePath: fixture.root,
      socketPath: path.join(fixture.root, "supervisor.sock"),
      logPath: path.join(fixture.root, "supervisor.log"),
    },
  });
  const fallback = vi.fn(() => Effect.die("legacy PTY fallback was called"));
  const adapter = dev.wrapPtyAdapter({ spawn: fallback });
  const spawn = vi.spyOn(adapter, "spawn");
  const makeManager = (
    quit?: Partial<
      Pick<TerminalManagerOptions, "resolveQuitIntent" | "keepRunningAfterQuit" | "logsDir">
    >,
  ) =>
    makeTerminalManagerWithOptions({
      logsDir: path.join(fixture.root, "logs"),
      ptyAdapter: adapter,
      directSshCwdOwner: dev.cwdOwner,
      agentDetector: () => Effect.succeed(new Map()),
      subprocessPollIntervalMs: 60_000,
      views: new TerminalViewRegistry(),
      ...quit,
    });
  return { fixture, targetId, pane, key, reader, owner, fallback, adapter, spawn, makeManager };
});

type ManagerFixture = Effect.Success<ReturnType<typeof setup>>;

export async function withSshOwnerDevTerminalManager<A, E>(
  label: string,
  body: (
    fixture: ManagerFixture,
  ) => Effect.Effect<A, E, Effect.Services<ReturnType<ManagerFixture["makeManager"]>>>,
) {
  const fixture = await makeLoopbackPickerFixture({ allowInteractiveShell: true });
  try {
    const options = await proofOptions(fixture, undefined, true);
    const database = path.join(fixture.root, `manager-${label}.sqlite`);
    await fixture.start();
    vi.stubEnv("HOME", fixture.home);
    vi.stubEnv("PATH", fixture.env.PATH);
    return await storageScope(database, (sql) =>
      setup({ fixture, options, label, database, sql }).pipe(
        Effect.flatMap(body),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    );
  } finally {
    vi.unstubAllEnvs();
    await fixture.dispose();
  }
}
