import { describe, expect, it } from "vitest";

import {
  MAX_STARTUP_ERROR_MESSAGE_LENGTH,
  MAX_STARTUP_STDERR_TAIL_LENGTH,
  MAX_DEVELOPMENT_DIAGNOSTICS_LENGTH,
  createDevelopmentBackendDiagnostics,
  createBackendStartupDiagnostics,
  sanitizeBackendStartupText,
} from "./backendStartupDiagnostics";

describe("backend startup diagnostics", () => {
  it("redacts secrets and omits paths, SQL, and conversation content before IPC", () => {
    const hostile = [
      "token=super-secret",
      "Authorization: Bearer bearer-secret",
      "cookie: session=private",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
      "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz",
      "https://user:password@example.test/private",
      "/Users/person/private/project/server.ts",
      "SELECT * FROM messages",
      "user prompt: confidential conversation",
      "safe failure summary",
    ].join("\n");
    const diagnostics = createBackendStartupDiagnostics({
      category: "process",
      errorMessage: hostile,
      stderrTail: hostile.repeat(100),
    });
    const rendered = `${diagnostics.errorMessage}\n${diagnostics.stderrTail}`;

    expect(rendered).toContain("safe failure summary");
    expect(rendered).not.toContain("super-secret");
    expect(rendered).not.toContain("bearer-secret");
    expect(rendered).not.toContain("private/project");
    expect(rendered).not.toContain("SELECT *");
    expect(rendered).not.toContain("confidential conversation");
    expect(diagnostics.errorMessage?.length).toBeLessThanOrEqual(MAX_STARTUP_ERROR_MESSAGE_LENGTH);
    expect(diagnostics.stderrTail?.length).toBeLessThanOrEqual(MAX_STARTUP_STDERR_TAIL_LENGTH);
  });

  it("returns no display text when every line is unsafe", () => {
    expect(
      sanitizeBackendStartupText("/Users/person/private\nSELECT * FROM data", 100),
    ).toBeUndefined();
  });

  it("retains useful development crash context while redacting bootstrap credentials", () => {
    const diagnostics = createDevelopmentBackendDiagnostics({
      error: Object.assign(new Error("authToken=bootstrap-secret"), {
        cause: new Error("password=private"),
      }),
      stderrTail: "line\nauthToken=bootstrap-secret\n".repeat(2_000),
    });

    expect(JSON.stringify(diagnostics)).not.toContain("bootstrap-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("private");
    expect(JSON.stringify(diagnostics)).toContain("[REDACTED]");
    expect(
      Object.values(diagnostics)
        .filter((value): value is string => typeof value === "string")
        .reduce((length, value) => length + value.length, 0),
    ).toBeLessThanOrEqual(MAX_DEVELOPMENT_DIAGNOSTICS_LENGTH + diagnostics.capturedAt.length);
  });
});
