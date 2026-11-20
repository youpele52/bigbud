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
    const store = createFileServeOwnershipStore(filePath, 443);
    expect(store.read()).toBeNull();
    store.write(3774);
    expect(store.read()).toBe(3774);
    expect(JSON.parse(FS.readFileSync(filePath, "utf8"))).toEqual({
      httpsPort: 443,
      proxyPort: 3774,
    });
    store.clear();
    expect(store.read()).toBeNull();
    FS.writeFileSync(filePath, '{"proxyPort":"3774"}');
    expect(store.read()).toBeNull();
    FS.writeFileSync(filePath, "not json");
    expect(store.read()).toBeNull();
  });

  it("claims a record only for the listener it was written for", () => {
    const filePath = tempFile();
    createFileServeOwnershipStore(filePath, 8443).write(3774);
    expect(createFileServeOwnershipStore(filePath, 8443).read()).toBe(3774);
    expect(createFileServeOwnershipStore(filePath, 443).read()).toBeNull();
  });

  it("reads a pre-split record (no httpsPort) as HTTPS 443 only", () => {
    const filePath = tempFile();
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, '{"proxyPort":3774}');
    expect(createFileServeOwnershipStore(filePath, 443).read()).toBe(3774);
    // A beta that recorded 443 before the split never claims its new 8443 listener from it.
    expect(createFileServeOwnershipStore(filePath, 8443).read()).toBeNull();
  });
});
