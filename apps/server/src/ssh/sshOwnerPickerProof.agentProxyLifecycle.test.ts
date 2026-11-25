import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import {
  decodeDelimitedFrame,
  encodeDelimitedFrame,
} from "../remote-agent/remoteAgentProtocol.codec.ts";
import {
  REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
  REMOTE_AGENT_PROTOCOL_MAJOR,
  REMOTE_AGENT_PROTOCOL_MINOR,
} from "../remote-agent/remoteAgentProtocol.ts";
import type { PickerProofAgentProxyInput } from "./sshOwnerPickerProof.client.agentProxy.ts";
import {
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

type Fixture = Awaited<ReturnType<typeof makeLoopbackPickerFixture>>;

// A readable listener primes Node's buffer without consuming the agent's bytes.
const keepPaused = () => {};

async function withApprovedProxy(
  run: (
    fixture: Fixture,
    owner: LaunchedPickerProofOwner,
    target: PickerProofAgentProxyInput,
  ) => Promise<void>,
) {
  const fixture = await makeLoopbackPickerFixture();
  try {
    // This deliberately stages only the local ephemeral fixture, not a managed-runtime artifact.
    const agentDir = path.join(fixture.root, "agent");
    const binaryPath = path.join(agentDir, "bigbud-remote-agent");
    await mkdir(agentDir, { mode: 0o700 });
    await copyFile(
      new URL("../../../../target/debug/bigbud-remote-agent", import.meta.url),
      binaryPath,
    );
    await chmod(binaryPath, 0o700);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(binaryPath)) digest.update(chunk);
    const sha256 = digest.digest("hex");
    const options = await proofOptions(fixture);
    await fixture.start();
    vi.stubEnv("PATH", fixture.env.PATH);
    vi.stubEnv("HOME", fixture.home);
    await storageScope(path.join(fixture.root, "agent-proxy-lifecycle.sqlite"), (sql) =>
      Effect.promise(async () => {
        const owner = await startPickerProofOwner({
          ...options,
          sql,
          agentProxyFixture: { binaryPath, sha256 },
        });
        try {
          const trust = await owner.inspectTrust();
          if (trust.state !== "approvalRequired")
            throw new Error("Expected fixture trust approval");
          await expect(owner.approveTrust(trust.challenge)).resolves.toMatchObject({
            state: "verified",
            fingerprint: trust.fingerprint,
          });
          await run(fixture, owner, { executionTargetId: options.targetId, binaryPath, sha256 });
        } finally {
          await owner.close();
        }
      }),
    );
  } finally {
    vi.unstubAllEnvs();
    await fixture.dispose();
  }
}

async function readFirstAgentFrame(stdout: Readable, drain = true) {
  const timeout = setTimeout(
    () => stdout.destroy(new Error("Fixture agent hello timed out")),
    5_000,
  );
  try {
    let bytes = Buffer.alloc(0);
    for await (const chunk of stdout.iterator({ destroyOnReturn: false })) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) continue;
      const length = bytes.readUInt32BE(0);
      if (length > REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES) throw new Error("Oversized agent hello");
      if (bytes.length >= length + 4) return decodeDelimitedFrame(bytes.subarray(0, length + 4));
    }
    throw new Error("Fixture agent closed before hello");
  } finally {
    clearTimeout(timeout);
    if (drain) stdout.resume();
  }
}

it.skipIf(!pickerProofOptedIn).each(["cancel", "disconnect"] as const)(
  "keeps owner control responsive while native agent output is backpressured (%s)",
  (action) =>
    withApprovedProxy(async (fixture, owner, target) => {
      const name = "backpressure.bin";
      const size = (REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES * 3) / 4;
      await writeFile(path.join(fixture.folder, name), randomBytes(size));
      const lease = await owner.openProofAgentProxy(target);
      lease.pipes.stderr.resume();
      const { stdin, stdout } = lease.pipes;
      const send = (frame: Parameters<typeof encodeDelimitedFrame>[0]) =>
        stdin.write(encodeDelimitedFrame(frame));
      send({
        type: "clientHello",
        value: {
          protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
          protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
          clientInstanceId: randomUUID(),
          connectionId: randomUUID(),
          serverNonce: randomUUID(),
          maxFrameBytes: REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
        },
      });
      await expect(readFirstAgentFrame(stdout, false)).resolves.toMatchObject({
        type: "agentHello",
      });
      const workspaceHandle = randomUUID();
      send({
        type: "workspaceOpenRequest",
        value: { requestId: randomUUID(), workspaceHandle, root: fixture.folder },
      });
      await expect(readFirstAgentFrame(stdout, false)).resolves.toMatchObject({
        type: "workspaceOpenResponse",
        value: { accepted: true },
      });
      const requestId = randomUUID();
      stdout.on("readable", keepPaused);
      send({
        type: "readFileRequest",
        value: {
          requestId,
          operationId: requestId,
          requestDigest: new Uint8Array(32).fill(1),
          workspaceHandle,
          path: name,
          offset: 0,
          maxBytes: size,
        },
      });
      try {
        await vi.waitFor(
          () => expect(stdout.readableLength).toBeGreaterThanOrEqual(stdout.readableHighWaterMark),
          { timeout: 5_000 },
        );
        await expect(owner.sampleProofHealth(target.executionTargetId)).resolves.toBe(true);
        expect(stdout.readableLength).toBeGreaterThanOrEqual(stdout.readableHighWaterMark);
        if (action === "cancel") {
          await lease.close({ mode: "terminate", timeoutMs: 3_000 });
        } else {
          await expect(owner.disconnect()).resolves.toEqual({ state: "disconnected" });
          await expect(owner.sampleProofHealth(target.executionTargetId)).rejects.toMatchObject({
            code: "targetDisconnected",
          });
        }
      } finally {
        stdout.off("readable", keepPaused);
        stdout.resume();
      }
      await vi.waitFor(() => expect(stdout.readableEnded).toBe(true), { timeout: 5_000 });
      const exit = await lease.exit;
      expect([255, "SIGTERM", "SIGKILL"]).toContain(exit.code ?? exit.signal);
    }),
  120_000,
);

it.skipIf(!pickerProofOptedIn)(
  "blocks the native proxy launch when the staged agent bytes change after trust approval",
  () =>
    withApprovedProxy(async (fixture, owner, target) => {
      const attempts = fixture.connectionStarts();
      // Keep the exact registered path, mode and request digest: only on-disk bytes change.
      await appendFile(target.binaryPath, "modified after trust approval\n");
      await expect(owner.openProofAgentProxy(target)).rejects.toMatchObject({
        code: "operationDenied",
      });
      expect(fixture.connectionStarts()).toBe(attempts);
      expect(fixture.acceptedPublicKeys()).toBe(0);
      expect(await fixture.launchNames()).toEqual([]);
    }),
  120_000,
);

it.skipIf(!pickerProofOptedIn)(
  "Disconnect revokes a live native agent proxy and confirms its exit over the inherited pipes",
  () =>
    withApprovedProxy(async (fixture, owner, target) => {
      const lease = await owner.openProofAgentProxy(target);
      lease.pipes.stderr.resume();
      const hello = readFirstAgentFrame(lease.pipes.stdout);
      lease.pipes.stdin.write(
        encodeDelimitedFrame({
          type: "clientHello",
          value: {
            protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
            protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
            clientInstanceId: randomUUID(),
            connectionId: randomUUID(),
            serverNonce: randomUUID(),
            maxFrameBytes: REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
          },
        }),
      );
      await expect(hello).resolves.toMatchObject({
        type: "agentHello",
        value: { os: "macos", protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR },
      });
      await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
      expect(lease.pipes.stdin.writable).toBe(true);
      expect(lease.pipes.stdout.readableEnded).toBe(false);
      const attempts = fixture.connectionStarts();

      // Do not end stdin or call lease.close(): only Disconnect may revoke this live proxy.
      await expect(owner.disconnect()).resolves.toEqual({ state: "disconnected" });
      const timeout = new AbortController();
      try {
        const exit = await Promise.race([
          lease.exit,
          delay(5_000, undefined, { signal: timeout.signal }).then(() => {
            throw new Error("Disconnect did not confirm the proxy exit");
          }),
        ]);
        // OpenSSH can handle SIGTERM itself (exit 255) or be reaped by signal.
        expect([255, "SIGTERM", "SIGKILL"]).toContain(exit.code ?? exit.signal);
        expect(lease.pipes.stdout.readableEnded).toBe(true);
        expect(lease.pipes.stderr.readableEnded).toBe(true);
        expect(lease.pipes.stdin.destroyed).toBe(true);
      } finally {
        timeout.abort();
      }
      // The consumed proxy slot alone cannot prove the target's admission is closed.
      await expect(owner.sampleProofHealth(target.executionTargetId)).rejects.toMatchObject({
        code: "targetDisconnected",
      });
      expect(fixture.connectionStarts()).toBe(attempts);
      expect(await fixture.launchNames()).toEqual([]);
    }),
  120_000,
);
