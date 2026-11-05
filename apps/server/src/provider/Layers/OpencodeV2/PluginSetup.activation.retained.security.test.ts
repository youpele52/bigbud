import { createHash, sign } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2RetainedActivationFixture } from "./PluginSetup.activation.retained.fixture.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { readV2ManagedThreadSource } from "./Orchestration.readiness.source.ts";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import type { V2PluginPublication } from "./PluginSetup.record.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => {
    throw new Error("No native activation/reload in retained tests");
  },
}));
type Fixture = Awaited<ReturnType<typeof makeV2RetainedActivationFixture>>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function changeManifest(
  f: Fixture,
  change: (body: Record<string, any>) => void,
  resign: boolean,
) {
  const filename = path.join(f.installed.directory, "manifest.json");
  const { signature, ...body } = JSON.parse(await readFile(filename, "utf8"));
  change(body);
  await writeFile(
    filename,
    JSON.stringify({
      ...body,
      signature: resign
        ? sign(
            null,
            Buffer.from(JSON.stringify(["bigbud.thread.bootstrap.manifest.v1", body])),
            f.preferred.privateKey,
          ).toString("base64url")
        : signature,
    }),
  );
}
async function changePublication(f: Fixture, change: Partial<V2PluginPublication>) {
  await f.installations.replace(f.key, (await f.installations.read(f.key))!.revision, {
    ...f.publication,
    ...change,
  });
}
async function noAdmission(f: Fixture) {
  const owners = await f.enrollments.inventory(),
    publications = await f.installations.inventory();
  const content = await readFile(f.filename, "utf8");
  await expect(f.ready()).rejects.toThrow();
  expect(await f.enrollments.inventory()).toEqual(owners);
  expect(await f.installations.inventory()).toEqual(publications);
  expect(await readFile(f.filename, "utf8")).toBe(content);
  for (const method of Object.values(f.client.session))
    if (vi.isMockFunction(method)) expect(method).not.toHaveBeenCalled();
  expect(f.rpc.mock.calls.every(([input]) => input.method === "info")).toBe(true);
  expect(f.coordinator.passiveReady.bind(f.coordinator, f.descriptor, f.root)).toThrow();
}

it.each([
  "unsigned-descriptor",
  "signed-altered-descriptor",
  "signed-unknown-descriptor",
  "foreign-issuer",
  "module-bytes",
] as const)(
  "fails closed on retained %s without changing evidence or admitting work",
  async (kind) => {
    const f = await makeV2RetainedActivationFixture();
    try {
      if (kind === "module-bytes")
        await writeFile(path.join(f.installed.directory, "index.mjs"), "// changed\n");
      else
        await changeManifest(
          f,
          (body) => {
            if (kind === "foreign-issuer") body.issuer = "f".repeat(64);
            else {
              body.compatibility.nativeContractDigest = "f".repeat(64);
              if (kind === "signed-unknown-descriptor")
                body.compatibilityDigest = hash(body.compatibility);
            }
          },
          kind !== "unsigned-descriptor",
        );
      await expect(
        readV2RetainedArtifact(f.preferred, f.installed.artifactDigest),
      ).rejects.toThrow();
      await noAdmission(f);
    } finally {
      await f.close();
    }
  },
);

it.each([
  "content",
  "inode",
  "root-identity",
  "plugins-identity",
  "foreign-root",
  "foreign-issuer",
  "publication-phase",
  "artifact-uri",
] as const)("does not adopt a managed source with changed %s proof", async (kind) => {
  const f = await makeV2RetainedActivationFixture();
  try {
    if (kind === "content") await writeFile(f.filename, `${f.entry.content}// changed\n`);
    if (kind === "inode") {
      await rename(f.filename, `${f.filename}.old`);
      await writeFile(f.filename, f.entry.content, { mode: 0o600 });
    }
    if (kind === "root-identity") await changePublication(f, { rootIdentity: { dev: 0, ino: 0 } });
    if (kind === "plugins-identity")
      await changePublication(f, { pluginsIdentity: { dev: 0, ino: 0 } });
    if (kind === "foreign-root") await changePublication(f, { root: path.join(f.root, "other") });
    if (kind === "foreign-issuer")
      await changePublication(f, { next: { ...f.entry, issuer: "f".repeat(64) } });
    if (kind === "publication-phase") await changePublication(f, { phase: "publishing" });
    if (kind === "artifact-uri")
      await changePublication(f, { next: { ...f.entry, artifactDirectoryUri: "file:///foreign" } });
    await noAdmission(f);
  } finally {
    await f.close();
  }
});

it.each([
  "inactive",
  "wrong-registration",
  "duplicate-registration",
  "foreign-source",
  "foreign-config-root",
] as const)("does not adopt %s inventory", async (kind) => {
  const f = await makeV2RetainedActivationFixture();
  try {
    if (kind === "inactive") f.plugins[0]!.state.status = "disabled";
    if (kind === "wrong-registration") f.plugins[0]!.id = `bigbud.thread.v2.${"f".repeat(64)}`;
    if (kind === "duplicate-registration") f.plugins.push({ ...f.plugins[0]! });
    if (kind === "foreign-source")
      f.plugins[0]!.source.path = path.join(f.app.root, "foreign", path.basename(f.filename));
    if (kind === "foreign-config-root") {
      await expect(
        readV2ManagedThreadSource(f.preferred, f.filename, `${f.root}-foreign`),
      ).resolves.toBeUndefined();
      expect(f.setup).not.toHaveBeenCalled();
    } else await noAdmission(f);
  } finally {
    await f.close();
  }
});

it.each([
  "issuer",
  "bootstrapDigest",
  "artifactDigest",
  "compatibilityDigest",
  "bootstrapAbi",
  "schemaDigest",
  "nativeVersion",
  "tools",
] as const)("retained adoption still verifies loaded %s identity", async (field) => {
  const f = await makeV2RetainedActivationFixture();
  try {
    f.rpc.mockImplementation(async ({ method, input }) => ({
      output: {
        ...((await f.host.call(method, input)) as Record<string, unknown>),
        [field]: field === "tools" ? [] : "wrong",
      },
    }));
    await noAdmission(f);
    expect(f.setup).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["plugin-deny", "tool-deny", "api-proof", "implementation"] as const)(
  "retained bytes cannot bypass fresh %s enforcement",
  async (kind) => {
    const f = await makeV2RetainedActivationFixture();
    try {
      const registration = v2ThreadRegistration(f.installed);
      if (kind === "plugin-deny")
        f.config.unshift({ type: "document", info: { plugins: [`-${registration.id}`] } });
      if (kind === "tool-deny")
        f.config.unshift({
          type: "document",
          info: {
            policies: [
              {
                action: "tool.use",
                resource: `${registration.tool("list_threads")}:*`,
                effect: "deny",
              },
            ],
          },
        });
      if (kind === "api-proof")
        f.eligibility.mockRejectedValue(
          new V2NativeCompatibilityError(
            "native-contract-incompatible",
            "synthetic API rejection",
            "2.2.0",
          ),
        );
      if (kind === "implementation") {
        await expect(
          f.run(() =>
            verifyV2ThreadTools(
              f.installed,
              f.client,
              f.root,
              undefined,
              { ...v2ThreadImplementation(), schemaDigest: "f".repeat(64) },
              f.eligibility,
              f.root,
            ),
          ),
        ).rejects.toThrow();
      } else await noAdmission(f);
      expect(f.setup).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("cannot adopt across a pending activation epoch", async () => {
  const f = await makeV2RetainedActivationFixture();
  try {
    const gate = f.run(async () => f.coordinator.scopeFor(f.preferred, f.descriptor).gate);
    const selected = await gate;
    expect(selected.tryCloseGate("test-pending")).toBe(true);
    await noAdmission(f);
    expect(f.setup).not.toHaveBeenCalled();
    expect(selected.expectedDigest()).toBe(f.preferred.artifactDigest);
    selected.releaseGate("test-pending");
  } finally {
    await f.close();
  }
});

it("does not adopt the gate digest if the final loaded identity revalidation fails", async () => {
  const f = await makeV2RetainedActivationFixture();
  try {
    let calls = 0;
    f.rpc.mockImplementation(async ({ method, input }) => {
      const output = (await f.host.call(method, input)) as Record<string, unknown>;
      // Preferred mismatch, source inspection, retained verification, then final verification.
      return { output: ++calls === 4 ? { ...output, bootstrapDigest: "f".repeat(64) } : output };
    });
    await noAdmission(f);
    expect(calls).toBe(4);
    expect(f.setup).not.toHaveBeenCalled();
    const gate = await f.run(async () => f.coordinator.scopeFor(f.preferred, f.descriptor).gate);
    expect(gate.expectedDigest()).toBe(f.preferred.artifactDigest);
  } finally {
    await f.close();
  }
});
