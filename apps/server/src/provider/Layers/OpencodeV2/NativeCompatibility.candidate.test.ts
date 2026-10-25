import { expect, it, vi } from "vitest";
import { makeV2OwnedCandidateEligibility } from "./NativeCompatibility.candidate.fixture.ts";
import type { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import type { OpencodeV2Client } from "./Client.ts";

it("a fabricated candidate declaration cannot bypass clean-machine approval or issue a native API probe", async () => {
  const info = vi.fn(),
    client = { server: { info } } as unknown as OpencodeV2Client;
  const native = {
    approval: {
      id: "not-approved",
      executablePath: "/fixture/owned/retail",
      fixtureRoot: "/fixture/owned",
    },
    child: { pid: 42, exitCode: null, signalCode: null },
    configFile: "/fixture/owned/profile/config/opencode/opencode.json",
  } as unknown as Awaited<ReturnType<typeof sharedServiceNativeFixture>>;
  expect(() =>
    makeV2OwnedCandidateEligibility(
      native,
      client,
      "synthetic-suite",
      "a".repeat(64),
      "v2-system-global-config-v1",
    ),
  ).toThrow("factory-owned approved retail child ticket");
  expect(info).not.toHaveBeenCalled();
});
