import { expect, it } from "vitest";

import { isBackendStartupState } from "./backendStartupDiagnostics.validation";

const safeState = {
  diagnostics: {
    category: "process",
    errorMessage: "Backend exited.",
    occurredAt: "2026-01-01T00:00:00.000Z",
    stderrTail: "Exited with status 1.",
  },
  failureReason: "child_exit_before_ready",
  generation: 1,
  startedAt: 1,
  status: "failed",
};

it("accepts only bounded, structured startup diagnostics", () => {
  expect(isBackendStartupState(safeState)).toBe(true);
  expect(isBackendStartupState({ ...safeState, failureReason: "arbitrary" })).toBe(false);
  expect(
    isBackendStartupState({
      ...safeState,
      diagnostics: { ...safeState.diagnostics, errorMessage: "x".repeat(301) },
    }),
  ).toBe(false);
  expect(
    isBackendStartupState({
      ...safeState,
      diagnostics: { ...safeState.diagnostics, stderrTail: "Bearer raw-secret" },
    }),
  ).toBe(false);
  expect(
    isBackendStartupState({
      ...safeState,
      diagnostics: { ...safeState.diagnostics, stderrTail: "token=raw-secret" },
    }),
  ).toBe(false);
  expect(
    isBackendStartupState({
      ...safeState,
      diagnostics: { ...safeState.diagnostics, errorMessage: "/Users/private/file" },
    }),
  ).toBe(false);
  const development = {
    capturedAt: "2026-01-01T00:00:00.000Z",
    errorStack: "/Users/person/project/server.ts:1",
    stderrTail: "full local stack",
  };
  expect(isBackendStartupState({ ...safeState, developmentDiagnostics: development })).toBe(false);
  expect(isBackendStartupState({ ...safeState, developmentDiagnostics: development }, true)).toBe(
    true,
  );
  expect(
    isBackendStartupState(
      { ...safeState, developmentDiagnostics: { ...development, stderrTail: "token=raw-secret" } },
      true,
    ),
  ).toBe(false);
});
