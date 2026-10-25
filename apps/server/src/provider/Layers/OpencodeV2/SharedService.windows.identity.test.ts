import { afterEach, expect, it, vi } from "vitest";
import {
  decodeV2WindowsDirectoryIdentity,
  readV2WindowsDirectoryIdentity,
} from "./SharedService.windows.identity.ts";
import { v2WindowsInspector } from "./SharedService.windows.ts";

afterEach(() => vi.restoreAllMocks());

it("preserves full volume/file bits and rejects truncated or malformed identity responses", () => {
  const identity = "fedcba9876543210:ffeeddccbbaa99887766554433221100";
  expect(decodeV2WindowsDirectoryIdentity([identity])).toBe(identity);
  for (const value of [
    [],
    [identity, "extra"],
    [identity.toUpperCase()],
    [identity.slice(1)],
    ["9007199254740993:42"],
  ])
    expect(() => decodeV2WindowsDirectoryIdentity(value)).toThrow("V2 Windows directory identity");
});

it("requires the exact native capability before requesting a directory snapshot", async () => {
  const request = vi.spyOn(v2WindowsInspector, "request").mockResolvedValue(["boot=1"]);
  await expect(readV2WindowsDirectoryIdentity("C:\\private")).rejects.toThrow(
    "feature unavailable",
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("CAPABILITIES\t1");
});
