import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { buildIsolatedRemoteAgentLaunch } from "./remoteAgentRuntime.launch.ts";
import {
  createLinuxControlFixture,
  linuxFixtureAvailability,
} from "./remoteAgentUpgrade.linux.fixtures.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";

const enabled = linuxFixtureAvailability("aarch64", ["legacy"]).available;

// Exact source-built fixtures, NOT authentication/certification of published release bytes.
describe.runIf(enabled)("actual legacy Linux source fixture continuity", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  const connections: RemoteAgentConnection[] = [];
  const oldState = "/tmp/old-state";
  function proxy(binary: string, state: string) {
    const connection = RemoteAgentConnection.local({
      binaryPath: "docker",
      args: [
        "exec",
        "-i",
        "-e",
        `BIGBUD_AGENT_STATE_DIR=${state}`,
        fixture.container!,
        binary,
        "--proxy",
      ],
    });
    connections.push(connection);
    return connection;
  }
  async function waitForSocket(path: string) {
    await fixture.run(
      `for n in $(seq 1 100); do test ! -S '${path}' || exit 0; sleep .05; done; exit 1`,
    );
  }
  beforeAll(async () => {
    fixture = createLinuxControlFixture();
    await fixture.run(
      `mkdir -m 700 '${fixture.root}' '${oldState}' /tmp/workspace; BIGBUD_AGENT_STATE_DIR='${oldState}' nohup /fixtures/legacy-reviewed-0.2.205 --supervisor </dev/null >/tmp/legacy.log 2>&1 &`,
    );
    await waitForSocket(`${oldState}/supervisor.sock`);
  });
  afterAll(() => {
    for (const connection of connections) connection.close();
    fixture?.close();
  });

  it("keeps old operation recovery isolated from candidate startup and refuses cross-journal replay", async () => {
    const old = proxy("/fixtures/legacy-reviewed-0.2.205", oldState);
    const hello = await old.handshake();
    expect(hello.agentVersion).toBe("0.1.0");
    expect(hello.buildDigest).toBe("461b7865cd28bb2570d9f580405fa53daee7b51f");
    await new RemoteAgentWorkspaceClient(old).openWorkspace("workspace", "/tmp/workspace");
    const accepted = await old.request(
      {
        type: "processRequest",
        value: {
          requestId: "run",
          operationId: "owned-operation",
          requestDigest: remoteAgentRequestDigest("one-execution"),
          workspaceHandle: "workspace",
          command: "/bin/sh",
          args: ["-c", "printf marker >> /tmp/workspace/marker; sleep 1; printf retained-output"],
          timeoutMs: 10_000,
          maxOutputBytes: 4096,
        },
      },
      (frame) => frame.type === "processAccepted",
    );
    expect(accepted.type === "processAccepted" && accepted.value.accepted).toBe(true);
    old.close();
    const epoch = await fixture.run(`cat '${oldState}/epoch'`);
    const identity = await fixture.run("/fixtures/candidate-reviewed-0.2.207 --check");
    expect(identity).toContain("0.2.207");
    expect(await fixture.run(`cat '${oldState}/epoch'`)).toBe(epoch);
    const sha256 = (
      await fixture.run("sha256sum /fixtures/candidate-reviewed-0.2.207 | cut -d ' ' -f1")
    ).trim();
    const statePath = `${fixture.root}/runtimes/candidate`;
    const binaryPath = `${fixture.root}/bin/0.2.207/${sha256}/bigbud-remote-agent`;
    await fixture.run(
      `mkdir -p -m 700 '${fixture.root}/bin/0.2.207/${sha256}'; cp /fixtures/candidate-reviewed-0.2.207 '${binaryPath}'; chmod 700 '${binaryPath}'`,
    );
    expect(
      await fixture.run(
        buildIsolatedRemoteAgentLaunch(
          {
            generation: "candidate",
            version: "0.2.207",
            sha256,
            buildDigest: "1d02e44cd090cc0e2bce25a2cca1a88442e4873e",
            targetTriple: "aarch64-unknown-linux-gnu",
            binaryPath,
            statePath,
            socketPath: `${statePath}/supervisor.sock`,
            logPath: `${statePath}/supervisor.log`,
            origin: "managed",
          },
          "candidate-attempt",
        ),
      ),
    ).toBe("launch-reserved");
    await waitForSocket(`${statePath}/supervisor.sock`);
    const candidate = proxy(binaryPath, statePath);
    expect((await candidate.handshake()).agentVersion).toBe("0.2.207");
    await expect(
      new RemoteAgentProcessClient(candidate).attach({ operationId: "owned-operation" }),
    ).rejects.toMatchObject({ code: "PROCESS_OUTCOME_UNKNOWN" });
    const recovery = proxy("/fixtures/legacy-reviewed-0.2.205", oldState);
    expect((await recovery.handshake()).agentEpoch).toBe(hello.agentEpoch);
    const result = await new RemoteAgentProcessClient(recovery).attach({
      operationId: "owned-operation",
    });
    expect(new TextDecoder().decode(result.stdout)).toBe("retained-output");
    expect(await fixture.run("cat /tmp/workspace/marker")).toBe("marker");
    expect(await fixture.run(`cat '${oldState}/epoch'`)).toBe(epoch);
  });

  it("actual legacy missing/expired cancel terminal flag is unknown, not completion", async () => {
    const connection = proxy("/fixtures/legacy-reviewed-0.2.205", oldState);
    await connection.handshake();
    const client = new RemoteAgentProcessClient(connection);
    expect(await client.cancel({ operationId: "missing" })).toMatchObject({
      terminal: true,
      detail: "operation-unknown-or-expired",
    });
    await expect(client.cancelAndWait({ operationId: "missing" })).rejects.toMatchObject({
      code: "PROCESS_OUTCOME_UNKNOWN",
    });
  });
});
