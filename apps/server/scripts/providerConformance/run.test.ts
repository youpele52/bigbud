import { describe, expect, it } from "vitest";

import { runAgainstMock, statusOf } from "./conformance.test.helpers.ts";
import { buildReport } from "./report.ts";
import { ROWS, selectProviders } from "./rows.ts";

describe("provider conformance self-test against the mock provider", () => {
  it("exercises every row and every status, then cleans up", async () => {
    const { output, mock, journal } = await runAgainstMock();
    const results = output.results;

    // Every row id appears, and every provider has every provider-scoped row.
    expect(new Set(results.map((entry) => entry.row))).toEqual(new Set(ROWS.map((row) => row.id)));
    for (const provider of ["codex", "claudeAgent", "copilot", "muse", "pi"])
      expect(results.filter((entry) => entry.provider === provider)).toHaveLength(ROWS.length - 1);

    // A fully working provider passes every session row.
    for (const row of ROWS.filter((entry) => entry.needsSession))
      expect([row.id, statusOf(results, "codex", row.id)]).toEqual([row.id, "pass"]);
    expect(statusOf(results, "backend", "version-rejection")).toBe("pass");
    expect(statusOf(results, "codex", "install-reuse")).toBe("pass");
    // Authenticated: auth is not safely observable, so the row does not run.
    expect(statusOf(results, "codex", "auth-state")).toBe("not-run");

    // needs-auth: the auth row passes and session rows are not run, with the reason.
    expect(statusOf(results, "claudeAgent", "auth-state")).toBe("pass");
    const blocked = results.find((e) => e.provider === "claudeAgent" && e.row === "text-turn");
    expect(blocked).toMatchObject({ status: "not-run", reason: "provider state needs-auth" });

    // Declared gaps are unsupported-by-provider; Muse's rejection was actually observed.
    const museAttachment = results.find((e) => e.provider === "muse" && e.row === "attachment");
    expect(museAttachment?.status).toBe("unsupported-by-provider");
    expect(museAttachment?.reason).toContain("rejected explicitly");
    expect(statusOf(results, "pi", "approval")).toBe("unsupported-by-provider");

    // Copilot was provisioned (opt-in) and then reused as a managed install.
    const copilot = results.find((e) => e.provider === "copilot" && e.row === "install-reuse");
    expect(copilot?.evidence).toMatchObject({
      provisionOutcome: "installing",
      copilotJobPhase: "installed",
      executableSource: "managed",
    });

    // Only conformance-named threads/projects were created, and all were removed.
    expect(journal.threadIds.length).toBeGreaterThan(0);
    expect(journal.threadIds.every((id) => id.startsWith("bigbud-conformance-thread-"))).toBe(true);
    expect(journal.projectId).toMatch(/^bigbud-conformance-project-/u);
    expect(mock.inspect.liveThreads()).toEqual([]);
    expect(mock.inspect.removed()).toBe(true);
    expect(output.cleanupProblems).toEqual([]);
  });

  it("never provisions Copilot unless asked", async () => {
    const { output, mock } = await runAgainstMock({
      providers: "copilot",
      rows: "install-reuse",
      provisionCopilot: false,
    });
    const row = output.results.find((entry) => entry.row === "install-reuse");
    expect(row).toMatchObject({ status: "fail" });
    expect(row?.reason).toContain("--provision-copilot");
    expect(mock.inspect.events().some((event) => event.type === "project.created")).toBe(false);
  });

  it("counts a self-test as no acceptance even when everything passes", async () => {
    const { output } = await runAgainstMock({ providers: "codex" });
    const report = buildReport({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      mode: "self-test",
      tuple: "mock",
      transport: "mock",
      backendVersion: output.backendVersion,
      providers: selectProviders("codex"),
      results: output.results,
      cleanupProblems: output.cleanupProblems,
    });
    expect(report.counts.fail).toBe(0);
    expect(report.acceptance).toBe("none");
    expect(report.acceptanceNote).toContain("No acceptance");
  });
});
