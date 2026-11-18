import { describe, expect, it } from "vitest";

import { runAgainstMock } from "./conformance.test.helpers.ts";
import { redactDeep, redactText } from "./redact.ts";
import { buildReport, renderMarkdown } from "./report.ts";
import { result, selectProviders } from "./rows.ts";

describe("redaction", () => {
  it.each([
    ["/home/alice/.nvm/versions/node/v22/bin/codex", "alice"],
    ["~/.codex/auth.json", ".codex"],
    ["C:\\Users\\alice\\bin\\codex.exe", "alice"],
    ["Authorization: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"],
    ["key sk-ant-api03-PLANTED0123456789", "PLANTED"],
    ["gh token ghp_abcdefghijklmnopqrstuvwx", "ghp_"],
    ["github_pat_11ABCDEFG0123456789", "github_pat"],
    ["jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig", "eyJ"],
    ["api_key=supersecretvalue", "supersecretvalue"],
    ['password: "hunter22"', "hunter22"],
    ["https://user:pass@example.org/x", "pass"],
    ["contact alice@example.com", "alice@example.com"],
    ["digest 0123456789abcdef0123456789abcdef", "0123456789abcdef"],
    ["nonce BBCONF-1A2B3C4D", "1A2B3C4D"],
  ])("removes secrets from %s", (input, secret) => {
    expect(redactText(input)).not.toContain(secret);
  });

  it("keeps harness vocabulary and repo-relative module references readable", () => {
    const text = "reused discovered installation (provider/Layers/Pi/Adapter.methods.ts)";
    expect(redactText(text)).toBe(text);
    expect(redactText("x".repeat(1000)).length).toBeLessThanOrEqual(301);
  });

  it("redacts deeply without changing keys", () => {
    expect(redactDeep({ a: ["/etc/secret/file"], b: { c: 1 } })).toEqual({
      a: ["<path>"],
      b: { c: 1 },
    });
  });
});

const baseReport = (results: ReturnType<typeof result>[], mode: "live" | "self-test" = "live") =>
  buildReport({
    startedAt: "2026-11-18T10:00:00.000Z",
    finishedAt: "2026-11-18T10:05:00.000Z",
    mode,
    tuple: "linux-arm64-glibc",
    transport: "ssh-relay",
    backendVersion: "0.1.0",
    providers: selectProviders("codex,muse"),
    results,
    cleanupProblems: [],
  });

describe("report", () => {
  it("never carries executable paths, provider messages, tokens or model output", async () => {
    const { output } = await runAgainstMock();
    const report = baseReport([...output.results], "self-test");
    const serialized = JSON.stringify(report) + renderMarkdown(report);
    for (const planted of [
      "/home/alice",
      "PLANTEDSECRET",
      "alice@example.com",
      "/opt/muse",
      "BBCONF-",
    ])
      expect(serialized).not.toContain(planted);
    expect(serialized).not.toMatch(/executablePath|"message"/u);
  });

  it("renders the matrix with one column per provider and the backend row separately", () => {
    const report = baseReport([
      result("install-reuse", "codex", "pass", "reused discovered installation"),
      result("attachment", "muse", "unsupported-by-provider", "declared"),
      result("text-turn", "codex", "fail", "turn settled failed | at /home/alice/x"),
      result("version-rejection", "backend", "pass", "mismatched revision refused with 426"),
    ]);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("| Row | codex | muse |");
    expect(markdown).toContain("| Install reuse | pass | - |");
    expect(markdown).toContain("| Attachment | - | unsupported |");
    expect(markdown).toContain("| Plain text turn | **FAIL** | - |");
    expect(markdown).toContain("Backend row Version rejection: pass");
    expect(markdown).toContain("turn settled failed \\| at <path>");
    expect(markdown).not.toContain("/home/alice");
    expect(report.acceptance).toBe("failed");
  });

  it("marks a clean live run only as a candidate, and self-tests as no acceptance", () => {
    const clean = [result("install-reuse", "codex", "pass", "ok")];
    expect(baseReport(clean).acceptance).toBe("candidate");
    expect(baseReport(clean, "self-test").acceptance).toBe("none");
    expect(baseReport([result("cancel", "codex", "not-run", "x")]).acceptance).toBe("failed");
  });
});
