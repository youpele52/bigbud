import { describe, expect, it } from "vitest";

import { parseAllowlist, type Allowlist } from "./allowlist.ts";
import { checkStructural } from "./check.ts";
import { scanFile, type SourceFile } from "./rules.ts";

const allowlist: Allowlist = {
  version: 1,
  entries: [
    {
      path: "apps/server/src/remote-agent/remoteAgentGit.ts",
      rule: 2,
      symbol: "GIT_SSH_COMMAND",
      reason: "row 32 denial list",
      reference: "cutover §a row 32",
    },
  ],
};
const empty: Allowlist = { version: 1, entries: [] };
const file = (path: string, content: string): SourceFile => ({ path, content });
const rules = (source: SourceFile) => scanFile(source).map((finding) => finding.rule);
const report = (source: SourceFile, list = empty) => checkStructural([source], list);

describe("deleted-row fixtures (cutover rows 1-8)", () => {
  const rows: readonly [string, string, string, number][] = [
    ["row 1 command builder", "apps/server/src/ssh/sshCommand.ts", 'spawn("ssh", ["host"]);', 1],
    [
      "row 2 client env",
      "apps/server/src/ssh/sshCommand.ts",
      "const k = process.env.SSH_ASKPASS;",
      2,
    ],
    [
      "row 3 local executor",
      "apps/server/src/ssh/sshLocalCommand.ts",
      'execFile("ssh", ["host"]);',
      1,
    ],
    [
      "row 4 shared executor",
      "apps/server/src/ssh/sshProcess.ts",
      'runProcess("ssh", ["host"]);',
      1,
    ],
    ["row 5 session check", "apps/server/src/ssh/sshSession.ts", 'const a = ["-O", "exit"];', 2],
    [
      "row 6 askpass master",
      "apps/server/src/ssh/sshSession.ts",
      'env.SSH_ASKPASS_REQUIRE = "force";',
      2,
    ],
    [
      "row 7 control path",
      "apps/server/src/ssh/sshSession.control.ts",
      'const o = ["ControlPath=/tmp/m"];',
      2,
    ],
    [
      "row 8 teardown",
      "apps/server/src/ssh/sshSession.ts",
      'spawn("ssh", ["-O", "exit", "host"]);',
      1,
    ],
  ];
  it.each(rows)("%s is flagged", (_name, path, content, rule) => {
    expect(rules(file(path, content))).toContain(rule);
  });
});

describe("indirect launch fixtures", () => {
  it("flags a shell wrapper, node-pty file, and a known command position", () => {
    for (const content of [
      'spawn("sh", ["-c", "ssh host"]);',
      'const pty = spawn("x", [], { file: "ssh" });',
      'runProcess("/bin/sh", ["-c", "ssh -o BatchMode=yes host"]);',
    ]) {
      expect(rules(file("apps/server/src/ssh/wrapper.ts", content))).toContain(1);
    }
  });

  it("flags an API accepting an executable, sshBinary, command or env that reaches spawn", () => {
    const cases = [
      "export function run(executable: string, env: Env) { return spawn(executable, [], { env }); }",
      "export const run = async (sshBinary: string) => { await spawn(sshBinary); };",
      "export const run = async (command: string) => { return spawn('ss' + command); };",
    ];
    for (const content of cases) {
      expect(rules(file("apps/server/src/remote-agent/fixture.ts", content))).toContain(4);
    }
    expect(rules(file("packages/shared/src/other.ts", cases[0]!))).not.toContain(4);
  });

  it("flags a renamed binary from configuration in a product family", () => {
    expect(
      rules(
        file(
          "apps/server/src/terminal-host/localTerminalHost.directSsh.ts",
          "const run = (sshBinary: string) => spawn(sshBinary, [], {});",
        ),
      ),
    ).toContain(4);
  });

  it("flags an executable built by string concatenation", () => {
    expect(
      rules(
        file(
          "apps/server/src/peer-orchestration/peerSshKey.ts",
          "export function run(command: string) { return spawn('ssh' + command); }",
        ),
      ),
    ).toContain(4);
  });
});

describe("deleted-module imports and D1-D5", () => {
  const deleted = [
    "sshCommand",
    "sshSession",
    "sshSession.control",
    "sshLocalCommand",
    "sshProcess",
  ];
  it.each(deleted)("flags product imports of %s", (module) => {
    expect(
      rules(
        file(
          "apps/server/src/remote-agent/remoteAgentDiagnostics.ts",
          `import { RunSshCommandInput } from "../ssh/${module}.ts";`,
        ),
      ),
    ).toContain(3);
  });

  it("flags the D1-D5 type-only import of RunSshCommandInput", () => {
    for (const path of [
      "apps/server/src/remote-agent/remoteAgentDiagnostics.ts",
      "apps/server/src/remote-agent/remoteAgentInstall.inbox.ts",
      "apps/server/src/remote-agent/remoteAgentInstall.transaction.ts",
      "apps/server/src/remote-agent/remoteAgentLocalControl.approval.ts",
      "apps/server/src/remote-backend/localSupervisorInstaller.ts",
    ]) {
      expect(
        rules(file(path, 'import type { RunSshCommandInput } from "../ssh/sshProcess.ts";')),
      ).toContain(3);
    }
  });
});

describe("Rust second-owner rule", () => {
  it("flags Command::new with an SSH basename outside the owner crate", () => {
    expect(rules(file("crates/other/src/lib.rs", 'let _ = Command::new("ssh");'))).toContain(5);
    expect(rules(file("crates/other/src/lib.rs", 'let _ = Command::new("ssh-keygen");'))).toContain(
      5,
    );
  });

  it("does not flag the owner crate", () => {
    expect(
      rules(file("crates/bigbud-ssh-owner/src/bin/ssh_owner/transport.rs", 'Command::new("ssh");')),
    ).not.toContain(5);
  });
});

describe("allowlist and report", () => {
  it("allows only the reviewed row-32 denial list and still reports it", () => {
    const source = file(
      "apps/server/src/remote-agent/remoteAgentGit.ts",
      'const denied = ["GIT_SSH_COMMAND"];',
    );
    const result = report(source, allowlist);
    expect(result.scanned[0]?.findings).toMatchObject([
      { rule: 2, symbol: "GIT_SSH_COMMAND", allowed: true, reason: "row 32 denial list" },
    ]);
    expect(result.status).toBe("structural-conform");
    expect(result.summary).toMatchObject({ findings: 1, allowed: 1, violations: 0 });
  });

  it("does not allow the same symbol in another file or rule", () => {
    const other = report(
      file("apps/server/src/ssh/sshAgent.ts", 'const denied = ["GIT_SSH_COMMAND"];'),
      allowlist,
    );
    expect(other.status).toBe("structural-violations");
    expect(other.scanned[0]?.findings[0]).toMatchObject({ allowed: false });
  });

  it("rejects an ssh-keygen allowlist entry under U9", () => {
    expect(() =>
      parseAllowlist({
        version: 1,
        entries: [
          {
            path: "apps/server/src/peer-orchestration/peerSshKey.ts",
            rule: 1,
            symbol: "ssh-keygen",
            reason: "x",
            reference: "y",
          },
        ],
      }),
    ).toThrow();
  });

  it("passes a clean fixture and skips test files", () => {
    const clean = report(
      file(
        "apps/server/src/feature/clean.ts",
        'export const run = () => runProcess("node", ["-e", "console.log(1)"]);',
      ),
    );
    expect(clean.status).toBe("structural-conform");
    expect(clean.summary.findings).toBe(0);
    expect(rules(file("apps/server/src/ssh/sshCommand.test.ts", 'spawn("ssh");'))).toEqual([]);
  });

  it("never emits an acceptance verdict", () => {
    const result = report(file("apps/server/src/ssh/sshCommand.ts", 'spawn("ssh");'));
    expect(result.structuralOnly).toBe(true);
    expect(result.s4Accepted).toBe(false);
    expect(result.status).toBe("structural-violations");
  });
});
