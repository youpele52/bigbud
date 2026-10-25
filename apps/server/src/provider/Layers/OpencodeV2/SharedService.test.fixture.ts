import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v2OfficialContract } from "./SharedService.official.fixture.ts";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";

/** Independently sourced official contract, never generated from the production capability manifest. */
export function sharedServiceTestContract() {
  return v2OfficialContract();
}

/** Private disposable native-registration shape; never edits a real service file. */
export async function sharedServiceTestRegistration(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-shared-unit-"));
  const file = path.join(root, "service.json");
  const value = {
    id: "fixture-instance",
    version: "2.0.24",
    url: "http://127.0.0.1:4096",
    pid: 42,
    password: "private-fixture-password",
    ...overrides,
  };
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await ownV2WindowsFixture(root);
  return { file, root, value, close: () => rm(root, { recursive: true, force: true }) };
}
