import { expect, it } from "vitest";

import { withProductionV2Owner } from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { PickerProofBoundTarget } from "./sshOwnerPickerProof.client.session.types.ts";
import type { SshOwnerTargetDescriptor } from "./sshOwnerProductionClient.launch.ts";
import { unlockProductionCredential } from "./sshOwnerProductionCredential.ts";
import { registerSshOwnerProductionOwner } from "./sshOwnerProductionRegistry.ts";
import { resolveProviderRuntimeTarget } from "../provider-runtime/providerRuntimeTarget.ts";
import { resolveWorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { createPiRpcProcess } from "../provider/Layers/Pi/RpcProcess.ts";

// Live proof of in-app password and key-passphrase entry (v1.credential.proto): a PRODUCTION
// (target-free) owner on this host against two disposable sshd on one Linux guest, one that
// admits only `password` and one that admits only `publickey` for a passphrase-protected key:
// BIGBUD_TEST_CREDENTIAL_TARGETS='{"host":…,"user":…,"passwordPort":…,"keyPort":…,
//   "password":…,"passphrase":…,"passphraseIdentity":…,
//   "knownHostsFile":…,"keyKnownHostsFile":…,"cwd":…}'
//   bun run --cwd apps/server vitest run <this file>
interface CredentialTargets {
  readonly host: string;
  readonly user: string;
  readonly passwordPort: number;
  readonly keyPort: number;
  readonly password: string;
  readonly passphrase: string;
  readonly passphraseIdentity: string;
  readonly knownHostsFile: string;
  readonly keyKnownHostsFile: string;
  readonly cwd: string;
}

const raw = process.env.BIGBUD_TEST_CREDENTIAL_TARGETS;
const live = raw === undefined ? undefined : (JSON.parse(raw) as CredentialTargets);
const enabled = live !== undefined && process.platform !== "win32";

const descriptor = (
  targets: CredentialTargets,
  mode: "password" | "key",
): SshOwnerTargetDescriptor => {
  const port = mode === "password" ? targets.passwordPort : targets.keyPort;
  return {
    targetId: `ssh:${new URLSearchParams({ host: targets.host, port: String(port), user: targets.user, transport: "direct-ssh", ...(mode === "password" ? { auth: "password" } : {}) })}`,
    kind: "structured",
    host: targets.host,
    port,
    user: targets.user,
    authMode: mode,
    // A password target needs no key file at all.
    identityFile: mode === "password" ? "" : targets.passphraseIdentity,
    // The owner's trust store holds one record per file, so each port has its own pin.
    knownHostsFile: mode === "password" ? targets.knownHostsFile : targets.keyKnownHostsFile,
  };
};

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { readonly code?: string; readonly authMode?: string }) =>
      error.authMode ? `prompt:${error.authMode}` : (error.code ?? String(error)),
  );

async function exercise(
  bound: PickerProofBoundTarget,
  targets: CredentialTargets,
  credential: "password" | "keyPassphrase",
  secret: string,
  afterUnlock?: () => Promise<void>,
) {
  const trust = await bound.inspectTrust();
  if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
  const executionTargetId = bound.targetId;
  const readiness = () =>
    bound.probeProofWorkspaceReadiness({ executionTargetId, workspaceRoot: targets.cwd });
  let invocation = 0;
  const shell = (command: string, signal: AbortSignal) =>
    bound.runProviderWorkspaceShell(
      {
        workspaceRoot: targets.cwd,
        cwd: targets.cwd,
        provider: "pi",
        sessionId: "credential-live",
        invocationId: `credential-live-${credential}-${(invocation += 1)}`,
        command,
        timeoutMs: 120_000,
      },
      signal,
    );

  const initial = await bound.inspectCredential();
  expect(initial).toMatchObject({ credential, unlocked: false, attemptsRemaining: 3 });
  // No master and no secret: every lane (picker, workspace, shell) answers the typed in-app
  // prompt the web client opens, before any SSH process starts.
  const prompt = credential === "password" ? "prompt:password" : "prompt:ssh-key-passphrase";
  expect(await code(bound.listRemoteFolders({ executionTargetId, path: targets.cwd }))).toBe(
    prompt,
  );
  expect(await code(readiness())).toBe(prompt);
  expect(await code(shell("true", AbortSignal.timeout(30_000)))).toBe(prompt);

  const wrong = Buffer.from(`${secret}-wrong`, "utf8");
  expect(await code(unlockProductionCredential(bound, credential, wrong))).toBe(
    "credentialRejected",
  );
  expect(wrong.every((byte) => byte === 0)).toBe(true);
  expect((await bound.inspectCredential()).attemptsRemaining).toBe(2);

  const right = Buffer.from(secret, "utf8");
  expect(await unlockProductionCredential(bound, credential, right)).toMatchObject({
    credential,
    unlocked: true,
    attemptsRemaining: 3,
  });
  expect(right.every((byte) => byte === 0)).toBe(true);

  // The master lane (folder list) and a separately spawned lease both ride the master.
  const listed = await bound.listRemoteFolders({ executionTargetId, path: targets.cwd });
  expect(listed.path).toBe(targets.cwd);
  expect(await readiness()).toMatchObject({ os: expect.stringMatching(/linux/iu) });
  expect(await readiness()).toMatchObject({ os: expect.stringMatching(/linux/iu) });

  // A shell session over the shared master: closing it kills its remote process group
  // while the master (and the per-connection sshd) stays up.
  const seconds = credential === "password" ? 301 : 302;
  const aborted = new AbortController();
  const running = code(shell(`sleep ${seconds}`, aborted.signal));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  aborted.abort();
  expect(await running).toBe("shellCancelled");
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const left = await shell(
    `pgrep -f "slee[p] ${seconds}" >/dev/null && echo alive || echo gone`,
    AbortSignal.timeout(30_000),
  );
  expect(left.output.trim()).toBe("gone");
  if (afterUnlock) await afterUnlock();
  expect(await bound.lockCredential()).toMatchObject({ unlocked: false });
  expect(await code(readiness())).toBe(prompt);
}

it.skipIf(!enabled)(
  "unlocks a password target and a passphrase key in the app, then routes leases over the master",
  async () => {
    const targets = live!;
    await withProductionV2Owner(
      {
        host: targets.host,
        port: targets.keyPort,
        user: targets.user,
        identityFile: targets.passphraseIdentity,
        knownHostsFile: targets.keyKnownHostsFile,
        cwd: targets.cwd,
        remoteBinary: "/unused",
      },
      1,
      async ({ handle }) => {
        await exercise(
          handle.target(descriptor(targets, "password")),
          targets,
          "password",
          targets.password,
        );
        const key = descriptor(targets, "key");
        await exercise(handle.target(key), targets, "keyPassphrase", targets.passphrase, () =>
          startLocalPiOnRemoteWorkspace(handle, key, targets.cwd),
        );
      },
    );
  },
  120_000,
);

/**
 * Part 1 (Pi): a local Pi runtime with a direct SSH workspace starts through the default
 * readiness probe (the owner's typed verb, here over the unlocked credential master) and its
 * remote-workspace bridge extension; no TypeScript SSH process is launched. Runs only when a
 * local `pi` CLI is installed (BIGBUD_TEST_LOCAL_PI=1).
 */
async function startLocalPiOnRemoteWorkspace(
  handle: Parameters<Parameters<typeof withProductionV2Owner>[2]>[0]["handle"],
  key: SshOwnerTargetDescriptor,
  cwd: string,
) {
  if (process.env.BIGBUD_TEST_LOCAL_PI !== "1") return;
  const unregister = registerSshOwnerProductionOwner({ handle, descriptorFor: async () => key });
  try {
    const pi = await createPiRpcProcess({
      binaryPath: "pi",
      providerRuntimeTarget: resolveProviderRuntimeTarget({ executionTargetId: "local" }),
      workspaceTarget: resolveWorkspaceTarget({ executionTargetId: key.targetId, cwd }),
      orchestrationBridge: {
        httpConfig: { host: "127.0.0.1", port: 9, threadId: "thread-pi-bridge", token: "t" },
        extraArgs: [],
        cleanup: async () => undefined,
      } as never,
      env: process.env,
    });
    try {
      const state = await pi.request({ type: "get_state" }, 20_000);
      expect(state.success).toBe(true);
      expect(pi.args).toEqual(expect.arrayContaining(["--no-builtin-tools", "--extension"]));
    } finally {
      await pi.stop();
    }
  } finally {
    unregister();
  }
}

// U2: a destination that offers only keyboard-interactive never receives the password. The
// password master offers only `password`, so the handshake fails without any askpass prompt.
// BIGBUD_TEST_CREDENTIAL_KBD='{"port":…,"knownHostsFile":…}' (same host, user and identity).
const kbd = process.env.BIGBUD_TEST_CREDENTIAL_KBD;
it.skipIf(!enabled || kbd === undefined)(
  "never releases a password to a keyboard-interactive-only destination (U2)",
  async () => {
    const targets = live!;
    const only = JSON.parse(kbd!) as { port: number; knownHostsFile: string };
    await withProductionV2Owner(
      {
        host: targets.host,
        port: targets.keyPort,
        user: targets.user,
        identityFile: targets.passphraseIdentity,
        knownHostsFile: targets.keyKnownHostsFile,
        cwd: targets.cwd,
        remoteBinary: "/unused",
      },
      1,
      async ({ handle }) => {
        const bound = handle.target({
          ...descriptor(targets, "password"),
          targetId: `ssh:host=${targets.host}&port=${only.port}&user=${targets.user}&auth=password`,
          port: only.port,
          knownHostsFile: only.knownHostsFile,
        });
        const trust = await bound.inspectTrust();
        if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
        const secret = Buffer.from(targets.password, "utf8");
        const outcome = await code(unlockProductionCredential(bound, "password", secret));
        expect(["transportLost", "authRequired"]).toContain(outcome);
        expect((await bound.inspectCredential()).unlocked).toBe(false);
        // Not a rejected secret: nothing was offered, so no attempt is consumed.
        expect((await bound.inspectCredential()).attemptsRemaining).toBe(3);
      },
    );
  },
  60_000,
);
