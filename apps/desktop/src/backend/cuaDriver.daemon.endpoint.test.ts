import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeStaleDaemonSocket } from "./cuaDriver.daemon.endpoint";

const directories: string[] = [];
function privateDirectory(): string {
  // Short path: Unix socket paths are limited to about 104 bytes.
  const directory = FS.mkdtempSync(Path.join("/tmp", "bigbud-cua-stale-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(OS.platform() === "win32")("removeStaleDaemonSocket", () => {
  it("removes a socket file left at the endpoint before respawn", async () => {
    const endpoint = Path.join(privateDirectory(), "cua.sock");
    const server = Net.createServer();
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    expect(FS.lstatSync(endpoint).isSocket()).toBe(true);
    expect(removeStaleDaemonSocket(endpoint, Path.dirname(endpoint))).toBe("removed");
    expect(FS.existsSync(endpoint)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("never deletes a non-socket file and reports it as blocking", () => {
    const endpoint = Path.join(privateDirectory(), "cua.sock");
    FS.writeFileSync(endpoint, "not a socket");
    expect(removeStaleDaemonSocket(endpoint, Path.dirname(endpoint))).toBe("blocked");
    expect(FS.readFileSync(endpoint, "utf8")).toBe("not a socket");
  });

  it("never touches a socket outside the private run dir", async () => {
    const endpoint = Path.join(privateDirectory(), "cua.sock");
    const server = Net.createServer();
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    expect(removeStaleDaemonSocket(endpoint, privateDirectory())).toBe("blocked");
    expect(FS.lstatSync(endpoint).isSocket()).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("treats a missing endpoint as absent", () => {
    const endpoint = Path.join(privateDirectory(), "cua.sock");
    expect(removeStaleDaemonSocket(endpoint, Path.dirname(endpoint))).toBe("absent");
  });
});

describe("removeStaleDaemonSocket on Windows", () => {
  it("does nothing for named pipes", () => {
    expect(removeStaleDaemonSocket("\\\\.\\pipe\\bigbud-cua-x", "\\\\.\\pipe", "win32")).toBe(
      "absent",
    );
  });
});
