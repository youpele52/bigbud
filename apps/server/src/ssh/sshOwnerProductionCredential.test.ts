import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CredentialState } from "./sshOwnerPickerProof.codec.credential.ts";
import {
  credentialRequiredError,
  unlockProductionCredential,
} from "./sshOwnerProductionCredential.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake owner whose entry socket records exactly what the caller wrote. */
async function fakeOwner(initial: CredentialState) {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-cred-"));
  dirs.push(dir);
  const socketPath = path.join(dir, "s");
  const received: Buffer[] = [];
  const server = createServer((socket) => socket.on("data", (chunk) => received.push(chunk)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const calls: string[] = [];
  return {
    received,
    calls,
    target: {
      targetId: "ssh:host=h&user=u&port=22&auth=password",
      inspectCredential: async () => (calls.push("inspect"), initial),
      openCredentialUnlock: async (lease: Uint8Array) => (
        calls.push("open"), { lease, socketPath }
      ),
      commitCredentialUnlock: async () => {
        calls.push("commit");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...initial, unlocked: true };
      },
    },
  };
}

const locked: CredentialState = { credential: "password", unlocked: false, attemptsRemaining: 3 };

describe("in-app credential through the production owner", () => {
  it("writes the secret only to the owner's entry socket and zeroes the buffer", async () => {
    const owner = await fakeOwner(locked);
    const secret = Buffer.from("hunter2", "utf8");
    const state = await unlockProductionCredential(owner.target, "password", secret);
    expect(state.unlocked).toBe(true);
    expect(owner.calls).toEqual(["inspect", "open", "commit"]);
    expect(Buffer.concat(owner.received).toString("utf8")).toBe("hunter2");
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it("refuses a mismatched kind or a malformed secret before opening a channel", async () => {
    const owner = await fakeOwner(locked);
    const passphrase = Buffer.from("p", "utf8");
    await expect(
      unlockProductionCredential(owner.target, "keyPassphrase", passphrase),
    ).rejects.toThrow(/operationDenied/u);
    const newline = Buffer.from("a\nb", "utf8");
    await expect(unlockProductionCredential(owner.target, "password", newline)).rejects.toThrow(
      /invalidOperands/u,
    );
    expect(owner.calls).toEqual(["inspect"]);
    expect(passphrase.every((byte) => byte === 0) && newline.every((b) => b === 0)).toBe(true);
  });

  it("maps a required credential to the prompts the web client parses", async () => {
    const password = await credentialRequiredError(
      { targetId: "t", inspectCredential: async () => locked },
      "ssh:host=h",
    );
    expect(password?.message).toMatch(/^SSH password is required for ssh:host=h\./u);
    const key = await credentialRequiredError(
      {
        targetId: "t",
        inspectCredential: async () => ({
          credential: "keyPassphrase",
          unlocked: false,
          attemptsRemaining: 3,
          identity: "/home/u/.ssh/id_ed25519",
        }),
      },
      "ssh:host=h",
    );
    expect(key?.message).toMatch(
      /^SSH key '\/home\/u\/\.ssh\/id_ed25519' requires a passphrase\./u,
    );
    expect(key?.authMode).toBe("ssh-key-passphrase");
  });
});
