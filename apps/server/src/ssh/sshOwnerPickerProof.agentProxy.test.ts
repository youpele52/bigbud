import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
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
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

async function stageAgent(root: string, home: string) {
  await mkdir(root, { mode: 0o700 });
  const artifact = fileURLToPath(
    new URL("../../../../target/debug/bigbud-remote-agent", import.meta.url),
  );
  const identity = execFileSync(artifact, ["--check"], {
    cwd: root,
    env: { HOME: home },
    encoding: "utf8",
    timeout: 5_000,
  }).trim();
  const [name, version, , , , platform] = identity.split("\t");
  if (name !== "bigbud-remote-agent" || platform !== "macos" || !version)
    throw new Error("Expected an owned macOS fixture agent build");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(artifact)) digest.update(chunk);
  const binaryPath = path.join(root, "bigbud-remote-agent");
  await copyFile(artifact, binaryPath);
  await chmod(binaryPath, 0o700);
  return { version, binaryPath, sha256: digest.digest("hex") };
}

// The production installed-runtime descriptor intentionally accepts Linux agents
// only. Test the real macOS agent's bytes without weakening that admission check.
function receiveFirstAgentFrame(stream: Readable) {
  return new Promise<ReturnType<typeof decodeDelimitedFrame>>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(
      () => onError(new Error("Timed out waiting for fixture agent hello")),
      5_000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => onError(new Error("Fixture agent closed before hello"));
    const onData = (chunk: Buffer) => {
      if (buffered.length + chunk.length > REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES + 4) {
        onError(new Error("Oversized fixture agent frame"));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32BE(0);
      if (length > REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES) {
        onError(new Error("Oversized fixture agent frame"));
        return;
      }
      if (buffered.length < length + 4) return;
      try {
        const frame = decodeDelimitedFrame(buffered.subarray(0, length + 4));
        cleanup();
        resolve(frame);
      } catch (error) {
        onError(error);
      }
    };
    stream.on("error", onError);
    stream.on("end", onEnd);
    stream.on("data", onData);
  });
}

it.skipIf(!pickerProofOptedIn)(
  "runs a real ephemeral agent's binary handshake over native inherited SSH byte pipes",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const artifact = await stageAgent(path.join(fixture.root, "agent"), fixture.home);
      const options = await proofOptions(fixture);
      await fixture.start();
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await storageScope(path.join(fixture.root, "agent-proxy.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            agentProxyFixture: { binaryPath: artifact.binaryPath, sha256: artifact.sha256 },
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected fixture trust approval");
            await owner.approveTrust(trust.challenge);
            const target = { executionTargetId: options.targetId, binaryPath: artifact.binaryPath };
            const before = fixture.connectionStarts();
            await expect(
              owner.openProofAgentProxy({ ...target, sha256: "0".repeat(64) }),
            ).rejects.toMatchObject({
              code: "operationDenied",
            });
            expect(fixture.connectionStarts()).toBe(before);
            const lease = await owner.openProofAgentProxy({ ...target, sha256: artifact.sha256 });
            try {
              lease.pipes.stderr.resume();
              const firstFrame = receiveFirstAgentFrame(lease.pipes.stdout);
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
              await expect(firstFrame).resolves.toMatchObject({
                type: "agentHello",
                value: {
                  agentVersion: artifact.version,
                  protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
                },
              });
              await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
              await lease.close({ mode: "graceful", timeoutMs: 2_000 });
              await expect(lease.exit).resolves.toEqual({ code: 0, signal: null });
            } finally {
              await lease.close({ mode: "terminate", timeoutMs: 2_000 });
            }
            const after = fixture.connectionStarts();
            await expect(
              owner.openProofAgentProxy({ ...target, sha256: artifact.sha256 }),
            ).rejects.toMatchObject({ code: "operationDenied" });
            expect(fixture.connectionStarts()).toBe(after);
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);
