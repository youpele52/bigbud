import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { findPackagedDesktopSupervisor } from "./lib/packaged-desktop-supervisor.ts";
import { startPackagedBackend } from "./lib/inyosira-qualification.process.ts";
import { waitForHttp } from "./lib/inyosira-qualification.rpc.ts";
import { runOrganizationScenario } from "./lib/inyosira-qualification.scenario.ts";

const [releaseRoot, evidenceDirectory] = process.argv.slice(2);
assert(
  releaseRoot && evidenceDirectory,
  "Usage: node scripts/verify-packaged-inyosira-windows.ts <release-root> <evidence-directory>",
);
assert.equal(process.platform, "win32", "Native Windows runner required");
assert.equal(process.arch, "x64", "Native x64 Node required");
const evidence = resolve(evidenceDirectory);
await mkdir(evidence, { recursive: true });
const supervisor = findPackagedDesktopSupervisor(resolve(releaseRoot), "win");
assert(supervisor, "Packaged supervisor missing");
const serverDirectory = dirname(dirname(dirname(supervisor)));
const appDirectory = dirname(dirname(serverDirectory));
const executables = (await readdir(appDirectory)).filter((name) =>
  /^bigbud(?:[ -].*)?\.exe$/i.test(name),
);
assert.equal(executables.length, 1, "Expected one packaged bigbud Electron executable");
const executable = join(appDirectory, executables[0]!);
const entry = join(serverDirectory, "dist", "bin.mjs");
const profile = await mkdtemp(join(tmpdir(), "bigbud-inyosira-qualification-"));
const hashes: Record<string, string> = {};
for (const path of [executable, entry, supervisor])
  hashes[path] = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const result: Record<string, unknown> = {
  sourceSha: process.env.GITHUB_SHA ?? null,
  platform: process.platform,
  arch: process.arch,
  profile,
  hashes,
  status: "FAIL",
};
let backend: Awaited<ReturnType<typeof startPackagedBackend>> | undefined;
try {
  backend = await startPackagedBackend(executable, entry, supervisor, profile);
  await waitForHttp(backend.url);
  result.scenario = await runOrganizationScenario(
    backend.wsUrl,
    join(profile, "state", "userdata", "state.sqlite"),
  );
  const { organizers } = await backend.nativeProcesses();
  result.organizer = organizers[0];
  result.http = "PASS";
  const completedBackend = backend;
  backend = undefined;
  result.termination = await completedBackend.stop();
  result.status = "PASS";
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  if (backend) {
    try {
      result.termination = await backend.stop();
    } catch (error) {
      result.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  const log = await readFile(join(profile, "server.log"), "utf8").catch(
    () => "Backend did not create a log",
  );
  await writeFile(join(evidence, "server.log"), log);
  await writeFile(join(evidence, "qualification.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
