import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Option from "effect/Option";
import { afterEach, assert, it } from "vitest";

import { setRuntimeUpdateDevInputs } from "../cli/cli.backend.updateInputs.ts";
import { developmentGraphOverridesAllowed } from "./developmentOverrides.ts";
import {
  readRuntimeUpdateDevInputs,
  RUNTIME_UPDATE_DEV_INPUTS_FILE,
} from "./runtimeUpdate.devInputs.ts";
import { makeRuntimeUpdateGraphSource } from "./runtimeUpdate.graphSource.ts";

const AUTHORITY = "b".repeat(32);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bb-dev-inputs-")));
  dirs.push(home);
  const serviceDir = join(home, ".bigbud/backend-services", AUTHORITY);
  await fs.mkdir(serviceDir, { recursive: true, mode: 0o700 });
  await fs.chmod(serviceDir, 0o700);
  const graphs = join(home, "graphs");
  await fs.mkdir(graphs, { mode: 0o700 });
  const keys = join(home, "keys.json");
  const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  await fs.writeFile(keys, JSON.stringify({ "dev-fixture": pem.toString() }), { mode: 0o600 });
  const read = (environment: NodeJS.ProcessEnv = {}) =>
    readRuntimeUpdateDevInputs({ homeDir: home, authorityId: AUTHORITY, environment });
  const set = (environment: NodeJS.ProcessEnv = {}) =>
    setRuntimeUpdateDevInputs(
      {
        authorityId: AUTHORITY,
        graphVersionsDirectory: graphs,
        trustedKeys: Option.some(keys),
        installSource: Option.none(),
      },
      { homeDir: home, environment },
    );
  return { home, serviceDir, graphs, read, set };
}

it("release mode is a packaged desktop app or a release-stamped build", () => {
  assert.isTrue(developmentGraphOverridesAllowed({}, { version: "1.0.0" }));
  assert.isFalse(
    developmentGraphOverridesAllowed({ BIGBUD_DESKTOP_PACKAGED: "1" }, { version: "1.0.0" }),
  );
  assert.isFalse(
    developmentGraphOverridesAllowed({}, { version: "1.0.0", bigbudReleaseTag: "v1.0.0" }),
  );
});

it("set writes an owner-private file once that the backend reads back", async () => {
  const f = await fixture();
  assert.deepStrictEqual(await f.read(), { kind: "absent" });
  const { path } = await f.set();
  assert.equal(path, join(f.serviceDir, RUNTIME_UPDATE_DEV_INPUTS_FILE));
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  const report = await f.read();
  assert.equal(report.kind, "loaded");
  if (report.kind !== "loaded") return;
  assert.equal(report.value.graphVersionsDirectory, f.graphs);
  assert.deepStrictEqual(Object.keys(report.value.trustedKeys), ["dev-fixture"]);
  assert.isNull(report.value.installSourcePath);
  // Never replaced: the owner removes it deliberately first.
  const again = await f.set().then(
    () => undefined,
    (cause: NodeJS.ErrnoException) => cause.code,
  );
  assert.equal(again, "EEXIST");
});

it("release mode refuses both writing and reading the inputs", async () => {
  const f = await fixture();
  const refused = await f.set({ BIGBUD_DESKTOP_PACKAGED: "1" }).then(
    () => "written",
    (cause: Error) => cause.message,
  );
  assert.match(refused, /refused in release builds/);
  await f.set();
  assert.deepStrictEqual(await f.read({ BIGBUD_DESKTOP_PACKAGED: "1" }), {
    kind: "refused",
    reason: "development inputs are refused in release builds",
  });
});

it("a malformed or unsafe file is refused, never partly applied", async () => {
  const f = await fixture();
  const path = join(f.serviceDir, RUNTIME_UPDATE_DEV_INPUTS_FILE);
  await fs.writeFile(
    path,
    JSON.stringify({ schemaVersion: 1, graphVersionsDirectory: f.graphs, extra: 1 }),
    { mode: 0o600 },
  );
  assert.equal((await f.read()).kind, "refused");
  await fs.writeFile(path, JSON.stringify({ schemaVersion: 1, graphVersionsDirectory: f.graphs }));
  await fs.chmod(path, 0o644);
  assert.equal((await f.read()).kind, "refused");
  await fs.chmod(path, 0o600);
  assert.equal((await f.read()).kind, "loaded");
});

const failure = (
  graph: ReturnType<typeof makeRuntimeUpdateGraphSource>,
  version: string,
  kind: "local-graph" | "release",
) =>
  graph.resolve({ version, source: kind }, new AbortController().signal).then(
    () => "resolved",
    (cause: Error) => cause.message,
  );

it("local-graph updates resolve <graphVersionsDirectory>/<version> from the inputs", async () => {
  const f = await fixture();
  await f.set();
  const source = (devInputs: () => ReturnType<typeof f.read>) =>
    makeRuntimeUpdateGraphSource({
      environment: {},
      loadRustSource: async () => ({ manifest: {}, trustStore: {} }) as never,
      devInputs,
      target: "x86_64-unknown-linux-gnu",
    });
  // The per-version directory is missing, so the resolver reached exactly that directory.
  assert.match(
    await failure(source(f.read), "9.9.9", "local-graph"),
    /local backend graph directory is missing/,
  );
  await fs.mkdir(join(f.graphs, "9.9.9"));
  assert.match(await failure(source(f.read), "9.9.9", "local-graph"), /No single local/);
  assert.match(
    await failure(
      source(() => f.read({ BIGBUD_DESKTOP_PACKAGED: "1" })),
      "9.9.9",
      "local-graph",
    ),
    /development update inputs were refused: development inputs are refused in release builds/,
  );
  assert.match(
    await failure(
      source(async () => ({ kind: "absent" })),
      "9.9.9",
      "local-graph",
    ),
    /bigbud backend update-inputs set/,
  );
});
