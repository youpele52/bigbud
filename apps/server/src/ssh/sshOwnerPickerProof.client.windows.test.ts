import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import * as Effect from "effect/Effect";
import { beforeEach, expect, it, vi } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { startWindowsPickerProofOwner } from "./sshOwnerPickerProof.client.windows.ts";
import { encodeHello, encodeStorageSnapshot, OWNER_MAJOR } from "./sshOwnerPickerProof.codec.ts";
import { decodeOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";

vi.mock("node:process", async (load) => ({
  ...(await load<typeof import("node:process")>()),
  platform: "win32",
}));
vi.mock("node:child_process", async (load) => ({
  ...(await load<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const executable = "C:\\trusted build\\bigbud-ssh-owner.exe";
const profileBinding = Buffer.from("a1b2", "hex");
const targetId = "windows-loopback";
const options = {
  binary: executable,
  profileBinding,
  targetId,
  lockFile: "C:\\private profile\\owner.lock",
  port: 22_222,
  user: "test-user",
  identityFile: "C:\\private profile\\id_ed25519",
  knownHostsFile: "C:\\private profile\\known_hosts",
};

function framed(payload: Uint8Array) {
  const bytes = Buffer.alloc(4 + payload.length);
  bytes.writeUInt32BE(payload.length);
  bytes.set(payload, 4);
  return bytes;
}

function ownerFrame(tag: number, write: (writer: WireWriter) => void) {
  const payload = new WireWriter();
  write(payload);
  const frame = new WireWriter();
  frame.fieldRepeatedMessage(tag, payload.finish());
  return framed(frame.finish());
}

function fakeDispatcher(reply: () => Buffer | undefined) {
  const sent: Buffer[] = [];
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      sent.push(Buffer.from(chunk));
      const response = reply();
      if (response) {
        // The inherited transport may split the length header across reads.
        stdout.write(response.subarray(0, 2));
        stdout.write(response.subarray(2));
      }
      callback();
    },
  });
  stdin.once("finish", () => {
    stdout.end();
    child.emit("close", 0, null);
  });
  const kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(Object.assign(child, { stdin, stdout, kill }));
  return { child, sent, kill };
}

async function withStorage<A, E>(body: Parameters<typeof storageScope<A, E>>[1]) {
  const temp = await mkdtemp(join(tmpdir(), "bigbud-picker-client-"));
  try {
    return await storageScope(join(temp, "profile.sqlite"), body);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

beforeEach(() => vi.mocked(spawn).mockReset());

it("launches only the private native dispatcher and hydrates it from the selected SQLite profile", async () => {
  const epoch = Buffer.alloc(32, 3);
  const hydrate = ownerFrame(7, (writer) => writer.fieldString(1, targetId));
  const accepted = ownerFrame(2, (writer) => {
    writer.fieldUint(1, OWNER_MAJOR);
    writer.fieldBytes(3, epoch);
    writer.fieldBytes(4, Buffer.alloc(32, 4));
    writer.fieldBytes(6, profileBinding);
  });
  const responses = [hydrate, accepted];
  const { sent, kill } = fakeDispatcher(() => responses.shift());

  await withStorage((sql) =>
    Effect.promise(async () => {
      const owner = await startWindowsPickerProofOwner({ ...options, sql });
      try {
        expect(spawn).toHaveBeenCalledExactlyOnceWith(
          executable,
          [
            "--windows-picker-dispatcher",
            "a1b2",
            targetId,
            options.lockFile,
            "22222",
            options.user,
            options.identityFile,
            options.knownHostsFile,
          ],
          {
            cwd: "C:\\trusted build",
            env: { BIGBUD_SSH_OWNER_PICKER_PROOF: "1" },
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
            shell: false,
          },
        );
        const [writer] = await Effect.runPromise(sql<{ writerEpoch: string }>`
          SELECT writer_epoch AS writerEpoch FROM ssh_owner_writer WHERE singleton = 1
        `);
        if (!writer) throw new Error("The SQLite writer was not hydrated");
        expect(sent).toEqual([
          framed(encodeHello(profileBinding, OWNER_MAJOR)),
          framed(
            encodeStorageSnapshot(targetId, {
              writerEpoch: writer.writerEpoch,
              seq: 0,
              disconnected: false,
            }),
          ),
        ]);
        expect(owner.ownerEpoch).toEqual(Uint8Array.from(epoch));
        expect(owner).not.toHaveProperty("openProofTerminal");
        expect(owner).not.toHaveProperty("detach");
        // Key-only Windows: no password or keyboard-interactive prompt exists.
        expect(owner).not.toHaveProperty("unlockSyntheticPosixPassword");
        for (const prompt of ["unlockPassword", "submitSshAuthentication", "keyboardInteractive"]) {
          expect(owner).not.toHaveProperty(prompt);
        }
      } finally {
        await owner.close();
      }
      expect(kill).not.toHaveBeenCalled();
      await expect(owner.connect()).rejects.toMatchObject({ code: "ownerUnavailable" });
    }),
  );
});

it("fails closed on dispatcher failure without rotating the SQLite writer or trying a fallback", async () => {
  const { child } = fakeDispatcher(() => undefined);
  await withStorage((sql) =>
    Effect.promise(async () => {
      const startup = startWindowsPickerProofOwner({ ...options, sql });
      child.emit("error", new Error("private bootstrap rejected"));
      await expect(startup).rejects.toMatchObject({ code: "ownerUnavailable" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(await Effect.runPromise(sql`SELECT * FROM ssh_owner_writer`)).toEqual([]);
    }),
  );
});

it("rejects a nonlocal binary before dispatching", async () => {
  await withStorage((sql) =>
    Effect.promise(async () => {
      await expect(
        startWindowsPickerProofOwner({ ...options, binary: "\\\\remote\\share\\owner.exe", sql }),
      ).rejects.toMatchObject({ code: "invalidOperands" });
      expect(spawn).not.toHaveBeenCalled();
    }),
  );
});

it("surfaces the typed key-only denials without a credential prompt", () => {
  expect(decodeOwnerError(28)).toBe("sessionQuota");
  expect(decodeOwnerError(29)).toBe("windowsPasswordUnsupported");
  expect(decodeOwnerError(30)).toBe("keyboardInteractiveUnsupported");
});
