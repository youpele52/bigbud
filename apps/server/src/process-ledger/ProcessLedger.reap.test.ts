import { describe, expect, it } from "vitest";

import { decideProcessLedgerRecord } from "./ProcessLedger.reap.ts";
import {
  commandLineMatches,
  encodeProcessLedgerRecord,
  makeProcessLedgerRecord,
  parseProcessLedgerRecord,
  type ProcessLedgerRecord,
  processLedgerRecordPath,
} from "./ProcessLedger.record.ts";
import {
  descendantsOf,
  parseProcessTable,
  type ProcessTableRow,
} from "./ProcessLedger.snapshot.ts";

const TOKEN = "start-v2:ps-utc:Tue_Oct_27_14:49:52_2026";
const CURSOR_LINE =
  "/Users/me/.local/bin/agent --use-system-ca /Users/me/.local/share/cursor-agent/index.js --trust acp";

const record = (overrides: Partial<ProcessLedgerRecord> = {}): ProcessLedgerRecord => ({
  ...makeProcessLedgerRecord({
    owner: { nonce: "dead", pid: 10, startedAt: "s", hostname: "h", machineId: null },
    pid: 100,
    startToken: TOKEN,
    command: "agent",
    args: ["--trust", "acp"],
    kill: "group",
    label: "acp-agent",
  }),
  ...overrides,
});

const row = (pid: number, ppid: number, pgid: number, command = CURSOR_LINE): ProcessTableRow => ({
  pid,
  ppid,
  pgid,
  lstart: "Tue Oct 27 14:49:52 2026",
  command,
});

const table = (...rows: ProcessTableRow[]) => new Map(rows.map((entry) => [entry.pid, entry]));

const decide = (
  subject: ProcessLedgerRecord,
  rows: ProcessTableRow[],
  owner: "dead" | "live" | "foreign-host" = "dead",
  /** `null`: the token is unobtainable. */
  startToken: string | null = TOKEN,
) =>
  decideProcessLedgerRecord(subject, {
    selfNonce: "self",
    classifyOwner: () => owner,
    table: table(...rows),
    startTokenOf: () => startToken ?? undefined,
  });

describe("decideProcessLedgerRecord", () => {
  it("kills the group of a dead owner's agent whose identity matches exactly", () => {
    const decision = decide(record(), [
      row(100, 1, 100),
      row(101, 100, 100, "npm exec server-puppeteer"),
      row(102, 101, 102, "node watchdog"),
    ]);
    // Members are the group's processes at snapshot time; the setsid watchdog is not one.
    expect(decision).toEqual({
      action: "kill",
      targets: {
        kill: "group",
        processes: [100, 101].map((pid) => ({ pid, startToken: TOKEN })),
      },
    });
  });

  it("leaves this backend's, live owners' and other hosts' records alone", () => {
    const own = record({ owner: { ...record().owner, nonce: "self" } });
    expect(decide(own, [row(100, 1, 100)])).toEqual({ action: "keep", reason: "own" });
    expect(decide(record(), [row(100, 1, 100)], "live")).toEqual({
      action: "keep",
      reason: "owner-live",
    });
    expect(decide(record(), [row(100, 1, 100)], "foreign-host")).toEqual({
      action: "keep",
      reason: "owner-foreign-host",
    });
  });

  it("never kills a reused, unprovable, renamed or regrouped PID", () => {
    expect(decide(record(), [])).toEqual({ action: "drop", reason: "gone" });
    expect(decide(record(), [row(100, 1, 100)], "dead", `${TOKEN}x`)).toEqual({
      action: "drop",
      reason: "pid-reused",
    });
    expect(decide(record(), [row(100, 1, 100)], "dead", null)).toEqual({
      action: "drop",
      reason: "identity-unknown",
    });
    expect(decide(record(), [row(100, 1, 100, "/usr/bin/vim notes.txt")])).toEqual({
      action: "drop",
      reason: "command-mismatch",
    });
    expect(decide(record(), [row(100, 1, 7)])).toEqual({
      action: "drop",
      reason: "not-group-leader",
    });
  });

  it("kills a shared-group child by tree, never by group", () => {
    const kilo = record({ command: "kilo", args: ["serve", "--port=0"], kill: "tree" });
    const decision = decide(kilo, [
      row(100, 1, 16000, "/Users/me/.kilo/bin/kilo serve --port=0"),
      row(101, 100, 16000, "node mcp"),
      row(102, 101, 102, "node watchdog"),
      row(200, 1, 16000, "/Applications/bigbud.app/Contents/MacOS/bigbud"),
    ]);
    expect(decision).toEqual({
      action: "kill",
      targets: {
        kill: "tree",
        processes: [100, 101, 102].map((pid) => ({ pid, startToken: TOKEN })),
      },
    });
  });
});

describe("process ledger records", () => {
  it("round-trips and rejects foreign content", () => {
    const subject = record();
    expect(parseProcessLedgerRecord(encodeProcessLedgerRecord(subject))).toEqual(subject);
    expect(parseProcessLedgerRecord("{}")).toBeUndefined();
    expect(parseProcessLedgerRecord("not json")).toBeUndefined();
  });

  it("names files by owner nonce and PID, refusing unsafe names", () => {
    expect(processLedgerRecordPath("/d", "abc-1", 42)).toBe("/d/abc-1.42.json");
    expect(processLedgerRecordPath("/d", "../x", 42)).toBeUndefined();
    expect(processLedgerRecordPath("/d", "abc", 0)).toBeUndefined();
  });

  it("matches a command line by its recorded arguments across wrapper execs", () => {
    expect(commandLineMatches(record(), CURSOR_LINE)).toBe(true);
    expect(commandLineMatches(record(), "agent --trust acp")).toBe(true);
    expect(commandLineMatches(record(), "agent --trust acp --extra")).toBe(false);
    expect(commandLineMatches(record(), "other-acp")).toBe(false);
    expect(commandLineMatches(record({ args: [] }), "/opt/bin/agent")).toBe(true);
    expect(commandLineMatches(record({ args: [] }), "/opt/bin/agents")).toBe(false);
  });
});

describe("process table snapshot", () => {
  it("parses ps rows, including space-padded days and spaces in commands", () => {
    const parsed = parseProcessTable(
      [
        "  100     1   100 Tue Oct  7 14:49:52 2026     /bin/agent --trust acp",
        "  101   100   100 Tue Oct 27 09:01:02 2026     node /tmp/a b/mcp.js",
        "garbage",
      ].join("\n"),
    );
    expect([...parsed.keys()]).toEqual([100, 101]);
    expect(parsed.get(100)).toEqual({
      ...row(100, 1, 100, "/bin/agent --trust acp"),
      lstart: "Tue Oct  7 14:49:52 2026",
    });
    expect(parsed.get(101)?.command).toBe("node /tmp/a b/mcp.js");
    expect(descendantsOf(parsed, 100)).toEqual([101]);
  });
});
