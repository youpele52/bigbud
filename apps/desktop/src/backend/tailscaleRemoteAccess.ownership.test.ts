import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileServeOwnershipStore } from "./tailscaleRemoteAccess.ownership";

const directories: string[] = [];

function tempFile(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-serve-owner-"));
  directories.push(directory);
  return Path.join(directory, "nested", "tailscale-serve-owner.json");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    FS.rmSync(directory, { recursive: true, force: true });
});

describe("createFileServeOwnershipStore", () => {
  it("round-trips, clears and ignores missing or malformed records", () => {
    const filePath = tempFile();
    const store = createFileServeOwnershipStore(filePath);
    expect(store.read()).toBeNull();
    store.write(3774);
    expect(store.read()).toBe(3774);
    store.clear();
    expect(store.read()).toBeNull();
    FS.writeFileSync(filePath, '{"proxyPort":"3774"}');
    expect(store.read()).toBeNull();
    FS.writeFileSync(filePath, "not json");
    expect(store.read()).toBeNull();
  });
});
