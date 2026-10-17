import { afterEach, expect, it, vi } from "vitest";
import {
  windowsCreate,
  windowsPublish,
  windowsRead,
  windowsFileHash,
  v2WindowsFiles,
} from "./NativeFiles.windows.ts";
import { deferred } from "./Test.fixtures.ts";

afterEach(() => vi.restoreAllMocks());
const parent = { dev: "1234567890abcdef", ino: "f".repeat(32) };
const identity = `${parent.dev}:${parent.ino}`;

it("rejects old helpers before issuing any file mutation", async () => {
  const request = vi.spyOn(v2WindowsFiles, "request").mockResolvedValue(["boot=1"]);
  await expect(windowsCreate("C:\\private\\file", "bytes", () => {}, parent)).rejects.toThrow(
    "capability unavailable",
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it("fences revoked queued writes at issuance and never retries uncertain publication", async () => {
  let current = true;
  const entered = deferred<void>(),
    release = deferred<void>();
  const request = vi
    .spyOn(v2WindowsFiles, "request")
    .mockImplementation(async (command, issuance) => {
      if (command === "CAPABILITIES\t1") return ["private-files=1"];
      entered.resolve();
      await release.promise;
      issuance?.();
      throw Object.assign(new Error("uncertain"), { code: "EUNCERTAIN" });
    });
  const pending = windowsCreate(
    "C:\\private\\file",
    "bytes",
    () => {
      if (!current) throw new Error("revoked");
    },
    parent,
  );
  const rejected = expect(pending).rejects.toThrow("revoked");
  await entered.promise;
  current = false;
  release.resolve();
  await rejected;
  expect(request).toHaveBeenCalledTimes(2);
  current = true;
  await expect(windowsCreate("C:\\private\\file", "bytes", () => {}, parent)).rejects.toMatchObject(
    { code: "EUNCERTAIN" },
  );
  expect(request).toHaveBeenCalledTimes(4);
});

it("requires native hash verification and exact publication acknowledgements without numeric file-ID coercion", async () => {
  const content = "private-content",
    hash = windowsFileHash(content);
  const request = vi.spyOn(v2WindowsFiles, "request").mockImplementation(async (command, issue) => {
    if (command === "CAPABILITIES\t1") return ["private-files=1"];
    issue?.();
    return command.includes("\tREAD\t")
      ? [identity, hash, Buffer.from(content).toString("hex")]
      : [identity, hash];
  });
  const source = await windowsRead("C:\\private\\stage", true);
  expect(source.identity).toEqual(parent);
  await windowsPublish(
    "C:\\private\\stage",
    "C:\\private\\target",
    source,
    undefined,
    parent,
    () => {},
  );
  expect(request.mock.calls.at(-1)?.[0]).toContain(`\t${identity}\t${hash}\t`);
  request.mockImplementation(async (command) =>
    command === "CAPABILITIES\t1"
      ? ["private-files=1"]
      : [identity, "0".repeat(64), Buffer.from(content).toString("hex")],
  );
  await expect(windowsRead("C:\\private\\stage", true)).rejects.toThrow("hash rejected");
});
