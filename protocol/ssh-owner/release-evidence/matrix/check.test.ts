import { describe, expect, it } from "vitest";
import { fixtures } from "./check.fixture.ts";
import { checkMatrix } from "./check.ts";

type Fixture = ReturnType<typeof fixtures>;
function cell(f: Fixture, slot: string) {
  return f.plan.cells.find((entry) => entry.slot === slot)!;
}
function report(f: Fixture, slot: string) {
  return f.bundle.cells.find((entry) => entry.binding.slot === slot)!;
}

const mac = "D.darwin.arm64.dmg";
const win10 = "D.win32.x64.nsis.win10-22h2";
const win11 = "D.win32.x64.nsis.win11";
const graph = "R.linux.x64.signed-gnu-graph";

function check(f: Fixture) {
  return checkMatrix(f.plan, f.bundle);
}

describe("matrix claim coverage", () => {
  it("matches a complete synthetic reference set without accepting S4 or authenticating references", () => {
    const result = check(fixtures());
    expect(result).toMatchObject({
      status: "matrix-claim-coverage-conforms",
      referencesAuthenticated: false,
      s4Accepted: false,
    });
    expect(result.coverage.map((item) => item.slot)).toEqual(
      expect.arrayContaining([
        mac,
        win10,
        win11,
        graph,
        "D.darwin.x64.dmg",
        "D.linux.x64.appimage",
        "D.no-win32-arm64-installer",
        "V-E.linux.arm64.electron-dev",
        "V-B.darwin.arm64.bun-dev",
        "N.linux.arm64.node-web",
        "N.win32.x64.node-desktop.win11",
        "N.no-win32-arm64-standalone",
        "R.linux.arm64.signed-gnu-graph",
        "R.non-linux",
        "N.linux-musl",
      ]),
    );
  });

  it.each([
    win10,
    win11,
    "N.win32.x64.node-desktop.win10-22h2",
    "N.no-win32-arm64-standalone",
    "N.linux.arm64.node-web",
    "R.linux.arm64.signed-gnu-graph",
    "V-E.linux.arm64.electron-dev",
    "R.linux-musl",
  ])("rejects a plan that silently omits %s even when there is no evidence for it", (omitted) => {
    const f = fixtures();
    f.plan.cells = f.plan.cells.filter((entry) => entry.slot !== omitted);
    f.bundle.cells = f.bundle.cells.filter((entry) => entry.binding.slot !== omitted);
    expect(() => check(f)).toThrow(`Missing scope slots: ${omitted}`);
  });

  it("rejects preflight-only input at both the bundle and individual lane boundary", () => {
    const f = fixtures();
    expect(() => checkMatrix(f.plan, { ...f.bundle, kind: "preflight-only" })).toThrow(
      /not preflight/,
    );
    report(f, mac).claims.find((item) => item.lane === "provenance")!.status = "preflight-only";
    expect(() => check(f)).toThrow(/expected a verified claim reference/);
  });

  it.each(["owner", "askpass", "dbDomain", "artifact", "runtime"])(
    "rejects a mismatched %s binding",
    (field) => {
      const f = fixtures();
      const identity = report(f, win11).binding.identity!;
      if (field === "owner") identity.owner.image.build = "different-owner";
      if (field === "askpass") identity.askpass!.sha256 = "f".repeat(64);
      if (field === "dbDomain") identity.dbDomain = "different-db";
      if (field === "artifact") identity.b.sha256 = "f".repeat(64);
      if (field === "runtime") identity.platform.runtimeBuild = "electron-other";
      expect(() => check(f)).toThrow(/mismatched matrix binding/);
    },
  );

  it("rejects Git-for-Windows, a copied Win10 row and an incorrect Win10 inbox version", () => {
    const f = fixtures();
    const platform = cell(f, win10).identity!.platform;
    platform.sshOrigin = "git-for-windows";
    expect(() => check(f)).toThrow(/Windows inbox/);
    platform.sshOrigin = "windows-inbox";
    platform.sshVersion = "OpenSSH_for_Windows_9.5p1";
    expect(() => check(f)).toThrow(/Windows inbox/);
    platform.sshVersion = "OpenSSH_for_Windows_8.1p1";
    cell(f, win11).identity!.platform.osBuild = "win11-19045.1234";
    expect(() => check(f)).toThrow(/Windows inbox/);
  });

  it("requires helper identity for qualified credential auth or explicit decision for each denial", () => {
    const f = fixtures();
    const refs = report(f, win11);
    refs.binding.identity!.askpass = cell(f, win11).identity!.askpass = null;
    refs.claims = refs.claims.filter((item) => item.lane !== "native-askpass");
    expect(() => check(f)).toThrow(/requires native askpass/);
    const auth = refs.claims.filter((item) =>
      ["inbox-login-password", "inbox-keyboard-interactive"].includes(item.lane),
    );
    for (const entry of auth) entry.result = "approved-auth-denial-before-collection";
    expect(() => check(f)).toThrow(/explicit scope\/auth decision/);
    for (const entry of auth) entry.decision = "synthetic-compatibility-decision";
    expect(check(f).s4Accepted).toBe(false);
  });

  it("keeps auth and R denials distinct from positive profile claims", () => {
    const f = fixtures();
    const key = report(f, win11).claims.find((item) => item.lane === "inbox-key")!;
    key.result = "approved-auth-denial-before-collection";
    key.decision = "wrongly-excludes-key";
    expect(() => check(f)).toThrow(/inbox-key: mismatched/);
    key.result = "qualified-auth";
    key.decision = null;
    report(f, graph).claims.find((item) => item.lane === "local-only-deploy")!.result =
      "authorized-shared-route-trace";
    expect(() => check(f)).toThrow(/local-only-deploy: mismatched/);
  });

  it("cannot use launch-lineage conformance as retirement, rollback, or build A release proof", () => {
    for (const lane of [
      "legacy-retirement",
      "legacy-writers",
      "offline-rollback",
      "build-a-first",
      "pre-a-and-fresh-db",
      "too-old-rollback",
      "unsafe-rollback",
    ]) {
      const f = fixtures();
      const refs = report(f, mac);
      refs.claims.find((item) => item.lane === lane)!.result = "launch-traces-conform";
      expect(() => check(f)).toThrow(`${lane}: mismatched`);
      refs.claims = refs.claims.filter((item) => item.lane !== lane);
      expect(() => check(f)).toThrow(`missing required lane ${lane}`);
    }
  });

  it("requires independent A/B pane-record rollback evidence for a supported profile", () => {
    const f = fixtures();
    const refs = report(f, "N.linux.arm64.node-desktop");
    const lane = "pane-record-rollback";
    const paneRef = refs.claims.find((item) => item.lane === lane)!;
    refs.claims = refs.claims.filter((item) => item.lane !== lane);
    expect(() => check(f)).toThrow(`missing required lane ${lane}`);

    refs.claims.push(paneRef);
    const rollback = refs.claims.find((item) => item.lane === "offline-rollback")!;
    paneRef.result = rollback.result;
    expect(() => check(f)).toThrow(`${lane}: mismatched`);
    paneRef.result = "drained-pane-stays-closed-uncertain-pane-blocks-rollback";

    const ref = paneRef.ref;
    paneRef.ref = rollback.ref;
    expect(() => check(f)).toThrow(`${lane}: duplicate lane or reused claim reference`);
    paneRef.ref = ref;
    expect(check(f)).toMatchObject({ referencesAuthenticated: false, s4Accepted: false });
  });

  it("requires an independent stale-write fencing reference for a supported profile", () => {
    const f = fixtures();
    const refs = report(f, graph);
    const lane = "stale-write-fencing";
    const fencing = refs.claims.find((item) => item.lane === lane);
    expect(fencing?.result).toBe("stale-epochs-rejected-without-mutation-or-teardown");
    refs.claims = refs.claims.filter((item) => item.lane !== lane);
    expect(() => check(f)).toThrow(`missing required lane ${lane}`);

    const rollback = refs.claims.find((item) => item.lane === "offline-rollback")!;
    const writers = refs.claims.find((item) => item.lane === "legacy-writers")!;
    const substitute = { ...fencing!, result: rollback.result };
    refs.claims.push(substitute);
    expect(() => check(f)).toThrow(`${lane}: mismatched`);
    substitute.result = writers.result;
    expect(() => check(f)).toThrow(`${lane}: mismatched`);

    refs.claims.pop();
    refs.claims.push({ ...fencing!, ref: writers.ref });
    expect(() => check(f)).toThrow(`${lane}: duplicate lane or reused claim reference`);
    refs.claims.pop();
    refs.claims.push(fencing!);
    expect(check(f)).toMatchObject({ referencesAuthenticated: false, s4Accepted: false });
  });

  it("rejects a non-migration-aware A, unsigned graph attestation, or musl disguised as GNU", () => {
    const f = fixtures();
    const identity = cell(f, graph).identity!;
    identity.schemaA -= 1;
    expect(() => check(f)).toThrow(/same schema ceiling/);
    identity.schemaA += 1;
    identity.artifactVerification = "verified-release-members";
    expect(() => check(f)).toThrow(/verification mode/);
    identity.artifactVerification = "release-trusted-signed-graph";
    identity.platform.abi = "musl";
    expect(() => check(f)).toThrow(/Linux GNU native ABI/);
  });

  it("requires explicit unsigned-NSIS and unsupported-dev decisions", () => {
    const f = fixtures();
    cell(f, win10).identity!.artifactVerification = report(
      f,
      win10,
    ).binding.identity!.artifactVerification = "approved-unsigned-release";
    expect(() => check(f)).toThrow(/provenance: mismatched/);
    report(f, win10).claims.find((item) => item.lane === "provenance")!.decision =
      "synthetic-signing-decision";
    const dev = report(f, "V-B.linux.x64.bun-dev");
    dev.claims[0]!.decision = null;
    expect(() => check(f)).toThrow(/scope-exclusion: mismatched/);
    dev.claims[0]!.decision = "synthetic-dev-decision";
    expect(check(f).status).toBe("matrix-claim-coverage-conforms");
  });

  it("rejects missing or duplicate cells, duplicate/reused references and unrelated claims", () => {
    const f = fixtures();
    const refs = f.bundle.cells.pop()!;
    expect(() => check(f)).toThrow(/Missing claim cells/);
    f.bundle.cells.push(refs, refs);
    expect(() => check(f)).toThrow(/duplicate or mismatched/);
    f.bundle.cells.pop();
    const positive = report(f, mac).claims;
    positive.push({ ...positive[0]!, lane: "unrelated" });
    expect(() => check(f)).toThrow(/reused claim reference/);
    positive.at(-1)!.ref = "unique-unrelated-reference";
    expect(() => check(f)).toThrow(/unexpected claim lane/);
  });
});
