import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { executeOwnedNode } from "../lib/checkpoint-node-tests.process.ts";
import { combinedCheckpointFailure } from "../lib/checkpoint-node-tests.errors.ts";
import { inputs, hash, verifyArtifacts } from "./checkpoint.extension.artifacts.mjs";
import { compilerCommand } from "./checkpoint.extension.toolchain.mjs";

// Both reviewed inputs come from this package's own pinned 6.0.0 devDependencies, so the app's
// xterm version (now a 6.1 beta) can move without invalidating the checkpoint harness pairing.
const requireScripts = createRequire(new URL("../package.json", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

/** Resolve only standard installed packages; no cache fallback, downloads or auto-install. */
async function vendorBytes(requirePackage, name, kind) {
  const manifest = JSON.parse(
    await readFile(requirePackage.resolve(`${name}/package.json`), "utf8"),
  );
  if (
    manifest.version !== "6.0.0" ||
    manifest.license !== "MIT" ||
    Object.keys(manifest.dependencies ?? {}).length
  )
    throw new Error(`Unreviewed installed ${name} test input`);
  const bytes = await readFile(requirePackage.resolve(name));
  if (hash(bytes) !== inputs[kind]) throw new Error(`Unverified installed ${kind} test input`);
  return bytes;
}

export async function createCheckpointTestFixture(options = {}) {
  const temporaryRoot = resolve(
    options.temporaryRoot ?? process.env.BIGBUD_CHECKPOINT_TEST_TMPDIR ?? tmpdir(),
  );
  const directory = await realpath(
    await mkdtemp(join(temporaryRoot, "bigbud-checkpoint-fixture-")),
  );
  try {
    await writeFile(
      join(directory, "headless.cjs"),
      await vendorBytes(requireScripts, "@xterm/headless", "headless"),
    );
    await writeFile(
      join(directory, "browser.cjs"),
      await vendorBytes(requireScripts, "@xterm/xterm", "browser"),
    );
    await executeOwnedNode(
      [
        "--no-install",
        "run",
        fileURLToPath(new URL("checkpoint.extension.generate.mjs", import.meta.url)),
        directory,
      ],
      {
        command: compilerCommand(),
        cwd: root,
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    const verified = await verifyArtifacts(directory);
    const nonce = randomBytes(32).toString("hex");
    const ticket = {
      schema: 1,
      directory,
      nonce,
      manifest: hash(await readFile(join(directory, "manifest.json"))),
    };
    await writeFile(join(directory, "fixture-ticket.json"), JSON.stringify(ticket), {
      flag: "wx",
      mode: 0o600,
    });
    let disposed = false;
    return {
      directory,
      build: verified.build,
      toolchain: verified.toolchain,
      env: {
        BIGBUD_CHECKPOINT_FIXTURE: directory,
        BIGBUD_CHECKPOINT_FIXTURE_TICKET: nonce,
        BIGBUD_CHECKPOINT_OWNED_TREE: nonce,
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        // Only the freshly allocated, closure-owned tree—not a supplied root/cache.
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanup) {
      throw combinedCheckpointFailure(error, cleanup, "Fixture setup and owned cleanup failed");
    }
    throw error;
  }
}

/** A ticket routes an owned test fixture; it never substitutes for source-derived verification. */
export async function checkpointTestFixtureFromEnvironment() {
  const directory = process.env.BIGBUD_CHECKPOINT_FIXTURE;
  const nonce = process.env.BIGBUD_CHECKPOINT_FIXTURE_TICKET;
  if (!directory || !isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(nonce ?? ""))
    throw new Error("Missing owned checkpoint test fixture ticket; run the scripts Vitest task");
  if ((await realpath(directory)) !== directory)
    throw new Error("Checkpoint test fixture path was replaced");
  const ticket = JSON.parse(await readFile(join(directory, "fixture-ticket.json"), "utf8"));
  if (
    ticket.schema !== 1 ||
    ticket.directory !== directory ||
    ticket.nonce !== nonce ||
    ticket.manifest !== hash(await readFile(join(directory, "manifest.json")))
  )
    throw new Error("Invalid owned checkpoint test fixture ticket");
  return directory;
}
