import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it, vi } from "vitest";
import { createMobileOwnerPairing } from "./cli.mobile.client.ts";
import { mobileCommand } from "./cli.mobile.ts";
vi.mock("./cli.mobile.client.ts", () => ({ createMobileOwnerPairing: vi.fn() }));
const previousExit = process.exitCode;
afterEach(() => {
  process.exitCode = previousExit;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const args = [
  "pair",
  "--authority",
  "a".repeat(32),
  "--origin",
  "https://fixture.ts.net",
  "--scope",
  "approve-only",
];
const run = (argv = args) =>
  Effect.runPromise(
    Command.runWith(mobileCommand, { version: "fixture" })(argv).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
it("requires explicit scope and passes only public target fields to the private client", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await expect(run(args.slice(0, -2))).rejects.toThrow();
  expect(createMobileOwnerPairing).not.toHaveBeenCalled();
});
it("prints only intentional pair link and public target/scope/expiry", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.mocked(createMobileOwnerPairing).mockResolvedValue({
    pairingId: "pair",
    scope: "approve-only",
    expiresAt: "2099-01-01T00:00:00Z",
    secret: "one-time-secret",
    pairUrl: "https://fixture.ts.net/mobile/pair/pair#secret=one-time-secret",
  });
  await run();
  expect(createMobileOwnerPairing).toHaveBeenCalledWith({
    authorityId: "a".repeat(32),
    backendOrigin: "https://fixture.ts.net",
    scope: "approve-only",
  });
  const text = output.mock.calls.map((call) => call[0]).join("");
  expect(text).toContain("Authority: " + "a".repeat(32));
  expect(text).toContain("Scope: approve-only");
  expect(text).toContain("https://fixture.ts.net/mobile/pair/pair#secret=one-time-secret");
  expect(text.split("one-time-secret")).toHaveLength(2);
});
it("never echoes private failures or emits a success link after refusal", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(createMobileOwnerPairing).mockRejectedValue(new Error("PRIVATE_OWNER_TOKEN"));
  await run();
  expect(output).not.toHaveBeenCalled();
  expect(error.mock.calls.map((call) => call[0]).join("")).not.toContain("PRIVATE_OWNER_TOKEN");
  expect(process.exitCode).toBe(1);
});
