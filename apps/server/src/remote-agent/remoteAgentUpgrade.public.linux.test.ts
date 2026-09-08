import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { configureRemoteAgentOwners, parseRemoteAgentOwner } from "./remoteAgentOwners.ts";
import { makeRemoteAgentAdmission, remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import * as Control from "./remoteAgentControl.ts";
import * as RemoteDefault from "./remoteAgentDefault.ts";
import {
  createLinuxControlFixture,
  linuxFixtureAvailability,
} from "./remoteAgentUpgrade.linux.fixtures.ts";
import { installSourceFixture } from "./remoteAgentUpgrade.installFixture.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { makeOwnedRemoteAgentProcess } from "./remoteAgentOwnedProcess.ts";
import { makeRemoteAgentToolRunner } from "./remoteAgentToolRunner.ts";
import { runRestartFixtureTool } from "./remoteAgentOwners.httpFixture.ts";

const enabled = linuxFixtureAvailability("aarch64", ["legacy", "candidate"]).available;

it.runIf(enabled)(
  "public HTTP tool reply loss, application restart, activation and pruning execute each origin only once",
  async () => {
    const fixture = createLinuxControlFixture();
    const directory = mkdtempSync(join(tmpdir(), "bigbud-public-replay-"));
    const home = "/tmp/home";
    await fixture.run("mkdir -p -m 700 /tmp/home /tmp/workspace /workspace");
    const connections: RemoteAgentConnection[] = [];
    const connect = (_target: string, runtime: RemoteAgentRuntime) => {
      const connection = RemoteAgentConnection.local({
        binaryPath: "docker",
        args: [
          "exec",
          "-i",
          "-e",
          `BIGBUD_AGENT_STATE_DIR=${runtime.statePath}`,
          fixture.container!,
          runtime.binaryPath,
          "--proxy",
        ],
      });
      connections.push(connection);
      return connection;
    };
    const control = await Control.openRemoteAgentControl("ssh:fixture", async (input) => ({
      stdout: await fixture.run(`export HOME='${home}'; ${input.args?.[1] ?? "exit 1"}`),
    }));
    vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue(control);
    let local = ManagedRuntime.make(
      NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
    );
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body);
      try {
        const result = await runRestartFixtureTool(input.id, "/bin/sh", [
          "-c",
          "printf marker >> /tmp/workspace/public-marker",
        ]);
        if (input.loseReply) response.destroy();
        else response.end(JSON.stringify(result));
      } catch (cause) {
        response.statusCode = 502;
        response.end(String(cause));
      }
    });
    try {
      await fixture.run("mkdir -p -m 700 /tmp/home /tmp/workspace");
      await local.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
      let store = await local.runPromise(makeRemoteAgentRuntimeBindings);
      configureRemoteAgentOwners(store);
      const admit = makeRemoteAgentAdmission({
        control: async () => control,
        connect,
        bindings: store,
      });
      vi.spyOn(remoteAgentAdmission, "resolveBinding").mockImplementation((target) =>
        store.getBinding(target),
      );
      const stage = async (version: string, digest: string) =>
        installSourceFixture(
          fixture,
          home,
          control,
          readFileSync(
            join(
              process.env.BIGBUD_TEST_AGENT_FIXTURES!,
              version === "0.2.205" ? "legacy-reviewed-0.2.205" : "candidate-reviewed-0.2.207",
            ),
          ),
          version,
          digest,
        );
      await stage("0.2.205", "461b7865cd28bb2570d9f580405fa53daee7b51f");
      await admit.fresh("ssh:fixture", "old-admission");
      const createPool = () =>
        new RemoteAgentConnectionPool({
          create: async (target, binding) => connect(target, binding!.runtime),
        });
      let pool = createPool();
      const configure = () =>
        vi.spyOn(RemoteDefault, "getConfiguredRemoteAgentComposition").mockReturnValue({
          toolRunner: makeRemoteAgentToolRunner({
            runOwned: makeOwnedRemoteAgentProcess(pool),
            resolve: async () => {
              throw new Error("Unbound dispatch forbidden");
            },
          }),
        } as never);
      configure();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing port");
      const call = (id: string, loseReply = false) =>
        fetch(`http://127.0.0.1:${address.port}`, {
          method: "POST",
          body: JSON.stringify({ id, loseReply }),
        });
      let replyLost = false;
      const first = await call("provider-origin-1", true).catch(() => {
        replyLost = true;
      });
      if (first) throw new Error(await first.text());
      expect(replyLost).toBe(true);
      expect(await fixture.run("cat /tmp/workspace/public-marker")).toBe("marker");
      pool.closeAll();
      await local.dispose();
      local = ManagedRuntime.make(NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }));
      store = await local.runPromise(makeRemoteAgentRuntimeBindings);
      configureRemoteAgentOwners(store);
      pool = createPool();
      configure();
      await stage("0.2.207", "1d02e44cd090cc0e2bce25a2cca1a88442e4873e");
      await makeRemoteAgentAdmission({
        control: async () => control,
        connect,
        bindings: store,
      }).fresh("ssh:fixture", "new-admission");
      await (await call("provider-origin-1")).text();
      expect(await fixture.run("cat /tmp/workspace/public-marker")).toBe("marker");
      const rows = await local.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            route_json: string;
          }>`SELECT route_json FROM remote_agent_runtime_owners`;
        }),
      );
      const owner = parseRemoteAgentOwner(rows[0]!.route_json);
      expect(owner.connectionId).toBe("old-admission");
      for (let index = 0; index < 260; index++) {
        const key = `pruning-fixture:${index}`;
        await store.reserve({ ...owner, ownerKey: key, resourceId: key });
      }
      await store.pruneTerminal();
      expect(await store.get(owner.ownerKey)).toBeUndefined();
      const expired = await call("provider-origin-1");
      expect(expired.status).toBe(502);
      expect(await expired.text()).toContain("expired");
      expect(await fixture.run("cat /tmp/workspace/public-marker")).toBe("marker");
      expect((await call("provider-origin-2")).status).toBe(200);
      expect(await fixture.run("cat /tmp/workspace/public-marker")).toBe("markermarker");
      pool.closeAll();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const connection of connections) connection.close();
      await local.dispose();
      fixture.close();
      rmSync(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
  60_000,
);
