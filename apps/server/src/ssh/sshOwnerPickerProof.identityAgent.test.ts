import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";

import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

type Fixture = Awaited<ReturnType<typeof makeLoopbackPickerFixture>>;

async function withPrivateAgent<A>(
  fixture: Fixture,
  run: (socket: string, publicKey: string) => Promise<A>,
) {
  const socket = path.join(fixture.root, "real-agent");
  const child = spawn("/usr/bin/ssh-agent", ["-D", "-a", socket], {
    cwd: fixture.root,
    env: fixture.env,
    stdio: "ignore",
  });
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => {});
    child.once("close", () => resolve());
  });
  try {
    await vi.waitFor(async () => expect((await lstat(socket)).isSocket()).toBe(true));
    execFileSync("/usr/bin/ssh-add", [fixture.identity], {
      cwd: fixture.root,
      env: { ...fixture.env, SSH_AUTH_SOCK: socket },
      stdio: "ignore",
      timeout: 5_000,
    });
    const publicKey = path.join(fixture.root, "only-public");
    await writeFile(publicKey, await readFile(`${fixture.identity}.pub`), { mode: 0o600 });
    await unlink(fixture.identity);
    return await run(socket, publicKey);
  } finally {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
}

async function meteredAgent(socket: string, backend: string) {
  const peers = new Set<Socket>();
  let requests = 0;
  const server = createServer((client) => {
    // Subscribe before forwarding: any bytes, including an identities query,
    // are observable even if SSH then decides not to request a signature.
    client.on("data", () => requests++);
    const upstream = createConnection(backend);
    for (const peer of [client, upstream]) {
      peers.add(peer);
      peer.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
      peer.once("close", () => {
        peers.delete(peer);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  server.listen(socket);
  await once(server, "listening");
  const close = async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  try {
    await chmod(socket, 0o600);
    return { requests: () => requests, close };
  } catch (error) {
    await close();
    throw error;
  }
}

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "honors an explicit isolated IdentityAgent and ignores the same startup hint under none",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      await withPrivateAgent(fixture, async (backend, identityFile) => {
        const selected = path.join(fixture.root, "selected-agent");
        const agent = await meteredAgent(selected, backend);
        try {
          const clientSandboxPolicy = path.join(fixture.root, "client-agent.sb");
          await writeFile(
            clientSandboxPolicy,
            [
              await readFile(fixture.clientSandboxPolicy, "utf8"),
              `(allow network-outbound (remote unix-socket (path-literal ${JSON.stringify(selected)})))`,
            ].join("\n"),
            { mode: 0o600 },
          );
          const options = await proofOptions({ ...fixture, clientSandboxPolicy });
          const alias = "proof-identity-agent";
          const targetId = `ssh:${alias}`;
          const file = path.join(fixture.root, "agent-config");
          await fixture.start();
          await storageScope(path.join(fixture.root, "agent.sqlite"), (sql) =>
            Effect.promise(async () => {
              for (const mode of ["none", "configured"] as const) {
                await writeFile(
                  file,
                  [
                    `Host ${alias}`,
                    `  HostName ${fixture.loopback}`,
                    `  Port ${fixture.port}`,
                    `  User ${fixture.user}`,
                    `  IdentityFile ${identityFile}`,
                    `  UserKnownHostsFile ${fixture.knownHosts}`,
                    `  IdentityAgent ${mode === "none" ? "none" : selected}`,
                    "",
                  ].join("\n"),
                  { mode: 0o600 },
                );
                const owner = await startPickerProofOwner({
                  ...options,
                  sql,
                  identityFile,
                  targetId,
                  aliasConfig: { file, alias },
                  identityAgentPath: selected,
                });
                try {
                  const list = picker(owner, fixture, targetId);
                  if (mode === "none") {
                    const trust = await owner.inspectTrust();
                    if (trust.state !== "approvalRequired")
                      throw new Error("Expected first-use approval");
                    await owner.approveTrust(trust.challenge);
                    await expect(list()).rejects.toMatchObject({ cause: { code: "authRequired" } });
                    expect(agent.requests()).toBe(0);
                    expect(fixture.acceptedPublicKeys()).toBe(0);
                    continue;
                  }
                  await expect(list()).resolves.toMatchObject({ path: fixture.folder });
                  expect(agent.requests()).toBeGreaterThan(0);
                  await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
                  await rename(selected, path.join(fixture.root, "stale-agent"));
                  const replacement = await meteredAgent(selected, backend);
                  try {
                    const attempts = fixture.connectionStarts();
                    await expect(list()).rejects.toMatchObject({
                      cause: { code: "configUnsupported" },
                    });
                    expect(fixture.connectionStarts()).toBe(attempts);
                    expect(replacement.requests()).toBe(0);
                  } finally {
                    await replacement.close();
                  }
                } finally {
                  await owner.close();
                }
              }
            }),
          );
        } finally {
          await agent.close();
        }
      });
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
