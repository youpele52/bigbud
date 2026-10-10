import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  readV2SharedRegistration,
  v2SharedRegistrationFile,
} from "./SharedService.registration.ts";
import { sharedServiceTestRegistration } from "./SharedService.test.fixture.ts";

it("follows native XDG state/HOME discovery without creating files", () => {
  expect(v2SharedRegistrationFile({ HOME: "/native/home" })).toBe(
    "/native/home/.local/state/opencode/service.json",
  );
  expect(v2SharedRegistrationFile({ HOME: "/native/home", XDG_STATE_HOME: "/native/state" })).toBe(
    "/native/state/opencode/service.json",
  );
});

it("reads only private transport registration and preserves bytes", async () => {
  const fixture = await sharedServiceTestRegistration();
  try {
    const before = await readFile(fixture.file);
    expect(await readV2SharedRegistration(fixture.file)).toMatchObject({
      id: "fixture-instance",
      version: "2.0.24",
      pid: 42,
      endpoint: { url: "http://127.0.0.1:4096", auth: { username: "opencode" } },
    });
    expect(await readFile(fixture.file)).toEqual(before);
    await expect(readV2SharedRegistration(path.join(fixture.root, "missing.json"))).rejects.toThrow(
      "Open the installed V2 TUI",
    );
    await expect(readV2SharedRegistration("relative.json")).rejects.toThrow("absolute");
  } finally {
    await fixture.close();
  }
});

it.each([
  { url: "https://example.com" },
  { url: "http://127.0.0.1:4096/api" },
  { url: "http://user:secret@127.0.0.1:4096" },
  { pid: 1.5 },
  { pid: 0 },
  { version: "2.0.24\nsecret" },
  { id: "" },
  { password: "x".repeat(4097) },
])("rejects invalid metadata without echoing native values (%j)", async (overrides) => {
  const fixture = await sharedServiceTestRegistration(overrides);
  try {
    await expect(readV2SharedRegistration(fixture.file)).rejects.toThrow("registration is invalid");
    const error = await readV2SharedRegistration(fixture.file).catch((error: Error) => error);
    expect(String(error)).not.toContain(fixture.value.password);
  } finally {
    await fixture.close();
  }
});

it.skipIf(process.platform === "win32")(
  "rejects public files, symlinks and oversized registration",
  async () => {
    const fixture = await sharedServiceTestRegistration();
    try {
      await chmod(fixture.file, 0o644);
      await expect(readV2SharedRegistration(fixture.file)).rejects.toThrow("not private");
      await chmod(fixture.file, 0o600);
      const alias = path.join(fixture.root, "alias.json");
      await symlink(fixture.file, alias);
      await expect(readV2SharedRegistration(alias)).rejects.toThrow("registration is invalid");
      await writeFile(fixture.file, "x".repeat(16_385));
      await expect(readV2SharedRegistration(fixture.file)).rejects.toThrow(
        "registration is invalid",
      );
    } finally {
      await fixture.close();
    }
  },
);
