import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import { afterEach, expect, it } from "vitest";
import { PrivatePermissionError } from "../remote-backend/privatePermission.ts";
import { BackendCliError } from "./cli.backend.effect.ts";
import { describeBackendFailure } from "./cli.backend.failure.ts";
import { prepareBackendSetupCliInput } from "./cli.backend.inputs.ts";
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

/** Runs setup input preparation and returns the reason the CLI would print. */
async function setupReason(input: Parameters<typeof prepareBackendSetupCliInput>[0]) {
  const error = await prepareBackendSetupCliInput(input, new AbortController().signal).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(PrivatePermissionError);
  const wrapped = new BackendCliError({
    message: "Backend operation did not complete; inspect its state before retrying.",
    cause: error,
  });
  return describeBackendFailure(Cause.fail(wrapped), "setup");
}

it("names a non-private trusted-keys file, its mode and the chmod that fixes it", async () => {
  const f = await fixture();
  await chmod(f.input.trustedKeys, 0o644);
  const reason = await setupReason(f.input);
  expect(reason).toBe(
    `The trusted-keys file (--trusted-keys) '${f.input.trustedKeys}' has mode 0644; it must be ` +
      `0600 (private to this account). Run: chmod 600 '${f.input.trustedKeys}'`,
  );
  // Nothing read from the file is echoed.
  expect(reason).not.toContain("BEGIN PUBLIC KEY");
});

it("names the graph and Rust manifests by their flags", async () => {
  const f = await fixture();
  await chmod(f.input.graphManifest, 0o640);
  expect(await setupReason(f.input)).toContain(
    `graph manifest (--graph-manifest) '${f.input.graphManifest}' has mode 0640`,
  );
  await chmod(f.input.graphManifest, 0o600);
  await chmod(f.input.rustManifest, 0o604);
  expect(await setupReason(f.input)).toContain(
    `Rust manifest (--rust-manifest) '${f.input.rustManifest}' has mode 0604`,
  );
});

it("names a group-readable graph directory and asks for chmod 700", async () => {
  const f = await fixture();
  await chmod(f.input.graphRoot, 0o755);
  const reason = await setupReason(f.input);
  expect(reason).toContain(
    `executable graph directory (--graph-root) '${f.input.graphRoot}' has mode 0755; it must be 0700`,
  );
  expect(reason).toContain(`Run: chmod 700 '${f.input.graphRoot}'`);
});

it("names a graph member file with the mode its kind requires", async () => {
  const f = await fixture();
  const entry = join(f.input.graphRoot, "bin.mjs");
  await chmod(entry, 0o644);
  expect(await setupReason(f.input)).toContain(`Run: chmod 600 '${entry}'`);
  await chmod(entry, 0o600);
  const node = join(f.input.graphRoot, "node");
  await chmod(node, 0o755);
  const reason = await setupReason(f.input);
  expect(reason).toContain(`executable graph file '${node}' has mode 0755; it must be 0700`);
  expect(reason).toContain(`Run: chmod 700 '${node}'`);
});
