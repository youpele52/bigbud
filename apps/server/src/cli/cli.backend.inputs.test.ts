import { chmod, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { revalidateBackendGraph } from "../remote-backend/backendGraph.ts";
import { readLocalSupervisorServiceFile } from "../remote-backend/localSupervisorService.files.ts";
import { decodeBackendSetupTrust, prepareBackendSetupCliInput } from "./cli.backend.inputs.ts";
import { backendSetupInputFixture } from "./cli.backend.inputs.fixture.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const f = await backendSetupInputFixture();
  directories.push(f.directory);
  return f;
}
it("authenticates the original complete graph and Rust metadata without creating backend state", async () => {
  const f = await fixture();
  const result = await prepareBackendSetupCliInput(f.input, new AbortController().signal);
  expect((await revalidateBackendGraph(result.graph)).root).toBe(f.input.graphRoot);
  expect(result.confirmFreshSetup).toBe(true);
  expect(result.restart).toBe(true);
  await expect(readFile(join(f.input.backendHome, "userdata/backend.lock"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
});
it("refuses missing explicit consent or an unstable operation ID before reading metadata", async () => {
  const f = await fixture();
  for (const changed of [{ confirmFreshSetup: false }, { requestId: "not-a-uuid" }])
    await expect(
      prepareBackendSetupCliInput(
        { ...f.input, trustedKeys: "/does-not-exist", ...changed },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Explicit fresh setup");
});
it("refuses metadata inside the graph and altered executable bytes", async () => {
  const f = await fixture();
  await expect(
    prepareBackendSetupCliInput(
      { ...f.input, trustedKeys: join(f.input.graphRoot, "..keys.json") },
      new AbortController().signal,
    ),
  ).rejects.toThrow("outside");
  await writeFile(join(f.input.graphRoot, "bin.mjs"), "changed");
  await expect(
    prepareBackendSetupCliInput(f.input, new AbortController().signal),
  ).rejects.toThrow();
});
it("rejects writable or linked trust files before graph admission", async () => {
  const f = await fixture();
  await chmod(f.input.trustedKeys, 0o644);
  await expect(
    prepareBackendSetupCliInput(f.input, new AbortController().signal),
  ).rejects.toThrow();
  await chmod(f.input.trustedKeys, 0o600);
  const link = join(f.directory, "linked-keys.json");
  await symlink(f.input.trustedKeys, link);
  await expect(
    prepareBackendSetupCliInput({ ...f.input, trustedKeys: link }, new AbortController().signal),
  ).rejects.toThrow();
});
it("refuses graph/state overlap before finite bootstrap could modify the signed graph", async () => {
  const f = await fixture();
  for (const backendHome of [f.input.graphRoot, join(f.input.graphRoot, "backend"), f.directory])
    await expect(
      prepareBackendSetupCliInput({ ...f.input, backendHome }, new AbortController().signal),
    ).rejects.toThrow("separate");
  expect((await readdir(f.input.graphRoot)).toSorted()).toEqual(["bin.mjs", "node"]);
});
it("refuses an existing ancestor alias into the graph before creating backend state", async () => {
  const f = await fixture();
  const alias = join(f.directory, "alias");
  await symlink(f.input.graphRoot, alias);
  await expect(
    prepareBackendSetupCliInput(
      { ...f.input, backendHome: join(alias, "backend") },
      new AbortController().signal,
    ),
  ).rejects.toThrow("canonical");
  expect((await readdir(f.input.graphRoot)).toSorted()).toEqual(["bin.mjs", "node"]);
});
it("accepts only public Ed25519 pins rather than private or unrelated keys", async () => {
  const f = await fixture();
  expect(Object.isFrozen(decodeBackendSetupTrust({ release: f.publicKey }))).toBe(true);
  const keys = generateKeyPairSync("ed25519");
  expect(() =>
    decodeBackendSetupTrust({
      release: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
  ).toThrow();
  expect(() => decodeBackendSetupTrust({ release: "not-a-key" })).toThrow();
  expect(() => decodeBackendSetupTrust({})).toThrow();
});
it("reads a large private metadata snapshot within the explicit expanded bound", async () => {
  const f = await fixture();
  const path = join(f.directory, "large.json"),
    raw = " ".repeat(1024 * 1024 + 32);
  await writeFile(path, raw, { mode: 0o600 });
  expect(await readLocalSupervisorServiceFile(path, 2 * 1024 * 1024)).toBe(raw);
  await expect(readLocalSupervisorServiceFile(path, 16 * 1024 * 1024 + 1)).rejects.toThrow(
    "bounded policy",
  );
});
