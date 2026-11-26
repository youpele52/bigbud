import { describe, expect, it } from "vitest";
import { checkCutover } from "./check.ts";

const hex = (n: number) => n.toString(16).repeat(64);
const binding = {
  profile: "N",
  os: "linux",
  arch: "x64",
  cell: "node-22",
  dbDomain: "db-1",
  schema: "35",
};
const a = { id: "rollback-A", sha256: hex(1) };
const b = { id: "candidate-B", sha256: hex(2) };
const root = {
  seq: 1,
  id: "backend",
  instance: "p1",
  via: "root",
  from: null,
  basename: "node",
  sha256: hex(5),
};
type Image = Omit<typeof root, "from"> & { from: string | null };
const spawn = (id: string, from: string, basename: string, sha256 = hex(6)) => ({
  id,
  instance: `p-${id}`,
  via: "spawn",
  from,
  basename,
  sha256,
});

function add(run: { images: Image[] }, ...images: Omit<Image, "seq">[]) {
  for (const image of images) run.images.push({ ...image, seq: (run.images.at(-1)?.seq ?? 1) + 2 });
}

function fixture() {
  const cases = ["X1", "X2", "X3", "X4", "G1", "G2", "G3"].map((row) => {
    const denied = row === "X4" || row === "G3";
    const ownerOnly = row === "G1" || row === "G2";
    return {
      id: row.toLowerCase(),
      row,
      aMode: denied ? "intentional-denial" : "legacy-baseline",
      bMode: ownerOnly ? "owner-only" : "zero-ssh",
      aOutcome: denied ? "roleDenied" : "ok",
      bOutcome: denied ? "roleDenied" : ownerOnly ? "ok" : "legacyEntryFenced",
    };
  });
  const plan = {
    kind: "cutover-plan-v1",
    binding,
    a,
    b,
    ownerSha256: hex(3),
    sshSha256: [hex(4)],
    cases,
  };
  const runs = cases.flatMap((c) =>
    (["A", "B"] as const).map((side) => {
      const owner = side === "B" && c.bMode === "owner-only" ? "owner" : null;
      const trace = { images: [{ ...root }] as Image[] };
      if (owner) {
        add(trace, spawn(owner, "backend", "bigbud-ssh-owner", hex(3)));
        add(trace, spawn("wrapper", owner, "sh"), spawn("ssh", "wrapper", "SSH.EXE"));
      } else if (side === "A" && c.aMode === "legacy-baseline") {
        add(trace, spawn("legacy", "backend", "ssh"));
      }
      return {
        id: `${c.id}-${side}`,
        caseId: c.id,
        side,
        binding: { ...binding },
        artifact: { ...(side === "A" ? a : b) },
        capture: { scope: "creation-and-exec-lineage", complete: true, lostEvents: 0 },
        action: {
          actor: "backend",
          outcome: side === "A" ? c.aOutcome : c.bOutcome,
          begin: 2,
          end: 50,
        },
        owner,
        images: trace.images,
      };
    }),
  );
  return {
    plan,
    bundle: { kind: "cutover-process-traces-v1", runs },
    run: (id: string) => runs.find((r) => r.id === id)!,
  };
}

describe("paired cutover launch evidence", () => {
  it("records A baselines and intentional denials without claiming retirement or S4 acceptance", () => {
    const { plan, bundle } = fixture();
    const report = checkCutover(plan, bundle);
    expect(report).toMatchObject({
      status: "launch-traces-conform",
      retirement: "unproven",
      s4Accepted: false,
    });
    expect(report.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: "x2-A", mode: "legacy-baseline", legacyLaunches: 1 }),
        expect.objectContaining({ run: "x4-A", mode: "intentional-denial", legacyLaunches: 0 }),
        expect.objectContaining({
          run: "g1-B",
          mode: "owner-only",
          ownerLaunches: 1,
          legacyLaunches: 0,
        }),
      ]),
    );
  });

  it.each(["git-sh-wrapper", "node-pty-sh-wrapper", "detached-terminal-host", "peer-keyscan"])(
    "rejects %s bypass despite valid owner-launched SSH elsewhere",
    (wrapper) => {
      const { plan, bundle, run } = fixture();
      const b = run("g1-B");
      add(b, spawn("hidden", "backend", wrapper), spawn("shell", "hidden", "sh"));
      add(b, spawn("bypass", "shell", wrapper === "peer-keyscan" ? "ssh-keyscan" : "ssh.exe"));
      expect(() => checkCutover(plan, bundle)).toThrow(/outside owner lineage.*bypass/);
    },
  );

  it("detects a renamed SSH image when a wrapper execs without changing PID identity", () => {
    const { plan, bundle, run } = fixture();
    add(run("x2-B"), spawn("pty", "backend", "terminal-host"), {
      id: "renamed-ssh",
      instance: "p-pty",
      via: "exec",
      from: "pty",
      basename: "other-name",
      sha256: hex(4),
    });
    expect(() => checkCutover(plan, bundle)).toThrow(/outside owner lineage.*renamed-ssh/);
  });

  it("does not treat exec replacing the owner as supervised", () => {
    const { plan, bundle, run } = fixture();
    add(run("g1-B"), {
      id: "replacement",
      instance: "p-owner",
      via: "exec",
      from: "owner",
      basename: "ssh",
      sha256: hex(4),
    });
    expect(() => checkCutover(plan, bundle)).toThrow(/outside owner lineage.*replacement/);
  });

  it("rejects missing parent identity and spoofed owner basename", () => {
    const broken = fixture();
    broken.run("g1-B").images[2]!.from = "unknown-parent";
    expect(() => checkCutover(broken.plan, broken.bundle)).toThrow(
      /missing or stale process ancestry/,
    );
    const spoofed = fixture();
    spoofed.run("g1-B").images[1]!.sha256 = hex(9);
    expect(() => checkCutover(spoofed.plan, spoofed.bundle)).toThrow(/unverified owner identity/);
  });

  it.each(["x1-A", "g1-B"])("rejects missing paired trace %s", (id) => {
    const { plan, bundle } = fixture();
    bundle.runs = bundle.runs.filter((run) => run.id !== id);
    expect(() => checkCutover(plan, bundle)).toThrow(/missing A\/B trace pair/);
  });

  it.each(["artifact-id", "digest", "profile", "platform", "cell", "schema", "db-domain"])(
    "rejects a nonmatching %s",
    (kind) => {
      const { plan, bundle, run } = fixture();
      const b = run("x1-B");
      if (kind === "artifact-id") b.artifact.id = "other-B";
      if (kind === "digest") b.artifact.sha256 = hex(9);
      if (kind === "profile") b.binding.profile = "R";
      if (kind === "platform") b.binding.arch = "arm64";
      if (kind === "cell") b.binding.cell = "different-runtime";
      if (kind === "schema") b.binding.schema = "34";
      if (kind === "db-domain") b.binding.dbDomain = "unknown-db";
      expect(() => checkCutover(plan, bundle)).toThrow(/artifact or profile binding mismatch/);
    },
  );

  it("rejects preflight metadata, dropped events, and synthetic zero from missing image records", () => {
    const { plan, bundle, run } = fixture();
    expect(() => checkCutover(plan, { status: "preflight-only", missingTraceFields: [] })).toThrow(
      /trace bundle/,
    );
    const denied = run("x4-B");
    denied.capture.lostEvents = 1;
    expect(() => checkCutover(plan, bundle)).toThrow(/Incomplete process capture/);
    denied.capture.lostEvents = 0;
    denied.images = [];
    expect(() => checkCutover(plan, bundle)).toThrow(/nonempty array/);
  });

  it("rejects denied cases with owner SSH, wrong results, or no recorded actor", () => {
    const { plan, bundle, run } = fixture();
    const denied = run("x4-B");
    denied.owner = "owner";
    add(
      denied,
      spawn("owner", "backend", "bigbud-ssh-owner", hex(3)),
      spawn("child", "owner", "ssh"),
    );
    expect(() => checkCutover(plan, bundle)).toThrow(/inconsistent with zero-ssh/);
    denied.images.pop();
    denied.action.outcome = "ok";
    expect(() => checkCutover(plan, bundle)).toThrow(/unexpected action outcome/);
    denied.action.actor = "not-observed";
    expect(() => checkCutover(plan, bundle)).toThrow(/missing action actor/);
  });

  it("does not use startup SSH as a positive control, and counts fallback after the result", () => {
    const { plan, bundle, run } = fixture();
    run("g1-A").action.begin = 4;
    expect(() => checkCutover(plan, bundle)).toThrow(/inconsistent with legacy-baseline/);
    run("g1-A").action.begin = 2;
    run("g1-B").action.end = 8;
    add(run("g1-B"), spawn("late", "backend", "ssh"));
    expect(() => checkCutover(plan, bundle)).toThrow(/outside owner lineage.*late/);
  });

  it("requires observed positive launch controls in both builds", () => {
    const { plan, bundle, run } = fixture();
    run("g1-A").images.pop();
    expect(() => checkCutover(plan, bundle)).toThrow(/inconsistent with legacy-baseline/);
    add(run("g1-A"), spawn("legacy", "backend", "ssh"));
    run("g1-B").images.pop();
    expect(() => checkCutover(plan, bundle)).toThrow(/inconsistent with owner-only/);
  });
});
