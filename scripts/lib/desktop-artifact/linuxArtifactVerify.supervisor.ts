import { Effect } from "effect";

import { findDesktopWorkspaceAgentTarget } from "../workspace-agent-target.ts";
import {
  assertDesktopSupervisorBinary,
  assertDesktopSupervisorEvidence,
} from "./desktopSupervisor.ts";

const LINUX_X64_SUPERVISOR = findDesktopWorkspaceAgentTarget("linux", "x64")!;

export const assertLinuxDesktopSupervisor = Effect.fn("assertLinuxDesktopSupervisor")(function* (
  artifactRoot: string,
  label: string,
) {
  const binaryPath = `${artifactRoot}/resources/server/delivery-supervisor/bin/bigbud-desktop-supervisor`;
  yield* assertDesktopSupervisorBinary(binaryPath, label, LINUX_X64_SUPERVISOR);
  yield* assertDesktopSupervisorEvidence(binaryPath, label);
});
