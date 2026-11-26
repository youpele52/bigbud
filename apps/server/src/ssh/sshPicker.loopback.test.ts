import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { ServerListRemoteFoldersError } from "@bigbud/contracts/server/server.remoteFolders";
import { withRemoteExecutionTargetDisconnects } from "../persistence/Layers/RemoteExecutionTargetDisconnects.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  connectExecutionTargetEffect,
  disconnectExecutionTargetEffect,
  listDisconnectedExecutionTargetsEffect,
} from "../ws/wsRemoteConnection.ts";
import { listRemoteFoldersEffect } from "../ws/wsRemoteFolders.ts";
import { trustSshHost } from "./sshHostTrust.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import {
  configureSshTargetDisconnects,
  REMOTE_TARGET_DISCONNECTED_MESSAGE,
  RemoteTargetDisconnectedError,
} from "./sshTargetDisconnects.ts";
import { SshTargetAuthRequiredError } from "./sshTargetUnavailable.ts";

const optedIn = process.env.BIGBUD_TEST_PICKER_LOOPBACK === "1";

function readChallenge(error: unknown, executionTargetId: string): SshHostTrustChallenge {
  if (!Schema.is(ServerListRemoteFoldersError)(error)) throw error;
  const cause = error.cause;
  if (!(cause instanceof SshTargetAuthRequiredError)) throw error;
  expect(cause.authMode).toBe("host-trust");
  expect(cause.executionTargetId).toBe(executionTargetId);
  expect(error.message).toBe(cause.message);
  const prefix = "SSH host trust is required: ";
  expect(error.message.startsWith(prefix)).toBe(true);
  return JSON.parse(error.message.slice(prefix.length));
}

function runWithDisconnectStore<A, E>(dbPath: string, effect: Effect.Effect<A, E>): Promise<A> {
  const persistence = withRemoteExecutionTargetDisconnects(
    makeSqlitePersistenceLive(dbPath, { worker: false }),
  ).pipe(Layer.provide(NodeServices.layer));
  return Effect.runPromise(effect.pipe(Effect.provide(persistence)));
}

describe.skipIf(!optedIn)("F01 legacy picker against a sandboxed loopback sshd", () => {
  const originalEnv = process.env;
  let fixture: Awaited<ReturnType<typeof makeLoopbackPickerFixture>>;

  beforeAll(async () => {
    fixture = await makeLoopbackPickerFixture();
    await fixture.start();
    // Replace rather than merge so no agents, askpass, config or dynamic loader env leaks in.
    process.env = fixture.env;
  }, 30_000);

  afterAll(async () => {
    process.env = originalEnv;
    configureSshTargetDisconnects(undefined, []);
    await fixture?.dispose();
  });

  it("requires exact trust, recovers after sshd restarts, and keeps Disconnect across SQLite rebind until Connect", async () => {
    const {
      root,
      executionTargetId,
      folder,
      home,
      host,
      knownHosts,
      hostPublicKey,
      wrongPublicKey,
      launchNames,
    } = fixture;
    const target = { executionTargetId };
    const input = { ...target, path: `~/${path.basename(folder)}` };
    const list = () => Effect.runPromise(listRemoteFoldersEffect(input));
    const latencyMs: Record<string, number> = {};
    const measure = async <A>(name: string, operation: () => Promise<A>): Promise<A> => {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        latencyMs[name] = Math.round(performance.now() - start);
      }
    };

    const challenge = await measure("unknown", () =>
      list().then(
        () => {
          throw new Error("Unknown host unexpectedly listed folders.");
        },
        (error: unknown) => readChallenge(error, executionTargetId),
      ),
    );
    const blob = Buffer.from(hostPublicKey.split(" ")[1]!, "base64");
    const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
    expect([host, `${host} (${host})`]).toContain(challenge.host);
    expect(challenge).toMatchObject({ keyType: "ED25519", fingerprint });
    expect(await readFile(knownHosts, "utf8")).toBe("");
    await expect(
      measure("approve", () => trustSshHost({ ...target, challengeId: challenge.challengeId })),
    ).resolves.toEqual({ message: "SSH server identity trusted. Continue connecting." });
    const trusted = await readFile(knownHosts, "utf8");
    expect(trusted.trim()).toBe(`${host} ${hostPublicKey}`);
    expect(await launchNames()).toEqual(["ssh-keygen", "ssh", "ssh", "ssh"]);

    const listing = {
      path: folder,
      homePath: home,
      folders: [
        { name: "alpha", isGitRepo: false },
        { name: "Z repo", isGitRepo: true },
      ],
      truncated: false,
    };
    await expect(measure("coldList", list)).resolves.toEqual(listing);
    await expect(measure("repeatList", list)).resolves.toEqual(listing);
    await writeFile(knownHosts, `${host} ${wrongPublicKey}\n`);
    await expect(measure("wrongPin", list)).rejects.toThrow(
      "The SSH server's identity has changed or was revoked. Connection blocked.",
    );
    expect(await readFile(knownHosts, "utf8")).toBe(`${host} ${wrongPublicKey}\n`);
    await writeFile(knownHosts, trusted);
    const beforeOutage = await launchNames();
    expect(beforeOutage).toEqual([
      "ssh-keygen",
      "ssh",
      "ssh",
      "ssh", // rejected listing, credential-free inspect and approval
      "ssh-keygen",
      "ssh", // first pinned listing
      "ssh-keygen",
      "ssh", // independent repeat (no ControlMaster)
      "ssh-keygen",
      "ssh",
      "ssh", // wrong pin and credential-free inspect
    ]);
    expect(fixture.acceptedPublicKeys()).toBe(2);

    // This is a new picker connection, not automatic reconnect of an in-flight operation.
    await measure("stopSshd", fixture.stop);
    await expect(measure("offlineList", list)).rejects.toMatchObject({
      _tag: "ServerListRemoteFoldersError",
      message: expect.stringContaining("Connection refused"),
    });
    expect(await launchNames()).toEqual([...beforeOutage, "ssh-keygen", "ssh"]);
    await measure("restartSshd", fixture.start);
    await expect(measure("recoveredList", list)).resolves.toEqual(listing);
    expect(fixture.acceptedPublicKeys()).toBe(1);
    expect(await readFile(knownHosts, "utf8")).toBe(trusted);
    const beforeDisconnect = await launchNames();
    expect(beforeDisconnect).toEqual([...beforeOutage, "ssh-keygen", "ssh", "ssh-keygen", "ssh"]);

    const dbPath = path.join(root, "state.sqlite");
    const expectBlocked = async (label: string) => {
      await expect(measure(label, list)).rejects.toMatchObject({
        _tag: "ServerListRemoteFoldersError",
        message: REMOTE_TARGET_DISCONNECTED_MESSAGE,
        cause: expect.any(RemoteTargetDisconnectedError),
      });
      expect(await launchNames()).toEqual(beforeDisconnect);
    };
    const readDisconnects = () => Effect.runPromise(listDisconnectedExecutionTargetsEffect());

    await runWithDisconnectStore(
      dbPath,
      Effect.promise(async () => {
        // No runtime teardown steps: this fixture owns no provider, agent or terminal sessions.
        await expect(
          measure("disconnect", () =>
            Effect.runPromise(disconnectExecutionTargetEffect(target, [])),
          ),
        ).resolves.toEqual({ ...target, disconnected: true });
        await expectBlocked("disconnectedList");
      }),
    );

    // The first storage scope is closed. Empty memory before installing the fresh backend binding.
    // This reloads from disk in the same test process; it does not restart the backend executable.
    configureSshTargetDisconnects(undefined, []);
    await expect(readDisconnects()).resolves.toEqual({ executionTargetIds: [] });
    await runWithDisconnectStore(
      dbPath,
      Effect.promise(async () => {
        await expect(readDisconnects()).resolves.toEqual({
          executionTargetIds: [executionTargetId],
        });
        await expectBlocked("reboundDisconnectedList");
        await expect(
          measure("connect", () => Effect.runPromise(connectExecutionTargetEffect(target))),
        ).resolves.toEqual({ ...target, disconnected: false });
        expect(await launchNames()).toEqual(beforeDisconnect);
        await expect(measure("connectedList", list)).resolves.toEqual(listing);
      }),
    );
    const finalLaunches = await launchNames();
    expect(finalLaunches).toEqual([...beforeDisconnect, "ssh-keygen", "ssh"]);
    expect(fixture.acceptedPublicKeys()).toBe(2);
    expect(await readFile(knownHosts, "utf8")).toBe(trusted);

    configureSshTargetDisconnects(undefined, []);
    await expect(
      runWithDisconnectStore(dbPath, listDisconnectedExecutionTargetsEffect()),
    ).resolves.toEqual({ executionTargetIds: [] });
    expect(await launchNames()).toEqual(finalLaunches);

    console.info("F01 loopback legacy picker", {
      platform: `${process.platform}/${process.arch} (${release()})`,
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
      ssh: fixture.ssh,
      sshd: fixture.sshd,
      versions: fixture.versions,
      launchCounts: {
        ssh: finalLaunches.filter((name) => name === "ssh").length,
        sshKeygen: finalLaunches.filter((name) => name === "ssh-keygen").length,
        afterDisconnect: 0,
        afterRebindWhileDisconnected: 0,
      },
      latencyMs,
    });
  }, 60_000);
});
