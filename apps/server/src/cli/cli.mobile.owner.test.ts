import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it, vi } from "vitest";
import {
  activateMobileOwner,
  enableMobileOwnerConsent,
  readMobileOwnerStatus,
  stopMobileOwner,
} from "./cli.mobile.owner.client.ts";
import { mobileCommand } from "./cli.mobile.ts";
vi.mock("./cli.mobile.owner.client.ts", () => ({
  activateMobileOwner: vi.fn(),
  enableMobileOwnerConsent: vi.fn(),
  readMobileOwnerStatus: vi.fn(),
  stopMobileOwner: vi.fn(),
}));
const previousExit = process.exitCode;
afterEach(() => {
  process.exitCode = previousExit;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const authority = "a".repeat(32);
const run = (argv: string[]) =>
  Effect.runPromise(
    Command.runWith(mobileCommand, { version: "fixture" })(argv).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
const written = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => String(call[0])).join("");
const capture = () => {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const text = written;
  return { out: () => text(out), err: () => text(err) };
};
const status = {
  authorityId: authority,
  controller: {
    attached: true,
    retiring: false,
    stopping: false,
    phase: "idle" as const,
    lastOutcome: { kind: "exit-recorded", repairRequired: false, at: "2026-11-17T00:00:00.000Z" },
  },
  consent: { state: "enabled" as const, revision: 3 },
  inputs: { state: "loaded" as const, reason: null },
  settingsEnabled: true,
};

it("refuses enable without --confirm-consent and sends nothing", async () => {
  const io = capture();
  await run(["enable", "--authority", authority]);
  expect(enableMobileOwnerConsent).not.toHaveBeenCalled();
  expect(io.err()).toContain("requires --confirm-consent");
  expect(process.exitCode).toBe(1);
});

it("grants with confirmation and reports the revision", async () => {
  const io = capture();
  vi.mocked(enableMobileOwnerConsent).mockResolvedValue({
    ok: true,
    value: { enabled: true, revision: 3, changed: true },
  });
  await run(["enable", "--authority", authority, "--confirm-consent"]);
  expect(enableMobileOwnerConsent).toHaveBeenCalledWith(authority);
  expect(io.out()).toContain("Mobile consent granted (revision 3)");
});

it("prints status as text or JSON", async () => {
  vi.mocked(readMobileOwnerStatus).mockResolvedValue({ ok: true, value: status });
  let io = capture();
  await run(["status", "--authority", authority]);
  expect(io.out()).toContain("Controller: attached, phase idle");
  expect(io.out()).toContain("Consent: enabled (revision 3)");
  expect(io.out()).toContain("Proof inputs: loaded");
  expect(io.out()).toContain("Last outcome: exit-recorded at 2026-11-17T00:00:00.000Z");
  vi.restoreAllMocks();
  io = capture();
  await run(["status", "--authority", authority, "--json"]);
  expect(JSON.parse(io.out())).toEqual({ ok: true, value: status });
});

it("activate passes origin/port and fails on a non-accepted acknowledgement", async () => {
  const io = capture();
  vi.mocked(activateMobileOwner).mockResolvedValue({
    ok: true,
    value: { requestId: null, status: "unavailable" },
  });
  await run([
    "activate",
    "--authority",
    authority,
    "--origin",
    "https://h.ts.net",
    "--port",
    "443",
  ]);
  expect(activateMobileOwner).toHaveBeenCalledWith(authority, {
    externalOrigin: "https://h.ts.net",
    port: 443,
  });
  expect(io.out()).toContain("Activation not started");
  expect(process.exitCode).toBe(1);
  await expect(
    run(["activate", "--authority", authority, "--origin", "https://h.ts.net", "--port", "0"]),
  ).rejects.toThrow();
});

it("maps refusals and unreachable sockets to fixed text without echoing failures", async () => {
  let io = capture();
  vi.mocked(stopMobileOwner).mockResolvedValue({ ok: false, refused: "uncertain" });
  await run(["stop", "--authority", authority]);
  expect(io.err()).toContain("uncertain");
  expect(process.exitCode).toBe(1);
  process.exitCode = previousExit;
  vi.restoreAllMocks();
  io = capture();
  vi.mocked(stopMobileOwner).mockRejectedValue(new Error("PRIVATE_OWNER_TOKEN"));
  await run(["stop", "--authority", authority, "--json"]);
  expect(JSON.parse(io.out())).toEqual({ ok: false, error: "unreachable" });
  expect(io.out() + io.err()).not.toContain("PRIVATE_OWNER_TOKEN");
  expect(process.exitCode).toBe(1);
});
