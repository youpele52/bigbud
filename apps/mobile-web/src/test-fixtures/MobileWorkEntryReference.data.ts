import type { WorkLogEntry } from "@bigbud/shared/workLog";

const command = `printf '${"fixture-only output ".repeat(7)}'`;

/** Fictional display text only; no runner ever dispatches this command. */
export const workEntryDetailsFixture: WorkLogEntry = {
  id: "fixture-detail",
  createdAt: "2026-11-16T00:00:00.000Z",
  label: "Command completed",
  tone: "tool",
  itemType: "command_execution",
  command,
  rawCommand: `sh -lc "${command}"`,
  detail: "Fixture output line one\nFixture output line two",
};
