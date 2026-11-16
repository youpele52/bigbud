import { ProjectId, ThreadId } from "@bigbud/contracts";

// Route-free constants shared by the two separately typechecked fixture projects.
export const parityShellProjectId = ProjectId.makeUnsafe("parity-shell-project");
export const parityShellThreadId = ThreadId.makeUnsafe("parity-shell-thread");
export const parityShellPrompt = "What are we working on?";
export const parityShellTime = "2026-11-15T00:00:00.000Z";
