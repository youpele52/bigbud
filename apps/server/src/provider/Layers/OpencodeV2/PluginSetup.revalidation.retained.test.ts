import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeV2RetainedActivationFixture } from "./PluginSetup.activation.retained.fixture.ts";
import { readV2CompatibleManualBootstrap } from "./Orchestration.readiness.manual.ts";
import { V2RetainedInstallationIdentityChanged } from "./PluginSetup.revalidation.retained.ts";
import { makeV2AutomaticPluginSetup } from "./PluginSetup.native.ts";
import { prepareV2InstallationRevalidation } from "./PluginSetup.revalidation.ts";
import { recoverV2AutomaticInstallationIdentity } from "./PluginSetup.revalidation.automatic.ts";
import * as Host from "./RebootRecovery.host.ts";
import * as NativeFiles from "./PluginSetup.fs.ts";
import * as Proof from "./RebootRecovery.proof.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import type { V2PluginPublication } from "./PluginSetup.record.ts";

vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => {
    throw new Error("No native service startup in identity maintenance tests");
  },
}));
afterEach(() => vi.restoreAllMocks());
type Fixture = Awaited<ReturnType<typeof makeV2RetainedActivationFixture>>;

async function renumber(f: Fixture) {
  const oldDev = Number(f.publication.rootIdentity.dev) + 1;
  await f.installations.replace(f.key, (await f.installations.read(f.key))!.revision, {
    ...f.publication,
    rootIdentity: { ...f.publication.rootIdentity, dev: oldDev },
    pluginsIdentity: { ...f.publication.pluginsIdentity, dev: oldDev },
    nextIdentity: { ...f.publication.nextIdentity, dev: oldDev },
  });
}

// OS/checkpoint observations are synthetic; backups, signed approvals, locks and adoption are real.
// RebootRecovery and PluginSetup.revalidation suites cover authentic checkpoint/seal verification.
async function approve(f: Fixture, missingApproval: boolean) {
  const host = {
    host: "a".repeat(64),
    bootSession: "33333333-3333-3333-3333-333333333333",
    bootSeconds: 300,
    bootMicroseconds: 1,
  };
  const backup = { directory: path.join(f.app.root, "backup"), databaseDigest: "d".repeat(64) };
  vi.spyOn(Host, "readV2RecoveryHost").mockResolvedValue(host);
  vi.spyOn(Proof, "readV2RebootProof").mockResolvedValue({
    digest: "c".repeat(64),
    store: await f.installations.sibling("recovery"),
    checkpoint: {
      format: "bigbud.thread.reboot-checkpoint.v1",
      purpose: "physical-retirement-only-no-replay",
      stateRoot: f.installed.root,
      issuer: f.installed.issuer,
      preparedAt: new Date().toISOString(),
      host: { ...host, bootSeconds: 100, bootSession: "11111111-1111-1111-1111-111111111111" },
      backup,
      owners: [],
      receipts: [],
      journal: [],
    },
    seal: {
      format: "bigbud.thread.reboot-settlement.v1",
      checkpointDigest: "c".repeat(64),
      host: { ...host, bootSeconds: 200, bootSession: "22222222-2222-2222-2222-222222222222" },
      settledAt: new Date().toISOString(),
      physicalEvidence: "verified-host-reboot",
      receiptOutcome: "unknown-preserved-no-replay",
    },
  });
  if (missingApproval) return;
  await mkdir(path.join(backup.directory, "installations"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(backup.directory, "installations", createHash("sha256").update(f.key).digest("hex")),
    JSON.stringify(await f.installations.read(f.key)),
    { mode: 0o600 },
  );
  await writeFile(path.join(backup.directory, path.basename(f.filename)), f.entry.content, {
    mode: 0o600,
  });
  await prepareV2InstallationRevalidation(
    f.installations,
    f.root,
    f.installed.issuer,
    backup,
    () => {},
    path.basename(f.filename),
  );
}

function authority(): V2PluginSetupAuthority["publication"] {
  const identity = {
    prepare: vi.fn(async () => {}),
    locked: vi.fn(async () => () => {}),
    beforeMutation: vi.fn(async () => {}),
    assertGate: () => {},
    joinPhysicalOnCancel: true as const,
  };
  const forbidden = vi.fn(async () => {
    throw new Error("Native replacement/owner retirement must not run");
  });
  return { ...identity, prepare: forbidden, identityRevalidation: identity };
}

it
  .skipIf(process.platform === "win32")
  .each([
    "root-inode",
    "plugins-inode",
    "entry-inode",
    "mixed-device",
    "unsafe-directory",
  ] as const)("does not route device renumbering with %s to maintenance", async (kind) => {
  const f = await makeV2RetainedActivationFixture("2.2.5");
  try {
    await renumber(f);
    const signed = (await f.installations.read(f.key))!;
    const record = signed.value as V2PluginPublication;
    const field =
      kind === "root-inode"
        ? "rootIdentity"
        : kind === "entry-inode"
          ? "nextIdentity"
          : "pluginsIdentity";
    const identity = record[field]!;
    if (kind === "unsafe-directory") await chmod(path.dirname(f.filename), 0o777);
    else
      await f.installations.replace(f.key, signed.revision, {
        ...record,
        [field]:
          kind === "mixed-device"
            ? { ...identity, dev: Number(identity.dev) + 1 }
            : { ...identity, ino: Number(identity.ino) + 1 },
      });
    const before = await f.installations.inventory();
    await expect(f.ready()).rejects.toThrow();
    expect(f.setup).not.toHaveBeenCalled();
    expect(await f.installations.inventory()).toEqual(before);
  } finally {
    await f.close();
  }
});

it.skipIf(process.platform === "win32")(
  "retries an automatic audit after a crash before installation CAS",
  async () => {
    const f = await makeV2RetainedActivationFixture("2.2.5");
    try {
      await renumber(f);
      await approve(f, true);
      const signed = (await f.installations.read(f.key))!;
      const recover = () =>
        recoverV2AutomaticInstallationIdentity(f.installations, f.key, signed, f.installed, f.root);
      const owned = {
        signal: new AbortController().signal,
        assertCurrent: () => {},
        publication: authority()!.identityRevalidation!,
      };
      const replace = vi
        .spyOn(f.installations, "replace")
        .mockRejectedValueOnce(new Error("simulated crash"));
      await expect((await recover()).applyIdentityOnly(owned)).rejects.toThrow("simulated crash");
      expect(await f.installations.read(f.key)).toEqual(signed);
      const store = await f.installations.sibling("recovery");
      const audit = await store.inventory();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.signed.value).toMatchObject({ archivedSignedInstallation: signed });
      replace.mockRestore();
      await (await recover()).applyIdentityOnly(owned);
      expect(await store.inventory()).toEqual(audit);
      expect((await f.installations.read(f.key))!.value).toEqual(f.publication);
    } finally {
      await f.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "routes a byte-exact retained upgrade with device renumbering to setup, not passive adoption",
  async () => {
    const f = await makeV2RetainedActivationFixture("2.2.5");
    try {
      await renumber(f);
      const before = await f.installations.inventory();
      await expect(
        f.run(() =>
          readV2CompatibleManualBootstrap(
            f.preferred,
            f.client,
            f.root,
            undefined,
            f.eligibility,
            f.root,
          ),
        ),
      ).rejects.toBeInstanceOf(V2RetainedInstallationIdentityChanged);
      f.setup.mockImplementation(() => {
        throw new Error("setup admission reached");
      });
      await expect(f.ready()).rejects.toThrow("setup admission reached");
      expect(f.setup).toHaveBeenCalledOnce();
      expect(await f.installations.inventory()).toEqual(before);
      expect(await readFile(f.filename, "utf8")).toBe(f.entry.content);
    } finally {
      await f.close();
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "approved",
    "missing-proof",
    "missing-approval",
    "changed-after-approval",
    "revoked",
    "foreign-host",
    "same-boot",
    "successor",
    "changed-during-adoption",
    "already-adopted-this-boot",
    "prior-boot-adoption",
  ] as const)("retained bootstrap setup identity maintenance: %s", async (scenario) => {
  const f = await makeV2RetainedActivationFixture("2.2.5");
  try {
    await renumber(f);
    if (scenario !== "missing-proof")
      await approve(f, scenario === "missing-approval" || scenario === "prior-boot-adoption");
    if (scenario === "foreign-host" || scenario === "same-boot") {
      const host = await Host.readV2RecoveryHost();
      vi.spyOn(Host, "readV2RecoveryHost").mockResolvedValue(
        scenario === "foreign-host"
          ? { ...host, host: "f".repeat(64) }
          : { ...host, bootSeconds: 200, bootSession: "22222222-2222-2222-2222-222222222222" },
      );
    }
    if (scenario === "already-adopted-this-boot" || scenario === "prior-boot-adoption")
      await (
        await f.installations.sibling("recovery")
      ).replace("prior-adoption", undefined, {
        format: "bigbud.thread.automatic-installation-revalidation.v1",
        host: {
          ...(await Host.readV2RecoveryHost()),
          ...(scenario === "prior-boot-adoption"
            ? { bootSeconds: 250, bootSession: "44444444-4444-4444-4444-444444444444" }
            : {}),
        },
        revalidated: (await f.installations.read(f.key))!.value,
      });
    const before = await f.installations.inventory();
    const owners = await f.enrollments.inventory();
    const publication = authority()!;
    if (scenario === "revoked")
      vi.spyOn(publication.identityRevalidation!, "beforeMutation").mockImplementation(async () => {
        throw new Error("revoked identity maintenance");
      });
    if (scenario === "changed-after-approval")
      await writeFile(f.filename, `${f.entry.content}// foreign\n`);
    if (scenario === "successor" || scenario === "changed-during-adoption")
      vi.spyOn(publication.identityRevalidation!, "beforeMutation").mockImplementation(async () => {
        if (scenario === "changed-during-adoption")
          await writeFile(f.filename, `${f.entry.content}// raced\n`);
        else {
          const signed = (await f.installations.read(f.key))!;
          await f.installations.replace(f.key, signed.revision, signed.value);
        }
      });
    const setup = () =>
      f.run(() =>
        makeV2AutomaticPluginSetup(
          f.f.settings,
          f.f.consent,
          publication,
          f.eligibility,
        )(f.preferred, f.client, f.root),
      );
    if (["approved", "missing-approval", "prior-boot-adoption"].includes(scenario)) {
      const installed = await setup();
      expect(installed.artifactDigest).toBe(f.installed.artifactDigest);
      expect(installed.artifactDigest).not.toBe(f.preferred.artifactDigest);
      expect((await f.installations.read(f.key))?.value).toEqual(f.publication);
      expect(publication.identityRevalidation!.beforeMutation).toHaveBeenCalledOnce();
      expect((await setup()).artifactDigest).toBe(f.installed.artifactDigest);
      expect(publication.identityRevalidation!.beforeMutation).toHaveBeenCalledOnce();
      expect(await readFile(f.filename, "utf8")).toBe(f.entry.content);
      expect((await stat(f.filename)).ino).toBe(f.nativeFile.identity.ino);
    } else {
      await expect(setup()).rejects.toThrow();
      if (scenario !== "successor") expect(await f.installations.inventory()).toEqual(before);
    }
    expect(publication.prepare).not.toHaveBeenCalled();
    expect(await f.enrollments.inventory()).toEqual(owners);
    for (const method of Object.values(f.client.session)) expect(method).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.every(([input]) => input.method === "info")).toBe(true);
  } finally {
    await f.close();
  }
});

it.skipIf(process.platform === "win32")(
  "carries automatic signed adoption through successive boots and rejects a second same-boot transition",
  async () => {
    const f = await makeV2RetainedActivationFixture("2.2.5");
    try {
      await renumber(f);
      await approve(f, true);
      const originalHost = await Host.readV2RecoveryHost();
      const directory = NativeFiles.v2NativePluginDirectory;
      const file = NativeFiles.readV2NativePluginFile;
      let deviceOffset = 0;
      // Simulate the OS changing st_dev, not a caller replacing signed installation evidence.
      vi.spyOn(NativeFiles, "v2NativePluginDirectory").mockImplementation(
        async (name, expected) => {
          if (![f.root, path.dirname(f.filename)].includes(name)) return directory(name, expected);
          const identity = await directory(name);
          const current = { ino: Number(identity.ino), dev: Number(identity.dev) + deviceOffset };
          if (expected && (expected.dev !== current.dev || expected.ino !== current.ino))
            throw new Error("simulated native directory identity changed");
          return current;
        },
      );
      vi.spyOn(NativeFiles, "readV2NativePluginFile").mockImplementation(async (...args) => {
        const observed = await file(...args);
        return args[0] === f.filename && observed
          ? {
              ...observed,
              identity: {
                ino: Number(observed.identity.ino),
                dev: Number(observed.identity.dev) + deviceOffset,
              },
            }
          : observed;
      });
      const publication = authority()!;
      const setup = () =>
        f.run(() =>
          makeV2AutomaticPluginSetup(
            f.f.settings,
            f.f.consent,
            publication,
            f.eligibility,
          )(f.preferred, f.client, f.root),
        );
      const owners = await f.enrollments.inventory();
      for (let boot = 0; boot < 3; boot++) {
        deviceOffset = boot * 2;
        vi.spyOn(Host, "readV2RecoveryHost").mockResolvedValue({
          ...originalHost,
          bootSeconds: originalHost.bootSeconds + boot * 100,
          bootSession: `${boot + 3}`.repeat(8) + "-3333-3333-3333-333333333333",
        });
        const before = await f.installations.read(f.key);
        await expect(
          f.run(() =>
            readV2CompatibleManualBootstrap(
              f.preferred,
              f.client,
              f.root,
              undefined,
              f.eligibility,
              f.root,
            ),
          ),
        ).rejects.toBeInstanceOf(V2RetainedInstallationIdentityChanged);
        expect(await f.installations.read(f.key)).toEqual(before);
        expect((await setup()).artifactDigest).toBe(f.installed.artifactDigest);
        const adopted = await f.installations.read(f.key);
        expect(adopted?.value).toMatchObject({
          rootIdentity: { dev: Number(f.publication.rootIdentity.dev) + deviceOffset },
        });
        await setup();
        expect(await f.installations.read(f.key)).toEqual(adopted);
        deviceOffset++;
        await expect(setup()).rejects.toThrow("same boot");
        expect(await f.installations.read(f.key)).toEqual(adopted);
      }
      expect(await (await f.installations.sibling("recovery")).inventory()).toHaveLength(3);
      expect(await f.enrollments.inventory()).toEqual(owners);
      expect(await readFile(f.filename, "utf8")).toBe(f.entry.content);
      expect(publication.prepare).not.toHaveBeenCalled();
      for (const method of Object.values(f.client.session)) expect(method).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);
